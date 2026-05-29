/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS OPTIONS ENGINE v2 — Institutional Grade
 *  Black-Scholes + Full Greeks + Expected Value + Kelly Sizing
 *  Delta-targeted strikes, DTE optimization, IV crush scoring,
 *  Multi-leg strategies, Put/Call ratio signals
 *  Think: Citadel Options Desk / SIG / Jane Street
 * ═══════════════════════════════════════════════════════════════
 */

// ─── Math Utils ───────────────────────────────────────────────

/** Cumulative Normal Distribution (Hart approximation — accurate to 7 decimals) */
export function normCDF(x: number): number {
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

// ─── Black-Scholes-Merton ─────────────────────────────────────

export interface BSMResult {
  price: number;          // theoretical option price
  delta: number;          // Δ: directional exposure (0–1 call, -1–0 put)
  gamma: number;          // Γ: delta change per $1 move
  theta: number;          // Θ: daily time decay ($/day, negative)
  vega: number;           // ν: P&L per 1% IV increase
  rho: number;            // ρ: P&L per 1% rate change
  charm: number;          // dΔ/dt: delta decay per day (2nd-order)
  vanna: number;          // dΔ/dIV: delta sensitivity to IV changes
  volga: number;          // d²P/dσ²: vega curvature (vol of vol exposure)
  d1: number;
  d2: number;
  intrinsicValue: number;
  timeValue: number;
  breakeven: number;
  impliedLeverage: number;
  probabilityITM: number; // real-world P(ITM) ≈ |delta|
  probabilityOTM: number; // 1 - P(ITM)
  expectedValue: number;  // probability-weighted payoff
}

/**
 * Black-Scholes-Merton with full 2nd-order Greeks
 * Charm, Vanna, Volga enable real options-desk risk mgmt
 */
export function blackScholes(
  S: number, K: number, T: number, r: number, sigma: number,
  type: "call" | "put"
): BSMResult {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) {
    const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
    const p = type === "call" ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    return {
      price: intrinsic, delta: p, gamma: 0, theta: 0, vega: 0, rho: 0,
      charm: 0, vanna: 0, volga: 0, d1: 0, d2: 0,
      intrinsicValue: intrinsic, timeValue: 0,
      breakeven: type === "call" ? K + intrinsic : K - intrinsic,
      impliedLeverage: 0, probabilityITM: p, probabilityOTM: 1 - p, expectedValue: intrinsic,
    };
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

  const gamma   = normPDF(d1) / (S * sigma * sqrtT);
  const vega    = S * normPDF(d1) * sqrtT / 100;
  const thetaCall = (-S * normPDF(d1) * sigma / (2 * sqrtT)
                   - r * K * Math.exp(-r * T) * normCDF(d2)) / 365;
  const theta   = type === "call" ? thetaCall
                : (thetaCall + r * K * Math.exp(-r * T)) / 365;
  const rhoVal  = type === "call"
    ? K * T * Math.exp(-r * T) * normCDF(d2) / 100
    : -K * T * Math.exp(-r * T) * normCDF(-d2) / 100;

  // ── 2nd-order Greeks ──
  // Charm = dΔ/dt (how fast delta decays each day)
  const charm = type === "call"
    ? -normPDF(d1) * (2 * r * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT)
    : -normPDF(d1) * (2 * r * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT) + normPDF(d1) / (sqrtT * 365);

  // Vanna = dΔ/dσ = dVega/dS  (how delta changes with IV)
  const vanna   = -normPDF(d1) * d2 / sigma;

  // Volga = d²P/dσ² (convexity in vol — vol of vol exposure)
  const volga   = S * normPDF(d1) * sqrtT * d1 * d2 / sigma;

  const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  const timeValue = Math.max(0, price - intrinsic);
  const breakeven = type === "call" ? K + price : K - price;
  const impliedLeverage = price > 0 ? (delta * S) / price : 0;

  // P(ITM) under risk-neutral measure ≈ N(d2) for calls, N(-d2) for puts
  const probabilityITM = type === "call" ? normCDF(d2) : normCDF(-d2);
  const probabilityOTM = 1 - probabilityITM;

  // Expected value = probability-weighted intrinsic at expiry
  const expectedValue = type === "call"
    ? S * Math.exp((0) * T) * normCDF(d1) - K * normCDF(d2)   // forward EV
    : K * normCDF(-d2) - S * normCDF(-d1);

  return {
    price: +price.toFixed(4), delta: +delta.toFixed(4), gamma: +gamma.toFixed(6),
    theta: +theta.toFixed(4), vega: +vega.toFixed(4), rho: +rhoVal.toFixed(4),
    charm: +charm.toFixed(6), vanna: +vanna.toFixed(6), volga: +volga.toFixed(6),
    d1: +d1.toFixed(4), d2: +d2.toFixed(4),
    intrinsicValue: +intrinsic.toFixed(4), timeValue: +timeValue.toFixed(4),
    breakeven: +breakeven.toFixed(2), impliedLeverage: +impliedLeverage.toFixed(2),
    probabilityITM: +probabilityITM.toFixed(4), probabilityOTM: +probabilityOTM.toFixed(4),
    expectedValue: +expectedValue.toFixed(4),
  };
}

// ─── Implied Volatility (Newton-Raphson + Bisection fallback) ─

export function impliedVolatility(
  marketPrice: number, S: number, K: number, T: number, r: number, type: "call" | "put",
  tolerance = 1e-6, maxIter = 200,
): number {
  if (T <= 0 || marketPrice <= 0) return 0;

  // Intrinsic check
  const intrinsic = type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  if (marketPrice <= intrinsic) return 0.001;

  // Newton-Raphson with Brent fallback
  let sigma = 0.3;
  for (let i = 0; i < maxIter; i++) {
    const bsm = blackScholes(S, K, T, r, sigma, type);
    const diff = bsm.price - marketPrice;
    if (Math.abs(diff) < tolerance) return +sigma.toFixed(6);
    const vegaRaw = bsm.vega * 100;
    if (Math.abs(vegaRaw) < 1e-10) break;
    sigma -= diff / vegaRaw;
    sigma = Math.max(0.001, Math.min(5.0, sigma));
  }

  // Bisection fallback
  let lo = 0.001, hi = 5.0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const diff = blackScholes(S, K, T, r, mid, type).price - marketPrice;
    if (Math.abs(diff) < tolerance) return +mid.toFixed(6);
    if (diff > 0) hi = mid; else lo = mid;
  }
  return +(lo + hi).toFixed(6) / 2;
}

// ─── Delta-Targeted Strike Selection ─────────────────────────

/**
 * Find the strike closest to a target delta (e.g., 0.30 delta = 30-delta put)
 * Institutional desks always select strikes by delta, never by arbitrary OTM %
 */
export function strikeForDelta(
  S: number, T: number, r: number, sigma: number,
  targetDelta: number,  // e.g., 0.30 for 30-delta, -0.20 for 20-delta put
  type: "call" | "put",
  tickSize = 1,
): number {
  // Analytical inversion of BSM delta
  let K: number;
  if (type === "call") {
    // delta = N(d1), so d1 = N^{-1}(delta)
    const d1Target = inverseNormCDF(targetDelta);
    K = S * Math.exp(-(d1Target * sigma * Math.sqrt(T) - (r + 0.5 * sigma ** 2) * T));
  } else {
    // delta_put = N(d1) - 1, so N(d1) = delta + 1
    const d1Target = inverseNormCDF(targetDelta + 1);
    K = S * Math.exp(-(d1Target * sigma * Math.sqrt(T) - (r + 0.5 * sigma ** 2) * T));
  }
  return Math.round(K / tickSize) * tickSize;
}

/** Rational approximation for inverse Normal CDF (Beasley-Springer-Moro) */
function inverseNormCDF(p: number): number {
  if (p <= 0) return -10; if (p >= 1) return 10;
  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
  const b = [-8.47351093090, 23.08336743743, -21.06224101826, 3.13082909833];
  const c = [0.3374754822726147, 0.9761690190917186, 0.1607979714918209,
             0.0276438810333863, 0.0038405729373609, 0.0003951896511349,
             0.0000321767881768, 0.0000002888167364, 0.0000003960315187];
  const y = p - 0.5;
  if (Math.abs(y) < 0.42) {
    const r = y * y;
    return y * (((a[3] * r + a[2]) * r + a[1]) * r + a[0]) /
           ((((b[3] * r + b[2]) * r + b[1]) * r + b[0]) * r + 1);
  }
  const r = Math.log(-Math.log(y < 0 ? p : 1 - p));
  return (y < 0 ? -1 : 1) * (c[0] + r * (c[1] + r * (c[2] + r * (c[3] +
    r * (c[4] + r * (c[5] + r * (c[6] + r * (c[7] + r * c[8]))))))));
}

// ─── IV Context & Regime ──────────────────────────────────────

export interface IVContext {
  ivRank: number;           // 0–100: where current IV sits vs 52-week range
  ivPercentile: number;     // % of days IV was below current
  regime: "low" | "normal" | "elevated" | "extreme";
  recommendation: string;
  // NEW v2
  ivCrushRisk: "high" | "medium" | "low";    // risk of IV dropping after event
  ivExpansionExpected: boolean;              // true when IV likely to rise
  thetaEdge: "strong" | "moderate" | "weak"; // quality of theta-selling edge
  optimalStrategy: string;                   // top-level strategy for this IV regime
}

export function analyzeIV(currentIV: number, historicalIVs: number[]): IVContext {
  if (historicalIVs.length < 5) {
    return {
      ivRank: 50, ivPercentile: 50, regime: "normal",
      recommendation: "Insufficient IV history — using neutral defaults",
      ivCrushRisk: "medium", ivExpansionExpected: false,
      thetaEdge: "moderate", optimalStrategy: "small directional debit spread",
    };
  }
  const minIV  = Math.min(...historicalIVs);
  const maxIV  = Math.max(...historicalIVs);
  const ivRank = maxIV > minIV ? ((currentIV - minIV) / (maxIV - minIV)) * 100 : 50;
  const ivPercentile = (historicalIVs.filter(v => v < currentIV).length / historicalIVs.length) * 100;

  // Trend: is IV rising or falling recently?
  const recent = historicalIVs.slice(-5);
  const ivTrend = recent[recent.length - 1] > recent[0] ? "rising" : "falling";

  let regime: IVContext["regime"] = "normal";
  let recommendation: string;
  let ivCrushRisk: IVContext["ivCrushRisk"];
  let ivExpansionExpected: boolean;
  let thetaEdge: IVContext["thetaEdge"];
  let optimalStrategy: string;

  if (ivRank >= 80) {
    regime = "extreme";
    recommendation = `IV rank ${ivRank.toFixed(0)}/100 — EXTREME. Sell premium aggressively: Iron Condor or short strangle. IV crush will reward sellers.`;
    ivCrushRisk = "high";  // high crush risk for buyers, GOOD for sellers
    ivExpansionExpected = false;
    thetaEdge = "strong";
    optimalStrategy = "Iron Condor or wide Strangle (credit)";
  } else if (ivRank >= 60) {
    regime = "elevated";
    recommendation = `IV rank ${ivRank.toFixed(0)}/100 — ELEVATED. Premium selling has clear edge. CSP, Covered Calls, Bull Put Spreads.`;
    ivCrushRisk = "medium";
    ivExpansionExpected = false;
    thetaEdge = "strong";
    optimalStrategy = "Cash-Secured Put or Bull Put Spread";
  } else if (ivRank >= 35) {
    regime = "normal";
    recommendation = `IV rank ${ivRank.toFixed(0)}/100 — NORMAL. Balanced. Favor directional spreads aligned with tech signal.`;
    ivCrushRisk = "low";
    ivExpansionExpected = ivTrend === "rising";
    thetaEdge = "moderate";
    optimalStrategy = "Debit spread in direction of trend";
  } else {
    regime = "low";
    recommendation = `IV rank ${ivRank.toFixed(0)}/100 — LOW. Buy options cheap. Long calls/puts or debit spreads into catalyst.`;
    ivCrushRisk = "low";
    ivExpansionExpected = true;
    thetaEdge = "weak";
    optimalStrategy = "Long call or Bull Call Spread (debit)";
  }

  return {
    ivRank: +ivRank.toFixed(1), ivPercentile: +ivPercentile.toFixed(1),
    regime, recommendation, ivCrushRisk, ivExpansionExpected, thetaEdge, optimalStrategy,
  };
}

// ─── DTE Optimizer ────────────────────────────────────────────

/**
 * Find the optimal DTE for theta-selling given IV regime + theta decay curve.
 * Theta accelerates in the last 45 days. Sweet spot = 21-45 DTE.
 */
export function optimalDTE(
  ivRegime: IVContext["regime"],
  hasNearCatalyst: boolean,  // earnings/event within 14 days
  direction: "credit" | "debit",
): number {
  if (direction === "debit") {
    // Debit buyers want time: 30-60 DTE gives leverage without rapid decay
    if (hasNearCatalyst) return 14;  // play the event
    return ivRegime === "low" ? 45 : 30;
  }
  // Credit sellers: 21-45 DTE sweet spot for theta
  if (hasNearCatalyst) return 7;    // short-dated credit before event crush
  if (ivRegime === "extreme") return 21;  // take credit now, buy back at 50% profit
  if (ivRegime === "elevated") return 30;
  return 45;  // normal/low IV: need more premium, go further out
}

// ─── Strategy Definitions ─────────────────────────────────────

export interface StrategySummary {
  name: string;
  legs: { type: "call" | "put"; side: "long" | "short"; strike: number; premium: number }[];
  maxProfit: number;
  maxLoss: number;
  breakeven: number | number[];
  probabilityOfProfit: number;
  netPremium: number;       // positive = credit, negative = debit
  riskReward: number;
  expectedValue: number;    // probability-weighted profit
  thetaPerDay: number;      // daily time decay benefit
  vegaExposure: number;     // positive = long vol (bad if IV falls), negative = short vol
  delta: number;            // net directional exposure
  margin: number;           // estimated buying power required
}

/** Covered Call: own 100 shares + sell OTM call */
export function coveredCall(
  S: number, K: number, T: number, r: number, sigma: number, shares = 100
): StrategySummary {
  const call = blackScholes(S, K, T, r, sigma, "call");
  const premium = call.price * shares;
  const maxProfit = (K - S) * shares + premium;
  const maxLoss = (S - call.price) * shares;
  const breakeven = S - call.price;
  const ev = call.probabilityOTM * premium + call.probabilityITM * ((K - S) * shares + premium);
  return {
    name: "Covered Call",
    legs: [{ type: "call", side: "short", strike: K, premium: call.price }],
    maxProfit, maxLoss: -maxLoss, breakeven, netPremium: premium,
    probabilityOfProfit: normCDF(-call.d2) * 100,
    riskReward: maxProfit > 0 && maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +(-call.theta * shares).toFixed(2),
    vegaExposure: +(-call.vega * shares).toFixed(2),
    delta: +(1 - call.delta).toFixed(3),  // long stock delta minus short call delta
    margin: S * shares,
  };
}

/** Cash-Secured Put: sell OTM put, secured with cash */
export function cashSecuredPut(
  S: number, K: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const put = blackScholes(S, K, T, r, sigma, "put");
  const premium = put.price * 100 * contracts;
  const maxProfit = premium;
  const maxLoss = (K - put.price) * 100 * contracts;
  const breakeven = K - put.price;
  const ev = put.probabilityOTM * premium + put.probabilityITM * (-maxLoss + premium);
  return {
    name: "Cash-Secured Put",
    legs: [{ type: "put", side: "short", strike: K, premium: put.price }],
    maxProfit, maxLoss: -maxLoss, breakeven, netPremium: premium,
    probabilityOfProfit: normCDF(put.d2) * 100,
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +(-put.theta * 100 * contracts).toFixed(2),
    vegaExposure: +(-put.vega * 100 * contracts).toFixed(2),
    delta: +(-put.delta * contracts).toFixed(3),
    margin: K * 100 * contracts,
  };
}

/** Bull Put Spread: sell higher strike put, buy lower strike put (credit) */
export function bullPutSpread(
  S: number, K1: number, K2: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  // K2 > K1: short K2 put (closer to money), long K1 put (farther OTM)
  const shortPut = blackScholes(S, K2, T, r, sigma, "put");
  const longPut  = blackScholes(S, K1, T, r, sigma, "put");
  const credit   = (shortPut.price - longPut.price) * 100 * contracts;
  const width    = (K2 - K1) * 100 * contracts;
  const maxProfit = credit;
  const maxLoss   = width - credit;
  const breakeven = K2 - credit / (100 * contracts);
  const probProfit = normCDF(shortPut.d2) * 100;
  const ev = (probProfit / 100) * maxProfit + (1 - probProfit / 100) * (-maxLoss);
  return {
    name: "Bull Put Spread",
    legs: [
      { type: "put", side: "short", strike: K2, premium: shortPut.price },
      { type: "put", side: "long",  strike: K1, premium: longPut.price },
    ],
    maxProfit, maxLoss: -maxLoss, breakeven, netPremium: credit,
    probabilityOfProfit: +probProfit.toFixed(1),
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +((-shortPut.theta + longPut.theta) * 100 * contracts).toFixed(2),
    vegaExposure: +((-shortPut.vega + longPut.vega) * 100 * contracts).toFixed(2),
    delta: +((-shortPut.delta + longPut.delta) * contracts).toFixed(3),
    margin: maxLoss,  // spread margin = max loss
  };
}

/** Bear Call Spread: sell lower strike call, buy higher strike call (credit) */
export function bearCallSpread(
  S: number, K1: number, K2: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const shortCall = blackScholes(S, K1, T, r, sigma, "call");
  const longCall  = blackScholes(S, K2, T, r, sigma, "call");
  const credit    = (shortCall.price - longCall.price) * 100 * contracts;
  const width     = (K2 - K1) * 100 * contracts;
  const maxProfit = credit;
  const maxLoss   = width - credit;
  const breakeven = K1 + credit / (100 * contracts);
  const probProfit = (1 - normCDF(shortCall.d2)) * 100;
  const ev = (probProfit / 100) * maxProfit + (1 - probProfit / 100) * (-maxLoss);
  return {
    name: "Bear Call Spread",
    legs: [
      { type: "call", side: "short", strike: K1, premium: shortCall.price },
      { type: "call", side: "long",  strike: K2, premium: longCall.price },
    ],
    maxProfit, maxLoss: -maxLoss, breakeven, netPremium: credit,
    probabilityOfProfit: +probProfit.toFixed(1),
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +((-shortCall.theta + longCall.theta) * 100 * contracts).toFixed(2),
    vegaExposure: +((-shortCall.vega + longCall.vega) * 100 * contracts).toFixed(2),
    delta: +((-shortCall.delta + longCall.delta) * contracts).toFixed(3),
    margin: maxLoss,
  };
}

/** Bull Call Spread: buy ATM call, sell OTM call (debit — for low IV) */
export function bullCallSpread(
  S: number, K1: number, K2: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const longCall  = blackScholes(S, K1, T, r, sigma, "call");
  const shortCall = blackScholes(S, K2, T, r, sigma, "call");
  const debit     = (longCall.price - shortCall.price) * 100 * contracts;
  const maxProfit = (K2 - K1) * 100 * contracts - debit;
  const maxLoss   = debit;
  const breakeven = K1 + (longCall.price - shortCall.price);
  const probProfit = normCDF(longCall.d2) * 100;
  const ev = (probProfit / 100) * maxProfit + (1 - probProfit / 100) * (-maxLoss);
  return {
    name: "Bull Call Spread",
    legs: [
      { type: "call", side: "long",  strike: K1, premium: longCall.price },
      { type: "call", side: "short", strike: K2, premium: shortCall.price },
    ],
    maxProfit, maxLoss: -maxLoss, breakeven, netPremium: -debit,
    probabilityOfProfit: +probProfit.toFixed(1),
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +((longCall.theta - shortCall.theta) * 100 * contracts).toFixed(2),  // negative = theta costs
    vegaExposure: +((longCall.vega - shortCall.vega) * 100 * contracts).toFixed(2),
    delta: +((longCall.delta - shortCall.delta) * contracts).toFixed(3),
    margin: debit,
  };
}

/** Bear Put Spread: buy OTM put, sell further OTM put (debit) */
export function bearPutSpread(
  S: number, K1: number, K2: number, T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  const longPut  = blackScholes(S, K2, T, r, sigma, "put");
  const shortPut = blackScholes(S, K1, T, r, sigma, "put");
  const debit    = (longPut.price - shortPut.price) * 100 * contracts;
  const maxProfit = (K2 - K1) * 100 * contracts - debit;
  const maxLoss   = debit;
  const breakeven = K2 - (longPut.price - shortPut.price);
  const probProfit = (1 - normCDF(longPut.d2)) * 100;
  const ev = (probProfit / 100) * maxProfit + (1 - probProfit / 100) * (-maxLoss);
  return {
    name: "Bear Put Spread",
    legs: [
      { type: "put", side: "long",  strike: K2, premium: longPut.price },
      { type: "put", side: "short", strike: K1, premium: shortPut.price },
    ],
    maxProfit, maxLoss: -maxLoss, breakeven, netPremium: -debit,
    probabilityOfProfit: +probProfit.toFixed(1),
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +((longPut.theta - shortPut.theta) * 100 * contracts).toFixed(2),
    vegaExposure: +((longPut.vega - shortPut.vega) * 100 * contracts).toFixed(2),
    delta: +((longPut.delta - shortPut.delta) * contracts).toFixed(3),
    margin: debit,
  };
}

/** Iron Condor: sell OTM strangle + buy wings (neutral premium collection) */
export function ironCondor(
  S: number, K1: number, K2: number, K3: number, K4: number,
  T: number, r: number, sigma: number, contracts = 1
): StrategySummary {
  // K1 < K2 < S < K3 < K4
  const longPut   = blackScholes(S, K1, T, r, sigma, "put");
  const shortPut  = blackScholes(S, K2, T, r, sigma, "put");
  const shortCall = blackScholes(S, K3, T, r, sigma, "call");
  const longCall  = blackScholes(S, K4, T, r, sigma, "call");
  const credit    = (shortPut.price + shortCall.price - longPut.price - longCall.price) * 100 * contracts;
  const wingWidth = Math.max(K2 - K1, K4 - K3) * 100 * contracts;
  const maxProfit = credit;
  const maxLoss   = wingWidth - credit;
  const bePut  = K2 - credit / (100 * contracts);
  const beCall = K3 + credit / (100 * contracts);
  const probProfit = (normCDF(shortCall.d2) - normCDF(shortPut.d2)) * 100;
  const ev = (probProfit / 100) * maxProfit + (1 - probProfit / 100) * (-maxLoss / 2); // rough EV
  return {
    name: "Iron Condor",
    legs: [
      { type: "put",  side: "long",  strike: K1, premium: longPut.price },
      { type: "put",  side: "short", strike: K2, premium: shortPut.price },
      { type: "call", side: "short", strike: K3, premium: shortCall.price },
      { type: "call", side: "long",  strike: K4, premium: longCall.price },
    ],
    maxProfit, maxLoss: -maxLoss, breakeven: [+bePut.toFixed(2), +beCall.toFixed(2)],
    netPremium: credit,
    probabilityOfProfit: +probProfit.toFixed(1),
    riskReward: maxLoss > 0 ? +(maxProfit / maxLoss).toFixed(2) : 0,
    expectedValue: +ev.toFixed(2),
    thetaPerDay: +((-shortPut.theta - shortCall.theta + longPut.theta + longCall.theta) * 100 * contracts).toFixed(2),
    vegaExposure: +((-shortPut.vega - shortCall.vega + longPut.vega + longCall.vega) * 100 * contracts).toFixed(2),
    delta: 0,  // approximately delta-neutral
    margin: maxLoss,
  };
}

// ─── Kelly Criterion for Options ─────────────────────────────

/**
 * Kelly fraction for options position
 * Accounts for the binary-like payoff of options
 */
export function optionsKelly(
  probabilityOfProfit: number,   // 0–1
  maxProfitPct: number,          // max profit as % of capital risked
  maxLossPct: number,            // max loss as % of capital risked (positive number)
): number {
  const p = Math.min(0.95, Math.max(0.05, probabilityOfProfit));
  const q = 1 - p;
  const b = maxProfitPct / maxLossPct;
  const kelly = (b * p - q) / b;
  // Quarter-Kelly for safety, max 25% bankroll
  return Math.max(0, Math.min(0.25, kelly * 0.25));
}

// ─── Main Strategy Selector ───────────────────────────────────

export interface OptionOpportunity {
  type: "call" | "put";
  strategy: string;
  strike: number;
  strike2?: number;       // for spreads: second strike
  expDays: number;
  premium: number;
  delta: number;
  theta: number;          // daily theta benefit (positive = theta collecting)
  vega: number;           // net vega (negative = short vol = benefits from IV drop)
  iv: number;
  probabilityOTM: number;
  probabilityOfProfit: number;
  annualizedReturn: number;
  expectedValue: number;  // probability-weighted P&L
  kellyFraction: number;  // optimal position size as % of account
  maxProfit: number;
  maxLoss: number;
  score: number;
  rationale: string;
  direction: "credit" | "debit";
  legs: number;           // 1 = naked/covered, 2 = spread, 4 = condor
}

/**
 * Institutional-grade options strategy selector
 * Picks the strategy with highest probability-weighted edge for the current regime
 */
export function findBestOptionStrategy(
  S: number,
  currentIV: number,
  ivContext: IVContext,
  direction: "bullish" | "bearish" | "neutral",
  hasNearCatalyst = false,
  r = 0.05,
): OptionOpportunity | null {
  const opportunities: OptionOpportunity[] = [];

  // ── Determine strategy menu based on IV regime + direction ──
  const dte = optimalDTE(ivContext.regime, hasNearCatalyst, ivContext.thetaEdge === "weak" ? "debit" : "credit");
  const T = dte / 365;

  // ── Delta targets: 0.30 delta = ~70% OTM, institutional sweet spot ──
  const sellDelta = 0.25;  // short options: 25-delta = ~75% chance of profit
  const buyDelta  = 0.40;  // long options: 40-delta = good leverage, not too cheap

  // ─────────────────────────────────────────────────────────
  // CREDIT STRATEGIES (IV elevated/extreme — sell premium)
  // ─────────────────────────────────────────────────────────

  if (ivContext.ivRank >= 35) {

    // 1. Bull Put Spread (bullish/neutral, defined-risk credit)
    if (direction !== "bearish") {
      const K2 = strikeForDelta(S, T, r, currentIV, -sellDelta, "put");  // short put
      const K1 = Math.round((K2 - S * 0.03) / 1) * 1;  // 3% wide wing
      if (K1 > 0 && K2 > K1) {
        const strat = bullPutSpread(S, K1, K2, T, r, currentIV);
        const annRet = strat.margin > 0 ? (strat.maxProfit / strat.margin) * (365 / dte) * 100 : 0;
        const kelly = optionsKelly(strat.probabilityOfProfit / 100,
          strat.maxProfit / strat.margin, 1);
        if (strat.probabilityOfProfit > 52 && strat.netPremium > 0.05 && strat.expectedValue > -5) {
          opportunities.push({
            type: "put", strategy: "Bull Put Spread", strike: K2, strike2: K1,
            expDays: dte, premium: strat.netPremium / 100, delta: strat.delta,
            theta: strat.thetaPerDay, vega: strat.vegaExposure,
            iv: currentIV, probabilityOTM: 100 - strat.probabilityOfProfit,
            probabilityOfProfit: strat.probabilityOfProfit,
            annualizedReturn: +annRet.toFixed(1), expectedValue: strat.expectedValue,
            kellyFraction: kelly,
            maxProfit: strat.maxProfit, maxLoss: strat.maxLoss,
            score: scoreStrategy(strat, ivContext, annRet, "credit"),
            rationale: `${dte}DTE Bull Put Spread $${K2}/$${K1} | ${strat.probabilityOfProfit.toFixed(0)}% PoP | EV $${strat.expectedValue.toFixed(0)} | ${annRet.toFixed(0)}% ann. return | delta ${strat.delta.toFixed(2)}`,
            direction: "credit", legs: 2,
          });
        }
      }
    }

    // 2. Bear Call Spread (bearish/neutral, defined-risk credit)
    if (direction !== "bullish") {
      const K1 = strikeForDelta(S, T, r, currentIV, sellDelta, "call");  // short call
      const K2 = Math.round((K1 + S * 0.03) / 1) * 1;  // 3% wide wing
      if (K1 > 0 && K2 > K1) {
        const strat = bearCallSpread(S, K1, K2, T, r, currentIV);
        const annRet = strat.margin > 0 ? (strat.maxProfit / strat.margin) * (365 / dte) * 100 : 0;
        const kelly = optionsKelly(strat.probabilityOfProfit / 100,
          strat.maxProfit / strat.margin, 1);
        if (strat.probabilityOfProfit > 52 && strat.netPremium > 0.05 && strat.expectedValue > -5) {
          opportunities.push({
            type: "call", strategy: "Bear Call Spread", strike: K1, strike2: K2,
            expDays: dte, premium: strat.netPremium / 100, delta: strat.delta,
            theta: strat.thetaPerDay, vega: strat.vegaExposure,
            iv: currentIV, probabilityOTM: 100 - strat.probabilityOfProfit,
            probabilityOfProfit: strat.probabilityOfProfit,
            annualizedReturn: +annRet.toFixed(1), expectedValue: strat.expectedValue,
            kellyFraction: kelly,
            maxProfit: strat.maxProfit, maxLoss: strat.maxLoss,
            score: scoreStrategy(strat, ivContext, annRet, "credit"),
            rationale: `${dte}DTE Bear Call Spread $${K1}/$${K2} | ${strat.probabilityOfProfit.toFixed(0)}% PoP | EV $${strat.expectedValue.toFixed(0)} | ${annRet.toFixed(0)}% ann. return | delta ${strat.delta.toFixed(2)}`,
            direction: "credit", legs: 2,
          });
        }
      }
    }

    // 3. Iron Condor (neutral, extreme IV — best theta/vega ratio)
    if (direction === "neutral" && ivContext.ivRank >= 60) {
      const Kp2 = strikeForDelta(S, T, r, currentIV, -sellDelta, "put");
      const Kp1 = Math.round((Kp2 - S * 0.025) / 1) * 1;
      const Kc1 = strikeForDelta(S, T, r, currentIV, sellDelta, "call");
      const Kc2 = Math.round((Kc1 + S * 0.025) / 1) * 1;
      if (Kp1 > 0 && Kp2 > Kp1 && Kc1 > Kp2 && Kc2 > Kc1) {
        const strat = ironCondor(S, Kp1, Kp2, Kc1, Kc2, T, r, currentIV);
        const annRet = strat.margin > 0 ? (strat.maxProfit / strat.margin) * (365 / dte) * 100 : 0;
        const kelly = optionsKelly(strat.probabilityOfProfit / 100,
          strat.maxProfit / strat.margin, 1);
        if (strat.probabilityOfProfit > 50 && strat.netPremium > 0.05 && strat.expectedValue > -5) {
          opportunities.push({
            type: "call", strategy: "Iron Condor",
            strike: Kp2, strike2: Kc1,  // short strikes
            expDays: dte, premium: strat.netPremium / 100, delta: 0,
            theta: strat.thetaPerDay, vega: strat.vegaExposure,
            iv: currentIV, probabilityOTM: 0,
            probabilityOfProfit: strat.probabilityOfProfit,
            annualizedReturn: +annRet.toFixed(1), expectedValue: strat.expectedValue,
            kellyFraction: kelly,
            maxProfit: strat.maxProfit, maxLoss: strat.maxLoss,
            score: scoreStrategy(strat, ivContext, annRet, "credit") * 1.1,  // bonus for neutral
            rationale: `${dte}DTE Iron Condor $${Kp2}P/$${Kc1}C | ${strat.probabilityOfProfit.toFixed(0)}% PoP | EV $${strat.expectedValue.toFixed(0)} | theta $${strat.thetaPerDay.toFixed(1)}/day`,
            direction: "credit", legs: 4,
          });
        }
      }
    }

    // 4. Cash-Secured Put (bullish only, single-leg — when high IV + strong bull signal)
    if (direction === "bullish" && ivContext.ivRank >= 50) {
      const K = strikeForDelta(S, T, r, currentIV, -sellDelta, "put");
      const strat = cashSecuredPut(S, K, T, r, currentIV);
      const annRet = K > 0 ? (strat.maxProfit / (K * 100)) * (365 / dte) * 100 : 0;
      const kelly = optionsKelly(strat.probabilityOfProfit / 100,
        strat.maxProfit / (K * 100), 1);
      if (strat.probabilityOfProfit > 55 && strat.expectedValue > -5) {
        opportunities.push({
          type: "put", strategy: "Cash-Secured Put", strike: K,
          expDays: dte, premium: blackScholes(S, K, T, r, currentIV, "put").price,
          delta: blackScholes(S, K, T, r, currentIV, "put").delta,
          theta: strat.thetaPerDay, vega: strat.vegaExposure,
          iv: currentIV, probabilityOTM: 100 - strat.probabilityOfProfit,
          probabilityOfProfit: strat.probabilityOfProfit,
          annualizedReturn: +annRet.toFixed(1), expectedValue: strat.expectedValue,
          kellyFraction: kelly,
          maxProfit: strat.maxProfit, maxLoss: strat.maxLoss,
          score: scoreStrategy(strat, ivContext, annRet, "credit"),
          rationale: `${dte}DTE CSP @ $${K} | ${strat.probabilityOfProfit.toFixed(0)}% PoP | ${annRet.toFixed(0)}% ann. | theta $${strat.thetaPerDay.toFixed(1)}/day`,
          direction: "credit", legs: 1,
        });
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // DEBIT STRATEGIES (IV low — buy options cheap into catalyst)
  // ─────────────────────────────────────────────────────────

  if (ivContext.ivRank < 40) {

    // 5. Bull Call Spread (bullish, low IV, defined risk debit)
    if (direction === "bullish") {
      const K1 = strikeForDelta(S, T, r, currentIV, buyDelta, "call");   // ATM-ish
      const K2 = Math.round((K1 + S * 0.05) / 1) * 1;  // 5% OTM wing
      if (K1 > 0 && K2 > K1) {
        const strat = bullCallSpread(S, K1, K2, T, r, currentIV);
        const annRet = Math.abs(strat.maxLoss) > 0
          ? (strat.maxProfit / Math.abs(strat.maxLoss)) * (365 / dte) * 100 : 0;
        const kelly = optionsKelly(strat.probabilityOfProfit / 100,
          strat.maxProfit / Math.abs(strat.maxLoss), 1);
        if (strat.riskReward >= 1.5 && strat.expectedValue > 0) {
          opportunities.push({
            type: "call", strategy: "Bull Call Spread", strike: K1, strike2: K2,
            expDays: dte, premium: Math.abs(strat.netPremium) / 100, delta: strat.delta,
            theta: strat.thetaPerDay, vega: strat.vegaExposure,
            iv: currentIV, probabilityOTM: 100 - strat.probabilityOfProfit,
            probabilityOfProfit: strat.probabilityOfProfit,
            annualizedReturn: +annRet.toFixed(1), expectedValue: strat.expectedValue,
            kellyFraction: kelly,
            maxProfit: strat.maxProfit, maxLoss: strat.maxLoss,
            score: scoreStrategy(strat, ivContext, annRet, "debit"),
            rationale: `${dte}DTE Bull Call Spread $${K1}/$${K2} | R/R ${strat.riskReward}:1 | EV $${strat.expectedValue.toFixed(0)} | ${strat.probabilityOfProfit.toFixed(0)}% PoP`,
            direction: "debit", legs: 2,
          });
        }
      }
    }

    // 6. Bear Put Spread (bearish, low IV, defined risk debit)
    if (direction === "bearish") {
      const K2 = strikeForDelta(S, T, r, currentIV, -(buyDelta), "put");
      const K1 = Math.round((K2 - S * 0.05) / 1) * 1;
      if (K1 > 0 && K2 > K1) {
        const strat = bearPutSpread(S, K1, K2, T, r, currentIV);
        const annRet = Math.abs(strat.maxLoss) > 0
          ? (strat.maxProfit / Math.abs(strat.maxLoss)) * (365 / dte) * 100 : 0;
        const kelly = optionsKelly(strat.probabilityOfProfit / 100,
          strat.maxProfit / Math.abs(strat.maxLoss), 1);
        if (strat.riskReward >= 1.5 && strat.expectedValue > 0) {
          opportunities.push({
            type: "put", strategy: "Bear Put Spread", strike: K2, strike2: K1,
            expDays: dte, premium: Math.abs(strat.netPremium) / 100, delta: strat.delta,
            theta: strat.thetaPerDay, vega: strat.vegaExposure,
            iv: currentIV, probabilityOTM: 100 - strat.probabilityOfProfit,
            probabilityOfProfit: strat.probabilityOfProfit,
            annualizedReturn: +annRet.toFixed(1), expectedValue: strat.expectedValue,
            kellyFraction: kelly,
            maxProfit: strat.maxProfit, maxLoss: strat.maxLoss,
            score: scoreStrategy(strat, ivContext, annRet, "debit"),
            rationale: `${dte}DTE Bear Put Spread $${K2}/$${K1} | R/R ${strat.riskReward}:1 | EV $${strat.expectedValue.toFixed(0)} | ${strat.probabilityOfProfit.toFixed(0)}% PoP`,
            direction: "debit", legs: 2,
          });
        }
      }
    }
  }

  if (opportunities.length === 0) return null;

  // Sort by composite score — higher = better
  opportunities.sort((a, b) => b.score - a.score);
  return opportunities[0];
}

// ─── Scoring Engine ───────────────────────────────────────────

function scoreStrategy(
  strat: StrategySummary,
  ivCtx: IVContext,
  annualizedReturn: number,
  type: "credit" | "debit",
): number {
  let score = 0;

  // 1. Probability of profit (40% weight — most important)
  score += (strat.probabilityOfProfit / 100) * 40;

  // 2. Expected value positive (20% weight)
  score += strat.expectedValue > 0 ? 20 : (strat.expectedValue > -10 ? 5 : 0);

  // 3. Annualized return quality (20% weight)
  score += Math.min(20, annualizedReturn * 0.2);

  // 4. IV alignment bonus (20% weight)
  if (type === "credit" && ivCtx.ivRank >= 50) score += 20;
  else if (type === "credit" && ivCtx.ivRank >= 35) score += 10;
  else if (type === "debit" && ivCtx.ivRank < 35) score += 20;
  else if (type === "debit" && ivCtx.ivRank < 50) score += 10;

  return +score.toFixed(1);
}

// ─── IV Crush Risk Calculator ─────────────────────────────────

/**
 * Estimate the P&L impact of an IV crush event (e.g., post-earnings)
 * Helps traders understand what happens to options prices if IV drops 30%
 */
export function ivCrushImpact(
  optionPrice: number, vega: number, ivDropPct: number,
): { newPrice: number; dollarLoss: number; pctLoss: number } {
  const dollarLoss = vega * ivDropPct;  // vega already per 1% IV change
  const newPrice = Math.max(0, optionPrice - dollarLoss);
  const pctLoss = optionPrice > 0 ? (dollarLoss / optionPrice) * 100 : 0;
  return {
    newPrice: +newPrice.toFixed(4),
    dollarLoss: +dollarLoss.toFixed(4),
    pctLoss: +pctLoss.toFixed(1),
  };
}

// ─── Put/Call Ratio Signal ────────────────────────────────────

export interface PCRatioSignal {
  ratio: number;                         // put volume / call volume
  signal: "extreme_bearish" | "bearish" | "neutral" | "bullish" | "extreme_bullish";
  contrarian: "buy" | "sell" | "neutral";  // contrarian interpretation
  interpretation: string;
}

/**
 * Interpret put/call ratio as a contrarian sentiment signal
 * High P/C = excessive fear = contrarian buy
 * Low P/C = excessive greed = contrarian sell
 */
export function interpretPCRatio(putVolume: number, callVolume: number): PCRatioSignal {
  if (callVolume <= 0) return {
    ratio: 99, signal: "extreme_bearish", contrarian: "buy",
    interpretation: "Extreme put buying — contrarian bullish signal",
  };
  const ratio = putVolume / callVolume;
  let signal: PCRatioSignal["signal"];
  let contrarian: PCRatioSignal["contrarian"];
  let interpretation: string;

  if (ratio > 1.5) {
    signal = "extreme_bearish"; contrarian = "buy";
    interpretation = `P/C ${ratio.toFixed(2)} — Extreme fear. Market overly hedged. Contrarian: BULLISH. Often marks short-term bottoms.`;
  } else if (ratio > 1.0) {
    signal = "bearish"; contrarian = "buy";
    interpretation = `P/C ${ratio.toFixed(2)} — Elevated put buying. Net bearish sentiment. Mild contrarian bullish lean.`;
  } else if (ratio > 0.7) {
    signal = "neutral"; contrarian = "neutral";
    interpretation = `P/C ${ratio.toFixed(2)} — Balanced. No extreme positioning. Follow primary trend.`;
  } else if (ratio > 0.5) {
    signal = "bullish"; contrarian = "sell";
    interpretation = `P/C ${ratio.toFixed(2)} — Elevated call buying. Complacency rising. Mild contrarian bearish lean.`;
  } else {
    signal = "extreme_bullish"; contrarian = "sell";
    interpretation = `P/C ${ratio.toFixed(2)} — Extreme call buying (YOLO). Euphoric. Contrarian: BEARISH. Often marks short-term tops.`;
  }
  return { ratio: +ratio.toFixed(3), signal, contrarian, interpretation };
}

// ─── Earnings Volatility Estimator ───────────────────────────

/**
 * Estimate expected move from earnings based on IV and time to expiry
 * Used to size options trades around earnings
 */
export function earningsExpectedMove(
  S: number, currentIV: number, daysToEarnings: number,
): {
  expectedMovePct: number;     // 1-SD expected move as % of stock price
  expectedMoveDollar: number;  // dollar amount
  straddePrice: number;        // ATM straddle fair value (both call + put)
  playable: boolean;           // true if the expected move is > 4% (worth trading)
} {
  const T = daysToEarnings / 365;
  const expectedMovePct = currentIV * Math.sqrt(T) * 100;
  const expectedMoveDollar = S * (expectedMovePct / 100);

  const call = blackScholes(S, S, T, 0.05, currentIV, "call");
  const put  = blackScholes(S, S, T, 0.05, currentIV, "put");
  const straddlePrice = call.price + put.price;

  return {
    expectedMovePct: +expectedMovePct.toFixed(1),
    expectedMoveDollar: +expectedMoveDollar.toFixed(2),
    straddePrice: +straddlePrice.toFixed(2),
    playable: expectedMovePct > 4,
  };
}
