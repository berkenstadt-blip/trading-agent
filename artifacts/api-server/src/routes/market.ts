import { Router } from "express";
import { db } from "@workspace/db";
import { watchlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AddToWatchlistBody } from "@workspace/api-zod";
import { getSimulatedQuote } from "../lib/market-data.js";
import * as alpaca from "../lib/alpaca.js";

const router = Router();

async function getQuote(symbol: string) {
  if (alpaca.isConfigured()) {
    try {
      const snap = await alpaca.getSnapshot(symbol);
      const price = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
      const prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
      const change = +(price - prevClose).toFixed(2);
      const changePercent = prevClose > 0 ? +((change / prevClose) * 100).toFixed(2) : 0;
      return {
        symbol: symbol.toUpperCase(),
        price,
        change,
        changePercent,
        volume: snap.dailyBar?.v ?? 0,
        high: snap.dailyBar?.h ?? price,
        low: snap.dailyBar?.l ?? price,
        open: snap.dailyBar?.o ?? price,
        previousClose: prevClose,
        marketCap: null,
        timestamp: snap.latestTrade?.t ?? new Date().toISOString(),
        source: "alpaca",
      };
    } catch {
      // fall through
    }
  }
  return { ...getSimulatedQuote(symbol), source: "simulated" };
}

router.get("/quote", async (req, res) => {
  const symbol = req.query.symbol as string;
  if (!symbol) { res.status(400).json({ error: "symbol is required" }); return; }
  const quote = await getQuote(symbol);
  res.json(quote);
});

router.get("/watchlist", async (req, res) => {
  const items = await db.select().from(watchlistTable).orderBy(watchlistTable.addedAt);

  if (alpaca.isConfigured() && items.length > 0) {
    try {
      const symbols = items.map(i => i.symbol);
      const snaps = await alpaca.getSnapshots(symbols);
      const enriched = items.map(item => {
        const snap = snaps[item.symbol];
        if (!snap) {
          const q = getSimulatedQuote(item.symbol);
          return { id: item.id, symbol: item.symbol, currentPrice: q.price, change: q.change, changePercent: q.changePercent, addedAt: item.addedAt.toISOString(), source: "simulated" };
        }
        const price = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
        const prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
        const change = +(price - prevClose).toFixed(2);
        const changePercent = prevClose > 0 ? +((change / prevClose) * 100).toFixed(2) : 0;
        return { id: item.id, symbol: item.symbol, currentPrice: price, change, changePercent, addedAt: item.addedAt.toISOString(), source: "alpaca" };
      });
      res.json(enriched);
      return;
    } catch {
      // fall through
    }
  }

  const enriched = items.map(item => {
    const quote = getSimulatedQuote(item.symbol);
    return { id: item.id, symbol: item.symbol, currentPrice: quote.price, change: quote.change, changePercent: quote.changePercent, addedAt: item.addedAt.toISOString(), source: "simulated" };
  });
  res.json(enriched);
});

router.post("/watchlist", async (req, res) => {
  const parsed = AddToWatchlistBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const symbol = parsed.data.symbol.toUpperCase();

  const existing = await db.select().from(watchlistTable).where(eq(watchlistTable.symbol, symbol));
  const item = existing.length > 0
    ? existing[0]
    : (await db.insert(watchlistTable).values({ symbol }).returning())[0];

  const quote = await getQuote(symbol);
  res.status(201).json({ id: item.id, symbol, currentPrice: quote.price, change: quote.change, changePercent: quote.changePercent, addedAt: item.addedAt.toISOString(), source: quote.source });
});

router.delete("/watchlist/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await db.delete(watchlistTable).where(eq(watchlistTable.symbol, symbol));
  res.status(204).send();
});

export { router as marketRouter };
export { getSimulatedQuote };
