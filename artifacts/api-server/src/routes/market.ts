import { Router } from "express";
import { db } from "@workspace/db";
import { watchlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AddToWatchlistBody } from "@workspace/api-zod";
import { getSimulatedQuote } from "../lib/market-data.js";

const router = Router();

router.get("/quote", async (req, res) => {
  const symbol = req.query.symbol as string;
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  const quote = getSimulatedQuote(symbol);
  res.json(quote);
});

router.get("/watchlist", async (req, res) => {
  const items = await db.select().from(watchlistTable).orderBy(watchlistTable.addedAt);
  const enriched = items.map((item) => {
    const quote = getSimulatedQuote(item.symbol);
    return {
      id: item.id,
      symbol: item.symbol,
      currentPrice: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
      addedAt: item.addedAt.toISOString(),
    };
  });
  res.json(enriched);
});

router.post("/watchlist", async (req, res) => {
  const parsed = AddToWatchlistBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const symbol = parsed.data.symbol.toUpperCase();
  const existing = await db.select().from(watchlistTable).where(eq(watchlistTable.symbol, symbol));
  if (existing.length > 0) {
    const quote = getSimulatedQuote(symbol);
    res.status(201).json({ id: existing[0].id, symbol, currentPrice: quote.price, change: quote.change, changePercent: quote.changePercent, addedAt: existing[0].addedAt.toISOString() });
    return;
  }
  const [item] = await db.insert(watchlistTable).values({ symbol }).returning();
  const quote = getSimulatedQuote(symbol);
  res.status(201).json({ id: item.id, symbol, currentPrice: quote.price, change: quote.change, changePercent: quote.changePercent, addedAt: item.addedAt.toISOString() });
});

router.delete("/watchlist/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await db.delete(watchlistTable).where(eq(watchlistTable.symbol, symbol));
  res.status(204).send();
});

export { router as marketRouter };
export { getSimulatedQuote };
