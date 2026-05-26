/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS INDICATORS — Professional-grade technical analysis
 *  Pure math, zero dependencies, fully typed
 * ═══════════════════════════════════════════════════════════════
 */

// ─── Moving Averages ──────────────────────────────────────────

export function emaArray(values: number[], period: number): number[] {
  if (values.length < period) return values.map(() => NaN);
  const k = 2 / (period + 1);
  const result: number[] = new Array(period - 1).fill(NaN);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function ema(values: number[], period: number): number {
  const arr = emaArray(values, period);
  return arr[arr.length - 1] ?? NaN;
}

export function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ─── RSI ─────────────────────────────────────────────────────

export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const initial = changes.slice(0, period);
  let avgGain = initial.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  let avgLoss = initial.filter(c => c < 0).map(c => -c).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + Math.max(0, changes[i])) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -changes[i])) / period;
  }
  if (avgLoss === 0) return 100;
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

// ─── MACD ────────────────────────────────────────────────────

export function macd(closes: number[]): {
  macdLine: number; signalLine: number; histogram: number;
  crossover: "bullish" | "bearish" | "none";
} {
  const empty = { macdLine: 0, signalLine: 0, histogram: 0, crossover: "none" as const };
  if (closes.length < 35) return empty;
  const e12 = emaArray(closes, 12);
  const e26 = emaArray(closes, 26);
  const macdLine = e12.map((v, i) => (isNaN(v) || isNaN(e26[i]) ? NaN : v - e26[i]));
  const valid = macdLine.filter(v => !isNaN(v));
  if (valid.length < 9) return empty;
  const signalArr = emaArray(valid, 9);
  const lm = valid[valid.length - 1], pm = valid[valid.length - 2];
  const ls = signalArr[signalArr.length - 1], ps = signalArr[signalArr.length - 2];
  let crossover: "bullish" | "bearish" | "none" = "none";
  if (pm !== undefined && ps !== undefined) {
    if (pm < ps && lm > ls) crossover = "bullish";
    else if (pm > ps && lm < ls) crossover = "bearish";
  }
  return { macdLine: +lm.toFixed(4), signalLine: +ls.toFixed(4), histogram: +(lm - ls).toFixed(4), crossover };
}

// ─── Bollinger Bands ─────────────────────────────────────────

export function bollingerBands(closes: number[], period = 20): {
  upper: number; middle: number; lower: number; bandwidth: number; percentB: number;
} {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0.5 };
  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((acc, v) => acc + (v - middle) ** 2, 0) / period);
  const upper = middle + 2 * std, lower = middle - 2 * std;
  const last = closes[closes.length - 1];
  return {
    upper: +upper.toFixed(4), middle: +middle.toFixed(4), lower: +lower.toFixed(4),
    bandwidth: middle > 0 ? +((upper - lower) / middle).toFixed(4) : 0,
    percentB: (upper - lower) > 0 ? +((last - lower) / (upper - lower)).toFixed(4) : 0.5,
  };
}

// ─── ATR ─────────────────────────────────────────────────────

export function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < 2) return closes[closes.length - 1] * 0.02;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    trs.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1])));
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / Math.min(period, trs.length);
}

// ─── Volume ───────────────────────────────────────────────────

export function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const avg = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  return avg > 0 ? +(volumes[volumes.length - 1] / avg).toFixed(2) : 1;
}

export function obv(closes: number[], volumes: number[]): {
  value: number; trend: "accumulation" | "distribution" | "neutral";
} {
  let val = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) val += volumes[i];
    else if (closes[i] < closes[i-1]) val -= volumes[i];
  }
  const recentObvs: number[] = [0];
  let running = 0;
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i-1]) running += volumes[i];
    else if (closes[i] < closes[i-1]) running -= volumes[i];
    recentObvs.push(running);
  }
  const last10 = recentObvs.slice(-10);
  const trend10 = last10[last10.length - 1] - last10[0];
  return {
    value: val,
    trend: trend10 > 0 ? "accumulation" : trend10 < 0 ? "distribution" : "neutral",
  };
}

// ─── VWAP ────────────────────────────────────────────────────

export function vwap(highs: number[], lows: number[], closes: number[], volumes: number[]): number {
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * volumes[i];
    cumVol += volumes[i];
  }
  return cumVol > 0 ? +(cumTPV / cumVol).toFixed(4) : closes[closes.length - 1];
}

// ─── Stochastic Oscillator ────────────────────────────────────

export function stochastic(highs: number[], lows: number[], closes: number[], kPeriod = 14, dPeriod = 3): {
  k: number; d: number; signal: "overbought" | "oversold" | "neutral";
} {
  if (closes.length < kPeriod) return { k: 50, d: 50, signal: "neutral" };
  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < closes.length; i++) {
    const slice_h = highs.slice(i - kPeriod + 1, i + 1);
    const slice_l = lows.slice(i - kPeriod + 1, i + 1);
    const hh = Math.max(...slice_h), ll = Math.min(...slice_l);
    kValues.push(hh !== ll ? ((closes[i] - ll) / (hh - ll)) * 100 : 50);
  }
  const k = kValues[kValues.length - 1];
  const dSlice = kValues.slice(-dPeriod);
  const d = dSlice.reduce((a, b) => a + b, 0) / dSlice.length;
  return {
    k: +k.toFixed(2), d: +d.toFixed(2),
    signal: k > 80 ? "overbought" : k < 20 ? "oversold" : "neutral",
  };
}

// ─── Williams %R ─────────────────────────────────────────────

export function williamsR(highs: number[], lows: number[], closes: number[], period = 14): {
  value: number; signal: "overbought" | "oversold" | "neutral";
} {
  if (closes.length < period) return { value: -50, signal: "neutral" };
  const hh = Math.max(...highs.slice(-period));
  const ll = Math.min(...lows.slice(-period));
  const last = closes[closes.length - 1];
  const val = hh !== ll ? ((hh - last) / (hh - ll)) * -100 : -50;
  return {
    value: +val.toFixed(2),
    signal: val > -20 ? "overbought" : val < -80 ? "oversold" : "neutral",
  };
}

// ─── Ichimoku Cloud ───────────────────────────────────────────

export function ichimoku(highs: number[], lows: number[], closes: number[]): {
  tenkan: number; kijun: number; senkouA: number; senkouB: number;
  chikouSignal: "above" | "below" | "neutral";
  priceVsCloud: "above" | "below" | "inside";
} {
  const midpoint = (h: number[], l: number[], period: number, offset = 0): number => {
    const sl = h.slice(-(period + offset), offset > 0 ? -offset : undefined);
    const sl2 = l.slice(-(period + offset), offset > 0 ? -offset : undefined);
    if (!sl.length) return closes[closes.length - 1];
    return (Math.max(...sl) + Math.min(...sl2)) / 2;
  };
  const tenkan = midpoint(highs, lows, 9);
  const kijun  = midpoint(highs, lows, 26);
  const senkouA = (tenkan + kijun) / 2;
  const senkouB = midpoint(highs, lows, 52);
  const last = closes[closes.length - 1];
  const chikou26 = closes[closes.length - 26] ?? closes[0];
  const chikouSignal = last > chikou26 ? "above" : last < chikou26 ? "below" : "neutral";
  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBot = Math.min(senkouA, senkouB);
  const priceVsCloud = last > cloudTop ? "above" : last < cloudBot ? "below" : "inside";
  return {
    tenkan: +tenkan.toFixed(4), kijun: +kijun.toFixed(4),
    senkouA: +senkouA.toFixed(4), senkouB: +senkouB.toFixed(4),
    chikouSignal, priceVsCloud,
  };
}

// ─── Candlestick Patterns ─────────────────────────────────────

export interface CandlePatternResult {
  hammer: boolean; invertedHammer: boolean;
  bullishEngulfing: boolean; bearishEngulfing: boolean;
  doji: boolean; shootingStar: boolean;
  morningStar: boolean; eveningStar: boolean;
  threeWhiteSoldiers: boolean; threeBlackCrows: boolean;
  patternSignal: "strong_bullish" | "bullish" | "bearish" | "strong_bearish" | "neutral";
  patternScore: number; // -100 to +100
  detected: string[];
}

export function detectCandlePatterns(
  opens: number[], highs: number[], lows: number[], closes: number[]
): CandlePatternResult {
  const n = closes.length;
  if (n < 3) return {
    hammer: false, invertedHammer: false, bullishEngulfing: false, bearishEngulfing: false,
    doji: false, shootingStar: false, morningStar: false, eveningStar: false,
    threeWhiteSoldiers: false, threeBlackCrows: false,
    patternSignal: "neutral", patternScore: 0, detected: [],
  };

  const o = opens, h = highs, l = lows, c = closes;
  const i = n - 1; // last candle
  const body    = (idx: number) => Math.abs(c[idx] - o[idx]);
  const range   = (idx: number) => h[idx] - l[idx];
  const isGreen = (idx: number) => c[idx] > o[idx];
  const isRed   = (idx: number) => c[idx] < o[idx];
  const upperShadow = (idx: number) => h[idx] - Math.max(o[idx], c[idx]);
  const lowerShadow = (idx: number) => Math.min(o[idx], c[idx]) - l[idx];

  // Hammer: small body at top, long lower shadow >= 2x body, tiny upper shadow
  const hammer = isRed(i-1) && lowerShadow(i) >= 2 * body(i) && upperShadow(i) <= 0.3 * body(i) && body(i) > 0;

  // Inverted Hammer: small body at bottom, long upper shadow
  const invertedHammer = isRed(i-1) && upperShadow(i) >= 2 * body(i) && lowerShadow(i) <= 0.3 * body(i) && body(i) > 0;

  // Bullish Engulfing
  const bullishEngulfing = isRed(i-1) && isGreen(i) && o[i] < c[i-1] && c[i] > o[i-1];

  // Bearish Engulfing
  const bearishEngulfing = isGreen(i-1) && isRed(i) && o[i] > c[i-1] && c[i] < o[i-1];

  // Doji: body < 10% of range
  const doji = range(i) > 0 && body(i) / range(i) < 0.1;

  // Shooting Star: green run then red candle with long upper shadow
  const shootingStar = isGreen(i-1) && upperShadow(i) >= 2 * body(i) && lowerShadow(i) <= 0.3 * body(i);

  // Morning Star (3-candle): big red, small body (gap or doji), big green
  const morningStar = n >= 3 && isRed(i-2) && body(i-2) > range(i-2) * 0.5 &&
    body(i-1) < body(i-2) * 0.3 && isGreen(i) && c[i] > (o[i-2] + c[i-2]) / 2;

  // Evening Star
  const eveningStar = n >= 3 && isGreen(i-2) && body(i-2) > range(i-2) * 0.5 &&
    body(i-1) < body(i-2) * 0.3 && isRed(i) && c[i] < (o[i-2] + c[i-2]) / 2;

  // Three White Soldiers
  const threeWhiteSoldiers = n >= 3 &&
    isGreen(i) && isGreen(i-1) && isGreen(i-2) &&
    c[i] > c[i-1] && c[i-1] > c[i-2] &&
    o[i] > o[i-1] && o[i-1] > o[i-2] &&
    body(i) > range(i) * 0.6 && body(i-1) > range(i-1) * 0.6;

  // Three Black Crows
  const threeBlackCrows = n >= 3 &&
    isRed(i) && isRed(i-1) && isRed(i-2) &&
    c[i] < c[i-1] && c[i-1] < c[i-2] &&
    o[i] < o[i-1] && o[i-1] < o[i-2] &&
    body(i) > range(i) * 0.6 && body(i-1) > range(i-1) * 0.6;

  // Score
  let score = 0;
  const detected: string[] = [];
  if (threeWhiteSoldiers)  { score += 80; detected.push("Three White Soldiers"); }
  if (morningStar)         { score += 70; detected.push("Morning Star"); }
  if (bullishEngulfing)    { score += 60; detected.push("Bullish Engulfing"); }
  if (hammer)              { score += 45; detected.push("Hammer"); }
  if (invertedHammer)      { score += 30; detected.push("Inverted Hammer"); }
  if (threeBlackCrows)     { score -= 80; detected.push("Three Black Crows"); }
  if (eveningStar)         { score -= 70; detected.push("Evening Star"); }
  if (bearishEngulfing)    { score -= 60; detected.push("Bearish Engulfing"); }
  if (shootingStar)        { score -= 45; detected.push("Shooting Star"); }
  if (doji && score === 0) { detected.push("Doji"); }

  score = Math.max(-100, Math.min(100, score));
  const patternSignal =
    score >= 60 ? "strong_bullish" :
    score >= 25 ? "bullish" :
    score <= -60 ? "strong_bearish" :
    score <= -25 ? "bearish" : "neutral";

  return {
    hammer, invertedHammer, bullishEngulfing, bearishEngulfing, doji,
    shootingStar, morningStar, eveningStar, threeWhiteSoldiers, threeBlackCrows,
    patternSignal, patternScore: score, detected,
  };
}

// ─── Trend detection ──────────────────────────────────────────

export function detectTrend(closes: number[], period = 20): "uptrend" | "downtrend" | "sideways" {
  if (closes.length < period) return "sideways";
  const slice = closes.slice(-period);
  const pct = (slice[slice.length - 1] - slice[0]) / slice[0];
  return pct > 0.03 ? "uptrend" : pct < -0.03 ? "downtrend" : "sideways";
}

// ─── Support / Resistance ─────────────────────────────────────

export function supportResistance(highs: number[], lows: number[], price: number): {
  nearestSupport: number; nearestResistance: number;
  distanceToSupport: number; distanceToResistance: number;
} {
  const resistance = Math.max(...highs.slice(-20));
  const support    = Math.min(...lows.slice(-20));
  return {
    nearestSupport: +support.toFixed(2), nearestResistance: +resistance.toFixed(2),
    distanceToSupport: price > 0 ? +((price - support) / price * 100).toFixed(2) : 0,
    distanceToResistance: price > 0 ? +((resistance - price) / price * 100).toFixed(2) : 0,
  };
}

// ─── Composite Score ──────────────────────────────────────────

export interface CompositeInput {
  rsiVal: number;
  macdHistogram: number;
  macdCross: "bullish" | "bearish" | "none";
  bbPercentB: number;
  ema9: number; ema21: number; ema50: number; price: number;
  volRatio: number;
  changePercent: number;
  candleScore: number;
  obvTrend: "accumulation" | "distribution" | "neutral";
  stochK: number;
  williamsRVal: number;
  ichimokuPriceVsCloud: "above" | "below" | "inside";
}

export function compositeSignalScore(inp: CompositeInput): {
  score: number;
  breakdown: Record<string, number>;
} {
  const breakdown: Record<string, number> = {};

  // RSI (max ±25)
  breakdown.rsi = inp.rsiVal < 30 ? 25 : inp.rsiVal < 40 ? 12 : inp.rsiVal > 70 ? -25 : inp.rsiVal > 60 ? -12 : 0;

  // MACD (max ±25)
  breakdown.macd = (inp.macdCross === "bullish" ? 20 : inp.macdCross === "bearish" ? -20 : 0) +
                   (inp.macdHistogram > 0 ? 5 : inp.macdHistogram < 0 ? -5 : 0);

  // Bollinger (max ±15)
  breakdown.bb = inp.bbPercentB < 0.1 ? 15 : inp.bbPercentB < 0.25 ? 8 : inp.bbPercentB > 0.9 ? -15 : inp.bbPercentB > 0.75 ? -8 : 0;

  // EMA alignment (max ±20)
  const bullEMA = inp.price > inp.ema9 && inp.ema9 > inp.ema21 && inp.ema21 > inp.ema50;
  const bearEMA = inp.price < inp.ema9 && inp.ema9 < inp.ema21 && inp.ema21 < inp.ema50;
  breakdown.ema = bullEMA ? 20 : bearEMA ? -20 : inp.price > inp.ema21 ? 10 : inp.price < inp.ema21 ? -10 : 0;

  // Volume (max ±10)
  breakdown.volume = inp.volRatio > 1.5 ? (inp.changePercent > 0 ? 10 : -10) :
                     inp.volRatio > 1.2 ? (inp.changePercent > 0 ? 5 : -5) : 0;

  // Candles (max ±20)
  breakdown.candles = Math.max(-20, Math.min(20, inp.candleScore * 0.25));

  // OBV (max ±10)
  breakdown.obv = inp.obvTrend === "accumulation" ? 10 : inp.obvTrend === "distribution" ? -10 : 0;

  // Stochastic (max ±10)
  breakdown.stoch = inp.stochK < 20 ? 10 : inp.stochK > 80 ? -10 : 0;

  // Williams %R (max ±5)
  breakdown.williams = inp.williamsRVal < -80 ? 5 : inp.williamsRVal > -20 ? -5 : 0;

  // Ichimoku (max ±10)
  breakdown.ichimoku = inp.ichimokuPriceVsCloud === "above" ? 10 : inp.ichimokuPriceVsCloud === "below" ? -10 : 0;

  const score = Math.max(-100, Math.min(100,
    Object.values(breakdown).reduce((a, b) => a + b, 0)
  ));

  return { score: +score.toFixed(1), breakdown };
}
