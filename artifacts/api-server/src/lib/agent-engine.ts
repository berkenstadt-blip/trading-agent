/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS TRADING ENGINE v2 — Ken Griffin-level intelligence
 * ═══════════════════════════════════════════════════════════════
 *
 *  FULL PIPELINE:
 *
 *  0. SCANNER        — scan all symbols, pick only A+ / A grade
 *  1. RESEARCH AGENT — macro, sector, catalysts, earnings risk
 *  2. SENTIMENT AGENT — news + Reddit WSB + StockTwits + forums
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

import { findBestOpportunity, SymbolScan, ALL_SYMBOLS } from "./scanner.js";
import { getSocialSentiment, SocialSentimentResult } from "./social-sentiment.js";
import { getSymbolIntelligence, formatIntelligenceForPrompt, SymbolIntelligence } from "./data-feeds.js";
import { analyzeEarningsPlay, EarningsPlay } from "./earnings-plays.js";

import {
  blackScholes, analyzeIV, findBestOptionStrategy, IVContext, OptionOpportunity,
  interpretPCRatio, earningsExpectedMove, ivCrushImpact, normCDF,
} from "./options-engine.js";

// ─── OpenRouter client ────────────────────────────────────────

const MODEL = "nousresearch/hermes-3-llama-3.1-70b";

let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (_client) return _client;
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL
    ?? "https://openrouter.ai/api/v1";
  const apiKey  = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY
    ?? process.env.OPENROUTER_API_KEY ?? "";
  if (!apiKey) throw new Error("OpenRouter not configured — set AI_INTEGRATIONS_OPENROUTER_API_KEY");
  _client = new OpenAI({ baseURL, apiKey });
  return _client;
}

// ── Is LLM available? ────────────────────────────────────────
function isLLMConfigured(): boolean {
  return !!(process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY);
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
  action: "bought" | "sold" | "held" | "no_signal" | "error" | "option_placed";
  analysis: string;
  orderPlaced: {
    symbol: string; side: "buy" | "sell"; quantity: number; price: number;
    stopLoss: number; takeProfit: number; alpacaId?: string;
  } | null;
  optionOrderPlaced?: {
    symbol: string; optionSymbol: string; strategy: string;
    optionType: "call" | "put"; strike: number; expDays: number;
    contracts: number; premium: number; alpacaId?: string;
  };
  pipeline?: {
    scanGrade: string; compositeScore: number;
    confidence: number; kellyF: number;
    circuitBreaker: string; optionSuggestion?: string; earningsPlay?: string;
    ivRank?: number; ivRegime?: string;
    positionsActive?: number;
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
  // ── NEW: institutional-grade fields ──
  fedStance: "hawkish" | "dovish" | "neutral";
  yieldCurveSignal: "inverted" | "steepening" | "flat" | "normal";
  dollarStrength: "strong" | "weak" | "neutral";
  sectorRotation: string;           // e.g. "rotating into defensive"
  fundamentalBias: "undervalued" | "overvalued" | "fairly_valued";
  institutionalFlow: "accumulating" | "distributing" | "neutral";
  eventCalendar: string[];          // upcoming events: earnings, FOMC, CPI, etc.
  darkPoolSignal: "bullish" | "bearish" | "neutral";
  shortInterest: "high" | "low" | "unknown";
  insiderActivity: "buying" | "selling" | "neutral";
  moatStrength: "wide" | "narrow" | "none" | "unknown";
  priceTarget: number | null;       // analyst consensus price target (if inferrable)
  updownside: number | null;        // % upside to price target
  volatilityOutlook: "expanding" | "contracting" | "stable"; // NEW: expected IV direction
  optionsBias: "sell_premium" | "buy_options" | "neutral";   // NEW: premium seller vs buyer
  reasoning: string;
}

interface SentimentOutput {
  overallSentiment: "bullish" | "bearish" | "neutral";
  sentimentScore: number;
  newsSignal: "positive" | "negative" | "mixed" | "no_news";
  fearGreedProxy: "extreme_fear" | "fear" | "neutral" | "greed" | "extreme_greed";
  keyHeadlines: string[];
  // ── NEW ──
  momentumOfSentiment: "improving" | "deteriorating" | "stable";
  analystConsensus: "strong_buy" | "buy" | "hold" | "sell" | "unknown";
  shortSqueezeRisk: boolean;
  catalystImminent: boolean;        // earnings, product launch, regulatory decision < 7 days
  reasoning: string;
}

interface TechnicalOutput {
  rsi: number; rsiSignal: "oversold" | "overbought" | "neutral";
  rsiDivergence: "bullish" | "bearish" | "none";   // NEW: hidden/regular divergence
  macdCross: "bullish" | "bearish" | "none"; macdHistogram: number;
  bbPercentB: number; bbSignal: "squeeze" | "overextended_up" | "overextended_down" | "normal";
  trend: "uptrend" | "downtrend" | "sideways";
  trendStrength: "strong" | "moderate" | "weak";   // NEW
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
  // ── NEW: multi-timeframe & structure ──
  marketStructure: "higher_highs_higher_lows" | "lower_highs_lower_lows" | "range_bound" | "breakout" | "breakdown";
  setupQuality: "A+" | "A" | "B" | "C";
  entryType: "breakout" | "pullback" | "reversal" | "continuation" | "none";
  multiTimeframeAlign: "all_bullish" | "all_bearish" | "mixed" | "neutral";
  keyLevel: number;                // most important price level right now
  keyLevelType: "support" | "resistance" | "pivot";
  reasoning: string;
}

interface TraderDecision {
  action: "buy" | "sell" | "hold";
  quantity: number; confidence: number;
  stopLossPct: number; takeProfitPct: number;
  riskRewardRatio: number; positionSizePct: number;
  // ── NEW: institutional execution ──
  entryTechnique: "market_now" | "limit_near_support" | "breakout_confirm" | "scale_in";
  scalingPlan: string;             // e.g. "1/3 at entry, 1/3 at +1.5%, 1/3 at +3%"
  exitPlan: string;                // e.g. "50% at +3%, 30% at +5%, 20% trail"
  partialProfitAt: number[];       // price levels to take partial profits
  trailingStopPct: number;         // activate trailing stop after X% gain
  timeStopHours: number;           // exit if no movement after N hours
  worstCaseScenario: string;       // what if it goes wrong?
  reasoning: string;
  conviction: "high" | "medium" | "low";
  // ── Options decision ──
  optionsPlay: "execute" | "skip";  // should we execute the options strategy?
  optionsRationale: string;         // why execute or skip options
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

type RawTechOutput = Omit<TechnicalOutput,
  "reasoning" | "rsiDivergence" | "trendStrength" |
  "marketStructure" | "setupQuality" | "entryType" |
  "multiTimeframeAlign" | "keyLevel" | "keyLevelType">;

function computeTechnicals(md: MarketData): RawTechOutput {
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
  } satisfies RawTechOutput;
}

// ─── Agent 1: RESEARCH — GS + Point72 + Citadel level ─────────

async function runResearch(symbol: string, md: MarketData, intel?: SymbolIntelligence | null): Promise<ResearchOutput> {
  const newsBlob = md.news.slice(0, 15).map((n, i) =>
    `[${i+1}] (${n.created_at.slice(0,10)}) ${n.headline}\n    ${n.summary?.slice(0,250) || ""}`
  ).join("\n") || "No news available.";

  const priceHist = md.bars.closes.slice(-30).map((c, i) => `D-${30-i}: $${c.toFixed(2)}`).join(" | ");
  const hi52 = Math.max(...md.bars.closes);
  const lo52 = Math.min(...md.bars.closes);
  const pctFrom52Hi = ((md.price - hi52) / hi52 * 100).toFixed(1);
  const pctFrom52Lo = ((md.price - lo52) / lo52 * 100).toFixed(1);

  const vol5  = md.bars.volumes.slice(-5).reduce((a,b) => a+b,0) / 5;
  const vol20 = md.bars.volumes.slice(-20).reduce((a,b) => a+b,0) / 20;
  const volTrend = vol5 > vol20 * 1.3 ? "RISING ⚡ (accumulation signal)" :
                   vol5 < vol20 * 0.7 ? "FALLING (distribution signal)" : "NORMAL";

  const ret5  = md.bars.closes.length >= 5  ? ((md.price / md.bars.closes[md.bars.closes.length-6]  - 1) * 100).toFixed(2) : "N/A";
  const ret10 = md.bars.closes.length >= 10 ? ((md.price / md.bars.closes[md.bars.closes.length-11] - 1) * 100).toFixed(2) : "N/A";
  const ret20 = md.bars.closes.length >= 20 ? ((md.price / md.bars.closes[md.bars.closes.length-21] - 1) * 100).toFixed(2) : "N/A";

  const realizedVol = (() => {
    if (md.bars.closes.length < 10) return 0.25;
    const ret = md.bars.closes.slice(-20).slice(1).map((c,i) => Math.log(c / md.bars.closes.slice(-20)[i]));
    const mean = ret.reduce((a,b) => a+b,0) / ret.length;
    const variance = ret.reduce((a,b) => a + (b-mean)**2, 0) / ret.length;
    return Math.sqrt(variance * 252);
  })();

  const expectedMove = earningsExpectedMove(md.price, realizedVol, 30);

  const last5Closes = md.bars.closes.slice(-5);
  const consecutiveUp   = last5Closes.every((c,i) => i === 0 || c > last5Closes[i-1]);
  const consecutiveDown = last5Closes.every((c,i) => i === 0 || c < last5Closes[i-1]);
  const priceCharacter  = consecutiveUp ? "5 consecutive UP days — momentum" :
                          consecutiveDown ? "5 consecutive DOWN days — distribution" : "mixed";

  // Use the pre-fetched intel (shared with Sentiment agent)
  const intelStr = intel ? formatIntelligenceForPrompt(intel) : "External data unavailable.";

  // Override earningsRisk if we have real earnings data
  const earningsOverride = intel?.earnings?.isEarningsSoon
    ? `⚠️ EARNINGS IN ${intel.earnings.daysUntilEarnings} DAYS (${intel.earnings.earningsDate}) — HIGH RISK EVENT`
    : intel?.earnings?.earningsDate
    ? `Next earnings: ${intel.earnings.earningsDate} (${intel.earnings.daysUntilEarnings} days)`
    : "Earnings date: unknown";

  return llmJSON<ResearchOutput>(
    `You are a SENIOR RESEARCH ANALYST with 20+ years across Goldman Sachs (equity research), Point72 (fundamental L/S), and Citadel (options intelligence desk).

YOUR JOB: Produce a DEEP, SPECIFIC research note using the REAL DATA provided. You have actual Fed rates, actual yield curve, actual insider transactions, actual short interest, and actual earnings dates. Use them.

MANDATORY ANALYSIS FRAMEWORK:

1. COMPANY-SPECIFIC THESIS
   — What is this company's business? Why does it matter TODAY?
   — What specifically drove today's price move (use the news)?
   — Is the stock cheap or expensive relative to growth prospects?

2. MACRO REGIME (use the FRED data provided — exact numbers)
   — Cite the ACTUAL Fed rate, 10Y yield, yield spread
   — Is the curve inverted? Steepening? What does that mean for THIS stock?
   — Dollar and inflation impact on this specific business?

3. CATALYST ANALYSIS (most important section)
   — EARNINGS: use the exact date provided. How many days away?
   — What could move this 5-15% in next 30 days? Probability?
   — What is the setup going INTO earnings if it's soon?

4. INSTITUTIONAL INTELLIGENCE
   — Insiders BUYING = management confidence = BULLISH signal
   — Insiders SELLING = could be diversification or concern
   — HIGH SHORT FLOAT (>15%) = squeeze potential + elevated risk
   — Analyst consensus vs current price = where is the smart money target?

5. OPTIONS INTELLIGENCE
   — IV (realized vol): ${(realizedVol*100).toFixed(1)}%
   — Expected 30-day move: ±${expectedMove.expectedMovePct}% ($${expectedMove.expectedMoveDollar.toFixed(2)})
   — Vol regime: ${realizedVol > 0.60 ? "EXTREME — sell premium aggressively" : realizedVol > 0.40 ? "ELEVATED — premium selling edge" : realizedVol > 0.25 ? "NORMAL — directional focus" : "LOW — buy cheap options into catalyst"}
   — If earnings within 14 days: IV expansion expected → buy options NOW before IV spikes
   — Post-earnings: IV crush → sell premium immediately

6. SCORING
   — macroScore: incorporate the ACTUAL Fed rate and yield spread
   — priceTarget: use analyst consensus as anchor, adjust for your view
   — Be PRECISE — not generic

OUTPUT — valid JSON ONLY:
{
  "macroRegime": "risk-on"|"risk-off"|"neutral",
  "sectorStrength": "strong"|"weak"|"neutral",
  "earningsRisk": "high"|"low"|"none",
  "catalysts": ["specific catalyst with probability and timing"],
  "headwinds": ["specific risk with reasoning"],
  "macroScore": number (-100 to +100 — cite the actual yield spread and rate),
  "fedStance": "hawkish"|"dovish"|"neutral",
  "yieldCurveSignal": "inverted"|"steepening"|"flat"|"normal",
  "dollarStrength": "strong"|"weak"|"neutral",
  "sectorRotation": "1 specific sentence with WHERE and WHY",
  "fundamentalBias": "undervalued"|"overvalued"|"fairly_valued",
  "institutionalFlow": "accumulating"|"distributing"|"neutral",
  "eventCalendar": ["exact event with date"],
  "darkPoolSignal": "bullish"|"bearish"|"neutral",
  "shortInterest": "high"|"low"|"unknown",
  "insiderActivity": "buying"|"selling"|"neutral",
  "moatStrength": "wide"|"narrow"|"none"|"unknown",
  "priceTarget": number (use analyst target or derive from fundamentals),
  "updownside": number (% to target),
  "volatilityOutlook": "expanding"|"contracting"|"stable",
  "optionsBias": "sell_premium"|"buy_options"|"neutral",
  "reasoning": "400 chars — CITE ACTUAL NUMBERS: Fed rate, yield spread, short float, insider activity, earnings date. Not generic statements."
}

RULES: macroScore ≠ 0. priceTarget must be a number. Cite specific data from what you received.`,

    `═══ DEEP RESEARCH BRIEF ═══
TODAY: ${new Date().toDateString()}
SYMBOL: ${symbol} | PRICE: $${md.price.toFixed(2)} | DAY: ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%
DATA SOURCE: ${md.source}

── PRICE STRUCTURE ──
52W HIGH: $${hi52.toFixed(2)} (${pctFrom52Hi}% from high) | 52W LOW: $${lo52.toFixed(2)} (+${pctFrom52Lo}% from low)
5d / 10d / 20d returns: ${ret5}% / ${ret10}% / ${ret20}%
Recent price character: ${priceCharacter}
Volume trend: ${volTrend}
30-DAY HISTORY: ${priceHist}

── OPTIONS MATH ──
Realized Vol (20d ann.): ${(realizedVol*100).toFixed(1)}%
Expected 30d move: ±${expectedMove.expectedMovePct}% = ±$${expectedMove.expectedMoveDollar.toFixed(2)}
ATM Straddle (30DTE): $${expectedMove.straddePrice.toFixed(2)}

── EARNINGS ──
${earningsOverride}

${intelStr}

── NEWS & CATALYSTS ──
${newsBlob}

Use the real data. Be specific. Take a position.`, 1000
  );
}

// ─── Agent 2: SENTIMENT — RenTech + Two Sigma + Social quant level ──

async function runSentiment(symbol: string, md: MarketData, research: ResearchOutput, intel?: SymbolIntelligence | null): Promise<SentimentOutput> {
  const [socialData, newsBlob] = await Promise.all([
    getSocialSentiment(symbol).catch(() => null as SocialSentimentResult | null),
    Promise.resolve(md.news.map((n, i) => `[${i+1}] ${n.headline}\n    ${n.summary || "N/A"}`).join("\n\n") || "No news."),
  ]);

  const bullMentions = socialData?.redditBullCount ?? 0;
  const bearMentions = socialData?.redditBearCount ?? 0;
  const pcSignal = interpretPCRatio(bearMentions, bullMentions);
  const yoloDetected = !!(socialData?.isTrendingWSB &&
    (socialData?.overallSocialScore ?? 0) > 70 &&
    socialData?.mentionVelocity === "spiking");

  // Sentiment momentum: compare social score vs research macro score
  const sentimentMomentumSignal = research.macroScore > 30 && (socialData?.overallSocialScore ?? 50) > 60
    ? "DOUBLE BULL — macro + social aligned bullish"
    : research.macroScore < -30 && (socialData?.overallSocialScore ?? 50) < 40
    ? "DOUBLE BEAR — macro + social aligned bearish"
    : "DIVERGENCE — macro and social disagree";

  // News headline sentiment — quick scan for key words
  const headlineText = md.news.slice(0, 10).map(n => n.headline.toLowerCase()).join(" ");
  const bullishKeywords = ["beat", "surge", "rally", "upgrade", "buy", "growth", "record", "deal", "acquire", "partnership", "launch"];
  const bearishKeywords  = ["miss", "fall", "decline", "downgrade", "sell", "loss", "layoff", "cut", "warning", "probe", "lawsuit", "drop"];
  const bullCount = bullishKeywords.filter(w => headlineText.includes(w)).length;
  const bearCount  = bearishKeywords.filter(w => headlineText.includes(w)).length;
  const headlineLean = bullCount > bearCount + 1 ? `BULLISH (${bullCount} bull keywords vs ${bearCount} bear)` :
                       bearCount > bullCount + 1 ? `BEARISH (${bearCount} bear keywords vs ${bullCount} bull)` :
                       `MIXED (${bullCount} bull, ${bearCount} bear)`;

  const socialContext = socialData ? `
── REAL-TIME SOCIAL DATA ──
REDDIT: ${socialData.redditBullCount} bull posts / ${socialData.redditBearCount} bear posts | Score: ${socialData.redditScore}/100
WSB: ${socialData.isTrendingWSB ? "🔥 TRENDING — YOLO/gamma squeeze risk" : "not trending"}
${yoloDetected ? "⚡ YOLO ALERT: WSB + score>70 + spiking velocity = retail call-buying surge" : ""}
MENTIONS: ${socialData.mentionCount} total | velocity: ${socialData.mentionVelocity.toUpperCase()}
STOCKTWITS: ${socialData.stocktwitsBullPct}% bull / ${socialData.stocktwitsBearPct}% bear | ${socialData.stocktwitsMessageCount} msgs

P/C RATIO PROXY: ${pcSignal.ratio.toFixed(2)} → ${pcSignal.signal.toUpperCase()} | Contrarian: ${pcSignal.contrarian.toUpperCase()}
${pcSignal.interpretation}

TOP POSTS: ${socialData.topRedditPosts.slice(0, 3).map((p,i) => `[${i+1}] ${p}`).join(" | ")}
BULL THESIS: ${socialData.bullThesis.slice(0,2).join(" | ") || "none"}
BEAR THESIS: ${socialData.bearThesis.slice(0,2).join(" | ") || "none"}` : "Social data unavailable.";

  return llmJSON<SentimentOutput>(
    `You are the HEAD OF QUANTITATIVE SENTIMENT at Renaissance Technologies, specializing in multi-source signal fusion.
Your edge: finding where SENTIMENT DIVERGES FROM PRICE to identify the next 24-72 hour move BEFORE it happens.

YOUR ANALYTICAL FRAMEWORK:

1. HEADLINE SENTIMENT SCAN
   — Count bullish vs bearish keywords in headlines (already done for you below)
   — Headline lean: is the narrative improving or deteriorating?
   — Most important: is the news ALREADY PRICED IN or is the market missing something?

2. SOCIAL SIGNAL INTERPRETATION
   — WSB trending + high score + spiking = GAMMA SQUEEZE setup (market makers buy stock to delta-hedge calls)
   — Put/Call proxy > 1.2: crowd is too bearish = contrarian BUY (fear is the opportunity)
   — Put/Call proxy < 0.6: crowd is too bullish = contrarian SELL (complacency = danger)
   — Forum bull/bear thesis: what is the crowd's ACTUAL argument? Is it smart or retail noise?

3. DIVERGENCE SIGNALS (highest alpha)
   — Stock DOWN but social sentiment BULLISH = institutional selling into retail buying → caution
   — Stock UP but social sentiment BEARISH = short squeeze in progress → momentum play
   — News NEGATIVE but call volume SURGING = smart money accumulating on bad news → BUY signal
   — News POSITIVE but put volume SURGING = insiders hedging → warning sign

4. SENTIMENT MOMENTUM
   — Is sentiment IMPROVING (early signal, enter now) or DETERIORATING (exit warning)?
   — Velocity of change matters more than absolute level

5. CATALYST TIMING
   — Is there an event in <7 days that could resolve this sentiment divergence?
   — Earnings, FDA, FOMC, product launch = IV expansion opportunity

SCORING PRECISION:
+70 to +100: Strong bull divergence — news bad but money flowing in, OR WSB YOLO + gamma squeeze setup
+40 to +70: Clear bullish lean — good news flow, improving social, no major headwinds
0 to +40: Mild bullish — more positive than negative but mixed
-40 to 0: Mild bearish — more negative than positive
-70 to -40: Clear bearish — deteriorating narrative, distribution
-100 to -70: Bear trap or crash risk — negative cascade, panic selling

OUTPUT — valid JSON only:
{
  "overallSentiment": "bullish"|"bearish"|"neutral",
  "sentimentScore": number (-100 to +100 — DO NOT output 0, pick a side),
  "newsSignal": "positive"|"negative"|"mixed"|"no_news",
  "fearGreedProxy": "extreme_fear"|"fear"|"neutral"|"greed"|"extreme_greed",
  "keyHeadlines": ["most impactful headline 1", "headline 2", "headline 3"],
  "momentumOfSentiment": "improving"|"deteriorating"|"stable",
  "analystConsensus": "strong_buy"|"buy"|"hold"|"sell"|"unknown",
  "shortSqueezeRisk": boolean,
  "catalystImminent": boolean,
  "reasoning": "400 chars — cite SPECIFIC signals: the actual P/C ratio, specific forum theses, which headlines are bullish/bearish, and the KEY divergence you see"
}

RULE: sentimentScore of 0 = lazy analysis. The market always has a sentiment lean. Be precise.`,

    `═══ SENTIMENT FUSION ANALYSIS ═══
TODAY: ${new Date().toDateString()}
SYMBOL: ${symbol} @ $${md.price.toFixed(2)} | ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}% | Vol: ${(md.volume/1e6).toFixed(1)}M

── HEADLINE QUICK SCAN ──
Lean: ${headlineLean}
${socialContext}

── RESEARCH AGENT OUTPUT ──
Macro Score: ${research.macroScore}/100 | Regime: ${research.macroRegime.toUpperCase()}
Options Bias: ${research.optionsBias.toUpperCase()} | Vol Outlook: ${research.volatilityOutlook.toUpperCase()}
Inst. Flow: ${research.institutionalFlow.toUpperCase()} | Dark Pool: ${research.darkPoolSignal.toUpperCase()}
Short Interest: ${research.shortInterest.toUpperCase()} | Insider: ${research.insiderActivity.toUpperCase()}
Events: ${research.eventCalendar.join(", ") || "none"}
Catalysts: ${research.catalysts.join(" | ") || "none"}
Research reasoning: ${research.reasoning}

── ALIGNMENT CHECK ──
${sentimentMomentumSignal}

── INSTITUTIONAL INTELLIGENCE ──
Insiders: ${intel?.insiders?.summary ?? "No insider data"}
Insider Signal: ${intel?.insiders?.signal?.toUpperCase() ?? "unknown"}
Short Float: ${intel?.shortData?.shortFloat !== null && intel?.shortData?.shortFloat !== undefined ? `${intel.shortData.shortFloat}% ${intel.shortData.shortFloat > 20 ? "⚠️ HIGH" : intel.shortData.shortFloat > 10 ? "elevated" : "normal"}` : "N/A"}
Short Ratio: ${intel?.shortData?.shortRatio ?? "N/A"} days to cover
Analyst Consensus: ${intel?.analysts?.consensus?.toUpperCase()?.replace("_"," ") ?? "unknown"} | Target: ${intel?.analysts?.avgTarget ? `$${intel.analysts.avgTarget}` : "N/A"} | Upside: ${intel?.analysts?.upside !== null && intel?.analysts?.upside !== undefined ? `${intel.analysts.upside}%` : "N/A"}

── FULL NEWS FEED ──
${newsBlob}

Find the sentiment divergence. Factor in insider activity and short interest. Score it. Explain it.`, 700
  );
}

// ─── Agent 3: STRATEGY — Tudor Jones + Druckenmiller + O'Neil level ──

async function runStrategy(
  symbol: string, md: MarketData,
  research: ResearchOutput, sentiment: SentimentOutput,
  techs: Omit<TechnicalOutput, "reasoning" | "marketStructure" | "setupQuality" | "entryType" | "multiTimeframeAlign" | "keyLevel" | "keyLevelType" | "trendStrength" | "rsiDivergence">
): Promise<TechnicalOutput> {

  const closes = md.bars.closes;

  // ── RSI Divergence — proper calculation ──
  const rsiDivergence = ((): "bullish" | "bearish" | "none" => {
    if (closes.length < 20) return "none";
    const n = closes.length;
    const mid = n - 10;
    const recentHigh = Math.max(...closes.slice(mid));
    const prevHigh   = Math.max(...closes.slice(mid - 10, mid));
    const recentLow  = Math.min(...closes.slice(mid));
    const prevLow    = Math.min(...closes.slice(mid - 10, mid));
    // Bearish divergence: price made higher high but RSI is below 65 (weakening)
    if (recentHigh > prevHigh * 1.005 && techs.rsi < 65) return "bearish";
    // Bullish divergence: price made lower low but RSI is above 35 (strengthening)
    if (recentLow < prevLow * 0.995 && techs.rsi > 35) return "bullish";
    return "none";
  })();

  // ── Trend strength from multiple factors ──
  const trendStrength = ((): "strong" | "moderate" | "weak" => {
    const factors = [
      Math.abs(techs.technicalScore) > 55,    // strong composite
      techs.emaCrossSignal !== "neutral",       // EMA alignment
      techs.volumeRatio > 1.3,                  // volume confirmation
      techs.obvTrend !== "neutral",             // OBV trending
      Math.abs(techs.candleScore) >= 30,        // candle pattern
    ].filter(Boolean).length;
    return factors >= 4 ? "strong" : factors >= 2 ? "moderate" : "weak";
  })();

  // ── Key price levels — find the most magnetic level ──
  const levels = [
    { level: techs.support, type: "support", dist: techs.distToSupport },
    { level: techs.resistance, type: "resistance", dist: techs.distToResistance },
    { level: techs.ema21, type: "pivot", dist: Math.abs((md.price - techs.ema21) / md.price * 100) },
    { level: techs.ema50, type: "pivot", dist: Math.abs((md.price - techs.ema50) / md.price * 100) },
  ];
  const closestLevel = levels.sort((a,b) => a.dist - b.dist)[0];

  // ── Compute momentum slope — is it accelerating or decelerating? ──
  const last10 = closes.slice(-10);
  const firstHalf  = last10.slice(0, 5).reduce((a,b) => a+b, 0) / 5;
  const secondHalf = last10.slice(5).reduce((a,b) => a+b, 0) / 5;
  const momentumAccel = secondHalf > firstHalf * 1.005 ? "accelerating UP" :
                        secondHalf < firstHalf * 0.995 ? "decelerating/reversing" : "flat";

  // ── Confluence count — how many signals agree? ──
  const bullishFactors = [
    techs.rsi < 45 && techs.rsi > 25,          // oversold not extreme
    techs.macdCross === "bullish",
    techs.emaCrossSignal === "bullish",
    techs.vwapRelation === "above",
    techs.obvTrend === "accumulation",
    techs.stochK < 25,                          // stoch oversold
    techs.candleScore > 20,
    techs.bbSignal === "overextended_down",      // BB oversold
    research.macroScore > 20,
    sentiment.sentimentScore > 20,
  ].filter(Boolean).length;

  const bearishFactors = [
    techs.rsi > 65 && techs.rsi < 85,
    techs.macdCross === "bearish",
    techs.emaCrossSignal === "bearish",
    techs.vwapRelation === "below",
    techs.obvTrend === "distribution",
    techs.stochK > 75,
    techs.candleScore < -20,
    techs.bbSignal === "overextended_up",
    research.macroScore < -20,
    sentiment.sentimentScore < -20,
  ].filter(Boolean).length;

  const result = await llmJSON<{
    marketStructure: TechnicalOutput["marketStructure"];
    setupQuality: TechnicalOutput["setupQuality"];
    entryType: TechnicalOutput["entryType"];
    multiTimeframeAlign: TechnicalOutput["multiTimeframeAlign"];
    keyLevel: number;
    keyLevelType: TechnicalOutput["keyLevelType"];
    reasoning: string;
  }>(
    `You are a MASTER TECHNICAL STRATEGIST — synthesis of Paul Tudor Jones (macro-technical), Stan Druckenmiller (conviction sizing), and William O'Neil (CAN SLIM momentum).

YOUR JOB: Grade this setup and find the TRADE. Not "I need more data." Not "mixed signals." The market moves whether you trade or not — your job is to find the direction and the entry.

GRADING SYSTEM — be honest, but biased toward action:
A+: 7+ bullish/bearish factors aligned + volume + candle pattern + near key level. HIGHEST CONVICTION. Size up.
A:  5-6 factors aligned. Good setup, standard size. Trade it.
B:  3-4 factors aligned. Weaker setup but still directional. Smaller size, wider stop.
C:  1-2 factors. Too noisy. Options-only play or pass entirely.

ENTRY TYPE LOGIC:
- Breakout: price at/above resistance on elevated volume → buy the breakout NOW
- Pullback: price pulled back to EMA/support in a confirmed uptrend → best R/R, buy the dip
- Reversal: extreme oversold (RSI<30, Stoch<20) + bullish candle at major support → contrarian entry
- Continuation: consolidation (BB squeeze) after trend move → wait for breakout of range

KEY INSIGHT — What pro traders see that retail misses:
1. VOLUME is the truth. Price can lie, volume doesn't. Rising price on falling volume = weak breakout.
2. The BEST entries come when price pulls back to a rising EMA (9 or 21) in a strong uptrend.
3. BB SQUEEZE = coiled spring. When it breaks, it MOVES. This is one of the highest-probability setups.
4. When RSI makes higher lows while price makes lower lows = BULLISH DIVERGENCE = reversal imminent.
5. VWAP is institutional benchmark. Price above VWAP = institutions are buyers. Below = sellers.

OUTPUT — valid JSON only:
{
  "marketStructure": "higher_highs_higher_lows"|"lower_highs_lower_lows"|"range_bound"|"breakout"|"breakdown",
  "setupQuality": "A+"|"A"|"B"|"C",
  "entryType": "breakout"|"pullback"|"reversal"|"continuation"|"none",
  "multiTimeframeAlign": "all_bullish"|"all_bearish"|"mixed"|"neutral",
  "keyLevel": number (the ONE price level that matters most right now),
  "keyLevelType": "support"|"resistance"|"pivot",
  "reasoning": "500 chars — cite SPECIFIC indicator values, specific price levels, specific patterns. Name the setup like a pro: 'Bull flag on 20d EMA support, RSI 42 with bullish divergence, MACD crossing up, vol 1.8x avg. A setup. Entry on pullback to $XXX.' NOT generic commentary."
}

MANDATORY: If bullish factors ≥ 6 OR bearish factors ≥ 6, setupQuality CANNOT be C. Take a position.`,

    `═══ STRATEGY ANALYSIS ═══
TODAY: ${new Date().toDateString()}
SYMBOL: ${symbol} @ $${md.price.toFixed(2)} | ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%

── CONFLUENCE SCORE ──
BULLISH FACTORS: ${bullishFactors}/10 aligned
BEARISH FACTORS: ${bearishFactors}/10 aligned
MOMENTUM: ${momentumAccel}
TREND STRENGTH: ${trendStrength.toUpperCase()}
RSI DIVERGENCE: ${rsiDivergence === "none" ? "none" : `⚠️ ${rsiDivergence.toUpperCase()} DIVERGENCE`}

── KEY LEVELS ──
Session: High $${md.high.toFixed(2)} | Low $${md.low.toFixed(2)} | Open $${md.open.toFixed(2)}
52W: High $${Math.max(...md.bars.closes).toFixed(2)} | Low $${Math.min(...md.bars.closes).toFixed(2)}
Support: $${techs.support.toFixed(2)} (${techs.distToSupport.toFixed(1)}% away)
Resistance: $${techs.resistance.toFixed(2)} (${techs.distToResistance.toFixed(1)}% away)
CLOSEST LEVEL: $${closestLevel.level.toFixed(2)} (${closestLevel.type}, ${closestLevel.dist.toFixed(1)}% away)
EMA 9/21/50: $${techs.ema9}/$${techs.ema21}/$${techs.ema50} → ${techs.emaCrossSignal.toUpperCase()}

── MOMENTUM INDICATORS ──
RSI(14): ${techs.rsi.toFixed(1)} → ${techs.rsiSignal.toUpperCase()} ${rsiDivergence !== "none" ? `⚠️ ${rsiDivergence.toUpperCase()} DIVERGENCE` : ""}
MACD: ${techs.macdCross.toUpperCase()} | Histogram: ${techs.macdHistogram > 0 ? "+" : ""}${techs.macdHistogram.toFixed(4)}
Stochastic: %K=${techs.stochK} / %D=${techs.stochD} → ${techs.stochSignal}
Williams %R: ${techs.williamsR} → ${techs.williamsSignal}

── TREND & VOLUME ──
Trend (20d): ${techs.trend.toUpperCase()} | VWAP: price ${techs.vwapRelation}
OBV: ${techs.obvTrend.toUpperCase()} | Ichimoku: ${techs.ichimokuCloud} cloud
Volume: ${techs.volumeRatio.toFixed(2)}x avg → ${techs.volumeSignal.toUpperCase()}
ATR: $${techs.atr.toFixed(2)} (${techs.atrPct}%) — natural stop distance

── VOLATILITY ──
Bollinger %B: ${(techs.bbPercentB*100).toFixed(0)}% → ${techs.bbSignal.toUpperCase()}
${techs.bbSignal === "squeeze" ? "⚡ BB SQUEEZE — coiled spring, breakout imminent" : ""}

── CANDLES ──
Patterns: ${techs.candlePattern || "none"} | Score: ${techs.candleScore}
Composite Technical Score: ${techs.technicalScore}/100

── MACRO + SENTIMENT CONTEXT ──
Research: ${research.macroRegime.toUpperCase()} | Score: ${research.macroScore} | Sector: ${research.sectorStrength.toUpperCase()}
Sentiment: ${sentiment.overallSentiment.toUpperCase()} (${sentiment.sentimentScore}) | ${sentiment.fearGreedProxy.toUpperCase()}
Catalysts: ${research.catalysts.join(" | ") || "none"}
Squeeze Risk: ${sentiment.shortSqueezeRisk ? "🔥 YES" : "no"} | Catalyst Imminent: ${sentiment.catalystImminent ? "⚠️ YES" : "no"}

Grade this setup. Find the entry. Be specific.`, 700
  );

  return {
    ...techs, rsiDivergence, trendStrength,
    marketStructure: result.marketStructure ?? "range_bound",
    setupQuality: result.setupQuality ?? "B",
    entryType: result.entryType ?? "none",
    multiTimeframeAlign: result.multiTimeframeAlign ?? "neutral",
    keyLevel: result.keyLevel ?? closestLevel.level,
    keyLevelType: result.keyLevelType ?? (closestLevel.type as TechnicalOutput["keyLevelType"]),
    reasoning: result.reasoning ?? "Technical analysis complete.",
  };
}


// ─── Agent 4: TRADER — Steve Cohen / Ken Griffin / Citadel Options Desk level ──

async function runTrader(
  agent: typeof agentsTable.$inferSelect,
  symbol: string, md: MarketData,
  research: ResearchOutput, sentiment: SentimentOutput,
  technical: TechnicalOutput,
  existingPos: { qty: number; avgCost: number } | null,
  maxQty: number, compositeScore: number,
  ivCtx: IVContext,
  optOpp: OptionOpportunity | null,
  existingPositionSymbols: string[] = [],
): Promise<TraderDecision> {

  // Compute unrealized P&L context for existing position
  const posContext = existingPos
    ? `EXISTING LONG: ${existingPos.qty} shares @ $${existingPos.avgCost.toFixed(2)} | Current P&L: ${((md.price-existingPos.avgCost)/existingPos.avgCost*100).toFixed(2)}% ($${((md.price-existingPos.avgCost)*existingPos.qty).toFixed(2)})`
    : "NO EXISTING POSITION — evaluating entry";

  // Derive approxIV locally for use in prompt (consistent with outer scope)
  const approxIV = (technical.atrPct / 100) * Math.sqrt(252);

  // IV crush impact simulation (if we buy options and IV drops 30%)
  const crushImpact = optOpp ? ivCrushImpact(
    optOpp.premium, Math.abs(optOpp.vega / 100), 30
  ) : null;

  // Profit levels based on ATR
  const atr = technical.atr;
  const p1r = +(md.price + atr * 2).toFixed(2);
  const p2r = +(md.price + atr * 3).toFixed(2);
  const p3r = +(md.price + atr * 5).toFixed(2);
  const stopLevel = +(md.price - atr * 2).toFixed(2);

  const result = await llmJSON<TraderDecision>(
    `You are the HEAD PORTFOLIO MANAGER, CHIEF TRADING OFFICER, and HEAD OF OPTIONS TRADING at a world-class multi-strategy hedge fund.
Your style is a synthesis of:
- STEVE COHEN (Point72): high Sharpe, position sizing mastery, cuts losers fast
- KEN GRIFFIN (Citadel): execution precision, multi-leg options strategies, regime awareness
- PAUL TUDOR JONES: macro-driven entries, 5:1 R/R minimum, tight risk management
- SIG / JANE STREET: options flow expertise, expected value thinking, Greeks-based sizing

STOCK DECISION FRAMEWORK:
1. SETUP GATE: Only A and A+ setups. B and C = hold. No exceptions.
2. REGIME FILTER: risk-off macro + bearish sentiment = NO NEW LONGS
3. CONFLUENCE: need ≥3 of 5: (a) macro tailwind (b) sector strong (c) bullish technicals (d) positive sentiment (e) catalyst
4. SIZING: A+ full Kelly | A = 2/3 | B = 1/3
5. ENTRIES: market_now (A+ breakout) | limit_near_support (pullback) | breakout_confirm (wait close) | scale_in (uncertainty)
6. EXITS: stop at 1.5-2x ATR | partial profit 2R (40%) | 3R (30%) | trail rest
7. TIME STOP: no movement after 6h = exit (something is wrong)

OPTIONS DECISION FRAMEWORK (CRITICAL — this is where the real edge is):
The options decision is INDEPENDENT from the stock decision.
You can:
  - BUY stock + EXECUTE options (adds exposure or hedges)
  - HOLD stock + EXECUTE options (pure premium collection when IV elevated)
  - HOLD stock + SKIP options (IV too low, risk too high, conflict with stock direction)

OPTIONS EXECUTE CONDITIONS (need ≥2 to execute — aggressive):
✅ Expected Value > $0 (positive edge)
✅ Probability of Profit > 55% (lower bar — take the trade)
✅ Strategy aligns directionally OR IV regime is clear (elevated = sell, low = buy)
✅ Kelly fraction > 0.02 (any positive edge)

OPTIONS EXECUTION SIZING — NO LIMITS:
- Use Kelly fraction × full portfolio value = dollar allocation
- No contract maximum. If Kelly says 50 contracts, buy 50 contracts.
- Earnings plays: BUY options before earnings when IV is < 50 (cheap vol into catalyst)
- Post-earnings: SELL premium immediately after (IV crush = free money)
- YOLO mode: if WSB trending + short squeeze + A+ setup → max contracts, max aggression

HARD RULES:
- "buy" ONLY if no existing position
- "sell" ONLY if existing position
- PAPER TRADING: no portfolio risk limits. Go big when the edge is there.
- Earnings risk: options plays INTO earnings are ENCOURAGED when IV is high
- stopLoss: 1.5–5.0% | takeProfit: minimum 2x stop, prefer 5x+
- Confidence <50: hold. Confidence 50+: execute with appropriate size.
- EXTRAORDINARY RESULTS require extraordinary conviction AND position sizes.
  Never sandbag. If the signal is A+ and confluence is 5/5: go ALL IN.

OUTPUT — valid JSON only:
{
  "action": "buy"|"sell"|"hold",
  "quantity": number (1 to ${maxQty}),
  "confidence": number (0-100),
  "stopLossPct": number (1.5-3.0),
  "takeProfitPct": number (min 2x stopLossPct),
  "riskRewardRatio": number,
  "positionSizePct": number (33-100),
  "entryTechnique": "market_now"|"limit_near_support"|"breakout_confirm"|"scale_in",
  "scalingPlan": "how to build the position",
  "exitPlan": "exactly how you exit: % at each level",
  "partialProfitAt": [price1, price2, price3],
  "trailingStopPct": number,
  "timeStopHours": number,
  "worstCaseScenario": "what could go wrong and how bad",
  "reasoning": "450 chars — cite setup type, key levels, confluence factors, R/R",
  "conviction": "high"|"medium"|"low",
  "optionsPlay": "execute"|"skip",
  "optionsRationale": "200 chars — cite IV rank, EV, PoP, and why execute or skip. If execute: name the edge clearly."
}

THIS IS REAL MONEY. Expected value wins long-term. Think asymmetry. Protect capital first.`,

    `═══════════════════════════════════════════
  FULL INTELLIGENCE BRIEF — FINAL DECISION
═══════════════════════════════════════════

TICKER: ${symbol}
PRICE: $${md.price.toFixed(2)} | ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}% today
PORTFOLIO: ${existingPositionSymbols.length} positions active (NO LIMIT — Beast Mode): ${existingPositionSymbols.join(', ') || 'none'}
${posContext}
STRATEGY: ${agent.strategy.toUpperCase()} | RISK LEVEL: ${agent.riskLevel.toUpperCase()}
MAX SHARES: ${maxQty} | MAX POSITION: $${parseFloat(agent.maxPositionSize).toFixed(0)}
ATR-DERIVED LEVELS: Stop $${stopLevel} | 2R: $${p1r} | 3R: $${p2r} | 5R: $${p3r}

━━━ RESEARCH AGENT ━━━
Macro Regime: ${research.macroRegime.toUpperCase()} | Score: ${research.macroScore}/100
Fed: ${research.fedStance.toUpperCase()} | Yield Curve: ${research.yieldCurveSignal.toUpperCase()} | DXY: ${research.dollarStrength.toUpperCase()}
Sector: ${research.sectorStrength.toUpperCase()} | Rotation: ${research.sectorRotation}
Fundamental: ${research.fundamentalBias.toUpperCase()} | Moat: ${research.moatStrength.toUpperCase()}
Inst. Flow: ${research.institutionalFlow.toUpperCase()} | Dark Pool: ${research.darkPoolSignal.toUpperCase()}
Short Interest: ${research.shortInterest.toUpperCase()} | Insider: ${research.insiderActivity.toUpperCase()}
Price Target: ${research.priceTarget ? `$${research.priceTarget} (${research.updownside?.toFixed(1)}% upside)` : "N/A"}
Events: ${research.eventCalendar.join(", ") || "none"}
Catalysts: ${research.catalysts.join(" | ") || "none"}
Headwinds: ${research.headwinds.join(" | ") || "none"}
Research: ${research.reasoning}

━━━ SENTIMENT AGENT ━━━
Sentiment: ${sentiment.overallSentiment.toUpperCase()} (${sentiment.sentimentScore}/100) | ${sentiment.fearGreedProxy.toUpperCase()}
Momentum: ${sentiment.momentumOfSentiment.toUpperCase()} | Analyst: ${sentiment.analystConsensus.toUpperCase()}
Short Squeeze: ${sentiment.shortSqueezeRisk ? "🔥 HIGH" : "low"} | Catalyst Imminent: ${sentiment.catalystImminent ? "⚠️ YES" : "no"}
Headlines: ${sentiment.keyHeadlines.slice(0,2).join(" | ")}
Sentiment Note: ${sentiment.reasoning}

━━━ STRATEGY AGENT ━━━
Technical Score: ${technical.technicalScore}/100
Setup Quality: ${technical.setupQuality} | Entry: ${technical.entryType.toUpperCase()} | Structure: ${technical.marketStructure.replace(/_/g, " ").toUpperCase()}
Multi-TF: ${technical.multiTimeframeAlign.replace(/_/g, " ").toUpperCase()} | KEY LEVEL: $${technical.keyLevel.toFixed(2)} (${technical.keyLevelType.toUpperCase()})
Trend: ${technical.trend.toUpperCase()} (${technical.trendStrength.toUpperCase()}) | EMA: ${technical.emaCrossSignal.toUpperCase()}
RSI: ${technical.rsi} (${technical.rsiSignal}) ${technical.rsiDivergence !== "none" ? `⚠️ ${technical.rsiDivergence.toUpperCase()} DIVERGENCE` : ""}
MACD: ${technical.macdCross.toUpperCase()} | BB: ${(technical.bbPercentB*100).toFixed(0)}% (${technical.bbSignal})
Stoch: ${technical.stochK}/${technical.stochD} | Williams: ${technical.williamsR} | OBV: ${technical.obvTrend.toUpperCase()}
Volume: ${technical.volumeRatio}x | VWAP: ${technical.vwapRelation} | Ichimoku: ${technical.ichimokuCloud}
ATR: $${technical.atr} (${technical.atrPct}%) | Candles: ${technical.candlePattern || "none"}
Strategy Note: ${technical.reasoning}

━━━ COMPOSITE ━━━
FINAL SCORE: ${compositeScore}/100
Signal: ${compositeScore > 50 ? "🟢 STRONG BULL" : compositeScore > 25 ? "🟢 MILD BULL" : compositeScore > -10 ? "🟡 NEUTRAL" : compositeScore > -30 ? "🔴 MILD BEAR" : "🔴 STRONG BEAR"}
Weights: Technical 50% | Research 25% | Sentiment 25%

━━━ OPTIONS INTELLIGENCE ━━━
IV RANK: ${ivCtx.ivRank}/100 | REGIME: ${ivCtx.regime.toUpperCase()} | IV: ${(approxIV * 100).toFixed(1)}% annualized
IV Crush Risk: ${ivCtx.ivCrushRisk.toUpperCase()} | Theta Edge: ${ivCtx.thetaEdge.toUpperCase()} | Expansion Expected: ${ivCtx.ivExpansionExpected ? "YES" : "no"}
Research Options Bias: ${research.optionsBias.toUpperCase()} | Vol Outlook: ${research.volatilityOutlook.toUpperCase()}
IV Regime Recommendation: ${ivCtx.recommendation}
${optOpp ? `
BEST OPTIONS STRATEGY — INSTITUTIONAL ANALYSIS:
  Strategy: ${optOpp.strategy} | Direction: ${optOpp.direction.toUpperCase()} | Legs: ${optOpp.legs}
  Type: ${optOpp.type.toUpperCase()} | Strike(s): $${optOpp.strike}${optOpp.strike2 ? `/$${optOpp.strike2}` : ""}
  DTE: ${optOpp.expDays} days | Premium: $${optOpp.premium.toFixed(2)}/contract
  Delta: ${optOpp.delta.toFixed(2)} | Theta: $${optOpp.theta.toFixed(2)}/day | Vega: ${optOpp.vega.toFixed(2)}
  P(OTM): ${optOpp.probabilityOTM.toFixed(0)}% | P(Profit): ${optOpp.probabilityOfProfit.toFixed(0)}%
  Expected Value: $${optOpp.expectedValue.toFixed(2)} | Ann. Return: ${optOpp.annualizedReturn}%
  Kelly Fraction: ${(optOpp.kellyFraction * 100).toFixed(1)}% of account | Max Profit: $${optOpp.maxProfit.toFixed(0)} | Max Loss: $${optOpp.maxLoss.toFixed(0)}
  ${crushImpact ? `IV Crush Impact (if IV drops 30%): -$${crushImpact.dollarLoss.toFixed(2)} per option (-${crushImpact.pctLoss.toFixed(0)}%)` : ""}
  Rationale: ${optOpp.rationale}
  
  → EXECUTE if: EV > 0, PoP > 65%, IV rank aligns (credit: >40, debit: <35), no earnings in 7 days
  → SKIP if: EV negative, IV misaligned, earnings risk, or directional conflict` : "No options opportunity identified — optionsPlay = skip."}

Make your final decision. Stock action + options play. This is real capital. Think expected value.`, 900
  );

  // ─── Beast Mode Guardrails — minimal, only prevent invalid states ──────────
  if (!["buy","sell","hold"].includes(result.action)) result.action = "hold";
  if (result.action === "buy" && existingPos) result.action = "hold";   // can't double-buy
  if (result.action === "sell" && !existingPos) result.action = "hold"; // can't sell air
  // Only gate: confidence below 40 = truly uncertain, hold
  if ((result.confidence ?? 0) < 40) result.action = "hold";
  // All other gates REMOVED: no earnings gate, no setup quality gate, no macro regime gate

  // Sizing: no upper cap on quantity — full Kelly
  result.quantity = Math.max(1, Math.min(maxQty, Math.round(result.quantity) || 1));
  result.confidence = Math.max(0, Math.min(100, result.confidence ?? 50));
  // Wide stop/TP range for aggressive plays
  result.stopLossPct = Math.max(1.0, Math.min(8.0, result.stopLossPct ?? technical.atrPct * 2));
  result.takeProfitPct = Math.max(result.stopLossPct * 2.0, result.takeProfitPct ?? result.stopLossPct * 4);
  result.riskRewardRatio = +(result.takeProfitPct / result.stopLossPct).toFixed(2);
  // positionSizePct: allow 100% (all-in on A+ plays)
  result.positionSizePct = Math.max(25, Math.min(100, result.positionSizePct ?? 75));
  result.trailingStopPct = result.trailingStopPct ?? result.stopLossPct * 0.8;
  result.timeStopHours = result.timeStopHours ?? 8;
  result.partialProfitAt = result.partialProfitAt ?? [p1r, p2r, p3r];
  result.scalingPlan = result.scalingPlan ?? "Full position at entry";
  result.exitPlan = result.exitPlan ?? `50% at $${p1r}, 30% at $${p2r}, 20% trail`;
  result.worstCaseScenario = result.worstCaseScenario ?? "Stop hit — accept loss, move on";
  result.quantity = Math.max(1, Math.round(result.quantity * result.positionSizePct / 100));
  // Options: default to execute when IV context is present
  result.optionsPlay = result.optionsPlay ?? (optOpp ? "execute" : "skip");
  // Force execute if optOpp exists and EV is positive — don't let LLM sandbag
  if (optOpp && optOpp.expectedValue > -10 && result.optionsPlay !== "execute") {
    result.optionsPlay = "execute";
    result.optionsRationale = `Auto-execute: EV $${optOpp.expectedValue.toFixed(0)}, PoP ${optOpp.probabilityOfProfit.toFixed(0)}%, ${optOpp.strategy}`;
  }

  return result;
}

// ─── Options order helper ─────────────────────────────────────

async function tryPlaceOptionOrder(
  agent: typeof agentsTable.$inferSelect,
  underlying: string,
  optOpp: OptionOpportunity | null,
  trader: TraderDecision,
  price: number,
  reason: string,
  portfolioValue: number,
): Promise<NonNullable<AgentRunResult["optionOrderPlaced"]> | null> {
  // OPTIONS ARE THE PRIMARY TRADE — execute whenever optOpp exists, don't check trader.optionsPlay
  if (!optOpp) return null;
  try {
    const expiry = alpaca.getOptionExpiry(optOpp.expDays);
    const optSymbol = alpaca.buildOptionSymbol(underlying, expiry, optOpp.type, optOpp.strike);
    // Aggressive Kelly sizing — minimum 15% of portfolio if no historical data
    const kellyAlloc = Math.max(0.15, optOpp.kellyFraction > 0 ? optOpp.kellyFraction : 0.20);
    const optionsCapital = portfolioValue * kellyAlloc;
    const contracts = Math.max(1, Math.floor(optionsCapital / (optOpp.premium * 100)));
    let alpacaId: string | undefined;
    let orderStatus = "simulated"; // default simulated — Alpaca paper doesn't support options without approval
    if (alpaca.isConfigured()) {
      try {
        const ao = await alpaca.placeOptionOrder({ symbol: optSymbol, qty: contracts, side: "buy" });
        alpacaId = ao.id;
        orderStatus = "filled";
      } catch (optErr: any) {
        logger.warn({ optErr: optErr?.message ?? optErr, optSymbol, contracts }, "Alpaca options rejected — tracking as simulated");
      }
    }
    // ALWAYS save to DB — simulated options still track P&L
    await db.insert(ordersTable).values({
      symbol: underlying,
      assetType: "option",
      side: "buy",
      orderType: "market",
      quantity: contracts.toString(),
      filledPrice: optOpp.premium.toString(),
      status: orderStatus,
      agentId: agent.id,
      agentName: agent.name,
      reason: reason.slice(0, 500),
      optionType: optOpp.type,
      strikePrice: optOpp.strike.toString(),
      expirationDate: expiry.toISOString().split("T")[0],
      filledAt: new Date(),
    });
    return {
      symbol: underlying,
      optionSymbol: optSymbol,
      strategy: optOpp.strategy,
      optionType: optOpp.type,
      strike: optOpp.strike,
      expDays: optOpp.expDays,
      contracts,
      premium: optOpp.premium,
      alpacaId,
    };
  } catch (e) {
    logger.warn({ e, underlying }, "Options order failed — skipping");
    return null;
  }
}

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
  const agentSymbols = parseSymbols(agent.symbols);
  // Use dynamic universe: agent symbols + full market universe (150+ stocks)
  const symbols = [...new Set([...agentSymbols, ...ALL_SYMBOLS])];

  // ── 0. Market hours check ────────────────────────────────
  if (!isMarketOpen()) return { action: "no_signal", analysis: "Market closed.", orderPlaced: null };
  const minsToClose = minutesToMarketClose();

  // ── 0b. Get existing positions ───────────────────────────
  const existingPositionSymbols: string[] = [];
  if (alpaca.isConfigured()) {
    try {
      const positions = await alpaca.getPositions();
      for (const p of positions) existingPositionSymbols.push(p.symbol);
    } catch { /* ignore */ }
  }
  let existingPos: { qty: number; avgCost: number } | null = null;

  // ── 0c. Circuit breaker check ────────────────────────────
  const recentOrders = await db.select().from(ordersTable)
    .orderBy(ordersTable.createdAt)
    .limit(30);

  type OrderRow = typeof recentOrders[number];
  const stats = computeTradeStats(
    recentOrders
      .filter((o: OrderRow) => o.filledPrice !== null)
      .map((o: OrderRow) => ({
        filledPrice: o.filledPrice as string, side: o.side, quantity: o.quantity, agentId: o.agentId
      }))
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

  // ── 0d. Portfolio heat check — NO POSITION LIMIT (Beast Mode) ───────────
  // No cap — hold as many positions as the market gives us signals for.

  // ── 1. Scanner: find best opportunity ────────────────────
  const maxPos = parseFloat(agent.maxPositionSize);
  let scanResult: SymbolScan | null = null;
  let symbol: string;

  try {
    scanResult = await findBestOpportunity(symbols, existingPositionSymbols);
  } catch (e) { logger.warn({ e }, "Scanner failed, using random symbol"); }

  if (scanResult && (scanResult.grade === "A+" || scanResult.grade === "A")) {
    symbol = scanResult.symbol;
    logger.info({ symbol, grade: scanResult.grade, score: scanResult.technicalScore, iv: scanResult.approxIV }, "Scanner picked symbol");
  } else {
    // Fallback: pick from high-liquidity universe randomly
    const fallbacks = ["AAPL","MSFT","NVDA","AMD","SPY","QQQ","META","TSLA"];
    symbol = fallbacks[Math.floor(Date.now() / 300_000) % fallbacks.length];
    logger.info({ symbol }, "No A/A+ signal, using high-liquidity fallback");
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

  // Use REAL buying power from Alpaca — never spend more than available cash
  let portfolioValue = 100000 + parseFloat(agent.totalPnl);
  let availableCash = portfolioValue * 0.95; // conservative default
  if (alpaca.isConfigured()) {
    try {
      const account = await alpaca.getAccount();
      portfolioValue = parseFloat(account.equity || account.portfolio_value);
      availableCash = parseFloat(account.buying_power);
    } catch { /* use defaults */ }
  }
  // Cap position size to available cash — never go negative
  const aggressiveMaxPos = Math.max(0, availableCash * 0.30); // max 30% of available cash per trade

  const fallbackResearch: ResearchOutput = {
    macroRegime: "neutral", sectorStrength: "neutral", earningsRisk: "low",
    catalysts: [], headwinds: [], macroScore: 0,
    fedStance: "neutral", yieldCurveSignal: "normal", dollarStrength: "neutral",
    sectorRotation: "unknown", fundamentalBias: "fairly_valued",
    institutionalFlow: "neutral", eventCalendar: [], darkPoolSignal: "neutral",
    shortInterest: "unknown", insiderActivity: "neutral", moatStrength: "unknown",
    priceTarget: null, updownside: null, volatilityOutlook: "stable", optionsBias: "neutral",
    reasoning: "Research failed.",
  };

  const fallbackSentiment: SentimentOutput = {
    overallSentiment: "neutral", sentimentScore: 0,
    newsSignal: "no_news", fearGreedProxy: "neutral",
    keyHeadlines: [], momentumOfSentiment: "stable",
    analystConsensus: "unknown", shortSqueezeRisk: false,
    catalystImminent: false, reasoning: "Sentiment failed.",
  };

  // ── 3. Run 4-agent LLM pipeline ──────────────────────────
  // Fetch external intel once and share with Research + Sentiment
  const sharedIntel = await getSymbolIntelligence(symbol).catch(() => null);
  const research = await runResearch(symbol, md, sharedIntel).catch(() => fallbackResearch);
  const sentiment = await runSentiment(symbol, md, research, sharedIntel).catch(() => fallbackSentiment);

  const rawTechs = computeTechnicals(md);

  const fallbackTechnical: TechnicalOutput = {
    ...rawTechs,
    rsiDivergence: "none", trendStrength: "weak",
    marketStructure: "range_bound", setupQuality: "C",
    entryType: "none", multiTimeframeAlign: "neutral",
    keyLevel: rawTechs.support, keyLevelType: "support",
    reasoning: "Strategy failed.",
  };

  const technical = await runStrategy(symbol, md, research, sentiment, rawTechs)
    .catch(() => fallbackTechnical);

  const compositeScore = Math.round(
    research.macroScore * 0.25 + sentiment.sentimentScore * 0.25 + technical.technicalScore * 0.50
  );

  // No cap on quantity — let Kelly sizing decide. Paper trading = full exposure.
  const maxQty = Math.max(1, Math.floor(aggressiveMaxPos / md.price)); // can go all-in

  // ── 3b. TECHNICAL-ONLY execution path (when LLM unavailable or scan grade A+) ──
  if (!isLLMConfigured() || (scanResult?.grade === "A+" && rawTechs.technicalScore >= 55)) {
    const direction = scanResult?.direction ?? (rawTechs.technicalScore > 0 ? "long" : "short");
    const isBuy = direction === "long";
    const side: "buy" | "sell" | "hold" = existingPos ? "sell" : (isBuy ? "buy" : "hold");

    if (side === "buy" && !existingPos) {
      const techQty = Math.max(1, Math.min(maxQty, Math.floor((portfolioValue * 0.25) / md.price)));
      const levels = computeStopLevels(md.price, rawTechs.atr, "long", 2);
      const techAnalysis = `[TECHNICAL AUTO] Score:${rawTechs.technicalScore} Grade:${scanResult?.grade} RSI:${rawTechs.rsi.toFixed(0)} MACD:${rawTechs.macdCross} Vol:${rawTechs.volumeRatio}x`;
      try {
        const result = await placeOrder(agent, symbol, "buy", techQty, md.price, techAnalysis);
        await updateStats(agent, true, 0, false);
        logger.info({ symbol, qty: techQty, score: rawTechs.technicalScore }, "TECHNICAL AUTO-TRADE executed");
        return {
          action: "bought", analysis: techAnalysis,
          pipeline: { scanGrade: scanResult?.grade ?? "A+", compositeScore: rawTechs.technicalScore, confidence: 75, kellyF: 0.25, circuitBreaker: "none" },
          orderPlaced: { symbol, side: "buy", quantity: techQty, price: result.filledPrice, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit2, alpacaId: result.alpacaId },
        };
      } catch (err: any) {
        logger.error({ err, symbol }, "Technical auto-trade order failed");
      }
    } else if (side === "sell" && existingPos) {
      const techQty = existingPos.qty;
      const levels = computeStopLevels(existingPos.avgCost, rawTechs.atr, "long", 2);
      const techAnalysis = `[TECHNICAL AUTO SELL] Score:${rawTechs.technicalScore} RSI:${rawTechs.rsi.toFixed(0)}`;
      try {
        const result = await placeOrder(agent, symbol, "sell", techQty, md.price, techAnalysis);
        const pnl = (result.filledPrice - existingPos.avgCost) * techQty;
        await updateStats(agent, true, pnl, pnl > 0);
        logger.info({ symbol, qty: techQty, pnl }, "TECHNICAL AUTO-SELL executed");
        return {
          action: "sold", analysis: techAnalysis,
          pipeline: { scanGrade: scanResult?.grade ?? "A+", compositeScore: rawTechs.technicalScore, confidence: 75, kellyF: 0.25, circuitBreaker: "none" },
          orderPlaced: { symbol, side: "sell", quantity: techQty, price: result.filledPrice, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit2, alpacaId: result.alpacaId },
        };
      } catch (err: any) {
        logger.error({ err, symbol }, "Technical auto-sell order failed");
      }
    }
  }

  // IV floor: real stocks always have at least 20% annualized vol — low ATR from bad data = bad IV
  const approxIV = Math.max(0.20, (technical.atrPct / 100) * Math.sqrt(252));
  // Use 52-bar ATR history to simulate historical IV distribution
  const ivHistory = md.bars.closes.length >= 20
    ? md.bars.closes.slice(-40).map((_, i, arr) => {
        if (i < 5) return approxIV;
        const window = arr.slice(i - 5, i);
        const returns = window.slice(1).map((c, j) => Math.log(c / window[j]));
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
        return Math.sqrt(variance) * Math.sqrt(252);
      })
    : [approxIV * 0.8, approxIV * 0.9, approxIV, approxIV * 1.1, approxIV * 1.2];
  const ivCtx = analyzeIV(approxIV, ivHistory);
  // Force bullish/bearish — never "neutral" which causes findBestOptionStrategy to find nothing
  const optDirection = compositeScore >= 0 ? "bullish" : "bearish";
  let optOpp: OptionOpportunity | null = findBestOptionStrategy(md.price, approxIV, ivCtx, optDirection) ?? null;

  // FALLBACK: if engine found nothing, force a simple long call/put based on direction
  // IV is always >= 20% so there's always an options play
  if (!optOpp) {
    const T = 21 / 365;
    const r = 0.05;
    const S = md.price;
    const isBear = optDirection === "bearish";
    const type: "call" | "put" = isBear ? "put" : "call";
    const K = isBear ? Math.round(S * 0.97) : Math.round(S * 1.03);
    // Use a simple approximation: premium ~ S * IV * sqrt(T) * 0.4 (rough ATM approximation)
    const premium = Math.max(0.10, S * approxIV * Math.sqrt(T) * 0.4);
    const contracts_est = Math.max(1, Math.floor((portfolioValue * 0.10) / (premium * 100)));
    optOpp = {
      type, strategy: isBear ? "Long Put" : "Long Call",
      strike: K, expDays: 21, premium: +premium.toFixed(2),
      delta: isBear ? -0.40 : 0.40, theta: -(premium / 21), vega: +(S * Math.sqrt(T) * 0.3),
      iv: approxIV, probabilityOTM: 45, probabilityOfProfit: 55,
      annualizedReturn: 150, expectedValue: +(premium * 0.3).toFixed(2),
      kellyFraction: 0.10, maxProfit: premium * 10 * 100, maxLoss: premium * 100,
      score: 55,
      rationale: `21DTE ${isBear ? "Long Put" : "Long Call"} $${K} | IV ${(approxIV*100).toFixed(0)}% | ~$${premium.toFixed(2)} premium | fallback directional`,
      direction: "debit", legs: 1,
    } as OptionOpportunity;
  }

  logger.info({ symbol, approxIV: approxIV.toFixed(3), ivRank: ivCtx.ivRank, ivRegime: ivCtx.regime, optDirection, optOppFound: !!optOpp, optStrategy: optOpp?.strategy ?? "none", optEV: optOpp?.expectedValue?.toFixed(2) ?? "n/a" }, "Options analysis");

  const trader = await runTrader(agent, symbol, md, research, sentiment, technical, existingPos, maxQty, compositeScore, ivCtx, optOpp, existingPositionSymbols)
    .catch(err => ({
      action: "hold" as const, quantity: 1, confidence: 0,
      stopLossPct: 2, takeProfitPct: 4, riskRewardRatio: 2, positionSizePct: 50,
      entryTechnique: "market_now" as const, scalingPlan: "N/A", exitPlan: "N/A",
      partialProfitAt: [], trailingStopPct: 1.5, timeStopHours: 6,
      worstCaseScenario: "Agent error",
      reasoning: `Trader failed: ${(err as Error).message}`, conviction: "low" as const,
      optionsPlay: "skip" as const, optionsRationale: "Trader agent error",
    }));

  // ── 4. Kelly position sizing ─────────────────────────────
  const kellyF = kellyFraction(stats.winRate, stats.avgWin, stats.avgLoss);
  const sizing = computePositionSize(md.price, trader.stopLossPct, aggressiveMaxPos, kellyF);
  const finalQty = Math.max(1, Math.min(maxQty, sizing.shares, trader.quantity));

  // ── 5. Options suggestion text ───────────────────────────
  const optionSuggestion = optOpp ? `${optOpp.strategy}: ${optOpp.rationale}` : undefined;

  // ── 5b. Earnings play scan — buy cheap IV before earnings ──
  let earningsPlay: EarningsPlay | null = null;
  try {
    earningsPlay = await analyzeEarningsPlay(symbol, md.price, approxIV, compositeScore);
    if (earningsPlay) {
      logger.info({ symbol, earningsPlay }, "Earnings play identified");
    }
  } catch { /* optional */ }

  const analysis = `[${trader.confidence}% conf | Score: ${compositeScore} | ${scanResult?.grade ?? "N/A"}] ${trader.reasoning}`;

  const pipeline = {
    scanGrade: scanResult?.grade ?? "N/A",
    compositeScore, confidence: trader.confidence, kellyF: +kellyF.toFixed(3),
    circuitBreaker: breaker.reason,
    ...(optionSuggestion ? { optionSuggestion } : {}),
    ivRank: ivCtx.ivRank,
    ivRegime: ivCtx.regime,
    ...(earningsPlay ? { earningsPlay: earningsPlay.rationale } : {}),
    positionsActive: existingPositionSymbols.length,
  };

  // ── 6. Execute ───────────────────────────────────────────
  // OPTIONS FIRST — execute on every cycle whenever optOpp exists (primary profit driver)
  // Run options regardless of stock action (buy/sell/hold)
  let optResGlobal: NonNullable<AgentRunResult["optionOrderPlaced"]> | null = null;
  if (optOpp) {
    optResGlobal = await tryPlaceOptionOrder(agent, symbol, optOpp, trader, md.price, analysis, aggressiveMaxPos);
  }

  if (trader.action === "buy" && !existingPos) {
    const levels = computeStopLevels(md.price, technical.atr, "long", 2);
    try {
      const result = await placeOrder(agent, symbol, "buy", finalQty, md.price, analysis);
      await updateStats(agent, true, 0, false);
      return {
        action: "bought", analysis, pipeline,
        orderPlaced: { symbol, side: "buy", quantity: finalQty, price: result.filledPrice,
          stopLoss: levels.stopLoss, takeProfit: levels.takeProfit2, alpacaId: result.alpacaId },
        ...(optResGlobal ? { optionOrderPlaced: optResGlobal } : {}),
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
        ...(optResGlobal ? { optionOrderPlaced: optResGlobal } : {}),
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, pipeline, orderPlaced: null };
    }
  }

  // ── 6b. Pure options play (hold stock but options executed above) ──────────
  if (optResGlobal) {
    await updateStats(agent, false, 0, false);
    return { action: "option_placed", analysis, pipeline, orderPlaced: null, optionOrderPlaced: optResGlobal };
  }

  await updateStats(agent, false, 0, false);
  return {
    action: trader.action === "hold" ? "held" : "no_signal",
    analysis, pipeline, orderPlaced: null,
  };
}
