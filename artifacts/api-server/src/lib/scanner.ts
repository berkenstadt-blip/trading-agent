/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS DYNAMIC MARKET SCANNER v2
 *  Scans 150+ symbols across all sectors — no fixed watchlist.
 *  Finds the highest-conviction opportunities in real-time.
 *  Options-aware: flags high-IV + catalyst setups for options plays.
 * ═══════════════════════════════════════════════════════════════
 */

import * as alpaca from "./alpaca.js";
import { getSimulatedQuote } from "./market-data.js";
import {
  rsi, macd, bollingerBands, volumeRatio, emaArray, detectTrend,
  atr, detectCandlePatterns, stochastic, williamsR, obv, vwap,
  compositeSignalScore,
} from "./indicators.js";
import { logger } from "./logger.js";

// ─── Dynamic Universe — 150+ symbols across all sectors ──────

export const MARKET_UNIVERSE: Record<string, string[]> = {
  // Mega-cap tech & AI (highest options liquidity)
  tech: ["AAPL", "MSFT", "NVDA", "META", "GOOGL", "AMZN", "TSLA", "AMD", "INTC", "QCOM",
         "ORCL", "CRM", "ADBE", "NOW", "SNOW", "PLTR", "UBER", "LYFT", "SHOP", "NET"],
  // Semiconductors (high volatility, great options)
  semis: ["SMCI", "AVGO", "MU", "TSM", "AMAT", "LRCX", "KLAC", "MRVL", "ON", "TXN"],
  // ETFs with high options volume
  etfs: ["SPY", "QQQ", "IWM", "XLK", "SOXX", "ARKK", "GLD", "TLT", "SQQQ", "TQQQ"],
  // Financials (rate-sensitive, volatile)
  financials: ["JPM", "GS", "MS", "BAC", "C", "WFC", "BLK", "SCHW", "COIN", "HOOD"],
  // Healthcare & Biotech (high IV around FDA events)
  biotech: ["MRNA", "BNTX", "BIIB", "GILD", "REGN", "VRTX", "LLY", "PFE", "ABBV", "BMY"],
  // Energy (oil/gas volatile plays)
  energy: ["XOM", "CVX", "OXY", "COP", "SLB", "HAL", "MPC", "VLO", "DVN", "FANG"],
  // Consumer & Retail
  consumer: ["AMZN", "COST", "WMT", "TGT", "LULU", "NKE", "SBUX", "MCD", "DIS", "NFLX"],
  // High-momentum/meme potential (high options interest)
  momentum: ["MSTR", "RKLB", "IONQ", "QUBT", "RGTI", "BBAI", "AI", "SOUN", "BBIO", "ACHR"],
  // Macro/commodities
  macro: ["GLD", "SLV", "USO", "UNG", "DBA", "BITI", "BITO", "IBIT", "MARA", "RIOT"],
};

// Flattened universe, deduplicated
export const ALL_SYMBOLS: string[] = [
  ...new Set(Object.values(MARKET_UNIVERSE).flat()),
];

export interface SymbolScan {
  symbol: string;
  price: number;
  changePercent: number;
  rsi: number;
  macdSignal: "bullish" | "bearish" | "none";
  bbPercentB: number;
  trend: "uptrend" | "downtrend" | "sideways";
  volumeRatio: number;
  candlePattern: string;
  candleScore: number;
  ema9: number; ema21: number; ema50: number;
  atrPct: number;
  stochK: number;
  williamsR: number;
  vwapRelation: "above" | "below";
  technicalScore: number;
  direction: "long" | "short" | "none";
  grade: "A+" | "A" | "B" | "skip";
  gradingReasons: string[];
  // Options metadata
  approxIV: number;          // annualized IV from ATR
  optionsPotential: "high" | "medium" | "low"; // for options scanner
  sector: string;
}

async function buildSyntheticBars(symbol: string): Promise<{
  closes: number[]; highs: number[]; lows: number[]; volumes: number[]; opens: number[];
}> {
  const q = getSimulatedQuote(symbol);
  const bars = { closes: [] as number[], highs: [] as number[], lows: [] as number[], volumes: [] as number[], opens: [] as number[] };
  let p = q.previousClose;
  for (let i = 0; i < 60; i++) {
    p = Math.max(1, +(p * (1 + (Math.random() - 0.498) * 0.015)).toFixed(2));
    bars.closes.push(p);
    bars.highs.push(+(p * 1.006).toFixed(2));
    bars.lows.push(+(p * 0.994).toFixed(2));
    bars.volumes.push(q.volume + Math.floor(Math.random() * 500000));
    bars.opens.push(p);
  }
  bars.closes.push(q.price);
  bars.highs.push(Math.max(q.high, q.price));
  bars.lows.push(Math.min(q.low, q.price));
  bars.volumes.push(q.volume);
  bars.opens.push(q.open);
  return bars;
}

function getSector(symbol: string): string {
  for (const [sector, syms] of Object.entries(MARKET_UNIVERSE)) {
    if (syms.includes(symbol)) return sector;
  }
  return "other";
}

export async function scanSymbol(symbol: string): Promise<SymbolScan> {
  let price = 0, changePercent = 0;
  let bars = { closes: [] as number[], highs: [] as number[], lows: [] as number[], volumes: [] as number[], opens: [] as number[] };

  if (alpaca.isConfigured()) {
    try {
      const snap = await alpaca.getSnapshot(symbol);
      price = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
      const prev = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
      changePercent = prev > 0 ? +((price - prev) / prev * 100).toFixed(2) : 0;
    } catch { /* fall through */ }

    try {
      const rawBars = await alpaca.getDailyBars(symbol, 60);
      if (rawBars.length > 15) {
        bars = {
          closes:  rawBars.map(b => b.c),
          highs:   rawBars.map(b => b.h),
          lows:    rawBars.map(b => b.l),
          volumes: rawBars.map(b => b.v),
          opens:   rawBars.map(b => b.o),
        };
      }
    } catch { /* fall through */ }
  }

  if (price === 0) {
    const q = getSimulatedQuote(symbol);
    price = q.price;
    changePercent = q.changePercent;
  }

  if (bars.closes.length < 15) {
    bars = await buildSyntheticBars(symbol);
  }

  const { closes, highs, lows, volumes, opens } = bars;

  const rsiVal    = rsi(closes, 14);
  const macdRes   = macd(closes);
  const bb        = bollingerBands(closes, 20);
  const volR      = volumeRatio(volumes, 20);
  const trend     = detectTrend(closes, 20);
  const atrVal    = atr(highs, lows, closes, 14);
  const atrPct    = price > 0 ? +(atrVal / price * 100).toFixed(2) : 2;
  const candles   = detectCandlePatterns(opens, highs, lows, closes);
  const stoch     = stochastic(highs, lows, closes, 14, 3);
  const willR     = williamsR(highs, lows, closes, 14);
  const obvRes    = obv(closes, volumes);
  const vwapVal   = vwap(highs, lows, closes, volumes);
  const vwapRel: "above" | "below" = price >= vwapVal ? "above" : "below";

  const ema9Arr  = emaArray(closes, 9);
  const ema21Arr = emaArray(closes, 21);
  const ema50Arr = emaArray(closes, 50);
  const ema9Val  = ema9Arr[ema9Arr.length - 1] ?? price;
  const ema21Val = ema21Arr[ema21Arr.length - 1] ?? price;
  const ema50Val = ema50Arr[ema50Arr.length - 1] ?? price;

  const { score } = compositeSignalScore({
    rsiVal, macdHistogram: macdRes.histogram, macdCross: macdRes.crossover,
    bbPercentB: bb.percentB, ema9: ema9Val, ema21: ema21Val, ema50: ema50Val,
    price, volRatio: volR, changePercent, candleScore: candles.patternScore,
    obvTrend: obvRes.trend, stochK: stoch.k, williamsRVal: willR.value,
    ichimokuPriceVsCloud: price > ema50Val ? "above" : "below",
  });

  // Approximate IV from recent realized vol
  const approxIV = closes.length >= 10
    ? (() => {
        const ret = closes.slice(-20).slice(1).map((c, i) => Math.log(c / closes.slice(-20)[i]));
        const mean = ret.reduce((a, b) => a + b, 0) / ret.length;
        const variance = ret.reduce((a, b) => a + (b - mean) ** 2, 0) / ret.length;
        return Math.sqrt(variance * 252);
      })()
    : atrPct / 100 * Math.sqrt(252);

  // Options potential: high IV + liquid symbol = prime options candidate
  const isHighLiquid = ["SPY","QQQ","AAPL","MSFT","NVDA","TSLA","AMD","META","GOOGL","AMZN"].includes(symbol);
  const optionsPotential: SymbolScan["optionsPotential"] =
    approxIV > 0.50 ? "high" :
    approxIV > 0.30 || isHighLiquid ? "medium" : "low";

  const direction: SymbolScan["direction"] = score >= 20 ? "long" : score <= -20 ? "short" : "none";

  // ── Grading — more aggressive thresholds ──
  const reasons: string[] = [];
  let grade: SymbolScan["grade"] = "skip";

  const absScore = Math.abs(score);
  const hasVolumeConf = volR > 1.2;  // was 1.3 — more lenient
  const hasCandleConf = Math.abs(candles.patternScore) >= 20; // was 30
  const hasMacdConf   = macdRes.crossover !== "none";
  const hasRSIEdge    = rsiVal < 35 || rsiVal > 65; // oversold/overbought

  if (absScore >= 50 && hasVolumeConf && (hasCandleConf || hasMacdConf)) {
    grade = "A+";
    reasons.push(`Score ${score} | Vol ${volR.toFixed(1)}x | ${candles.detected.join(",") || "MACD"}`);
  } else if (absScore >= 35 && (hasVolumeConf || hasMacdConf)) {
    grade = "A";
    reasons.push(`Score ${score} | Vol ${volR.toFixed(1)}x | MACD:${macdRes.crossover}`);
  } else if (absScore >= 20 || hasRSIEdge) {
    grade = "B";
    reasons.push(`Score ${score} | RSI ${rsiVal.toFixed(0)}`);
  } else {
    grade = "skip";
    reasons.push(`Weak signal (${score})`);
  }

  // Disqualifiers — less strict for options plays
  if (price < 2) { grade = "skip"; reasons.push("Price too low (<$2)"); }
  if (atrPct > 12) { grade = "skip"; reasons.push("Too volatile (ATR > 12%)"); }
  if (Math.abs(changePercent) > 15) { grade = "skip"; reasons.push("Extreme move — avoid chasing"); }

  // Options-grade boost: high IV + good setup = upgrade B→A for options
  if (grade === "B" && optionsPotential === "high" && approxIV > 0.45) {
    grade = "A";
    reasons.push("Upgraded to A: high IV options opportunity");
  }

  return {
    symbol, price, changePercent, rsi: rsiVal,
    macdSignal: macdRes.crossover, bbPercentB: bb.percentB,
    trend, volumeRatio: volR,
    candlePattern: candles.detected.join(", ") || "none",
    candleScore: candles.patternScore,
    ema9: +ema9Val.toFixed(2), ema21: +ema21Val.toFixed(2), ema50: +ema50Val.toFixed(2),
    atrPct, stochK: stoch.k, williamsR: willR.value,
    vwapRelation: vwapRel, technicalScore: score,
    direction, grade, gradingReasons: reasons,
    approxIV: +approxIV.toFixed(4), optionsPotential, sector: getSector(symbol),
  };
}

export async function scanAllSymbols(symbols: string[]): Promise<SymbolScan[]> {
  // Scan in parallel batches of 20 to avoid rate limits
  const batchSize = 20;
  const all: SymbolScan[] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(s => scanSymbol(s)));
    for (const r of results) {
      if (r.status === "fulfilled") all.push(r.value);
    }
    // Small delay between batches to respect rate limits
    if (i + batchSize < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return all.sort((a, b) => Math.abs(b.technicalScore) - Math.abs(a.technicalScore));
}

export async function findBestOpportunity(
  symbols: string[],  // Now accepts dynamic universe or agent symbols
  existingPositions: string[] = [],
): Promise<SymbolScan | null> {
  // Always scan the full market universe + agent symbols
  const universe = [...new Set([...ALL_SYMBOLS, ...symbols])];

  // Limit to 80 symbols max per scan cycle for performance
  const toScan = universe.slice(0, 80);

  const scans = await scanAllSymbols(toScan);

  // Filter: no existing positions, direction clear, grade A or better
  const candidates = scans.filter(s =>
    !existingPositions.includes(s.symbol) &&
    s.direction !== "none" &&
    (s.grade === "A+" || s.grade === "A")
  );

  if (candidates.length === 0) {
    // Fallback: take best B-grade if options potential is high
    const bGrade = scans.filter(s =>
      !existingPositions.includes(s.symbol) &&
      s.grade === "B" &&
      s.optionsPotential === "high" &&
      s.direction !== "none"
    );
    if (bGrade.length > 0) {
      logger.info({ symbol: bGrade[0].symbol }, "Scanner: using B-grade options play");
      return bGrade[0];
    }
    logger.info({ scanned: scans.length }, "Scanner: no opportunities found");
    return null;
  }

  // Prefer A+ over A, then by absolute score, then by options potential
  const optScore = (s: SymbolScan) => s.optionsPotential === "high" ? 2 : s.optionsPotential === "medium" ? 1 : 0;
  const best = candidates.sort((a, b) => {
    const gradeScore = (g: string) => g === "A+" ? 3 : g === "A" ? 2 : 1;
    return (gradeScore(b.grade) - gradeScore(a.grade)) ||
           (optScore(b) - optScore(a)) ||
           (Math.abs(b.technicalScore) - Math.abs(a.technicalScore));
  })[0];

  logger.info({
    symbol: best.symbol, grade: best.grade, score: best.technicalScore,
    direction: best.direction, iv: best.approxIV, options: best.optionsPotential,
    candidates: candidates.length, scanned: scans.length,
  }, "Scanner: best opportunity found");

  return best;
}
