import { Router } from "express";
import { db } from "@workspace/db";
import { portfolioTable, positionsTable, ordersTable, performanceTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { ResetPortfolioBody } from "@workspace/api-zod";
import * as alpaca from "../lib/alpaca.js";
import { getSimulatedQuote } from "../lib/market-data.js";

// Black-Scholes to value simulated option positions
function normCDF(x: number): number {
  const a = 0.2316419, b1 = 0.319381530, b2 = -0.356563782,
        b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const t = 1 / (1 + a * Math.abs(x));
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const n = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? n : 1 - n;
}
function bsPrice(S: number, K: number, T: number, iv: number, type: "call" | "put"): number {
  if (T <= 0 || S <= 0 || K <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  const d1 = (Math.log(S / K) + (0.05 + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  if (type === "call") return Math.max(0, S * normCDF(d1) - K * Math.exp(-0.05 * T) * normCDF(d2));
  return Math.max(0, K * Math.exp(-0.05 * T) * normCDF(-d2) - S * normCDF(-d1));
}

/** Compute unrealized P&L of all open simulated option positions */
async function getSimulatedOptionsPnl(currentPrices: Record<string, number>): Promise<number> {
  const allOrders = await db.select().from(ordersTable);
  const optionBuys: Record<string, { qty: number; premium: number; strike: number; expiry: string; optType: string; symbol: string }> = {};

  for (const o of allOrders) {
    if (o.assetType !== "option") continue;
    const key = `${o.symbol}_${o.optionType}_${o.strikePrice}_${o.expirationDate}`;
    if (o.side === "buy") {
      optionBuys[key] = {
        symbol: o.symbol,
        qty: parseFloat(o.quantity),
        premium: o.filledPrice ? parseFloat(o.filledPrice) : 0,
        strike: o.strikePrice ? parseFloat(o.strikePrice) : 0,
        expiry: o.expirationDate ?? "",
        optType: o.optionType ?? "call",
      };
    } else {
      delete optionBuys[key];
    }
  }

  let unrealizedPnl = 0;
  for (const op of Object.values(optionBuys)) {
    if (!op.expiry || !op.strike || op.premium === 0) continue;
    if (new Date(op.expiry) <= new Date()) continue; // expired
    const S = currentPrices[op.symbol] ?? getSimulatedQuote(op.symbol).price;
    const T = Math.max(0, (new Date(op.expiry).getTime() - Date.now()) / (365 * 24 * 3600 * 1000));
    const currentVal = bsPrice(S, op.strike, T, 0.35, op.optType as "call" | "put");
    unrealizedPnl += (currentVal - op.premium) * op.qty * 100;
  }
  return unrealizedPnl;
}

const router = Router();

async function getOrCreatePortfolio() {
  const rows = await db.select().from(portfolioTable).limit(1);
  if (rows.length > 0) return rows[0];
  const [created] = await db.insert(portfolioTable).values({}).returning();
  return created;
}

async function computePortfolioSummary(portfolio: typeof portfolioTable.$inferSelect) {
  const positions = await db.select().from(positionsTable);
  const positionsValue = positions.reduce((sum, p) => {
    return sum + parseFloat(p.currentPrice) * parseFloat(p.quantity);
  }, 0);
  const cashBalance = parseFloat(portfolio.cashBalance);
  const initialCapital = parseFloat(portfolio.initialCapital);
  const totalValue = cashBalance + positionsValue;
  const totalPnl = totalValue - initialCapital;
  const totalPnlPercent = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

  const snapshots = await db
    .select()
    .from(performanceTable)
    .orderBy(desc(performanceTable.createdAt))
    .limit(2);
  let dayPnl = 0;
  let dayPnlPercent = 0;
  if (snapshots.length >= 2) {
    const prev = parseFloat(snapshots[1].portfolioValue);
    dayPnl = totalValue - prev;
    dayPnlPercent = prev > 0 ? (dayPnl / prev) * 100 : 0;
  }

  return {
    id: portfolio.id,
    cashBalance,
    totalValue,
    totalPnl,
    totalPnlPercent,
    dayPnl,
    dayPnlPercent,
    initialCapital,
    createdAt: portfolio.createdAt.toISOString(),
    updatedAt: portfolio.updatedAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  if (alpaca.isConfigured()) {
    try {
      const account = await alpaca.getAccount();
      const equity = parseFloat(account.equity);
      const lastEquity = parseFloat(account.last_equity);
      const cash = parseFloat(account.cash);
      const dayPnl = equity - lastEquity;
      const dayPnlPercent = lastEquity > 0 ? (dayPnl / lastEquity) * 100 : 0;

      // Use local DB for initial capital reference
      const portfolio = await getOrCreatePortfolio();
      const initialCapital = parseFloat(portfolio.initialCapital);
      const totalPnl = equity - initialCapital;
      const totalPnlPercent = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

      // Include unrealized P&L from simulated option positions
      const optionsPnl = await getSimulatedOptionsPnl(
        Object.fromEntries(
          (await alpaca.getPositions().catch(() => [])).map((p: any) => [p.symbol, parseFloat(p.current_price)])
        )
      );
      const adjustedEquity = equity + optionsPnl;
      const adjustedTotalPnl = adjustedEquity - initialCapital;
      const adjustedTotalPnlPercent = initialCapital > 0 ? (adjustedTotalPnl / initialCapital) * 100 : 0;
      const adjustedDayPnl = dayPnl + optionsPnl; // options P&L counted in today
      const adjustedDayPnlPercent = lastEquity > 0 ? (adjustedDayPnl / lastEquity) * 100 : 0;

      res.json({
        id: portfolio.id,
        cashBalance: cash,
        totalValue: +adjustedEquity.toFixed(2),
        totalPnl: +adjustedTotalPnl.toFixed(2),
        totalPnlPercent: +adjustedTotalPnlPercent.toFixed(2),
        dayPnl: +adjustedDayPnl.toFixed(2),
        dayPnlPercent: +adjustedDayPnlPercent.toFixed(2),
        initialCapital,
        buyingPower: parseFloat(account.buying_power),
        optionsPnl: +optionsPnl.toFixed(2),
        createdAt: portfolio.createdAt.toISOString(),
        updatedAt: portfolio.updatedAt.toISOString(),
        source: "alpaca+sim-options",
      });
      return;
    } catch (err: any) {
      req.log.warn({ err }, "Alpaca account fetch failed, falling back to simulated");
    }
  }

  const portfolio = await getOrCreatePortfolio();
  const summary = await computePortfolioSummary(portfolio);
  res.json({ ...summary, source: "simulated" });
});

router.post("/reset", async (req, res) => {
  const parsed = ResetPortfolioBody.safeParse(req.body);
  const initialCapital = parsed.success && parsed.data.initialCapital ? parsed.data.initialCapital : 100000;

  await db.delete(positionsTable);
  await db.delete(ordersTable);
  await db.delete(performanceTable);

  const existing = await db.select().from(portfolioTable).limit(1);
  let portfolio;
  if (existing.length > 0) {
    [portfolio] = await db
      .update(portfolioTable)
      .set({ cashBalance: initialCapital.toString(), initialCapital: initialCapital.toString() })
      .where(eq(portfolioTable.id, existing[0].id))
      .returning();
  } else {
    [portfolio] = await db
      .insert(portfolioTable)
      .values({ cashBalance: initialCapital.toString(), initialCapital: initialCapital.toString() })
      .returning();
  }

  const summary = await computePortfolioSummary(portfolio);
  res.json(summary);
});

export { router as portfolioRouter };
export { getOrCreatePortfolio, computePortfolioSummary };
