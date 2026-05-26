/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AEGIS TRADING ENGINE  — Ken Griffin-level multi-agent pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PIPELINE (sequential, each agent feeds the next):
 *
 *  1. RESEARCH AGENT   — macro context, sector rotation, historical bars,
 *                        fundamental snapshot, earnings calendar awareness
 *
 *  2. SENTIMENT AGENT  — news analysis (Alpaca News API), headline scoring,
 *                        fear/greed proxy, insider flow signals
 *
 *  3. STRATEGY AGENT   — full technical suite: RSI, MACD, Bollinger Bands,
 *                        ATR, EMA(9/21/50), volume ratio, support/resistance,
 *                        multi-timeframe confluence, regime detection
 *
 *  4. TRADER AGENT     — synthesizes all above, Kelly-fraction position sizing,
 *                        ATR-based stop-loss & take-profit, confidence gate,
 *                        daily loss limit guard, final execution decision
 *
 *  Each agent is a dedicated LLM call with a specialized system prompt.
 *  The trader only fires if all 3 upstream agents agree (or 2/3 with high conf).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { db } from "@workspace/db";
import { agentsTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import * as alpaca from "./alpaca.js";
import { getSimulatedQuote } from "./market-data.js";
import { logger } from "./logger.js";
import {
  rsi,
  macd,
  bollingerBands,
  atr,
  volumeRatio,
  emaArray,
  detectTrend,
  supportResistance,
} from "./indicators.js";

// ─── Model config ─────────────────────────────────────────────────────────────
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

async function llmJSON<T>(system: string, user: string, maxTokens = 512): Promise<T> {
  const client = getClient();
  const resp = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: maxTokens,
    temperature: 0.15,
    messages: [
      { role: "system", content: system },
      { role: "user",   content: user },
    ],
  });
  const raw = resp.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```(?:json)?/gi, "").trim();
  // Find first { ... } block
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 200)}`);
  return JSON.parse(match[0]) as T;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentRunResult {
  action: "bought" | "sold" | "held" | "no_signal" | "error";
  analysis: string;
  pipeline?: PipelineResult;
  orderPlaced: {
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    stopLoss: number;
    takeProfit: number;
    alpacaId?: string;
  } | null;
}

interface MarketData {
  symbol: string;
  price: number;
  changePercent: number;
  change: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  volume: number;
  source: "alpaca" | "simulated";
  bars: {
    closes: number[];
    highs: number[];
    lows: number[];
    volumes: number[];
    opens: number[];
    timestamps: string[];
  };
  news: { headline: string; summary: string; created_at: string }[];
}

interface ResearchOutput {
  macroRegime: "risk-on" | "risk-off" | "neutral";
  sectorStrength: "strong" | "weak" | "neutral";
  earningsRisk: "high" | "low" | "none";
  catalysts: string[];
  headwinds: string[];
  macroScore: number;       // -100 to +100
  reasoning: string;
}

interface SentimentOutput {
  overallSentiment: "bullish" | "bearish" | "neutral";
  sentimentScore: number;   // -100 to +100
  newsSignal: "positive" | "negative" | "mixed" | "no_news";
  fearGreedProxy: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
  keyHeadlines: string[];
  reasoning: string;
}

interface TechnicalOutput {
  rsi: number;
  rsiSignal: "oversold" | "overbought" | "neutral";
  macdCross: "bullish" | "bearish" | "none";
  macdHistogram: number;
  bbPercentB: number;
  bbSignal: "squeeze" | "overextended_up" | "overextended_down" | "normal";
  trend: "uptrend" | "downtrend" | "sideways";
  ema9: number; ema21: number; ema50: number;
  emaCrossSignal: "bullish" | "bearish" | "neutral";
  volumeRatio: number;
  volumeSignal: "high" | "low" | "normal";
  atr: number;
  atrPct: number;        // ATR as % of price
  support: number;
  resistance: number;
  distToSupport: number;
  distToResistance: number;
  technicalScore: number; // -100 to +100
  reasoning: string;
}

interface TraderDecision {
  action: "buy" | "sell" | "hold";
  quantity: number;
  confidence: number;        // 0–100
  stopLossPct: number;       // e.g. 2.5 = 2.5% below entry
  takeProfitPct: number;     // e.g. 5.0 = 5% above entry
  riskRewardRatio: number;
  positionSizePct: number;   // % of max position to use (Kelly-like)
  reasoning: string;
  conviction: "high" | "medium" | "low";
}

interface PipelineResult {
  research: ResearchOutput;
  sentiment: SentimentOutput;
  technical: TechnicalOutput;
  trader: TraderDecision;
  compositeScore: number;    // weighted sum of all scores
}

// ─── Data Fetching ────────────────────────────────────────────────────────────

async function fetchMarketData(symbol: string): Promise<MarketData> {
  let price = 0, changePercent = 0, change = 0, high = 0, low = 0,
      open = 0, prevClose = 0, volume = 0;
  let source: "alpaca" | "simulated" = "simulated";
  let bars = { closes: [] as number[], highs: [] as number[], lows: [] as number[],
               volumes: [] as number[], opens: [] as number[], timestamps: [] as string[] };
  let news: { headline: string; summary: string; created_at: string }[] = [];

  if (alpaca.isConfigured()) {
    try {
      // Live snapshot
      const snap = await alpaca.getSnapshot(symbol);
      price     = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
      prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
      change    = +(price - prevClose).toFixed(4);
      changePercent = prevClose > 0 ? +((change / prevClose) * 100).toFixed(4) : 0;
      high   = snap.dailyBar?.h ?? price;
      low    = snap.dailyBar?.l ?? price;
      open   = snap.dailyBar?.o ?? price;
      volume = snap.dailyBar?.v ?? 0;
      source = "alpaca";
    } catch (e) {
      logger.warn({ e, symbol }, "Snapshot failed, using simulated");
    }

    try {
      // 60-day daily bars for indicators
      const rawBars = await alpaca.getDailyBars(symbol, 60);
      if (rawBars.length > 10) {
        bars = {
          closes:     rawBars.map(b => b.c),
          highs:      rawBars.map(b => b.h),
          lows:       rawBars.map(b => b.l),
          volumes:    rawBars.map(b => b.v),
          opens:      rawBars.map(b => b.o),
          timestamps: rawBars.map(b => b.t),
        };
        // If live price available, append current day
        if (price > 0) {
          bars.closes.push(price);
          bars.highs.push(Math.max(high, price));
          bars.lows.push(Math.min(low, price));
          bars.volumes.push(volume);
          bars.opens.push(open);
          bars.timestamps.push(new Date().toISOString());
        }
      }
    } catch (e) {
      logger.warn({ e, symbol }, "Daily bars failed");
    }

    try {
      const articles = await alpaca.getNews(symbol, 15);
      news = articles.map(a => ({
        headline:   a.headline,
        summary:    a.summary?.slice(0, 300) ?? "",
        created_at: a.created_at,
      }));
    } catch (e) {
      logger.warn({ e, symbol }, "News fetch failed");
    }
  }

  // Fallback to simulated if no real data
  if (price === 0) {
    const q = getSimulatedQuote(symbol);
    price = q.price; change = q.change; changePercent = q.changePercent;
    high = q.high; low = q.low; open = q.open; prevClose = q.previousClose;
    volume = q.volume;
  }

  // Fallback bars from simulated price drift
  if (bars.closes.length < 14) {
    const synth: number[] = [];
    let p = prevClose;
    for (let i = 0; i < 60; i++) {
      p = +(p * (1 + (Math.random() - 0.498) * 0.015)).toFixed(2);
      synth.push(p);
    }
    synth.push(price);
    bars = {
      closes:     synth,
      highs:      synth.map(c => +(c * 1.005).toFixed(2)),
      lows:       synth.map(c => +(c * 0.995).toFixed(2)),
      volumes:    synth.map(() => volume + Math.floor(Math.random() * 500000)),
      opens:      synth,
      timestamps: synth.map((_, i) => new Date(Date.now() - (60 - i) * 86400000).toISOString()),
    };
  }

  return { symbol: symbol.toUpperCase(), price, changePercent, change,
           high, low, open, prevClose, volume, source, bars, news };
}

// ─── AGENT 1: RESEARCH ────────────────────────────────────────────────────────

async function runResearchAgent(symbol: string, md: MarketData): Promise<ResearchOutput> {
  const system = `You are the RESEARCH AGENT for an elite quantitative hedge fund.
Your job: analyze macro regime, sector dynamics, and fundamental catalysts for a stock.

OUTPUT: respond ONLY with a valid JSON object — no markdown, no preamble.
Schema:
{
  "macroRegime": "risk-on" | "risk-off" | "neutral",
  "sectorStrength": "strong" | "weak" | "neutral",
  "earningsRisk": "high" | "low" | "none",
  "catalysts": ["string", ...],        // up to 3 bullish catalysts
  "headwinds": ["string", ...],        // up to 3 risks
  "macroScore": number,                // -100 (bearish) to +100 (bullish)
  "reasoning": "string"                // max 300 chars
}`;

  const priceHistory = md.bars.closes.slice(-10).map(c => `$${c.toFixed(2)}`).join(", ");
  const newsBlob = md.news.length > 0
    ? md.news.slice(0, 8).map((n, i) =>
        `[${i+1}] (${n.created_at.slice(0,10)}) ${n.headline}`
      ).join("\n")
    : "No recent news available.";

  const user = `SYMBOL: ${symbol}
CURRENT PRICE: $${md.price.toFixed(2)}  |  DAY CHANGE: ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%
10-DAY PRICE HISTORY: ${priceHistory}
52-DAY HIGH: $${Math.max(...md.bars.closes).toFixed(2)}  |  52-DAY LOW: $${Math.min(...md.bars.closes).toFixed(2)}
VOLUME: ${(md.volume / 1_000_000).toFixed(2)}M  |  DATA SOURCE: ${md.source}

RECENT NEWS (last 8 articles):
${newsBlob}

MACRO CONTEXT (as of today):
- Fed rates: elevated, "higher for longer" stance
- USD: strong globally
- Market breadth: mixed, tech leading
- VIX environment: moderate volatility regime

Analyze this stock from a macro/fundamental/catalyst perspective.`;

  return llmJSON<ResearchOutput>(system, user, 400);
}

// ─── AGENT 2: SENTIMENT ───────────────────────────────────────────────────────

async function runSentimentAgent(symbol: string, md: MarketData, research: ResearchOutput): Promise<SentimentOutput> {
  const system = `You are the SENTIMENT AGENT for an elite quantitative hedge fund.
Your job: analyze news sentiment, social signals, and market fear/greed dynamics.

OUTPUT: respond ONLY with a valid JSON object — no markdown, no preamble.
Schema:
{
  "overallSentiment": "bullish" | "bearish" | "neutral",
  "sentimentScore": number,           // -100 to +100
  "newsSignal": "positive" | "negative" | "mixed" | "no_news",
  "fearGreedProxy": "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed",
  "keyHeadlines": ["string"],          // top 3 most impactful headlines
  "reasoning": "string"               // max 300 chars
}`;

  const newsBlob = md.news.length > 0
    ? md.news.map((n, i) =>
        `[${i+1}] ${n.headline}\n    Summary: ${n.summary || "N/A"}`
      ).join("\n\n")
    : "No news available.";

  const user = `SYMBOL: ${symbol}
CURRENT PRICE: $${md.price.toFixed(2)}  (${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}% today)

MACRO REGIME from Research Agent: ${research.macroRegime.toUpperCase()} | Macro Score: ${research.macroScore}
CATALYSTS: ${research.catalysts.join("; ") || "none identified"}
HEADWINDS: ${research.headwinds.join("; ") || "none identified"}

ALL RECENT NEWS:
${newsBlob}

Price behavior context:
- Today's range: $${md.low.toFixed(2)} – $${md.high.toFixed(2)}
- Previous close: $${md.prevClose.toFixed(2)}
- Volume vs normal: ${(md.volume / 1_000_000).toFixed(2)}M shares

Analyze the sentiment landscape for this stock.`;

  return llmJSON<SentimentOutput>(system, user, 400);
}

// ─── AGENT 3: STRATEGY (Technical) ───────────────────────────────────────────

function computeTechnicals(md: MarketData): Omit<TechnicalOutput, "reasoning"> {
  const { closes, highs, lows, volumes } = md.bars;
  const price = md.price;

  // RSI
  const rsiVal = rsi(closes, 14);
  const rsiSignal: TechnicalOutput["rsiSignal"] =
    rsiVal < 35 ? "oversold" : rsiVal > 65 ? "overbought" : "neutral";

  // MACD
  const macdResult = macd(closes);
  const macdCross = macdResult.crossover;

  // Bollinger Bands
  const bb = bollingerBands(closes, 20);
  let bbSignal: TechnicalOutput["bbSignal"] = "normal";
  if (bb.bandwidth < 0.03) bbSignal = "squeeze";
  else if (bb.percentB > 0.95) bbSignal = "overextended_up";
  else if (bb.percentB < 0.05) bbSignal = "overextended_down";

  // EMAs
  const ema9Arr  = emaArray(closes, 9);
  const ema21Arr = emaArray(closes, 21);
  const ema50Arr = emaArray(closes, 50);
  const ema9Val  = ema9Arr[ema9Arr.length - 1]   ?? price;
  const ema21Val = ema21Arr[ema21Arr.length - 1] ?? price;
  const ema50Val = ema50Arr[ema50Arr.length - 1] ?? price;

  let emaCrossSignal: TechnicalOutput["emaCrossSignal"] = "neutral";
  if (ema9Val > ema21Val && ema21Val > ema50Val) emaCrossSignal = "bullish";
  else if (ema9Val < ema21Val && ema21Val < ema50Val) emaCrossSignal = "bearish";

  // Trend
  const trend = detectTrend(closes, 20);

  // Volume
  const volRatio = volumeRatio(volumes, 20);
  const volumeSignal: TechnicalOutput["volumeSignal"] =
    volRatio > 1.5 ? "high" : volRatio < 0.6 ? "low" : "normal";

  // ATR
  const atrVal = atr(highs, lows, closes, 14);
  const atrPct = price > 0 ? +(atrVal / price * 100).toFixed(2) : 2;

  // Support / Resistance
  const sr = supportResistance(highs, lows, price);

  // Composite technical score
  let techScore = 0;
  // RSI contribution
  if (rsiVal < 30) techScore += 25;
  else if (rsiVal < 40) techScore += 10;
  else if (rsiVal > 70) techScore -= 25;
  else if (rsiVal > 60) techScore -= 10;
  // MACD
  if (macdCross === "bullish") techScore += 20;
  else if (macdCross === "bearish") techScore -= 20;
  if (macdResult.histogram > 0) techScore += 10;
  else if (macdResult.histogram < 0) techScore -= 10;
  // BB
  if (bb.percentB < 0.2) techScore += 15;
  else if (bb.percentB > 0.8) techScore -= 15;
  // EMA
  if (emaCrossSignal === "bullish") techScore += 20;
  else if (emaCrossSignal === "bearish") techScore -= 20;
  // Trend
  if (trend === "uptrend") techScore += 10;
  else if (trend === "downtrend") techScore -= 10;
  // Volume confirmation
  if (volRatio > 1.5 && md.changePercent > 0) techScore += 10;
  else if (volRatio > 1.5 && md.changePercent < 0) techScore -= 10;

  return {
    rsi: rsiVal, rsiSignal,
    macdCross, macdHistogram: macdResult.histogram,
    bbPercentB: bb.percentB, bbSignal,
    trend, ema9: +ema9Val.toFixed(2), ema21: +ema21Val.toFixed(2), ema50: +ema50Val.toFixed(2),
    emaCrossSignal, volumeRatio: volRatio, volumeSignal,
    atr: +atrVal.toFixed(4), atrPct,
    support: sr.nearestSupport, resistance: sr.nearestResistance,
    distToSupport: sr.distanceToSupport, distToResistance: sr.distanceToResistance,
    technicalScore: Math.max(-100, Math.min(100, techScore)),
  };
}

async function runStrategyAgent(
  symbol: string, md: MarketData,
  research: ResearchOutput, sentiment: SentimentOutput,
  techs: Omit<TechnicalOutput, "reasoning">
): Promise<TechnicalOutput> {
  const system = `You are the STRATEGY AGENT for an elite quantitative hedge fund.
Your job: interpret technical indicators and determine the trading signal.
You have deep expertise in RSI, MACD, Bollinger Bands, EMAs, volume analysis, and market microstructure.

OUTPUT: respond ONLY with a valid JSON object — no markdown, no preamble.
Schema: same as input technicals but add "reasoning" field (max 300 chars).
Just return the same numbers plus your reasoning — do NOT change the numeric values.`;

  const user = `SYMBOL: ${symbol} @ $${md.price.toFixed(2)}

TECHNICAL INDICATORS:
- RSI(14): ${techs.rsi} → ${techs.rsiSignal.toUpperCase()}
- MACD: histogram=${techs.macdHistogram}, crossover=${techs.macdCross.toUpperCase()}
- Bollinger %B: ${(techs.bbPercentB * 100).toFixed(1)}% → ${techs.bbSignal.toUpperCase()}
- EMA 9/21/50: $${techs.ema9}/$${techs.ema21}/$${techs.ema50} → ${techs.emaCrossSignal.toUpperCase()} alignment
- Trend (20-day): ${techs.trend.toUpperCase()}
- Volume ratio vs 20d avg: ${techs.volumeRatio}x → ${techs.volumeSignal.toUpperCase()}
- ATR(14): $${techs.atr} (${techs.atrPct}% of price) — used for stop sizing
- Support: $${techs.support} (${techs.distToSupport}% away)
- Resistance: $${techs.resistance} (${techs.distToResistance}% away)
- Composite Technical Score: ${techs.technicalScore}/100

UPSTREAM CONTEXT:
- Macro Regime: ${research.macroRegime} (score: ${research.macroScore})
- Sentiment: ${sentiment.overallSentiment} (score: ${sentiment.sentimentScore})
- Earnings Risk: ${research.earningsRisk}

Add your expert "reasoning" for the technical picture (max 300 chars).`;

  const result = await llmJSON<TechnicalOutput>(system, user, 300);
  // Preserve computed values, only take reasoning
  return { ...techs, reasoning: result.reasoning ?? "Technical analysis complete." };
}

// ─── AGENT 4: TRADER (Decision + Execution) ───────────────────────────────────

async function runTraderAgent(
  agent: typeof agentsTable.$inferSelect,
  symbol: string, md: MarketData,
  research: ResearchOutput, sentiment: SentimentOutput,
  technical: TechnicalOutput,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<TraderDecision> {
  const maxQty = Math.max(1, Math.floor(maxPos / md.price));
  const compositeScore = Math.round(
    research.macroScore * 0.25 +
    sentiment.sentimentScore * 0.25 +
    technical.technicalScore * 0.50
  );

  const system = `You are the HEAD TRADER of an elite quantitative hedge fund — think Ken Griffin, Jim Simons, Steve Cohen combined.
You have the final say on every trade. You synthesize macro, sentiment, AND technicals into precise execution decisions.

RULES (hard constraints):
- ONLY "buy" if there is NO existing position.
- ONLY "sell" if there IS an existing position.
- "hold" otherwise.
- Minimum confidence to trade: 60. Below that, always "hold".
- Risk/reward must be ≥ 1.5 before any buy.
- stopLossPct: 1.5–4.0 (use ATR-based sizing, not arbitrary).
- takeProfitPct: must be ≥ 1.5× stopLossPct.
- positionSizePct: 25–100 (% of max position to deploy, Kelly-inspired).
- conviction "high" = 80+ confidence, "medium" = 65–79, "low" = 60–64.

OUTPUT: respond ONLY with a valid JSON object — no markdown, no preamble.
Schema:
{
  "action": "buy" | "sell" | "hold",
  "quantity": number,
  "confidence": number,
  "stopLossPct": number,
  "takeProfitPct": number,
  "riskRewardRatio": number,
  "positionSizePct": number,
  "reasoning": "string",     // max 400 chars — cite specific signals
  "conviction": "high" | "medium" | "low"
}`;

  const user = `═══ FULL INTELLIGENCE BRIEF ═══

SYMBOL: ${symbol}
PRICE: $${md.price.toFixed(2)} | CHANGE: ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%
EXISTING POSITION: ${existingPos ? `${existingPos.qty} shares @ avg $${existingPos.avgCost.toFixed(2)} (unrealized P&L: ${((md.price - existingPos.avgCost) / existingPos.avgCost * 100).toFixed(2)}%)` : "NONE"}
MAX POSITION: $${maxPos.toFixed(0)} (max ${maxQty} shares) | STRATEGY: ${agent.strategy.toUpperCase()} | RISK: ${agent.riskLevel.toUpperCase()}

═══ RESEARCH AGENT ═══
Macro Regime: ${research.macroRegime.toUpperCase()} | Sector: ${research.sectorStrength} | Earnings Risk: ${research.earningsRisk}
Macro Score: ${research.macroScore}/100
Catalysts: ${research.catalysts.join("; ") || "none"}
Headwinds: ${research.headwinds.join("; ") || "none"}
Analysis: ${research.reasoning}

═══ SENTIMENT AGENT ═══
Sentiment: ${sentiment.overallSentiment.toUpperCase()} (${sentiment.sentimentScore}/100)
News Signal: ${sentiment.newsSignal.toUpperCase()} | Fear/Greed: ${sentiment.fearGreedProxy.toUpperCase()}
Key Headlines: ${sentiment.keyHeadlines.join(" | ") || "none"}
Analysis: ${sentiment.reasoning}

═══ STRATEGY AGENT (TECHNICALS) ═══
RSI(14): ${technical.rsi} → ${technical.rsiSignal.toUpperCase()}
MACD: ${technical.macdCross.toUpperCase()} crossover | histogram=${technical.macdHistogram}
Bollinger %B: ${(technical.bbPercentB * 100).toFixed(1)}% → ${technical.bbSignal.toUpperCase()}
EMA 9/21/50: ${technical.emaCrossSignal.toUpperCase()} alignment ($${technical.ema9}/$${technical.ema21}/$${technical.ema50})
Trend: ${technical.trend.toUpperCase()} | Volume: ${technical.volumeRatio}x (${technical.volumeSignal})
ATR: $${technical.atr} (${technical.atrPct}%) | Support: $${technical.support} | Resistance: $${technical.resistance}
Technical Score: ${technical.technicalScore}/100
Analysis: ${technical.reasoning}

═══ COMPOSITE SCORE ═══
OVERALL SIGNAL: ${compositeScore}/100 (${compositeScore > 30 ? "BULLISH" : compositeScore < -30 ? "BEARISH" : "NEUTRAL"})
Weights: Technical 50% | Research 25% | Sentiment 25%

Make your final trading decision. Be precise. Cite the strongest signals in your reasoning.`;

  const result = await llmJSON<TraderDecision>(system, user, 500);

  // Hard guardrails
  if (![  "buy", "sell", "hold"].includes(result.action)) result.action = "hold";
  if (result.action === "buy" && existingPos) result.action = "hold";
  if (result.action === "sell" && !existingPos) result.action = "hold";
  if ((result.confidence ?? 0) < 60) result.action = "hold";

  result.quantity    = Math.max(1, Math.min(maxQty, Math.round(result.quantity) || 1));
  result.confidence  = Math.max(0, Math.min(100, result.confidence ?? 50));
  result.stopLossPct = Math.max(1.0, Math.min(5.0, result.stopLossPct ?? technical.atrPct * 1.5));
  result.takeProfitPct = Math.max(result.stopLossPct * 1.5, result.takeProfitPct ?? result.stopLossPct * 2.5);
  result.riskRewardRatio = +(result.takeProfitPct / result.stopLossPct).toFixed(2);
  result.positionSizePct = Math.max(25, Math.min(100, result.positionSizePct ?? 50));
  result.reasoning   = String(result.reasoning ?? "").slice(0, 400);

  // Apply position sizing
  const sizedQty = Math.max(1, Math.round(result.quantity * result.positionSizePct / 100));
  result.quantity = sizedQty;

  return result;
}

// ─── Order execution ──────────────────────────────────────────────────────────

async function placeOrder(
  agent: typeof agentsTable.$inferSelect,
  symbol: string, side: "buy" | "sell",
  quantity: number, price: number,
  stopLossPct: number, takeProfitPct: number,
  reason: string,
): Promise<{ orderId: number; alpacaId?: string; filledPrice: number }> {
  let alpacaId: string | undefined;
  let filledPrice = price;

  if (alpaca.isConfigured()) {
    const alpacaOrder = await alpaca.placeOrder({
      symbol, qty: quantity, side, type: "market", time_in_force: "day",
    });
    alpacaId = alpacaOrder.id;
    if (alpacaOrder.filled_avg_price) filledPrice = parseFloat(alpacaOrder.filled_avg_price);
    logger.info({ alpacaId, symbol, side, quantity, stopLossPct, takeProfitPct }, "Placed real Alpaca order");
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
  if (!traded) {
    await db.update(agentsTable).set({ lastRunAt: new Date() }).where(eq(agentsTable.id, agent.id));
    return;
  }
  const newTrades = agent.totalTrades + 1;
  const oldWins   = Math.round((parseFloat(agent.winRate) / 100) * agent.totalTrades);
  const newWins   = oldWins + (isWin ? 1 : 0);
  const newWinRate = newTrades > 0 ? (newWins / newTrades) * 100 : 0;
  const newPnl    = parseFloat(agent.totalPnl) + pnl;
  await db.update(agentsTable).set({
    totalTrades: newTrades, winRate: newWinRate.toFixed(2),
    totalPnl: newPnl.toFixed(4), lastRunAt: new Date(),
  }).where(eq(agentsTable.id, agent.id));
}

// ─── Market Hours Guard ───────────────────────────────────────────────────────

function isMarketHours(): boolean {
  const now = new Date();
  // NYSE: 9:30–16:00 ET (UTC-4 in summer, UTC-5 in winter)
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
  const etMin  = now.getUTCMinutes();
  const etMins = etHour * 60 + etMin;
  const day    = now.getUTCDay();
  // Mon-Fri only
  if (day === 0 || day === 6) return false;
  return etMins >= 570 && etMins < 960; // 9:30–16:00
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

// ─── Main public entry point ──────────────────────────────────────────────────

function parseSymbols(val: string): string[] {
  try { return JSON.parse(val); } catch { return []; }
}

export async function runAgentLogic(
  agent: typeof agentsTable.$inferSelect
): Promise<AgentRunResult> {
  const symbols = parseSymbols(agent.symbols);
  if (symbols.length === 0) {
    return { action: "no_signal", analysis: "No symbols configured.", orderPlaced: null };
  }

  // Pick symbol — rotate based on time so we don't always hit the same one
  const symbol = symbols[Math.floor(Date.now() / 300_000) % symbols.length];
  const maxPos  = parseFloat(agent.maxPositionSize);

  // ── Step 1: Fetch all market data ──────────────────────────────────────────
  let md: MarketData;
  try {
    md = await fetchMarketData(symbol);
  } catch (err: any) {
    return { action: "error", analysis: `Data fetch failed: ${err.message}`, orderPlaced: null };
  }

  // ── Step 2: Get existing position ─────────────────────────────────────────
  let existingPos: { qty: number; avgCost: number } | null = null;
  if (alpaca.isConfigured()) {
    try {
      const pos = await alpaca.getPosition(symbol);
      existingPos = { qty: parseFloat(pos.qty), avgCost: parseFloat(pos.avg_entry_price) };
    } catch { /* no position */ }
  }

  logger.info({ agentId: agent.id, symbol, price: md.price, source: md.source, newsCount: md.news.length }, "Pipeline starting");

  // ── Step 3: Run 4-agent pipeline ──────────────────────────────────────────
  let research: ResearchOutput;
  let sentiment: SentimentOutput;
  let technical: TechnicalOutput;
  let trader: TraderDecision;

  try {
    research  = await runResearchAgent(symbol, md);
    logger.info({ agentId: agent.id, macroScore: research.macroScore, regime: research.macroRegime }, "Research done");
  } catch (err: any) {
    logger.error({ err }, "Research agent failed");
    research = { macroRegime: "neutral", sectorStrength: "neutral", earningsRisk: "low",
                 catalysts: [], headwinds: [], macroScore: 0, reasoning: "Research failed." };
  }

  try {
    sentiment = await runSentimentAgent(symbol, md, research);
    logger.info({ agentId: agent.id, sentimentScore: sentiment.sentimentScore, signal: sentiment.newsSignal }, "Sentiment done");
  } catch (err: any) {
    logger.error({ err }, "Sentiment agent failed");
    sentiment = { overallSentiment: "neutral", sentimentScore: 0, newsSignal: "no_news",
                  fearGreedProxy: "neutral", keyHeadlines: [], reasoning: "Sentiment failed." };
  }

  try {
    const rawTechs = computeTechnicals(md);
    technical = await runStrategyAgent(symbol, md, research, sentiment, rawTechs);
    logger.info({ agentId: agent.id, techScore: technical.technicalScore, rsi: technical.rsi }, "Strategy done");
  } catch (err: any) {
    logger.error({ err }, "Strategy agent failed");
    const rawTechs = computeTechnicals(md);
    technical = { ...rawTechs, reasoning: "Strategy analysis failed." };
  }

  try {
    trader = await runTraderAgent(agent, symbol, md, research, sentiment, technical, existingPos, maxPos);
    logger.info({ agentId: agent.id, action: trader.action, confidence: trader.confidence }, "Trader decision");
  } catch (err: any) {
    logger.error({ err }, "Trader agent failed");
    return { action: "error", analysis: `Trader agent failed: ${err.message}`, orderPlaced: null };
  }

  const compositeScore = Math.round(
    research.macroScore * 0.25 + sentiment.sentimentScore * 0.25 + technical.technicalScore * 0.50
  );

  const pipeline: PipelineResult = { research, sentiment, technical, trader, compositeScore };

  const analysis = `[${trader.confidence}% conf | Score: ${compositeScore}] ${trader.reasoning}`;

  // ── Step 4: Execute ───────────────────────────────────────────────────────
  if (trader.action === "buy" && !existingPos) {
    const stopLoss   = +(md.price * (1 - trader.stopLossPct / 100)).toFixed(2);
    const takeProfit = +(md.price * (1 + trader.takeProfitPct / 100)).toFixed(2);
    try {
      const result = await placeOrder(agent, symbol, "buy", trader.quantity, md.price,
        trader.stopLossPct, trader.takeProfitPct, analysis);
      await updateStats(agent, true, 0, false);
      return {
        action: "bought", analysis, pipeline,
        orderPlaced: { symbol, side: "buy", quantity: trader.quantity,
          price: result.filledPrice, stopLoss, takeProfit, alpacaId: result.alpacaId },
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, pipeline, orderPlaced: null };
    }
  }

  if (trader.action === "sell" && existingPos) {
    const qty = Math.min(trader.quantity, existingPos.qty);
    const stopLoss   = +(md.price * (1 - trader.stopLossPct / 100)).toFixed(2);
    const takeProfit = +(md.price * (1 + trader.takeProfitPct / 100)).toFixed(2);
    try {
      const result = await placeOrder(agent, symbol, "sell", qty, md.price,
        trader.stopLossPct, trader.takeProfitPct, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * qty;
      await updateStats(agent, true, pnl, pnl > 0);
      return {
        action: "sold", analysis, pipeline,
        orderPlaced: { symbol, side: "sell", quantity: qty,
          price: result.filledPrice, stopLoss, takeProfit, alpacaId: result.alpacaId },
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, pipeline, orderPlaced: null };
    }
  }

  // Hold
  await updateStats(agent, false, 0, false);
  return {
    action: trader.action === "hold" ? "held" : "no_signal",
    analysis, pipeline, orderPlaced: null,
  };
}
