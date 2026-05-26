/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS OPTIONS ENGINE — Black-Scholes, Greeks, IV, Strategies
 *  Enables options premium collection, spreads, and hedging
 * ═══════════════════════════════════════════════════════════════
 */

// ─── Black-Scholes ────────────────────────────────────────────

/** Cumulative Normal Distribution (Hart approximation) */
function normCDF(x: number): number {
  const a1 =  0.254829592, a2 = -0.284496736, a3 =  1.421413741;
  const a4 = -1.453152027, a5 =  1.061405429, p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));
  return 0.5 * (1 + sign * y);
}

/** Standard Normal PDF */
function normPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export interface BSMResult {
  price: number;        // theoretical option price
  delta: number;        // Δ: price sensitivity to underlying
  gamma: number;        // Γ: delta sensitivity
  theta: number;        // Θ: daily time decay ($/day)
  vega: number;         // ν: sensitivity to 1% IV change
  rho: number;          // ρ: sensitivity to 1% rate change
  d1: number;
  d2: number;
  intrinsicValue: number;
  timeValue: number;
  breakeven: number;
  impliedLeverage: number;
}

/**
 * Black-Scholes-Merton pricing + full Greeks
 * @param S - underlying price
 * @param K - strike price
 * @param T - time to expiration in YEARS (e.g., 30/365)
 * @param r - risk-free rate (e.g., 0.05 for 5%)
 * @param sigma - implied volatility (e.g., 0.30 for 30%)
 * @param type - 'call' or 'put'
 */
export function blackScholes(
  S: number, K: number, T: number, r: number, sigma: number,
  type: "call" | "put"
): BSMResult {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
    return { price: intrinsic, delta: type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0),
             gamma: 0, theta: 0, vega: 0, rho: 0, d1: 0, d2: 0,
             intrinsicValue: intrinsic, timeValue: 0,
             breakeven: type === "call" ? K + intrinsic : K - intrinsic,
             impliedLeverage: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  let price: number, delta: number;
  if (type === "call") {
    price = S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
    delta = normCDF(d1);
  } else {
    price = K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
    delta = normCDF(d1) - 1;
  }

  const gamma = normPDF(d1) / (S * sigma * sqrtT);
  const vega  = S * normPDF(d1) * sqrtT / 100; // per 1% IV change
  const thetaCall = (-S * normPDF(d1) * sigma / (2 * sqrtT) - r * K * Math.exp(-r * T) * normCDF(d2)) / 365;
  const theta = type === "call" ? thetaCall :
    (thetaCall + r * K * Math.exp(-r * T)) / 365;
  const rhoVal = type === "call"
    ? K * T * Math.exp(-r * T) * normCDF(d2) / 100
    : -K * T * Math.exp(-r * T) * normCDF(-d2) / 100;

  const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  const timeValue = Math.max(0, price - intrinsic);
  const breakeven = type === "call" ? K + price : K - price;
  const impliedLeverage = price > 0 ? (delta * S) / price : 0;

  return {
    price: +price.toFixed(4), delta: +delta.toFixed(4), gamma: +gamma.toFixed(6),
    theta: +thetaCall.toFixed(4), vega: +vega.toFixed(4), rho: +rhoVal.toFixed(4),
    d1: +d1.toFixed(4), d2: +d2.toFixed(4),
    intrinsicValue: +intrinsic.toFixed(4), timeValue: +timeValue.toFixed(4),
    breakeven: +breakeven.toFixed(2), impliedLeverage: +impliedLeverage.toFixed(2),
  };
}

// ─── Implied Volatility (Newton-Raphson) ─────────────────────

export function impliedVolatility(
  marketPrice: number, S: number, K: number, T: number, r: number, type: "call" | "put",
  tolerance = 1e-6, maxIter = 100,
): number {
  if (T <= 0 || marketPrice <= 0) return 0;
  let sigma = 0.3; // initial guess
  for (let i = 0; i < maxIter; i++) {
    const bsm = blackScholes(S, K, T, r, sigma, type);
    const diff = bsm.price - marketPrice;
    if (Math.abs(diff) < tolerance) return +sigma.toFixed(6);
    const vegaRaw = bsm.vega * 100; // convert back from per-1%
    if (Math.abs(vegaRaw) < 1e-10) break;
    sigma -= diff / vegaRaw;
    sigma = Math.max(0.001, Math.min(5.0, sigma));
  }
  return +sigma.toFixed(6);
}

// ─── Options Strategies ───────────────────────────────────────

export interface StrategySummary {
  name: string;
  maxProfit: number;
  maxLoss: number;
  breakeven: number | number[];
  probabilityOfProfit: number; // rough estimate
  netPremium: number;          // positive = credit, negative = debit
  riskReward: number;
}

/** Covered Call: long stock + short OTM call */
export function coveredCall(
  S: number, K: number, T: number, r: number, sigma: number, shares = 100
): StrategySummary {
  const call = blackScholes(S, K, T, r, sigma, "call");
  const premium = call.price * shares;
  const maxProfit = (K - S) * shares + premium;
  const maxLoss = (S - call.price) * shares; // stock goes to 0
  const breakeven = S - call.price;
  return {
    name: "Covered Call", maxProfit, maxLoss: -maxLoss,
    breakeven, netPremium: premium,
    probabilityOfProfit: normCDF(-call.d2) * 100,
    riskReward: maxProfit > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
  };
}

/** Cash-Secured Put: short OTM put, cash-secured */
export function cashSecuredPut(
  S: number, K: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const put = blackScholes(S, K, T, r, sigma, "put");
  const premium = put.price * 100 * contracts;
  const maxProfit = premium;
  const maxLoss = (K - put.price) * 100 * contracts;
  const breakeven = K - put.price;
  return {
    name: "Cash-Secured Put", maxProfit, maxLoss: -maxLoss,
    breakeven, netPremium: premium,
    probabilityOfProfit: normCDF(put.d2) * 100,
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
  };
}

/** Bull Call Spread: buy lower strike call, sell higher strike call */
export function bullCallSpread(
  S: number, K1: number, K2: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const longCall  = blackScholes(S, K1, T, r, sigma, "call");
  const shortCall = blackScholes(S, K2, T, r, sigma, "call");
  const debit = (longCall.price - shortCall.price) * 100 * contracts;
  const maxProfit = (K2 - K1) * 100 * contracts - debit;
  const maxLoss = debit;
  const breakeven = K1 + (longCall.price - shortCall.price);
  return {
    name: "Bull Call Spread", maxProfit, maxLoss: -maxLoss,
    breakeven, netPremium: -debit,
    probabilityOfProfit: normCDF(longCall.d2) * 100,
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
  };
}

/** Bear Put Spread: buy higher strike put, sell lower strike put */
export function bearPutSpread(
  S: number, K1: number, K2: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const longPut  = blackScholes(S, K2, T, r, sigma, "put");  // higher strike
  const shortPut = blackScholes(S, K1, T, r, sigma, "put");  // lower strike
  const debit = (longPut.price - shortPut.price) * 100 * contracts;
  const maxProfit = (K2 - K1) * 100 * contracts - debit;
  const maxLoss = debit;
  const breakeven = K2 - (longPut.price - shortPut.price);
  return {
    name: "Bear Put Spread", maxProfit, maxLoss: -maxLoss,
    breakeven, netPremium: -debit,
    probabilityOfProfit: (1 - normCDF(longPut.d2)) * 100,
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
  };
}

/** Iron Condor: short strangle + long wings */
export function ironCondor(
  S: number, K1: number, K2: number, K3: number, K4: number,
  T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const longPut   = blackScholes(S, K1, T, r, sigma, "put");
  const shortPut  = blackScholes(S, K2, T, r, sigma, "put");
  const shortCall = blackScholes(S, K3, T, r, sigma, "call");
  const longCall  = blackScholes(S, K4, T, r, sigma, "call");
  const credit = (shortPut.price + shortCall.price - longPut.price - longCall.price) * 100 * contracts;
  const wingWidth = Math.max(K2 - K1, K4 - K3) * 100 * contracts;
  const maxProfit = credit;
  const maxLoss = wingWidth - credit;
  return {
    name: "Iron Condor", maxProfit, maxLoss: -maxLoss,
    breakeven: [K2 - credit / 100 / contracts, K3 + credit / 100 / contracts],
    netPremium: credit,
    probabilityOfProfit: (normCDF(shortCall.d2) - normCDF(shortPut.d2)) * 100,
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
  };
}

// ─── IV Rank & Percentile ─────────────────────────────────────

export interface IVContext {
  ivRank: number;       // 0–100: where current IV sits vs 52-week range
  ivPercentile: number; // % of days IV was below current
  regime: "low" | "normal" | "elevated" | "extreme";
  recommendation: string;
}

export function analyzeIV(currentIV: number, historicalIVs: number[]): IVContext {
  if (historicalIVs.length < 5) {
    return { ivRank: 50, ivPercentile: 50, regime: "normal", recommendation: "Insufficient IV history" };
  }
  const minIV = Math.min(...historicalIVs);
  const maxIV = Math.max(...historicalIVs);
  const ivRank = maxIV > minIV ? ((currentIV - minIV) / (maxIV - minIV)) * 100 : 50;
  const ivPercentile = (historicalIVs.filter(v => v < currentIV).length / historicalIVs.length) * 100;

  let regime: IVContext["regime"] = "normal";
  let recommendation: string;

  if (ivRank >= 80) {
    regime = "extreme";
    recommendation = "IV extremely elevated — SELL premium (covered calls, CSP, iron condor). IV crush risk high.";
  } else if (ivRank >= 50) {
    regime = "elevated";
    recommendation = "IV above average — selling premium has edge. Consider credit spreads or covered calls.";
  } else if (ivRank >= 25) {
    regime = "normal";
    recommendation = "IV normal — no strong edge either way. Favor directional trades if strong signal.";
  } else {
    regime = "low";
    recommendation = "IV low — BUYING options cheap. Consider debit spreads or long calls/puts with catalyst.";
  }

  return {
    ivRank: +ivRank.toFixed(1),
    ivPercentile: +ivPercentile.toFixed(1),
    regime, recommendation,
  };
}

// ─── Options Chain Scanner ────────────────────────────────────

export interface OptionOpportunity {
  type: "call" | "put";
  strategy: string;
  strike: number;
  expDays: number;
  premium: number;
  delta: number;
  theta: number;
  iv: number;
  probabilityOTM: number;
  annualizedReturn: number;
  score: number;
  rationale: string;
}

/**
 * Find best premium-selling opportunity given current market conditions
 */
export function findBestOptionStrategy(
  S: number,
  currentIV: number,
  ivContext: IVContext,
  direction: "bullish" | "bearish" | "neutral",
  daysOptions: number[] = [7, 14, 21, 30, 45],
  r = 0.05,
): OptionOpportunity | null {
  const opportunities: OptionOpportunity[] = [];

  for (const days of daysOptions) {
    const T = days / 365;
    // Strike 1 SD OTM
    const sdMove = S * currentIV * Math.sqrt(T);

    if (direction !== "bearish" && ivContext.ivRank > 30) {
      // Cash-Secured Put (bullish/neutral)
      const K = Math.round((S - sdMove * 0.8) / 5) * 5;
      const put = blackScholes(S, K, T, r, currentIV, "put");
      const annRet = S > 0 ? (put.price / K) * (365 / days) * 100 : 0;
      const probOTM = normCDF(put.d2) * 100;
      if (probOTM > 70 && put.price > 0.05) {
        opportunities.push({
          type: "put", strategy: "Cash-Secured Put",
          strike: K, expDays: days, premium: put.price, delta: put.delta,
          theta: put.theta, iv: currentIV, probabilityOTM: +probOTM.toFixed(1),
          annualizedReturn: +annRet.toFixed(1),
          score: (probOTM * 0.4 + ivContext.ivRank * 0.4 + Math.min(annRet, 100) * 0.2),
          rationale: `${days}DTE CSP @ $${K} | ${probOTM.toFixed(0)}% OTM | ${annRet.toFixed(1)}% annualized`,
        });
      }
    }

    if (direction !== "bullish" && ivContext.ivRank > 30) {
      // Covered Call (bearish/neutral)
      const K = Math.round((S + sdMove * 0.8) / 5) * 5;
      const call = blackScholes(S, K, T, r, currentIV, "call");
      const annRet = S > 0 ? (call.price / S) * (365 / days) * 100 : 0;
      const probOTM = (1 - normCDF(call.d2)) * 100;
      if (probOTM > 70 && call.price > 0.05) {
        opportunities.push({
          type: "call", strategy: "Covered Call",
          strike: K, expDays: days, premium: call.price, delta: call.delta,
          theta: call.theta, iv: currentIV, probabilityOTM: +probOTM.toFixed(1),
          annualizedReturn: +annRet.toFixed(1),
          score: (probOTM * 0.4 + ivContext.ivRank * 0.4 + Math.min(annRet, 100) * 0.2),
          rationale: `${days}DTE CC @ $${K} | ${probOTM.toFixed(0)}% OTM | ${annRet.toFixed(1)}% annualized`,
        });
      }
    }
  }

  if (opportunities.length === 0) return null;
  return opportunities.sort((a, b) => b.score - a.score)[0];
}
