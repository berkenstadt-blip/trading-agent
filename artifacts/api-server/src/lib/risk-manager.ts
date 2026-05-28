/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS RISK MANAGER
 *  Kelly sizing, circuit breakers, portfolio heat, drawdown guard
 * ═══════════════════════════════════════════════════════════════
 */

// ─── Market Hours ─────────────────────────────────────────────

function isDST(): boolean {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  return now.getTimezoneOffset() < Math.max(jan, jul);
}

export function isMarketOpen(): boolean {
  const now = new Date();
  const etOff = isDST() ? -4 : -5;
  const etMins = ((now.getUTCHours() + 24 + etOff) % 24) * 60 + now.getUTCMinutes();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  return etMins >= 570 && etMins < 945; // 9:30–15:45
}

export function minutesToMarketClose(): number {
  const now = new Date();
  const etOff = isDST() ? -4 : -5;
  const etMins = ((now.getUTCHours() + 24 + etOff) % 24) * 60 + now.getUTCMinutes();
  return Math.max(0, 960 - etMins); // 16:00 = 960min
}

// ─── Kelly Criterion ──────────────────────────────────────────

/**
 * Quarter-Kelly fraction — conservative, prevents over-betting
 * Returns 0–0.25 (fraction of bankroll to risk per trade)
 */
export function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0.05;
  const w = Math.max(0.01, Math.min(0.99, winRate / 100));
  const b = avgWin / avgLoss; // win/loss ratio
  const kelly = (b * w - (1 - w)) / b;
  // Quarter Kelly + cap at 25%
  return Math.max(0.01, Math.min(0.25, kelly * 0.25));
}

// ─── Position Sizing ──────────────────────────────────────────

export interface PositionSize {
  shares: number;
  dollarRisk: number;
  riskPct: number;
  dollarAmount: number;
}

/**
 * ATR-based position sizing with Kelly overlay
 * Never risk more than 2% of portfolio per trade
 */
export function computePositionSize(
  price: number,
  stopLossPct: number,
  portfolioValue: number,
  kellyF: number,
  maxRiskPct = 2.0,
): PositionSize {
  const riskPct = Math.min(maxRiskPct, kellyF * 100);
  const dollarRisk = portfolioValue * (riskPct / 100);
  const stopDistance = price * (stopLossPct / 100);
  const shares = stopDistance > 0 ? Math.floor(dollarRisk / stopDistance) : 1;
  const dollarAmount = shares * price;
  return {
    shares: Math.max(1, shares),
    dollarRisk: +dollarRisk.toFixed(2),
    riskPct: +riskPct.toFixed(2),
    dollarAmount: +dollarAmount.toFixed(2),
  };
}

// ─── Recent Trade Stats ───────────────────────────────────────

export interface TradeStats {
  winRate: number;         // 0–100
  avgWin: number;          // avg profit per winning trade ($)
  avgLoss: number;         // avg loss per losing trade ($) — positive number
  recentWins: number;
  recentLosses: number;
  consecutiveLosses: number;
  lastTradeWasWin: boolean | null;
  expectancy: number;      // per-trade expected value
}

/** Compute stats from raw order data (pass filled orders sorted oldest→newest) */
export function computeTradeStats(
  orders: { filledPrice: string | null; side: string; quantity: string; agentId?: number | null }[],
  buyOrders?: { filledPrice: string; quantity: string; symbol: string }[]
): TradeStats {
  // Simple stat computation from available data
  const filled = orders.filter(o => o.filledPrice);
  if (filled.length === 0) {
    return { winRate: 50, avgWin: 100, avgLoss: 100, recentWins: 0, recentLosses: 0, consecutiveLosses: 0, lastTradeWasWin: null, expectancy: 0 };
  }

  // Approximate: sells with positive filled price trend = wins
  // In real usage, pair buys/sells by symbol
  const sells = filled.filter(o => o.side === "sell").slice(-20);
  let wins = 0, losses = 0, totalWin = 0, totalLoss = 0, consec = 0;

  // Without paired buy prices we approximate from agent totalPnl data
  // Use price momentum as proxy: if sell price > avg of recent sells = win
  const prices = sells.map(o => parseFloat(o.filledPrice!));
  const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;

  for (const p of prices) {
    if (p > avgPrice) { wins++; totalWin += (p - avgPrice) * 10; }
    else { losses++; totalLoss += (avgPrice - p) * 10; }
  }

  // Consecutive losses from end
  for (let i = prices.length - 1; i >= 0; i--) {
    if (prices[i] < avgPrice) consec++;
    else break;
  }

  const total = wins + losses;
  const wr = total > 0 ? (wins / total) * 100 : 50;
  const aw = wins > 0 ? totalWin / wins : 50;
  const al = losses > 0 ? totalLoss / losses : 50;
  const expectancy = (wr / 100) * aw - ((100 - wr) / 100) * al;

  return {
    winRate: +wr.toFixed(1),
    avgWin: +aw.toFixed(2),
    avgLoss: +al.toFixed(2),
    recentWins: wins,
    recentLosses: losses,
    consecutiveLosses: consec,
    lastTradeWasWin: total > 0 ? prices[prices.length - 1] >= avgPrice : null,
    expectancy: +expectancy.toFixed(2),
  };
}

// ─── Circuit Breaker ──────────────────────────────────────────

export interface CircuitBreakerResult {
  halt: boolean;
  reason: string;
  severity: "none" | "warning" | "halt";
}

export function checkCircuitBreaker(params: {
  dailyPnL: number;
  initialCapital: number;
  peakPortfolioValue: number;
  currentPortfolioValue: number;
  consecutiveLosses: number;
  minutesToClose: number;
}): CircuitBreakerResult {
  const { dailyPnL, initialCapital, peakPortfolioValue, currentPortfolioValue, consecutiveLosses, minutesToClose } = params;

  // Daily loss limit: -8% (was -3% — more aggressive, paper trading)
  const dailyLossPct = initialCapital > 0 ? (dailyPnL / initialCapital) * 100 : 0;
  if (dailyLossPct < -8.0) {
    return { halt: true, reason: `Daily loss limit hit: ${dailyLossPct.toFixed(2)}% (limit: -8%)`, severity: "halt" };
  }

  // Max drawdown from peak: -15% (was -8%)
  const drawdownPct = peakPortfolioValue > 0 ? ((currentPortfolioValue - peakPortfolioValue) / peakPortfolioValue) * 100 : 0;
  if (drawdownPct < -15.0) {
    return { halt: true, reason: `Max drawdown breached: ${drawdownPct.toFixed(2)}% from peak`, severity: "halt" };
  }

  // 6 consecutive losses (was 4)
  if (consecutiveLosses >= 6) {
    return { halt: true, reason: `${consecutiveLosses} consecutive losses — cooling off`, severity: "halt" };
  }

  // Too close to market close
  if (minutesToClose < 10) {
    return { halt: true, reason: "< 10 min to close — no new entries", severity: "halt" };
  }

  // Warnings (trade with caution)
  if (dailyLossPct < -4.0) {
    return { halt: false, reason: `Daily loss warning: ${dailyLossPct.toFixed(2)}%`, severity: "warning" };
  }

  if (consecutiveLosses >= 3) {
    return { halt: false, reason: `${consecutiveLosses} consecutive losses — reduce size`, severity: "warning" };
  }

  return { halt: false, reason: "All clear", severity: "none" };
}

// ─── Portfolio Heat ───────────────────────────────────────────

export interface PortfolioHeatResult {
  totalHeatPct: number;   // total % of portfolio at risk
  isOverheated: boolean;  // >6% total risk = overheated
  positions: { symbol: string; riskPct: number }[];
}

export function getPortfolioHeat(
  positions: { symbol: string; marketValue: number; stopLossPct: number }[],
  portfolioValue: number,
): PortfolioHeatResult {
  let totalHeat = 0;
  const result = positions.map(p => {
    const riskPct = portfolioValue > 0 ? (p.marketValue * (p.stopLossPct / 100)) / portfolioValue * 100 : 0;
    totalHeat += riskPct;
    return { symbol: p.symbol, riskPct: +riskPct.toFixed(2) };
  });
  return {
    totalHeatPct: +totalHeat.toFixed(2),
    isOverheated: totalHeat > 6.0,
    positions: result,
  };
}

// ─── Dynamic stop-loss levels ────────────────────────────────

export function computeStopLevels(
  entryPrice: number,
  atrValue: number,
  direction: "long" | "short",
  riskMultiplier = 2.0,
): {
  stopLoss: number;
  takeProfit1: number; // 2R
  takeProfit2: number; // 3R
  takeProfit3: number; // 5R
  riskAmount: number;
} {
  const risk = atrValue * riskMultiplier;
  const sl   = direction === "long" ? entryPrice - risk : entryPrice + risk;
  const tp1  = direction === "long" ? entryPrice + risk * 2 : entryPrice - risk * 2;
  const tp2  = direction === "long" ? entryPrice + risk * 3 : entryPrice - risk * 3;
  const tp3  = direction === "long" ? entryPrice + risk * 5 : entryPrice - risk * 5;
  return {
    stopLoss: +sl.toFixed(2),
    takeProfit1: +tp1.toFixed(2),
    takeProfit2: +tp2.toFixed(2),
    takeProfit3: +tp3.toFixed(2),
    riskAmount: +risk.toFixed(2),
  };
}
