import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, agentsTable, performanceTable, portfolioTable, positionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { getSimulatedQuote } from "../lib/market-data.js";

const router = Router();

router.get("/performance", async (req, res) => {
  const period = (req.query.period as string) || "1m";

  // Get existing snapshots
  const snapshots = await db.select().from(performanceTable).orderBy(performanceTable.date);

  // Get current portfolio value
  const [portfolio] = await db.select().from(portfolioTable).limit(1);
  const positions = await db.select().from(positionsTable);
  const positionsValue = positions.reduce((sum, p) => {
    const quote = getSimulatedQuote(p.symbol);
    return sum + quote.price * parseFloat(p.quantity);
  }, 0);
  const currentValue = portfolio ? parseFloat(portfolio.cashBalance) + positionsValue : 100000;
  const initialCapital = portfolio ? parseFloat(portfolio.initialCapital) : 100000;

  // Build data points — use real snapshots + simulate historical data
  const now = new Date();
  const dataPoints: { date: string; portfolioValue: number; cashBalance: number; pnl: number }[] = [];

  const periodDays: Record<string, number> = { "1d": 1, "1w": 7, "1m": 30, "3m": 90, "1y": 365, "all": 365 };
  const days = periodDays[period] || 30;

  // Generate simulated historical data
  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0];

    // Find real snapshot for this date
    const snap = snapshots.find((s) => s.date === dateStr);
    if (snap) {
      dataPoints.push({ date: dateStr, portfolioValue: parseFloat(snap.portfolioValue), cashBalance: parseFloat(snap.cashBalance), pnl: parseFloat(snap.pnl) });
    } else {
      // Simulate: random walk from initial capital
      const progress = (days - i) / days;
      const noise = (Math.random() - 0.45) * initialCapital * 0.02;
      const trend = (currentValue - initialCapital) * progress;
      const value = initialCapital + trend + noise;
      dataPoints.push({ date: dateStr, portfolioValue: +value.toFixed(2), cashBalance: portfolio ? parseFloat(portfolio.cashBalance) : initialCapital, pnl: +(value - initialCapital).toFixed(2) });
    }
  }

  const firstVal = dataPoints[0]?.portfolioValue ?? initialCapital;
  const lastVal = dataPoints[dataPoints.length - 1]?.portfolioValue ?? initialCapital;
  const totalReturn = lastVal - firstVal;
  const totalReturnPercent = firstVal > 0 ? (totalReturn / firstVal) * 100 : 0;

  // Max drawdown
  let peak = firstVal;
  let maxDrawdown = 0;
  for (const dp of dataPoints) {
    if (dp.portfolioValue > peak) peak = dp.portfolioValue;
    const drawdown = (peak - dp.portfolioValue) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Simplified Sharpe ratio approximation
  const returns = dataPoints.slice(1).map((dp, i) => (dp.portfolioValue - dataPoints[i].portfolioValue) / dataPoints[i].portfolioValue);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const stdDev = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1));
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  res.json({ period, dataPoints, totalReturn: +totalReturn.toFixed(2), totalReturnPercent: +totalReturnPercent.toFixed(2), maxDrawdown: +maxDrawdown.toFixed(4), sharpeRatio: +sharpeRatio.toFixed(2) });
});

router.get("/summary", async (req, res) => {
  const filledOrders = await db.select().from(ordersTable).where(eq(ordersTable.status, "filled"));

  const totalTrades = filledOrders.length;
  let winningTrades = 0;
  let losingTrades = 0;
  let totalWin = 0;
  let totalLoss = 0;
  let bestTrade = 0;
  let worstTrade = 0;
  let totalVolume = 0;
  let stockTrades = 0;
  let optionTrades = 0;

  for (const order of filledOrders) {
    const qty = parseFloat(order.quantity);
    const fp = order.filledPrice ? parseFloat(order.filledPrice) : 0;
    const value = qty * fp;
    totalVolume += value;
    if (order.assetType === "option") optionTrades++;
    else stockTrades++;

    // Simulate P&L per trade
    const pnl = (Math.random() - 0.4) * value * 0.05;
    if (pnl > 0) { winningTrades++; totalWin += pnl; if (pnl > bestTrade) bestTrade = pnl; }
    else { losingTrades++; totalLoss += Math.abs(pnl); if (pnl < worstTrade) worstTrade = pnl; }
  }

  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const avgWin = winningTrades > 0 ? totalWin / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;

  res.json({ totalTrades, winningTrades, losingTrades, winRate: +winRate.toFixed(2), avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2), profitFactor: +profitFactor.toFixed(2), bestTrade: +bestTrade.toFixed(2), worstTrade: +worstTrade.toFixed(2), totalVolume: +totalVolume.toFixed(2), stockTrades, optionTrades });
});

router.get("/agent-performance", async (req, res) => {
  const agents = await db.select().from(agentsTable);
  const result = agents.map((a) => ({
    agentId: a.id,
    agentName: a.name,
    strategy: a.strategy,
    totalTrades: a.totalTrades,
    winRate: parseFloat(a.winRate),
    totalPnl: parseFloat(a.totalPnl),
    isActive: a.isActive,
  }));
  res.json(result);
});

// Distinct colors for up to 8 agents
const AGENT_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#84cc16", // lime
];

router.get("/agent-history", async (req, res) => {
  const period = (req.query.period as string) || "1m";
  const periodDays: Record<string, number> = { "1w": 7, "1m": 30, "3m": 90, "1y": 365 };
  const days = periodDays[period] ?? 30;

  const agents = await db.select().from(agentsTable);

  const now = new Date();

  // Build one data-point per day for every agent
  // Each agent's cumulative P&L follows a random walk seeded from its total P&L
  const dataPoints: Record<string, number | string>[] = [];

  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;
    dataPoints.push({ date: dateStr });
  }

  // Deterministic-ish seed per agent so lines are smooth and stable
  for (const [idx, agent] of agents.entries()) {
    const totalPnl = parseFloat(agent.totalPnl);
    // Work backwards: end value = totalPnl, start = ~0
    // Use a consistent seed so values don't change each request
    const seed = agent.id * 12345;
    let cumPnl = 0;
    const driftPerDay = totalPnl / (days || 1);

    for (let i = 0; i <= days; i++) {
      // Pseudo-random noise based on seed + day index
      const noise = (((seed * (i + 1) * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * Math.abs(driftPerDay) * 1.8;
      cumPnl += driftPerDay + noise;
      const point = dataPoints[i];
      if (point) point[agent.name] = +cumPnl.toFixed(2);
    }
  }

  const result = {
    agents: agents.map((a, i) => ({
      id: a.id,
      name: a.name,
      strategy: a.strategy,
      color: AGENT_COLORS[i % AGENT_COLORS.length]!,
    })),
    dataPoints,
  };

  res.json(result);
});

export { router as analyticsRouter };
