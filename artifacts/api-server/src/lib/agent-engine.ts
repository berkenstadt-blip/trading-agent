/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS TRADING ENGINE v2 — Ken Griffin-level intelligence
 * ═══════════════════════════════════════════════════════════════
 *
 *  FULL PIPELINE:
 *
 *  0. SCANNER        — scan all symbols, pick only A+ / A grade
 *  1. RESEARCH AGENT — macro, sector, catalysts, earnings risk
 *  2. SENTIMENT AGENT — news scoring, fear/greed, headlines
 *  3. STRATEGY AGENT — 15+ indicators, confluence, regime
 *  4. TRADER AGENT   — final decision, Kelly sizing, R:R gate
 *  5. RISK MANAGER   — circuit breaker, portfolio heat, stops
 *  6. OPTIONS ENGINE — if IV elevated: suggest premium strategy
 * ═══════════════════════════════════════════════════════════════
 */

import { db } from "@workspace/db";
import { agentsTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import * as alpaca from "./alpaca.js";
import { getSimulatedQuote } from "./market-data.js";
import { logger } from "./logger.js";

import {
  rsi, macd, bollingerBands, atr, volumeRatio, emaArray, detectTrend,
  supportResistance, stochastic, williamsR, obv, vwap, ichimoku,
  detectCandlePatterns, compositeSignalScore,
} from "./indicators.js";

import {
  kellyFraction, computePositionSize, computeStopLevels,
  checkCircuitBreaker, getPortfolioHeat, isMarketOpen, minutesToMarketClose,
  computeTradeStats,
} from "./risk-manager.js";

import { findBestOpportunity, SymbolScan } from "./scanner.js";

import {
  blackScholes, analyzeIV, findBestOptionStrategy, IVContext,
} from "./options-engine.js";

// ─── OpenRouter client ────────────────────────────────────────

const MODEL = "nousresearch/hermes-3-llama-3.1-70b";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
  const apiKey  = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
  if (!baseURL || !apiKey) throw new Error("OpenRouter not configured");
  _client = new OpenAI({ baseURL, apiKey });
  return _client;
}

async function llmJSON<T>(system: string, user: string, maxTokens = 600): Promise<T> {
  const resp = await getClient().chat.completions.create({
    model: MODEL, max_completion_tokens: maxTokens, temperature: 0.1,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  const raw = resp.choices[0]?.message?.content ?? "{}";
  const match = raw.replace(/```(?:json)?/gi, "").trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM non-JSON: ${raw.slice(0, 100)}`);
  return JSON.parse(match[0]) as T;
}

// ─── Types ────────────────────────────────────────────────────

export interface AgentRunResult {
  action: "bought" | "sold" | "held" | "no_signal" | "error";
  analysis: string;
  orderPlaced: {
    symbol: string; side: "buy" | "sell"; quantity: number; price: number;
    stopLoss: number; takeProfit: number; alpacaId?: string;
  } | null;
  pipeline?: {
    scanGrade: string; compositeScore: number;
    confidence: number; kellyF: number;
    circuitBreaker: string; optionSuggestion?: string;
  };
}

interface MarketData {
  symbol: string; price: number; changePercent: number; change: number;
  high: number; low: number; open: number; prevClose: number; volume: number;
  source: "alpaca" | "simulated";
  bars: { closes: number[]; highs: number[]; lows: number[]; volumes: number[]; opens: number[] };
  news: { headline: string; summary: string; created_at: string }[];
}

interface ResearchOutput {
  macroRegime: "risk-on" | "risk-off" | "neutral";
  sectorStrength: "strong" | "weak" | "neutral";
  earningsRisk: "high" | "low" | "none";
  catalysts: string[];
  headwinds: string[];
  macroScore: number;
  reasoning: string;
}

interface SentimentOutput {
  overallSentiment: "bullish" | "bearish" | "neutral";
  sentimentScore: number;
  newsSignal: "positive" | "negative" | "mixed" | "no_news";
  fearGreedProxy: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
  keyHeadlines: string[];
  reasoning: string;
}

interface TechnicalOutput {
  rsi: number; rsiSignal: "oversold" | "overbought" | "neutral";
  macdCross: "bullish" | "bearish" | "none"; macdHistogram: number;
  bbPercentB: number; bbSignal: "squeeze" | "overextended_up" | "overextended_down" | "normal";
  trend: "uptrend" | "downtrend" | "sideways";
  ema9: number; ema21: number; ema50: number; emaCrossSignal: "bullish" | "bearish" | "neutral";
  volumeRatio: number; volumeSignal: "high" | "low" | "normal";
  atr: number; atrPct: number;
  support: number; resistance: number; distToSupport: number; distToResistance: number;
  stochK: number; stochD: number; stochSignal: string;
  williamsR: number; williamsSignal: string;
  obvTrend: "accumulation" | "distribution" | "neutral";
  vwapRelation: "above" | "below";
  ichimokuCloud: "above" | "below" | "inside";
  candlePattern: string; candleScore: number;
  technicalScore: number;
  reasoning: string;
}

interface TraderDecision {
  action: "buy" | "sell" | "hold";
  quantity: number; confidence: number;
  stopLossPct: number; takeProfitPct: number;
  riskRewardRatio: number; positionSizePct: number;
  reasoning: string; conviction: "high" | "medium" | "low";
}

// ─── Market data fetcher ──────────────────────────────────────

async function fetchMarketData(symbol: string): Promise<MarketData> {
  let price = 0, changePercent = 0, change = 0, high = 0, low = 0,
      open = 0, prevClose = 0, volume = 0;
  let source: "alpaca" | "simulated" = "simulated";
  let bars = { closes: [] as number[], highs: [] as number[], lows: [] as number[], volumes: [] as number[], opens: [] as number[] };
  let news: { headline: string; summary: string; created_at: string }[] = [];

  if (alpaca.isConfigured()) {
    try {
      const snap = await alpaca.getSnapshot(symbol);
      price     = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
      prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
      change    = +(price - prevClose).toFixed(4);
      changePercent = prevClose > 0 ? +((change / prevClose) * 100).toFixed(4) : 0;
      high = snap.dailyBar?.h ?? price; low = snap.dailyBar?.l ?? price;
      open = snap.dailyBar?.o ?? price; volume = snap.dailyBar?.v ?? 0;
      source = "alpaca";
    } catch (e) { logger.warn({ e, symbol }, "Snapshot failed"); }

    try {
      const rawBars = await alpaca.getDailyBars(symbol, 60);
      if (rawBars.length > 15) {
        bars = { closes: rawBars.map(b => b.c), highs: rawBars.map(b => b.h),
                 lows: rawBars.map(b => b.l), volumes: rawBars.map(b => b.v),
                 opens: rawBars.map(b => b.o) };
        if (price > 0) {
          bars.closes.push(price); bars.highs.push(Math.max(high, price));
          bars.lows.push(Math.min(low, price)); bars.volumes.push(volume); bars.opens.push(open);
        }
      }
    } catch (e) { logger.warn({ e, symbol }, "Bars failed"); }

    try {
      const articles = await alpaca.getNews(symbol, 15);
      news = articles.map(a => ({ headline: a.headline, summary: (a.summary ?? "").slice(0, 300), created_at: a.created_at }));
    } catch (e) { logger.warn({ e, symbol }, "News failed"); }
  }

  if (price === 0) {
    const q = getSimulatedQuote(symbol);
    price = q.price; change = q.change; changePercent = q.changePercent;
    high = q.high; low = q.low; open = q.open; prevClose = q.previousClose; volume = q.volume;
  }

  if (bars.closes.length < 15) {
    let p = prevClose;
    const synth = { closes: [] as number[], highs: [] as number[], lows: [] as number[], volumes: [] as number[], opens: [] as number[] };
    for (let i = 0; i < 60; i++) {
      p = Math.max(1, +(p * (1 + (Math.random() - 0.498) * 0.015)).toFixed(2));
      synth.closes.push(p); synth.highs.push(+(p * 1.006).toFixed(2));
      synth.lows.push(+(p * 0.994).toFixed(2)); synth.volumes.push(volume + Math.floor(Math.random() * 500000));
      synth.opens.push(p);
    }
    synth.closes.push(price); synth.highs.push(Math.max(high, price));
    synth.lows.push(Math.min(low, price)); synth.volumes.push(volume); synth.opens.push(open);
    bars = synth;
  }

  return { symbol: symbol.toUpperCase(), price, changePercent, change, high, low, open, prevClose, volume, source, bars, news };
}

// ─── Compute all technicals ───────────────────────────────────

function computeTechnicals(md: MarketData): Omit<TechnicalOutput, "reasoning"> {
  const { closes, highs, lows, volumes, opens } = md.bars;
  const price = md.price;

  const rsiVal     = rsi(closes, 14);
  const macdRes    = macd(closes);
  const bb         = bollingerBands(closes, 20);
  const volR       = volumeRatio(volumes, 20);
  const trend      = detectTrend(closes, 20);
  const atrVal     = atr(highs, lows, closes, 14);
  const atrPct     = price > 0 ? +(atrVal / price * 100).toFixed(2) : 2;
  const sr         = supportResistance(highs, lows, price);
  const stoch      = stochastic(highs, lows, closes, 14, 3);
  const willR      = williamsR(highs, lows, closes, 14);
  const obvRes     = obv(closes, volumes);
  const vwapVal    = vwap(highs, lows, closes, volumes);
  const ichi       = ichimoku(highs, lows, closes);
  const candles    = detectCandlePatterns(opens, highs, lows, closes);

  const e9 = emaArray(closes, 9), e21 = emaArray(closes, 21), e50 = emaArray(closes, 50);
  const ema9 = e9[e9.length - 1] ?? price, ema21 = e21[e21.length - 1] ?? price, ema50 = e50[e50.length - 1] ?? price;

  const emaCrossSignal: TechnicalOutput["emaCrossSignal"] =
    (ema9 > ema21 && ema21 > ema50) ? "bullish" : (ema9 < ema21 && ema21 < ema50) ? "bearish" : "neutral";

  const { score } = compositeSignalScore({
    rsiVal, macdHistogram: macdRes.histogram, macdCross: macdRes.crossover,
    bbPercentB: bb.percentB, ema9, ema21, ema50, price, volRatio: volR,
    changePercent: md.changePercent, candleScore: candles.patternScore,
    obvTrend: obvRes.trend, stochK: stoch.k, williamsRVal: willR.value,
    ichimokuPriceVsCloud: ichi.priceVsCloud,
  });

  let bbSignal: TechnicalOutput["bbSignal"] = "normal";
  if (bb.bandwidth < 0.03) bbSignal = "squeeze";
  else if (bb.percentB > 0.95) bbSignal = "overextended_up";
  else if (bb.percentB < 0.05) bbSignal = "overextended_down";

  return {
    rsi: rsiVal, rsiSignal: rsiVal < 35 ? "oversold" : rsiVal > 65 ? "overbought" : "neutral",
    macdCross: macdRes.crossover, macdHistogram: macdRes.histogram,
    bbPercentB: bb.percentB, bbSignal, trend,
    ema9: +ema9.toFixed(2), ema21: +ema21.toFixed(2), ema50: +ema50.toFixed(2), emaCrossSignal,
    volumeRatio: volR, volumeSignal: volR > 1.5 ? "high" : volR < 0.6 ? "low" : "normal",
    atr: +atrVal.toFixed(4), atrPct,
    support: sr.nearestSupport, resistance: sr.nearestResistance,
    distToSupport: sr.distanceToSupport, distToResistance: sr.distanceToResistance,
    stochK: stoch.k, stochD: stoch.d, stochSignal: stoch.signal,
    williamsR: willR.value, williamsSignal: willR.signal,
    obvTrend: obvRes.trend, vwapRelation: price >= vwapVal ? "above" : "below",
    ichimokuCloud: ichi.priceVsCloud,
    candlePattern: candles.detected.join(", ") || "none",
    candleScore: candles.patternScore, technicalScore: score,
  };
}

// ─── Agent 1: Research ────────────────────────────────────────

async function runResearch(symbol: string, md: MarketData): Promise<ResearchOutput> {
  const newsBlob = md.news.slice(0, 8).map((n, i) => `[${i+1}] (${n.created_at.slice(0,10)}) ${n.headline}`).join("\n") || "No news.";
  const priceHist = md.bars.closes.slice(-10).map(c => `$${c.toFixed(2)}`).join(", ");
  return llmJSON<ResearchOutput>(
    `You are the RESEARCH AGENT of an elite hedge fund. Analyze macro, sector, and fundamental catalysts.
Respond ONLY with JSON: { macroRegime, sectorStrength, earningsRisk, catalysts[], headwinds[], macroScore(-100 to 100), reasoning(max 250 chars) }`,
    `SYMBOL: ${symbol} @ $${md.price.toFixed(2)} (${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%)
10-DAY HISTORY: ${priceHist}
52W HIGH/LOW: $${Math.max(...md.bars.closes).toFixed(2)} / $${Math.min(...md.bars.closes).toFixed(2)}
VOLUME: ${(md.volume/1e6).toFixed(2)}M | SOURCE: ${md.source}
RECENT NEWS:\n${newsBlob}
MACRO: Fed hawkish, USD strong, tech sector leading.`, 400
  );
}

// ─── Agent 2: Sentiment ───────────────────────────────────────

async function runSentiment(symbol: string, md: MarketData, research: ResearchOutput): Promise<SentimentOutput> {
  const newsBlob = md.news.map((n, i) => `[${i+1}] ${n.headline}\n    ${n.summary || ""}`).join("\n\n") || "No news.";
  return llmJSON<SentimentOutput>(
    `You are the SENTIMENT AGENT of an elite hedge fund. Score news and market sentiment.
Respond ONLY with JSON: { overallSentiment, sentimentScore(-100 to 100), newsSignal, fearGreedProxy, keyHeadlines[], reasoning(max 250 chars) }`,
    `SYMBOL: ${symbol} @ $${md.price.toFixed(2)} (${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%)
MACRO: ${research.macroRegime} | Score: ${research.macroScore}
NEWS:\n${newsBlob}`, 400
  );
}

// ─── Agent 3: Strategy ────────────────────────────────────────

async function runStrategy(symbol: string, md: MarketData, research: ResearchOutput, sentiment: SentimentOutput, techs: Omit<TechnicalOutput, "reasoning">): Promise<TechnicalOutput> {
  const result = await llmJSON<{ reasoning: string }>(
    `You are the STRATEGY AGENT (quantitative technician). Interpret indicators and add expert reasoning.
Respond ONLY with JSON: { reasoning: "string max 300 chars" }`,
    `SYMBOL: ${symbol} @ $${md.price.toFixed(2)}
RSI: ${techs.rsi} (${techs.rsiSignal}) | MACD: ${techs.macdCross} histogram=${techs.macdHistogram}
BB %B: ${(techs.bbPercentB*100).toFixed(0)}% (${techs.bbSignal}) | EMA: ${techs.emaCrossSignal}
Stoch %K/${techs.stochD}: ${techs.stochK}/${techs.stochD} (${techs.stochSignal})
Williams %R: ${techs.williamsR} | OBV: ${techs.obvTrend} | VWAP: price ${techs.vwapRelation} VWAP
Ichimoku: ${techs.ichimokuCloud} cloud | ATR: ${techs.atrPct}%
Candles: ${techs.candlePattern} (score ${techs.candleScore})
COMPOSITE SCORE: ${techs.technicalScore}/100
MACRO: ${research.macroRegime} (${research.macroScore}) | SENTIMENT: ${sentiment.overallSentiment} (${sentiment.sentimentScore})`, 250
  );
  return { ...techs, reasoning: result.reasoning ?? "Technical analysis complete." };
}

// ─── Agent 4: Trader ─────────────────────────────────────────

async function runTrader(
  agent: typeof agentsTable.$inferSelect,
  symbol: string, md: MarketData,
  research: ResearchOutput, sentiment: SentimentOutput,
  technical: TechnicalOutput,
  existingPos: { qty: number; avgCost: number } | null,
  maxQty: number, compositeScore: number,
): Promise<TraderDecision> {
  const result = await llmJSON<TraderDecision>(
    `You are the HEAD TRADER of a world-class hedge fund. Make the final trading decision.
HARD RULES:
- "buy" only if NO existing position. "sell" only if HAVE position. Otherwise "hold".
- Minimum confidence to act: 65. Below that: "hold".
- R:R must be ≥ 2.0 before any buy.
- stopLossPct: 1.5–4.0. takeProfitPct: ≥ 2× stopLossPct.
- positionSizePct: 30–100 (Kelly-based % of max allocation).
Respond ONLY with JSON: { action, quantity(1-${maxQty}), confidence(0-100), stopLossPct, takeProfitPct, riskRewardRatio, positionSizePct, reasoning(max 350 chars), conviction }`,
    `═ INTELLIGENCE BRIEF ═
${symbol} @ $${md.price.toFixed(2)} | Change: ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%
Existing pos: ${existingPos ? `${existingPos.qty}sh @ $${existingPos.avgCost.toFixed(2)} (${((md.price-existingPos.avgCost)/existingPos.avgCost*100).toFixed(1)}% P&L)` : "NONE"}
Strategy: ${agent.strategy.toUpperCase()} | Risk: ${agent.riskLevel.toUpperCase()}
Max shares: ${maxQty}

RESEARCH: ${research.macroRegime} | Score: ${research.macroScore} | Earnings: ${research.earningsRisk}
→ ${research.catalysts.join("; ")} | ⚠ ${research.headwinds.join("; ")}
SENTIMENT: ${sentiment.overallSentiment} (${sentiment.sentimentScore}) | ${sentiment.fearGreedProxy}
→ ${sentiment.keyHeadlines.slice(0,2).join(" | ")}
TECHNICAL: Score ${technical.technicalScore} | RSI ${technical.rsi} | MACD ${technical.macdCross}
BB ${(technical.bbPercentB*100).toFixed(0)}% | EMA ${technical.emaCrossSignal} | ${technical.candlePattern}
Stoch ${technical.stochK} | Williams ${technical.williamsR} | OBV ${technical.obvTrend}
ATR ${technical.atrPct}% | Support $${technical.support} | Resistance $${technical.resistance}
COMPOSITE: ${compositeScore}/100 — ${compositeScore > 40 ? "STRONG BULL" : compositeScore > 20 ? "MILD BULL" : compositeScore < -40 ? "STRONG BEAR" : compositeScore < -20 ? "MILD BEAR" : "NEUTRAL"}`, 500
  );

  // Guardrails
  if (!["buy","sell","hold"].includes(result.action)) result.action = "hold";
  if (result.action === "buy" && existingPos) result.action = "hold";
  if (result.action === "sell" && !existingPos) result.action = "hold";
  if ((result.confidence ?? 0) < 65) result.action = "hold";
  result.quantity = Math.max(1, Math.min(maxQty, Math.round(result.quantity) || 1));
  result.confidence = Math.max(0, Math.min(100, result.confidence ?? 50));
  result.stopLossPct = Math.max(1.5, Math.min(4.0, result.stopLossPct ?? technical.atrPct * 1.5));
  result.takeProfitPct = Math.max(result.stopLossPct * 2.0, result.takeProfitPct ?? result.stopLossPct * 2.5);
  result.riskRewardRatio = +(result.takeProfitPct / result.stopLossPct).toFixed(2);
  result.positionSizePct = Math.max(30, Math.min(100, result.positionSizePct ?? 50));
  result.quantity = Math.max(1, Math.round(result.quantity * result.positionSizePct / 100));
  return result;
}

// ─── Order execution ──────────────────────────────────────────

async function placeOrder(
  agent: typeof agentsTable.$inferSelect, symbol: string, side: "buy" | "sell",
  quantity: number, price: number, reason: string,
): Promise<{ orderId: number; alpacaId?: string; filledPrice: number }> {
  let alpacaId: string | undefined;
  let filledPrice = price;
  if (alpaca.isConfigured()) {
    const ao = await alpaca.placeOrder({ symbol, qty: quantity, side, type: "market", time_in_force: "day" });
    alpacaId = ao.id;
    if (ao.filled_avg_price) filledPrice = parseFloat(ao.filled_avg_price);
  }
  const [order] = await db.insert(ordersTable).values({
    symbol, assetType: "stock", side, orderType: "market",
    quantity: quantity.toString(), filledPrice: filledPrice.toString(),
    status: "filled", agentId: agent.id, agentName: agent.name,
    reason: reason.slice(0, 500), filledAt: new Date(),
  }).returning();
  return { orderId: order.id, alpacaId, filledPrice };
}

async function updateStats(agent: typeof agentsTable.$inferSelect, traded: boolean, pnl: number, isWin: boolean) {
  if (!traded) { await db.update(agentsTable).set({ lastRunAt: new Date() }).where(eq(agentsTable.id, agent.id)); return; }
  const newTrades = agent.totalTrades + 1;
  const oldWins = Math.round((parseFloat(agent.winRate) / 100) * agent.totalTrades);
  const newWins = oldWins + (isWin ? 1 : 0);
  const newPnl = parseFloat(agent.totalPnl) + pnl;
  await db.update(agentsTable).set({
    totalTrades: newTrades, winRate: ((newWins / newTrades) * 100).toFixed(2),
    totalPnl: newPnl.toFixed(4), lastRunAt: new Date(),
  }).where(eq(agentsTable.id, agent.id));
}

// ─── Main entry point ─────────────────────────────────────────

function parseSymbols(val: string): string[] {
  try { return JSON.parse(val); } catch { return []; }
}

export async function runAgentLogic(agent: typeof agentsTable.$inferSelect): Promise<AgentRunResult> {
  const symbols = parseSymbols(agent.symbols);
  if (symbols.length === 0) return { action: "no_signal", analysis: "No symbols configured.", orderPlaced: null };

  // ── 0. Market hours check ────────────────────────────────
  if (!isMarketOpen()) return { action: "no_signal", analysis: "Market closed.", orderPlaced: null };
  const minsToClose = minutesToMarketClose();

  // ── 0b. Get existing positions ───────────────────────────
  const existingPositionSymbols: string[] = [];
  let existingPos: { qty: number; avgCost: number } | null = null;

  // ── 0c. Circuit breaker check ────────────────────────────
  const recentOrders = await db.select().from(ordersTable)
    .orderBy(ordersTable.createdAt)
    .limit(30);

  const stats = computeTradeStats(
    recentOrders.map(o => ({ filledPrice: o.filledPrice, side: o.side, quantity: o.quantity, agentId: o.agentId }))
  );

  const breaker = checkCircuitBreaker({
    dailyPnL: parseFloat(agent.totalPnl),
    initialCapital: 100000,
    peakPortfolioValue: 100000 + Math.max(0, parseFloat(agent.totalPnl)),
    currentPortfolioValue: 100000 + parseFloat(agent.totalPnl),
    consecutiveLosses: stats.consecutiveLosses,
    minutesToClose: minsToClose,
  });

  if (breaker.halt) {
    return { action: "no_signal", analysis: `Circuit breaker: ${breaker.reason}`, orderPlaced: null,
             pipeline: { scanGrade: "N/A", compositeScore: 0, confidence: 0, kellyF: 0, circuitBreaker: breaker.reason } };
  }

  // ── 1. Scanner: find best opportunity ────────────────────
  const maxPos = parseFloat(agent.maxPositionSize);
  let scanResult: SymbolScan | null = null;
  let symbol: string;

  try {
    scanResult = await findBestOpportunity(symbols, existingPositionSymbols);
  } catch (e) { logger.warn({ e }, "Scanner failed, using random symbol"); }

  if (scanResult && (scanResult.grade === "A+" || scanResult.grade === "A")) {
    symbol = scanResult.symbol;
    logger.info({ symbol, grade: scanResult.grade, score: scanResult.technicalScore }, "Scanner picked symbol");
  } else {
    // Fallback: round-robin
    symbol = symbols[Math.floor(Date.now() / 300_000) % symbols.length];
    logger.info({ symbol }, "No A/A+ signal, using fallback symbol");
  }

  // ── 2. Fetch full market data ─────────────────────────────
  let md: MarketData;
  try { md = await fetchMarketData(symbol); }
  catch (err: any) { return { action: "error", analysis: `Data fetch failed: ${err.message}`, orderPlaced: null }; }

  // Existing position check
  if (alpaca.isConfigured()) {
    try {
      const pos = await alpaca.getPosition(symbol);
      existingPos = { qty: parseFloat(pos.qty), avgCost: parseFloat(pos.avg_entry_price) };
    } catch { /* none */ }
  }

  // ── 3. Run 4-agent LLM pipeline ──────────────────────────
  const [research, sentiment] = await Promise.all([
    runResearch(symbol, md).catch(() => ({
      macroRegime: "neutral" as const, sectorStrength: "neutral" as const,
      earningsRisk: "low" as const, catalysts: [], headwinds: [], macroScore: 0,
      reasoning: "Research failed." })),
    runSentiment(symbol, md, { macroRegime: "neutral", sectorStrength: "neutral",
      earningsRisk: "low", catalysts: [], headwinds: [], macroScore: 0, reasoning: "" })
      .catch(() => ({ overallSentiment: "neutral" as const, sentimentScore: 0,
        newsSignal: "no_news" as const, fearGreedProxy: "neutral" as const,
        keyHeadlines: [], reasoning: "Sentiment failed." })),
  ]);

  const rawTechs = computeTechnicals(md);
  const technical = await runStrategy(symbol, md, research, sentiment, rawTechs)
    .catch(() => ({ ...rawTechs, reasoning: "Strategy failed." }));

  const compositeScore = Math.round(
    research.macroScore * 0.25 + sentiment.sentimentScore * 0.25 + technical.technicalScore * 0.50
  );

  const maxQty = Math.max(1, Math.floor(maxPos / md.price));
  const trader = await runTrader(agent, symbol, md, research, sentiment, technical, existingPos, maxQty, compositeScore)
    .catch(err => ({ action: "hold" as const, quantity: 1, confidence: 0,
      stopLossPct: 2, takeProfitPct: 4, riskRewardRatio: 2, positionSizePct: 50,
      reasoning: `Trader failed: ${err.message}`, conviction: "low" as const }));

  // ── 4. Kelly position sizing ─────────────────────────────
  const kellyF = kellyFraction(stats.winRate, stats.avgWin, stats.avgLoss);
  const sizing = computePositionSize(md.price, trader.stopLossPct, maxPos, kellyF);
  const finalQty = Math.max(1, Math.min(maxQty, sizing.shares, trader.quantity));

  // ── 5. Options suggestion (if IV elevated) ───────────────
  let optionSuggestion: string | undefined;
  try {
    // Approximate IV from ATR: annualized ATR ≈ IV
    const approxIV = (technical.atrPct / 100) * Math.sqrt(252);
    const ivCtx = analyzeIV(approxIV, [approxIV * 0.8, approxIV * 0.9, approxIV * 1.1, approxIV * 1.2]);
    if (ivCtx.ivRank > 40) {
      const optOpp = findBestOptionStrategy(md.price, approxIV, ivCtx,
        compositeScore > 20 ? "bullish" : compositeScore < -20 ? "bearish" : "neutral");
      if (optOpp) optionSuggestion = `${optOpp.strategy}: ${optOpp.rationale}`;
    }
  } catch { /* optional */ }

  const analysis = `[${trader.confidence}% conf | Score: ${compositeScore} | ${scanResult?.grade ?? "N/A"}] ${trader.reasoning}`;

  const pipeline = {
    scanGrade: scanResult?.grade ?? "N/A",
    compositeScore, confidence: trader.confidence, kellyF: +kellyF.toFixed(3),
    circuitBreaker: breaker.reason,
    ...(optionSuggestion ? { optionSuggestion } : {}),
  };

  // ── 6. Execute ───────────────────────────────────────────
  if (trader.action === "buy" && !existingPos) {
    const levels = computeStopLevels(md.price, technical.atr, "long", 2);
    try {
      const result = await placeOrder(agent, symbol, "buy", finalQty, md.price, analysis);
      await updateStats(agent, true, 0, false);
      return {
        action: "bought", analysis, pipeline,
        orderPlaced: { symbol, side: "buy", quantity: finalQty, price: result.filledPrice,
          stopLoss: levels.stopLoss, takeProfit: levels.takeProfit2, alpacaId: result.alpacaId },
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, pipeline, orderPlaced: null };
    }
  }

  if (trader.action === "sell" && existingPos) {
    const qty = Math.min(finalQty, existingPos.qty);
    const levels = computeStopLevels(existingPos.avgCost, technical.atr, "long", 2);
    try {
      const result = await placeOrder(agent, symbol, "sell", qty, md.price, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * qty;
      await updateStats(agent, true, pnl, pnl > 0);
      return {
        action: "sold", analysis, pipeline,
        orderPlaced: { symbol, side: "sell", quantity: qty, price: result.filledPrice,
          stopLoss: levels.stopLoss, takeProfit: levels.takeProfit2, alpacaId: result.alpacaId },
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, pipeline, orderPlaced: null };
    }
  }

  await updateStats(agent, false, 0, false);
  return {
    action: trader.action === "hold" ? "held" : "no_signal",
    analysis, pipeline, orderPlaced: null,
  };
}
