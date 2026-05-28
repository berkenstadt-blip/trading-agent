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

import {
  blackScholes, analyzeIV, findBestOptionStrategy, IVContext, OptionOpportunity,
  interpretPCRatio, earningsExpectedMove, ivCrushImpact, normCDF,
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
    circuitBreaker: string; optionSuggestion?: string;
    ivRank?: number; ivRegime?: string;
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

// ─── Agent 1: RESEARCH — Goldman Sachs / Citadel Options Desk level ──

async function runResearch(symbol: string, md: MarketData): Promise<ResearchOutput> {
  const newsBlob = md.news.slice(0, 10).map((n, i) => `[${i+1}] (${n.created_at.slice(0,10)}) ${n.headline}\n    ${n.summary?.slice(0,200) || ""}`).join("\n") || "No news.";
  const priceHist = md.bars.closes.slice(-20).map((c, i) => `D-${20-i}: $${c.toFixed(2)}`).join(" | ");
  const hi52 = Math.max(...md.bars.closes);
  const lo52 = Math.min(...md.bars.closes);
  const pctFrom52Hi = ((md.price - hi52) / hi52 * 100).toFixed(1);
  const pctFrom52Lo = ((md.price - lo52) / lo52 * 100).toFixed(1);
  const avgVol = md.bars.volumes.slice(-20).reduce((a,b)=>a+b,0)/20;
  const volSurge = md.volume > avgVol * 1.5 ? "ABOVE AVERAGE ⚡" : md.volume > avgVol * 0.8 ? "normal" : "BELOW AVERAGE";

  // Compute IV-derived options context to give Research agent real data
  const approxIV = (md.bars.closes.length >= 10)
    ? (() => {
        const ret = md.bars.closes.slice(-20).slice(1).map((c, i) => Math.log(c / md.bars.closes.slice(-20)[i]));
        const mean = ret.reduce((a,b) => a+b, 0) / ret.length;
        const variance = ret.reduce((a,b) => a + (b-mean)**2, 0) / ret.length;
        return Math.sqrt(variance * 252);
      })()
    : 0.25;
  const expectedMove = earningsExpectedMove(md.price, approxIV, 30);
  const ivNote = `Current IV (annualized): ${(approxIV * 100).toFixed(1)}% | 30-day expected move: ±${expectedMove.expectedMovePct}% ($${expectedMove.expectedMoveDollar.toFixed(2)})`;

  return llmJSON<ResearchOutput>(
    `You are a SENIOR EQUITY RESEARCH ANALYST at Goldman Sachs AND head of the OPTIONS INTELLIGENCE desk at Citadel.
You have 20 years covering equities, macro flows, AND institutional options positioning.

Your job: produce institutional-grade research that drives BOTH stock AND options decisions.

FRAMEWORKS (apply ALL):
1. MACRO REGIME: Fed policy, yield curve 2s10s, DXY, VIX regime, risk-on/off
2. SECTOR ROTATION: where institutional money is flowing (sector ETF flows, factor tilts)
3. FUNDAMENTAL QUALITY: P/E vs growth (PEG), FCF yield, buybacks, margin trajectory, balance sheet
4. INSTITUTIONAL SIGNALS: dark pool block prints, unusual options flow (calls/puts skew), 13F insider filings, short interest % float
5. EVENT CALENDAR: exact earnings date, FOMC, CPI, FDA, regulatory — anything that moves IV
6. OPTIONS-SPECIFIC INTELLIGENCE:
   - UNUSUAL OPTIONS FLOW: large call/put sweeps at unusual strikes = smart money positioning
   - IV REGIME: is implied volatility elevated vs historical? → sell premium; or low? → buy cheap options into catalyst
   - EARNINGS IV CRUSH: stock typically drops 30-50% IV after earnings → sell premium just before, or buy before the pop
   - SKEW: steep put skew = market hedging (fear), flat skew = complacency
   - OPEN INTEREST CONCENTRATION: heavy OI at certain strikes = "option pinning" — price gravitates to them
7. VOLATILITY OUTLOOK: expanding (pre-event, rising VIX) vs contracting (post-event, vol crush)
8. CATALYST SCORING: probability × magnitude = expected move in $

OPTIONS BIAS LOGIC:
- sell_premium: IV rank > 50, post-catalyst, stable macro, low event risk
- buy_options: IV rank < 35, catalyst imminent (<14 days), expanding uncertainty
- neutral: mixed signals, moderate IV, wait for clearer setup

OUTPUT: respond ONLY with valid JSON — no markdown:
{
  "macroRegime": "risk-on"|"risk-off"|"neutral",
  "sectorStrength": "strong"|"weak"|"neutral",
  "earningsRisk": "high"|"low"|"none",
  "catalysts": ["string x3 max"],
  "headwinds": ["string x3 max"],
  "macroScore": number (-100=extremely bearish, +100=extremely bullish),
  "fedStance": "hawkish"|"dovish"|"neutral",
  "yieldCurveSignal": "inverted"|"steepening"|"flat"|"normal",
  "dollarStrength": "strong"|"weak"|"neutral",
  "sectorRotation": "1 sentence on where money is rotating",
  "fundamentalBias": "undervalued"|"overvalued"|"fairly_valued",
  "institutionalFlow": "accumulating"|"distributing"|"neutral",
  "eventCalendar": ["string x3 max — events with estimated dates"],
  "darkPoolSignal": "bullish"|"bearish"|"neutral",
  "shortInterest": "high"|"low"|"unknown",
  "insiderActivity": "buying"|"selling"|"neutral",
  "moatStrength": "wide"|"narrow"|"none"|"unknown",
  "priceTarget": number or null,
  "updownside": number or null,
  "volatilityOutlook": "expanding"|"contracting"|"stable",
  "optionsBias": "sell_premium"|"buy_options"|"neutral",
  "reasoning": "400 chars max — cite specific macro signals, options flow anomalies, catalyst timing"
}

KEY: macroScore ±50 = strong conviction. Be precise. A mediocre analysis is worse than no analysis.`,

    `═══ RESEARCH & OPTIONS BRIEF ═══
SYMBOL: ${symbol}
PRICE: $${md.price.toFixed(2)} | DAY: ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%
52W HIGH: $${hi52.toFixed(2)} (${pctFrom52Hi}% from high) | 52W LOW: $${lo52.toFixed(2)} (+${pctFrom52Lo}% from low)
VOLUME: ${(md.volume/1e6).toFixed(2)}M — ${volSurge}
20-DAY PRICES: ${priceHist}
DATA SOURCE: ${md.source}

OPTIONS MATH (live):
${ivNote}
Straddle fair value (30DTE ATM): $${expectedMove.straddePrice.toFixed(2)} | Playable earnings move: ${expectedMove.playable ? "YES" : "no"}

MACRO CONTEXT:
- Fed: rates at 5.25-5.5%, "higher for longer", watching PCE/CPI
- Yield curve: 2s10s inverted (recession signal), steepening recently
- DXY: elevated ~104-106 (headwind for multinationals, tailwind for USD earners)
- VIX: ~15-18 (moderate, controlled risk appetite)
- SPX: AI/tech mega-caps driving index, narrow breadth, small-caps lagging
- Earnings: mixed results, guidance cautious, margin pressure from wages/energy

NEWS & CATALYSTS:
${newsBlob}

SECTOR CONTEXT:
- Tech/AI: strong momentum on AI infrastructure buildout (NVDA, MSFT, AMZN)
- Financials: NIM pressure, credit quality concerns, yield curve headwind
- Energy: volatile on OPEC+ decisions and China demand
- Healthcare: regulatory pipeline risk, M&A activity elevated
- Consumer: discretionary weak, staples defensive bid, Amazon taking share

Provide your institutional research + options bias output now.`, 900
  );
}

// ─── Agent 2: SENTIMENT — Renaissance/Two Sigma + Options Flow quant level ──

async function runSentiment(symbol: string, md: MarketData, research: ResearchOutput): Promise<SentimentOutput> {
  const [socialData, newsBlob] = await Promise.all([
    getSocialSentiment(symbol).catch(() => null as SocialSentimentResult | null),
    Promise.resolve(md.news.map((n, i) => `[${i+1}] ${n.headline}\n    ${n.summary || "N/A"}`).join("\n\n") || "No news."),
  ]);

  // Compute estimated P/C ratio from social data as a proxy
  const bullMentions = socialData?.redditBullCount ?? 0;
  const bearMentions = socialData?.redditBearCount ?? 0;
  const estimatedPCRatio = bullMentions > 0
    ? bearMentions / bullMentions  // bear posts / bull posts ≈ P/C proxy
    : 0.8;
  const pcSignal = interpretPCRatio(bearMentions, bullMentions);

  // YOLO detection: extreme bullish call buying on forums
  const yoloDetected = socialData?.isTrendingWSB &&
    (socialData?.overallSocialScore ?? 0) > 70 &&
    (socialData?.mentionVelocity === "spiking");

  // IV crush context for sentiment
  const approxIV = research.volatilityOutlook === "expanding" ? 0.40 : 0.25;
  const crush = ivCrushImpact(5.0, 0.04, 30);  // example: $5 option, vega 0.04, 30% IV drop

  const socialContext = socialData ? `
═══ REAL-TIME SOCIAL + OPTIONS SENTIMENT ═══
REDDIT: ${socialData.redditBullCount} bull posts / ${socialData.redditBearCount} bear posts | Score: ${socialData.redditScore}/100
WSB TRENDING: ${socialData.isTrendingWSB ? "🔥 YES — potential YOLO/gamma squeeze signal" : "not trending"}
${yoloDetected ? "⚡ YOLO ALERT: extreme WSB bullish + spiking mentions — retail call buying surge likely" : ""}
MENTION VELOCITY: ${socialData.mentionVelocity.toUpperCase()} (${socialData.mentionCount} total)
STOCKTWITS: ${socialData.stocktwitsBullPct}% bull / ${socialData.stocktwitsBearPct}% bear | ${socialData.stocktwitsMessageCount} msgs
SOCIAL SCORE: ${socialData.overallSocialScore}/100 → ${socialData.socialSignal.toUpperCase()}

PUT/CALL RATIO PROXY (social bear/bull ratio): ${pcSignal.ratio.toFixed(2)}
P/C Signal: ${pcSignal.signal.toUpperCase()} | Contrarian: ${pcSignal.contrarian.toUpperCase()}
Interpretation: ${pcSignal.interpretation}

TOP FORUM POSTS:
${socialData.topRedditPosts.slice(0, 5).map((p, i) => `[${i+1}] ${p}`).join("\n")}

BULL THESIS: ${socialData.bullThesis.slice(0, 3).map((t, i) => `[${i+1}] ${t}`).join(" | ") || "none"}
BEAR THESIS: ${socialData.bearThesis.slice(0, 3).map((t, i) => `[${i+1}] ${t}`).join(" | ") || "none"}` : "Social data unavailable.";

  return llmJSON<SentimentOutput>(
    `You are the HEAD OF QUANTITATIVE SENTIMENT RESEARCH at Renaissance Technologies + Two Sigma.
You process multi-source signals including news, social media, AND options market sentiment.

YOUR EDGE — you understand:
1. RETAIL FORUM SENTIMENT leads price by 24-72 hours on small/mid caps
2. YOLO CALL BUYING on WSB = potential gamma squeeze (market makers forced to buy stock as hedges)
3. PUT/CALL RATIO is the most powerful contrarian indicator:
   - P/C > 1.3: extreme fear, contrarian BUY signal, market likely bottoming
   - P/C < 0.5: extreme greed/euphoria, contrarian SELL signal, top forming
   - P/C 0.7-1.0: neutral, follow primary trend
4. OPTIONS FLOW DIVERGENCE: bearish stock news + heavy call buying = institutional accumulation (bullish)
5. GAMMA SQUEEZE setup: high short interest + call buying surge + WSB trending = explosive upside potential
6. IV SENTIMENT: when retail buys OTM calls aggressively, IV spikes — premium sellers profit on the other side
7. SENTIMENT MOMENTUM: improving sentiment = early entry signal; deteriorating = distribution warning
8. ANALYST CONSENSUS is LAGGING — weight it only 10%, weight social flow 40%, news 30%, options 20%

SCORING RUBRIC:
+80 to +100: Multi-signal convergence: WSB trending, P/C contrarian buy, positive news, analyst upgrades
+40 to +80: Clear positive bias, improving momentum, no major headwinds
-10 to +40: Mixed signals, wait for resolution
-40 to -10: Bearish lean, deteriorating narrative, options bearish
-100 to -40: Bear thesis dominant, negative cascade, put buying surge

OUTPUT — valid JSON only:
{
  "overallSentiment": "bullish"|"bearish"|"neutral",
  "sentimentScore": number (-100 to +100),
  "newsSignal": "positive"|"negative"|"mixed"|"no_news",
  "fearGreedProxy": "extreme_fear"|"fear"|"neutral"|"greed"|"extreme_greed",
  "keyHeadlines": ["top 3 impactful headlines"],
  "momentumOfSentiment": "improving"|"deteriorating"|"stable",
  "analystConsensus": "strong_buy"|"buy"|"hold"|"sell"|"unknown",
  "shortSqueezeRisk": boolean,
  "catalystImminent": boolean,
  "reasoning": "400 chars max — cite P/C ratio, WSB signals, YOLO detection, options flow divergence, and what it means"
}

shortSqueezeRisk = true if: high SI + WSB trending + bullish velocity
catalystImminent = true if earnings <7 days or major event
YOLO/gamma squeeze = flag in fearGreedProxy as extreme_greed and sentimentScore > 70`,

    `═══ SENTIMENT + OPTIONS FLOW ANALYSIS ═══
SYMBOL: ${symbol} @ $${md.price.toFixed(2)}
TODAY: ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}% | Vol: ${(md.volume/1e6).toFixed(1)}M
${socialContext}

═══ RESEARCH AGENT BACKDROP ═══
Regime: ${research.macroRegime.toUpperCase()} | Score: ${research.macroScore}
Options Bias: ${research.optionsBias.toUpperCase()} | Vol Outlook: ${research.volatilityOutlook.toUpperCase()}
Fed: ${research.fedStance.toUpperCase()} | Sector: ${research.sectorStrength.toUpperCase()}
Inst. Flow: ${research.institutionalFlow.toUpperCase()} | Dark Pool: ${research.darkPoolSignal.toUpperCase()}
Short Interest: ${research.shortInterest.toUpperCase()} | Insider: ${research.insiderActivity.toUpperCase()}
Events: ${research.eventCalendar.join(", ") || "none"} | Catalysts: ${research.catalysts.join("; ") || "none"}

═══ NEWS FEED ═══
${newsBlob}

Synthesize ALL signals — especially P/C ratio proxy, YOLO detection, and options flow — into your sentiment output now.`, 650
  );
}

// ─── Agent 3: STRATEGY — Paul Tudor Jones / Stanley Druckenmiller level ──

async function runStrategy(
  symbol: string, md: MarketData,
  research: ResearchOutput, sentiment: SentimentOutput,
  techs: Omit<TechnicalOutput, "reasoning" | "marketStructure" | "setupQuality" | "entryType" | "multiTimeframeAlign" | "keyLevel" | "keyLevelType" | "trendStrength" | "rsiDivergence">
): Promise<TechnicalOutput> {

  // Detect RSI divergence: price trend vs RSI trend over last 10 bars
  const closes = md.bars.closes;
  const rsiDivergence = ((): "bullish" | "bearish" | "none" => {
    if (closes.length < 15) return "none";
    const mid = closes.length - 10;
    const priceRising = closes[closes.length-1] > closes[mid];
    const rsiNow = techs.rsi;
    // Approximate: if price made new high but RSI < 65 = bearish divergence
    // If price made new low but RSI > 35 = bullish divergence
    if (priceRising && rsiNow < 60 && md.changePercent > 1) return "bearish";
    if (!priceRising && rsiNow > 40 && md.changePercent < -1) return "bullish";
    return "none";
  })();

  // Trend strength
  const trendStrength = ((): "strong" | "moderate" | "weak" => {
    const abs = Math.abs(techs.technicalScore);
    return abs > 60 ? "strong" : abs > 30 ? "moderate" : "weak";
  })();

  const result = await llmJSON<{
    marketStructure: TechnicalOutput["marketStructure"];
    setupQuality: TechnicalOutput["setupQuality"];
    entryType: TechnicalOutput["entryType"];
    multiTimeframeAlign: TechnicalOutput["multiTimeframeAlign"];
    keyLevel: number;
    keyLevelType: TechnicalOutput["keyLevelType"];
    reasoning: string;
  }>(
    `You are a WORLD-CLASS TECHNICAL STRATEGIST and PORTFOLIO MANAGER — the kind of analyst who works at Paul Tudor Jones' Tudor Investment Corp, Druckenmiller's Duquesne, or Soros Fund Management.

You combine technical analysis with macro regime awareness to identify HIGH-PROBABILITY trade setups with asymmetric risk/reward.

YOUR TECHNICAL FRAMEWORK:
1. MARKET STRUCTURE: Identify if price is making higher highs/lows (bull), lower highs/lows (bear), range-bound, or breaking out/down from consolidation
2. MULTI-TIMEFRAME: Weekly trend gives direction, daily gives structure, intraday (5m) gives entry. Only trade when ALL three align.
3. SETUP QUALITY GRADING:
   - A+: All indicators aligned + volume confirmation + candle pattern + near key level + macro tailwind + sentiment aligned
   - A: 5-6 factors aligned, minor disagreements
   - B: 3-4 factors, mixed signals, lower conviction
   - C: 1-2 factors, mostly noise, avoid
4. ENTRY TYPES:
   - Breakout: price clearing key resistance on high volume — momentum entries
   - Pullback: price pulling back to key support/EMA in an uptrend — best R/R
   - Reversal: oversold + bullish candle at major support — contrarian
   - Continuation: flag/pennant pattern, trend continuing after pause
5. KEY LEVEL: The SINGLE most important price level right now (strongest support/resistance). This is where the trade lives or dies.
6. RSI DIVERGENCE: hidden bullish divergence (price new low, RSI higher low) = trend continuation signal in uptrend. Regular bearish divergence (price new high, RSI lower high) = warning.

OUTPUT: respond ONLY with valid JSON:
{
  "marketStructure": "higher_highs_higher_lows"|"lower_highs_lower_lows"|"range_bound"|"breakout"|"breakdown",
  "setupQuality": "A+"|"A"|"B"|"C",
  "entryType": "breakout"|"pullback"|"reversal"|"continuation"|"none",
  "multiTimeframeAlign": "all_bullish"|"all_bearish"|"mixed"|"neutral",
  "keyLevel": number (most critical price level),
  "keyLevelType": "support"|"resistance"|"pivot",
  "reasoning": "string — 450 chars max — CITE SPECIFIC INDICATORS, price levels, and setup mechanics. Explain WHY this is or isn't a high-probability setup."
}

Be the strategist who finds the 1-2 setups per week that have 3:1 or better R/R. Most days = no trade.`,

    `═══ TECHNICAL STRATEGY BRIEF ═══
SYMBOL: ${symbol} @ $${md.price.toFixed(2)} | ${md.changePercent >= 0 ? "+" : ""}${md.changePercent.toFixed(2)}%

PRICE LEVELS:
Session High: $${md.high.toFixed(2)} | Session Low: $${md.low.toFixed(2)} | Open: $${md.open.toFixed(2)}
Support: $${techs.support.toFixed(2)} (${techs.distToSupport.toFixed(1)}% away) | Resistance: $${techs.resistance.toFixed(2)} (${techs.distToResistance.toFixed(1)}% away)
EMA 9/21/50: $${techs.ema9}/$${techs.ema21}/$${techs.ema50} → ${techs.emaCrossSignal.toUpperCase()} stack

MOMENTUM:
RSI(14): ${techs.rsi} → ${techs.rsiSignal.toUpperCase()} ${rsiDivergence !== "none" ? `⚠️ ${rsiDivergence.toUpperCase()} DIVERGENCE` : ""}
MACD: ${techs.macdCross.toUpperCase()} crossover | histogram ${techs.macdHistogram > 0 ? "+" : ""}${techs.macdHistogram}
Stochastic %K/%D: ${techs.stochK}/${techs.stochD} → ${techs.stochSignal.toUpperCase()}
Williams %R: ${techs.williamsR} → ${techs.williamsSignal.toUpperCase()}

TREND:
20-day trend: ${techs.trend.toUpperCase()} | Strength: ${trendStrength.toUpperCase()}
Ichimoku: price ${techs.ichimokuCloud} cloud
OBV: ${techs.obvTrend.toUpperCase()} | VWAP: price ${techs.vwapRelation} VWAP

VOLATILITY & VOLUME:
ATR(14): $${techs.atr} (${techs.atrPct}% of price) — this is your natural stop distance
Bollinger %B: ${(techs.bbPercentB*100).toFixed(0)}% → ${techs.bbSignal.toUpperCase()}
Volume: ${techs.volumeRatio}x avg → ${techs.volumeSignal.toUpperCase()}

CANDLESTICK PATTERNS: ${techs.candlePattern} (pattern score: ${techs.candleScore})
COMPOSITE TECHNICAL SCORE: ${techs.technicalScore}/100

CONTEXT:
Macro: ${research.macroRegime.toUpperCase()} | Macro Score: ${research.macroScore}
Sector: ${research.sectorStrength.toUpperCase()} | Rotation: ${research.sectorRotation}
Sentiment: ${sentiment.overallSentiment.toUpperCase()} (${sentiment.sentimentScore}) | ${sentiment.fearGreedProxy.toUpperCase()}
Catalyst Imminent: ${sentiment.catalystImminent ? "YES ⚠️" : "no"} | Short Squeeze Risk: ${sentiment.shortSqueezeRisk ? "YES 🔥" : "no"}

Identify the market structure, grade this setup, and specify the key level.`, 600
  );

  return {
    ...techs, rsiDivergence, trendStrength,
    marketStructure: result.marketStructure ?? "range_bound",
    setupQuality: result.setupQuality ?? "C",
    entryType: result.entryType ?? "none",
    multiTimeframeAlign: result.multiTimeframeAlign ?? "neutral",
    keyLevel: result.keyLevel ?? techs.support,
    keyLevelType: result.keyLevelType ?? "support",
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

OPTIONS EXECUTE CONDITIONS (need ≥3 to execute):
✅ IV rank > 40 (for credit) or < 35 (for debit — buying cheap)
✅ Expected Value > $0 (probability-weighted P&L is positive)
✅ Probability of Profit > 65%
✅ Strategy aligns with directional bias (don't sell calls on bullish stock)
✅ No earnings within 7 days (IV crush risk on credit, or unexpected catalyst for debit)
✅ Kelly fraction > 0.05 (strategy has positive expected edge)

OPTIONS EXECUTION SIZING (Greeks-based):
- Credit strategy: size so max loss = 1% of portfolio
- Debit strategy: size so max loss = 0.5% of portfolio (debit = defined risk but theta works against you)
- Iron Condor: size so max loss = 1.5% of portfolio (higher probability, lower per-loss)
- Never exceed 5 contracts on a single options position

HARD RULES (non-negotiable):
- "buy" ONLY if no existing position
- "sell" ONLY if existing position  
- Never risk >2% portfolio on any single stock trade
- Earnings within 5 days: NO new stock entry (but credit options INTO earnings = valid if IV rank > 70)
- stopLoss: 1.5–3.0% | takeProfit: min 2x stop
- Confidence <60: hold on stock, but options may still execute if IV edge is clear

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

  // ─── Hard guardrails ───────────────────────────────────────
  if (!["buy","sell","hold"].includes(result.action)) result.action = "hold";
  if (result.action === "buy" && existingPos) result.action = "hold";
  if (result.action === "sell" && !existingPos) result.action = "hold";
  // Earnings within 5 days = no new entries
  if (research.earningsRisk === "high" && !existingPos) result.action = "hold";
  // Need A or A+ setup to trade
  if (technical.setupQuality === "C" && result.action !== "hold") result.action = "hold";
  // Confidence gate
  if ((result.confidence ?? 0) < 60) result.action = "hold";
  // Macro risk-off + bearish sentiment = no new longs
  if (research.macroRegime === "risk-off" && sentiment.overallSentiment === "bearish" && result.action === "buy") result.action = "hold";

  result.quantity = Math.max(1, Math.min(maxQty, Math.round(result.quantity) || 1));
  result.confidence = Math.max(0, Math.min(100, result.confidence ?? 50));
  result.stopLossPct = Math.max(1.5, Math.min(3.0, result.stopLossPct ?? technical.atrPct * 1.5));
  result.takeProfitPct = Math.max(result.stopLossPct * 2.0, result.takeProfitPct ?? result.stopLossPct * 2.5);
  result.riskRewardRatio = +(result.takeProfitPct / result.stopLossPct).toFixed(2);
  result.positionSizePct = Math.max(33, Math.min(100, result.positionSizePct ?? 50));
  result.trailingStopPct = result.trailingStopPct ?? result.stopLossPct * 0.8;
  result.timeStopHours = result.timeStopHours ?? 6;
  result.partialProfitAt = result.partialProfitAt ?? [p1r, p2r, p3r];
  result.scalingPlan = result.scalingPlan ?? "Full position at entry";
  result.exitPlan = result.exitPlan ?? `40% at $${p1r}, 30% at $${p2r}, 30% trail`;
  result.worstCaseScenario = result.worstCaseScenario ?? "Stop hit at 2 ATR below entry";
  result.quantity = Math.max(1, Math.round(result.quantity * result.positionSizePct / 100));
  result.optionsPlay = result.optionsPlay ?? "skip";
  result.optionsRationale = result.optionsRationale ?? (result.optionsPlay === "execute" ? "IV elevated, strategy aligned" : "Conditions not met for options");

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
): Promise<NonNullable<AgentRunResult["optionOrderPlaced"]> | null> {
  if (!optOpp || trader.optionsPlay !== "execute") return null;
  try {
    const expiry = alpaca.getOptionExpiry(optOpp.expDays);
    const optSymbol = alpaca.buildOptionSymbol(underlying, expiry, optOpp.type, optOpp.strike);
    const contracts = Math.max(1, Math.min(10, Math.floor(
      parseFloat(agent.maxPositionSize) / (optOpp.premium * 100 * 1.5)
    )));
    let alpacaId: string | undefined;
    if (alpaca.isConfigured()) {
      const ao = await alpaca.placeOptionOrder({ symbol: optSymbol, qty: contracts, side: "buy" });
      alpacaId = ao.id;
    }
    // Log to DB
    await db.insert(ordersTable).values({
      symbol: underlying,
      assetType: "option",
      side: "buy",
      orderType: "market",
      quantity: contracts.toString(),
      filledPrice: optOpp.premium.toString(),
      status: alpaca.isConfigured() ? "filled" : "simulated",
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
  let existingPos: { qty: number; avgCost: number } | null = null;

  // ── 0c. Circuit breaker check ────────────────────────────
  const recentOrders = await db.select().from(ordersTable)
    .orderBy(ordersTable.createdAt)
    .limit(30);

  type OrderRow = typeof recentOrders[number];
  const stats = computeTradeStats(
    recentOrders.map((o: OrderRow) => ({
      filledPrice: o.filledPrice, side: o.side, quantity: o.quantity, agentId: o.agentId
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

  // ── Aggressive position sizing — use more of the available capital ──
  // maxPos from agent settings, but boost it: deploy at least 15% of portfolio per trade
  const portfolioValue = 100000 + parseFloat(agent.totalPnl);
  const aggressiveMaxPos = Math.max(
    parseFloat(agent.maxPositionSize),
    portfolioValue * 0.15   // at least 15% per position
  );

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
  const research = await runResearch(symbol, md).catch(() => fallbackResearch);
  const sentiment = await runSentiment(symbol, md, research).catch(() => fallbackSentiment);

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

  const maxQty = Math.max(1, Math.floor(aggressiveMaxPos / md.price));

  // ── 4a. Compute IV context BEFORE Trader so it can factor in options ─────
  const approxIV = (technical.atrPct / 100) * Math.sqrt(252);
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
  const optDirection = compositeScore > 20 ? "bullish" : compositeScore < -20 ? "bearish" : "neutral";
  const optOpp: OptionOpportunity | null = findBestOptionStrategy(md.price, approxIV, ivCtx, optDirection) ?? null;

  const trader = await runTrader(agent, symbol, md, research, sentiment, technical, existingPos, maxQty, compositeScore, ivCtx, optOpp)
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

  const analysis = `[${trader.confidence}% conf | Score: ${compositeScore} | ${scanResult?.grade ?? "N/A"}] ${trader.reasoning}`;

  const pipeline = {
    scanGrade: scanResult?.grade ?? "N/A",
    compositeScore, confidence: trader.confidence, kellyF: +kellyF.toFixed(3),
    circuitBreaker: breaker.reason,
    ...(optionSuggestion ? { optionSuggestion } : {}),
    ivRank: ivCtx.ivRank,
    ivRegime: ivCtx.regime,
  };

  // ── 6. Execute ───────────────────────────────────────────
  if (trader.action === "buy" && !existingPos) {
    const levels = computeStopLevels(md.price, technical.atr, "long", 2);
    try {
      const result = await placeOrder(agent, symbol, "buy", finalQty, md.price, analysis);
      await updateStats(agent, true, 0, false);
      // Also execute options play if trader approved it
      const optRes = await tryPlaceOptionOrder(agent, symbol, optOpp, trader, md.price, analysis);
      return {
        action: "bought", analysis, pipeline,
        orderPlaced: { symbol, side: "buy", quantity: finalQty, price: result.filledPrice,
          stopLoss: levels.stopLoss, takeProfit: levels.takeProfit2, alpacaId: result.alpacaId },
        ...(optRes ? { optionOrderPlaced: optRes } : {}),
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

  // ── 6b. Pure options play (hold stock but execute option strategy) ───────
  if (trader.action === "hold" && trader.optionsPlay === "execute" && optOpp) {
    const optRes = await tryPlaceOptionOrder(agent, symbol, optOpp, trader, md.price, analysis);
    if (optRes) {
      await updateStats(agent, false, 0, false);
      return { action: "option_placed", analysis, pipeline, orderPlaced: null, optionOrderPlaced: optRes };
    }
  }

  await updateStats(agent, false, 0, false);
  return {
    action: trader.action === "hold" ? "held" : "no_signal",
    analysis, pipeline, orderPlaced: null,
  };
}
