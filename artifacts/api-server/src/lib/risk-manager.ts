/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS RISK MANAGER — BEAST MODE (no artificial limits)
 *  Full Kelly sizing, no hard caps on position size or contracts.
 *  Paper trading: let it rip. Extraordinary results require full exposure.
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
  return etMins >= 570 && etMins < 945; // 9:30–15:45 ET
}

export function minutesToMarketClose(): number {
  const now = new Date();
  const etOff = isDST() ? -4 : -5;
  const etMins = ((now.getUTCHours() + 24 + etOff) % 24) * 60 + now.getUTCMinutes();
  return Math.max(0, 960 - etMins); // 16:00 = 960 min
}

// ─── Kelly Criterion — Full Kelly, no quarter-Kelly cap ───────

/**
 * Full Kelly fraction — maximum growth rate.
 * No artificial quarter-Kelly dampening. Paper trading = let it run.
 */
export function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0.25; // default aggressive when no history
  const w = Math.max(0.01, Math.min(0.99, winRate / 100));
  const b = avgWin / avgLoss;
  const kelly = (b * w - (1 - w)) / b;
  // Full Kelly, capped at 100% (allow going all-in when edge is strong)
  return Math.max(0.05, Math.min(1.0, kelly));
}

// ─── Position Sizing — No hard caps ───────────────────────────

export interface PositionSize {
  shares: number;
  dollarRisk: number;
  riskPct: number;
  dollarAmount: number;
}

/**
 * Aggressive Kelly-based sizing.
 * No per-trade cap — uses full portfolio value × Kelly fraction.
 * Paper trading: deploy as much as the math says.
 */
export function computePositionSize(
  price: number,
  stopLossPct: number,
  portfolioValue: number,
  kellyF: number,
  maxRiskPct = 100.0,  // no cap — use full Kelly
): PositionSize {
  // Dollar amount to deploy = portfolio × Kelly fraction
  const dollarAmount = portfolioValue * Math.min(kellyF, 1.0);
  const shares = price > 0 ? Math.floor(dollarAmount / price) : 1;
  const stopDistance = price * (stopLossPct / 100);
  const dollarRisk = shares * stopDistance;
  const riskPct = portfolioValue > 0 ? (dollarRisk / portfolioValue) * 100 : 0;
  return {
    shares: Math.max(1, shares),
    dollarRisk: +dollarRisk.toFixed(2),
    riskPct: +riskPct.toFixed(2),
    dollarAmount: +(shares * price).toFixed(2),
  };
}

// ─── Stop Levels ──────────────────────────────────────────────

export interface StopLevels {
  stopLoss: number;
  takeProfit1: number;  // 2R
  takeProfit2: number;  // 3R
  takeProfit3: number;  // 5R
  trailingStop: number;
}

export function computeStopLevels(
  entryPrice: number,
  atr: number,
  side: "long" | "short",
  atrMultiplier = 2,
): StopLevels {
  const stopDist = atr * atrMultiplier;
  if (side === "long") {
    return {
      stopLoss:    +(entryPrice - stopDist).toFixed(2),
      takeProfit1: +(entryPrice + stopDist * 2).toFixed(2),
      takeProfit2: +(entryPrice + stopDist * 3).toFixed(2),
      takeProfit3: +(entryPrice + stopDist * 5).toFixed(2),
      trailingStop: +(stopDist * 0.8).toFixed(2),
    };
  } else {
    return {
      stopLoss:    +(entryPrice + stopDist).toFixed(2),
      takeProfit1: +(entryPrice - stopDist * 2).toFixed(2),
      takeProfit2: +(entryPrice - stopDist * 3).toFixed(2),
      takeProfit3: +(entryPrice - stopDist * 5).toFixed(2),
      trailingStop: +(stopDist * 0.8).toFixed(2),
    };
  }
}

// ─── Circuit Breaker — Only stops on catastrophic loss ────────

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

  // Only halt on catastrophic daily loss: -25%
  const dailyLossPct = initialCapital > 0 ? (dailyPnL / initialCapital) * 100 : 0;
  if (dailyLossPct < -25.0) {
    return { halt: true, reason: `Catastrophic daily loss: ${dailyLossPct.toFixed(2)}%`, severity: "halt" };
  }

  // Max drawdown from peak: -40% (paper trading, extraordinary swings allowed)
  const drawdownPct = peakPortfolioValue > 0 ? ((currentPortfolioValue - peakPortfolioValue) / peakPortfolioValue) * 100 : 0;
  if (drawdownPct < -40.0) {
    return { halt: true, reason: `Max drawdown: ${drawdownPct.toFixed(2)}% from peak`, severity: "halt" };
  }

  // 10 consecutive losses = something is very wrong
  if (consecutiveLosses >= 10) {
    return { halt: true, reason: `${consecutiveLosses} consecutive losses — system check needed`, severity: "halt" };
  }

  // Last 5 min: don't open new positions
  if (minutesToClose < 5) {
    return { halt: true, reason: "< 5 min to close", severity: "halt" };
  }

  // Mild warning at -10% daily (but keep trading)
  if (dailyLossPct < -10.0) {
    return { halt: false, reason: `Heavy daily loss: ${dailyLossPct.toFixed(2)}% — consider reducing`, severity: "warning" };
  }

  return { halt: false, reason: "All clear", severity: "none" };
}

// ─── Portfolio Heat ───────────────────────────────────────────

export interface PortfolioHeatResult {
  totalHeatPct: number;
  isOverheated: boolean;
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
    isOverheated: totalHeat > 80, // warn at 80% of portfolio at risk (was 6%)
    positions: result,
  };
}

// ─── Trade Stats ──────────────────────────────────────────────

export interface TradeStats {
  winRate: number;
  avgWin: number;
  avgLoss: number;
  consecutiveLosses: number;
  totalTrades: number;
  expectancy: number;
}

export function computeTradeStats(
  orders: { filledPrice: string; side: string; quantity: string; agentId: number | null }[],
): TradeStats {
  if (orders.length < 2) return { winRate: 50, avgWin: 100, avgLoss: 100, consecutiveLosses: 0, totalTrades: 0, expectancy: 0 };

  const trades: number[] = [];
  let lastBuyPrice = 0;
  let lastBuyQty = 0;

  for (const o of orders) {
    const p = parseFloat(o.filledPrice);
    const q = parseFloat(o.quantity);
    if (o.side === "buy") { lastBuyPrice = p; lastBuyQty = q; }
    else if (o.side === "sell" && lastBuyPrice > 0) {
      trades.push((p - lastBuyPrice) * Math.min(q, lastBuyQty));
    }
  }

  if (trades.length === 0) return { winRate: 50, avgWin: 100, avgLoss: 100, consecutiveLosses: 0, totalTrades: 0, expectancy: 0 };

  const wins = trades.filter(t => t > 0);
  const losses = trades.filter(t => t <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 100;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 100;

  // Consecutive losses from the end
  let consec = 0;
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i] <= 0) consec++; else break;
  }

  const expectancy = (winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss;

  return {
    winRate: +winRate.toFixed(2),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    consecutiveLosses: consec,
    totalTrades: trades.length,
    expectancy: +expectancy.toFixed(2),
  };
}
