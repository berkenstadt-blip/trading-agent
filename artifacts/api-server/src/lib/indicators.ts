/**
 * Technical Indicators — pure math, zero dependencies
 * All functions take arrays of numbers (oldest first, newest last)
 */

/** Exponential Moving Average — returns full array */
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

/** Last EMA value */
export function ema(values: number[], period: number): number {
  const arr = emaArray(values, period);
  return arr[arr.length - 1] ?? NaN;
}

/** RSI(14) — Wilder smoothing */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);

  // Wilder's initial averages
  const initial = changes.slice(0, period);
  let avgGain = initial.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  let avgLoss = initial.filter(c => c < 0).map(c => -c).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < changes.length; i++) {
    const gain = Math.max(0, changes[i]);
    const loss = Math.max(0, -changes[i]);
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

/** MACD(12,26,9) */
export function macd(closes: number[]): {
  macdLine: number;
  signalLine: number;
  histogram: number;
  crossover: "bullish" | "bearish" | "none";
} {
  const empty = { macdLine: 0, signalLine: 0, histogram: 0, crossover: "none" as const };
  if (closes.length < 35) return empty;

  const ema12 = emaArray(closes, 12);
  const ema26 = emaArray(closes, 26);
  const macdLine = ema12.map((v, i) => (isNaN(v) || isNaN(ema26[i]) ? NaN : v - ema26[i]));
  const validMacd = macdLine.filter(v => !isNaN(v));
  if (validMacd.length < 9) return empty;

  const signalArr = emaArray(validMacd, 9);
  const lastMacd = validMacd[validMacd.length - 1];
  const prevMacd = validMacd[validMacd.length - 2];
  const lastSignal = signalArr[signalArr.length - 1];
  const prevSignal = signalArr[signalArr.length - 2];

  let crossover: "bullish" | "bearish" | "none" = "none";
  if (prevMacd !== undefined && prevSignal !== undefined) {
    if (prevMacd < prevSignal && lastMacd > lastSignal) crossover = "bullish";
    else if (prevMacd > prevSignal && lastMacd < lastSignal) crossover = "bearish";
  }

  return {
    macdLine: +lastMacd.toFixed(4),
    signalLine: +lastSignal.toFixed(4),
    histogram: +(lastMacd - lastSignal).toFixed(4),
    crossover,
  };
}

/** Bollinger Bands(20, 2) */
export function bollingerBands(closes: number[], period = 20): {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
  percentB: number; // 0=at lower band, 1=at upper band
} {
  const fallback = { upper: 0, middle: 0, lower: 0, bandwidth: 0, percentB: 0.5 };
  if (closes.length < period) return fallback;

  const slice = closes.slice(-period);
  const middle = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((acc, v) => acc + Math.pow(v - middle, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + 2 * std;
  const lower = middle - 2 * std;
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0;
  const lastClose = closes[closes.length - 1];
  const percentB = (upper - lower) > 0 ? (lastClose - lower) / (upper - lower) : 0.5;

  return {
    upper: +upper.toFixed(4),
    middle: +middle.toFixed(4),
    lower: +lower.toFixed(4),
    bandwidth: +bandwidth.toFixed(4),
    percentB: +percentB.toFixed(4),
  };
}

/** Average True Range(14) — used for dynamic stop-loss */
export function atr(highs: number[], lows: number[], closes: number[], period = 14): number {
  if (highs.length < 2) return closes[closes.length - 1] * 0.02;
  const trs: number[] = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    );
    trs.push(tr);
  }
  const recent = trs.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

/** Volume ratio vs N-day average */
export function volumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const avgVol = volumes.slice(-period - 1, -1).reduce((a, b) => a + b, 0) / period;
  const lastVol = volumes[volumes.length - 1];
  return avgVol > 0 ? +( lastVol / avgVol).toFixed(2) : 1;
}

/** Simple trend detection from last N closes */
export function detectTrend(closes: number[], period = 20): "uptrend" | "downtrend" | "sideways" {
  if (closes.length < period) return "sideways";
  const slice = closes.slice(-period);
  const first = slice[0];
  const last = slice[slice.length - 1];
  const pctChange = (last - first) / first;
  if (pctChange > 0.03) return "uptrend";
  if (pctChange < -0.03) return "downtrend";
  return "sideways";
}

/** Support / resistance levels (simple: recent swing highs/lows) */
export function supportResistance(highs: number[], lows: number[], currentPrice: number): {
  nearestSupport: number;
  nearestResistance: number;
  distanceToSupport: number;  // %
  distanceToResistance: number; // %
} {
  const recentHighs = highs.slice(-20);
  const recentLows = lows.slice(-20);
  const resistance = Math.max(...recentHighs);
  const support = Math.min(...recentLows);
  return {
    nearestSupport: +support.toFixed(2),
    nearestResistance: +resistance.toFixed(2),
    distanceToSupport: currentPrice > 0 ? +((currentPrice - support) / currentPrice * 100).toFixed(2) : 0,
    distanceToResistance: currentPrice > 0 ? +((resistance - currentPrice) / currentPrice * 100).toFixed(2) : 0,
  };
}
