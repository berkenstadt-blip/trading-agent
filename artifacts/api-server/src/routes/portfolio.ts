import { Router } from "express";
import { db } from "@workspace/db";
import { portfolioTable, positionsTable, ordersTable, performanceTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { ResetPortfolioBody } from "@workspace/api-zod";
import * as alpaca from "../lib/alpaca.js";

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

      res.json({
        id: portfolio.id,
        cashBalance: cash,
        totalValue: equity,
        totalPnl,
        totalPnlPercent,
        dayPnl,
        dayPnlPercent,
        initialCapital,
        buyingPower: parseFloat(account.buying_power),
        createdAt: portfolio.createdAt.toISOString(),
        updatedAt: portfolio.updatedAt.toISOString(),
        source: "alpaca",
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
