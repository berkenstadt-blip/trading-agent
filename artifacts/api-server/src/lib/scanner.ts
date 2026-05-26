/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS SYMBOL SCANNER
 *  Scans all symbols in parallel, ranks by composite score,
 *  returns only A+ and A opportunities worth trading
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
}

async function buildSyntheticBars(symbol: string): Promise<{
  closes: number[]; highs: number[]; lows: number[]; volumes: number[]; opens: number[];
}> {
  // Fallback: generate synthetic bars from current quote
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

export async function scanSymbol(symbol: string): Promise<SymbolScan> {
  let price = 0, changePercent = 0;
  let bars = { closes: [] as number[], highs: [] as number[], lows: [] as number[], volumes: [] as number[], opens: [] as number[] };

  // Fetch live data
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

  // Compute all indicators
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

  const direction: SymbolScan["direction"] = score >= 25 ? "long" : score <= -25 ? "short" : "none";

  // Grading logic
  const reasons: string[] = [];
  let grade: SymbolScan["grade"] = "skip";

  const absScore = Math.abs(score);
  const hasVolumeConf = volR > 1.3;
  const hasCandleConf = Math.abs(candles.patternScore) >= 30;
  const hasMacdConf   = macdRes.crossover !== "none";

  if (absScore >= 55 && hasVolumeConf && (hasCandleConf || hasMacdConf)) {
    grade = "A+";
    reasons.push(`Score ${score} | Vol ${volR}x | ${candles.detected.join(",") || "MACD cross"}`);
  } else if (absScore >= 40 && hasVolumeConf) {
    grade = "A";
    reasons.push(`Score ${score} | Vol ${volR}x`);
  } else if (absScore >= 25) {
    grade = "B";
    reasons.push(`Score ${score}`);
  } else {
    grade = "skip";
    reasons.push(`Score too low (${score})`);
  }

  // Disqualifiers
  if (atrPct > 5) { grade = "skip"; reasons.push("Too volatile (ATR > 5%)"); }
  if (Math.abs(changePercent) > 8) { grade = "skip"; reasons.push("Extreme daily move — avoid chasing"); }

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
  };
}

export async function scanAllSymbols(symbols: string[]): Promise<SymbolScan[]> {
  const results = await Promise.allSettled(symbols.map(s => scanSymbol(s)));
  const scans: SymbolScan[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") scans.push(r.value);
  }
  // Sort by absolute score descending
  return scans.sort((a, b) => Math.abs(b.technicalScore) - Math.abs(a.technicalScore));
}

export async function findBestOpportunity(
  symbols: string[],
  existingPositions: string[] = [],
): Promise<SymbolScan | null> {
  const scans = await scanAllSymbols(symbols);

  // Filter: no existing positions, direction clear, grade A or better
  const candidates = scans.filter(s =>
    !existingPositions.includes(s.symbol) &&
    s.direction !== "none" &&
    (s.grade === "A+" || s.grade === "A")
  );

  if (candidates.length === 0) {
    logger.info({ scanned: scans.length }, "Scanner: no A/A+ opportunities found");
    return null;
  }

  // Prefer A+ over A, then by score
  const best = candidates.sort((a, b) => {
    const gradeScore = (g: string) => g === "A+" ? 2 : g === "A" ? 1 : 0;
    return gradeScore(b.grade) - gradeScore(a.grade) ||
           Math.abs(b.technicalScore) - Math.abs(a.technicalScore);
  })[0];

  logger.info({
    symbol: best.symbol, grade: best.grade, score: best.technicalScore,
    direction: best.direction, candidates: candidates.length,
  }, "Scanner: best opportunity found");

  return best;
}
