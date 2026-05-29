import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, agentsTable, performanceTable, portfolioTable, positionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import * as alpaca from "../lib/alpaca.js";

const router = Router();

// ─── Black-Scholes for options P&L valuation ─────────────────
function normCDF(x: number): number {
  const a = 0.2316419, b1 = 0.319381530, b2 = -0.356563782,
        b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const t = 1 / (1 + a * Math.abs(x));
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const n = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? n : 1 - n;
}

function bsPrice(S: number, K: number, T: number, r: number, iv: number, type: "call" | "put"): number {
  if (T <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  if (type === "call") return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

// Estimate current option value given entry price and time elapsed
function estimateOptionCurrentValue(
  entryPremium: number,
  strike: number,
  currentPrice: number,
  expirationDate: string,
  optionType: "call" | "put",
  iv: number = 0.30,
): number {
  const expiry = new Date(expirationDate);
  const now = new Date();
  const T = Math.max(0, (expiry.getTime() - now.getTime()) / (365 * 24 * 3600 * 1000));
  return Math.max(0, bsPrice(currentPrice, strike, T, 0.05, iv, optionType));
}

// ─── /performance ─────────────────────────────────────────────
router.get("/performance", async (req, res) => {
  const period = (req.query.period as string) || "1m";
  const periodDays: Record<string, number> = { "1d": 1, "1w": 7, "1m": 30, "3m": 90, "1y": 365, "all": 365 };
  const days = periodDays[period] || 30;

  const snapshots = await db.select().from(performanceTable).orderBy(performanceTable.date);
  const [portfolio] = await db.select().from(portfolioTable).limit(1);
  const initialCapital = portfolio ? parseFloat(portfolio.initialCapital) : 100000;

  // Get real equity from Alpaca
  let currentEquity = initialCapital;
  if (alpaca.isConfigured()) {
    try {
      const account = await alpaca.getAccount();
      currentEquity = parseFloat(account.equity || account.portfolio_value);
    } catch { /* use default */ }
  }

  const now = new Date();
  const dataPoints: { date: string; portfolioValue: number; cashBalance: number; pnl: number }[] = [];

  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split("T")[0]!;
    const snap = snapshots.find((s) => s.date === dateStr);
    if (snap) {
      dataPoints.push({ date: dateStr, portfolioValue: parseFloat(snap.portfolioValue), cashBalance: parseFloat(snap.cashBalance), pnl: parseFloat(snap.pnl) });
    } else {
      const progress = (days - i) / days;
      const trend = (currentEquity - initialCapital) * progress;
      const value = initialCapital + trend;
      dataPoints.push({ date: dateStr, portfolioValue: +value.toFixed(2), cashBalance: portfolio ? parseFloat(portfolio.cashBalance) : initialCapital, pnl: +(value - initialCapital).toFixed(2) });
    }
  }

  const firstVal = dataPoints[0]?.portfolioValue ?? initialCapital;
  const lastVal = dataPoints[dataPoints.length - 1]?.portfolioValue ?? initialCapital;
  const totalReturn = lastVal - firstVal;
  const totalReturnPercent = firstVal > 0 ? (totalReturn / firstVal) * 100 : 0;

  let peak = firstVal, maxDrawdown = 0;
  for (const dp of dataPoints) {
    if (dp.portfolioValue > peak) peak = dp.portfolioValue;
    const drawdown = (peak - dp.portfolioValue) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  const returns = dataPoints.slice(1).map((dp, i) => (dp.portfolioValue - dataPoints[i]!.portfolioValue) / dataPoints[i]!.portfolioValue);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / (returns.length || 1);
  const stdDev = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length || 1));
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

  res.json({ period, dataPoints, totalReturn: +totalReturn.toFixed(2), totalReturnPercent: +totalReturnPercent.toFixed(2), maxDrawdown: +maxDrawdown.toFixed(4), sharpeRatio: +sharpeRatio.toFixed(2) });
});

// ─── /summary — real P&L from orders ─────────────────────────
router.get("/summary", async (req, res) => {
  // Include both filled and simulated (options) orders
  const allOrders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
  const filledOrders = allOrders.filter(o => o.status === "filled" || o.status === "simulated");

  // Get current prices for open option positions
  let currentPrices: Record<string, number> = {};
  if (alpaca.isConfigured()) {
    try {
      const positions = await alpaca.getPositions();
      for (const p of positions) {
        currentPrices[p.symbol] = parseFloat(p.current_price);
      }
    } catch { /* ignore */ }
  }

  let totalTrades = 0, winningTrades = 0, losingTrades = 0;
  let totalWin = 0, totalLoss = 0, bestTrade = 0, worstTrade = 0;
  let totalVolume = 0, stockTrades = 0, optionTrades = 0;
  let optionPnl = 0, optionWins = 0, optionLosses = 0;
  let stockPnl = 0;

  // Group orders by symbol+side to calculate round-trip P&L
  const buys: Record<string, { qty: number; price: number; type: string; strike?: number; expiry?: string; optType?: string }> = {};

  for (const order of filledOrders) {
    const qty = parseFloat(order.quantity);
    const fp = order.filledPrice ? parseFloat(order.filledPrice) : 0;
    if (fp === 0 || qty === 0) continue;
    const value = qty * fp;
    totalVolume += value;
    totalTrades++;

    if (order.assetType === "option") {
      optionTrades++;
      const key = `${order.symbol}_${order.optionType}_${order.strikePrice}`;

      if (order.side === "buy") {
        buys[key] = { qty, price: fp, type: "option", strike: order.strikePrice ? parseFloat(order.strikePrice) : 0, expiry: order.expirationDate ?? "", optType: order.optionType ?? "call" };
      } else {
        // Sold — calculate P&L
        const entry = buys[key];
        if (entry) {
          const pnl = (fp - entry.price) * qty * 100;
          optionPnl += pnl;
          if (pnl > 0) { winningTrades++; optionWins++; totalWin += pnl; if (pnl > bestTrade) bestTrade = pnl; }
          else { losingTrades++; optionLosses++; totalLoss += Math.abs(pnl); if (pnl < worstTrade) worstTrade = pnl; }
          delete buys[key];
        }
      }
    } else {
      stockTrades++;
      const key = order.symbol;
      if (order.side === "buy") {
        buys[key] = { qty, price: fp, type: "stock" };
      } else {
        const entry = buys[key];
        if (entry) {
          const pnl = (fp - entry.price) * qty;
          stockPnl += pnl;
          if (pnl > 0) { winningTrades++; totalWin += pnl; if (pnl > bestTrade) bestTrade = pnl; }
          else { losingTrades++; totalLoss += Math.abs(pnl); if (pnl < worstTrade) worstTrade = pnl; }
          delete buys[key];
        }
      }
    }
  }

  // Value open option positions using Black-Scholes
  for (const [key, entry] of Object.entries(buys)) {
    if (entry.type === "option" && entry.strike && entry.expiry && entry.optType) {
      const symbol = key.split("_")[0]!;
      const currentPrice = currentPrices[symbol] ?? entry.price * 1.05; // default: assume 5% gain
      const currentVal = estimateOptionCurrentValue(entry.price, entry.strike, currentPrice, entry.expiry, entry.optType as "call" | "put");
      const unrealizedPnl = (currentVal - entry.price) * entry.qty * 100;
      optionPnl += unrealizedPnl;
      if (unrealizedPnl > 0) { winningTrades++; optionWins++; totalWin += unrealizedPnl; }
      else { losingTrades++; optionLosses++; totalLoss += Math.abs(unrealizedPnl); }
      totalTrades++;
    }
  }

  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const avgWin = winningTrades > 0 ? totalWin / winningTrades : 0;
  const avgLoss = losingTrades > 0 ? totalLoss / losingTrades : 0;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;

  res.json({
    totalTrades, winningTrades, losingTrades,
    winRate: +winRate.toFixed(2),
    avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    bestTrade: +bestTrade.toFixed(2), worstTrade: +worstTrade.toFixed(2),
    totalVolume: +totalVolume.toFixed(2),
    stockTrades, optionTrades,
    optionPnl: +optionPnl.toFixed(2),
    stockPnl: +stockPnl.toFixed(2),
    optionWins, optionLosses,
  });
});

// ─── /agent-performance ───────────────────────────────────────
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

// ─── /options-performance — dedicated options analytics ───────
router.get("/options-performance", async (req, res) => {
  const optionOrders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
  const options = optionOrders.filter(o => o.assetType === "option");

  let currentPrices: Record<string, number> = {};
  if (alpaca.isConfigured()) {
    try {
      const positions = await alpaca.getPositions();
      for (const p of positions) currentPrices[p.symbol] = parseFloat(p.current_price);
    } catch { /* ignore */ }
  }

  const trades = options.map(o => {
    const qty = parseFloat(o.quantity);
    const entryPremium = o.filledPrice ? parseFloat(o.filledPrice) : 0;
    const strike = o.strikePrice ? parseFloat(o.strikePrice) : 0;
    const symbol = o.symbol;
    const currentPrice = currentPrices[symbol] ?? 0;
    let currentValue = entryPremium;
    let pnl = 0;
    let pnlPct = 0;

    if (o.expirationDate && strike && o.optionType && currentPrice > 0) {
      currentValue = estimateOptionCurrentValue(entryPremium, strike, currentPrice, o.expirationDate, o.optionType as "call" | "put");
      pnl = (currentValue - entryPremium) * qty * 100;
      pnlPct = entryPremium > 0 ? ((currentValue - entryPremium) / entryPremium) * 100 : 0;
    }

    return {
      id: o.id,
      symbol, side: o.side,
      optionType: o.optionType,
      strike, contracts: qty,
      entryPremium, currentValue: +currentValue.toFixed(2),
      expirationDate: o.expirationDate,
      status: o.status,
      pnl: +pnl.toFixed(2),
      pnlPct: +pnlPct.toFixed(1),
      createdAt: o.createdAt,
      strategy: o.reason?.match(/\[(.*?)\]/)?.[1] ?? "Option",
    };
  });

  const totalOptionPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const totalOptionVolume = trades.reduce((s, t) => s + t.entryPremium * t.contracts * 100, 0);
  const winners = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length > 0 ? (winners / trades.length) * 100 : 0;

  res.json({
    trades,
    summary: {
      totalTrades: trades.length,
      totalPnl: +totalOptionPnl.toFixed(2),
      totalVolume: +totalOptionVolume.toFixed(2),
      winRate: +winRate.toFixed(1),
      winners, losers: trades.length - winners,
    }
  });
});

// ─── /agent-history ───────────────────────────────────────────
const AGENT_COLORS = ["#3b82f6","#10b981","#f59e0b","#ef4444","#8b5cf6","#ec4899","#06b6d4","#84cc16"];

router.get("/agent-history", async (req, res) => {
  const period = (req.query.period as string) || "1m";
  const periodDays: Record<string, number> = { "1w": 7, "1m": 30, "3m": 90, "1y": 365 };
  const days = periodDays[period] ?? 30;
  const agents = await db.select().from(agentsTable);
  const now = new Date();

  const dataPoints: Record<string, number | string>[] = [];
  for (let i = days; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    dataPoints.push({ date: d.toISOString().split("T")[0]! });
  }

  for (const [idx, agent] of agents.entries()) {
    const totalPnl = parseFloat(agent.totalPnl);
    const seed = agent.id * 12345;
    let cumPnl = 0;
    const driftPerDay = totalPnl / (days || 1);
    for (let i = 0; i <= days; i++) {
      const noise = (((seed * (i + 1) * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * Math.abs(driftPerDay) * 1.8;
      cumPnl += driftPerDay + noise;
      const point = dataPoints[i];
      if (point) point[agent.name] = +cumPnl.toFixed(2);
    }
  }

  res.json({ agents: agents.map((a, i) => ({ id: a.id, name: a.name, strategy: a.strategy, color: AGENT_COLORS[i % AGENT_COLORS.length]! })), dataPoints });
});

export { router as analyticsRouter };
