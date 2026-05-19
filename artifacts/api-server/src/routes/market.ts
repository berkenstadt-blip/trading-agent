import { Router } from "express";
import { db } from "@workspace/db";
import { watchlistTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { AddToWatchlistBody } from "@workspace/api-zod";

const router = Router();

// Simulated market data - realistic prices for well-known symbols
const MARKET_DATA: Record<string, { price: number; change: number; changePercent: number; volume: number; high: number; low: number; open: number; previousClose: number; marketCap: number }> = {
  AAPL: { price: 189.30, change: 2.15, changePercent: 1.15, volume: 54200000, high: 191.05, low: 187.50, open: 187.90, previousClose: 187.15, marketCap: 2920000000000 },
  MSFT: { price: 415.60, change: -1.30, changePercent: -0.31, volume: 18700000, high: 418.20, low: 413.40, open: 416.80, previousClose: 416.90, marketCap: 3090000000000 },
  NVDA: { price: 875.40, change: 22.60, changePercent: 2.65, volume: 42100000, high: 882.50, low: 860.10, open: 862.00, previousClose: 852.80, marketCap: 2160000000000 },
  TSLA: { price: 175.20, change: -4.80, changePercent: -2.67, volume: 89300000, high: 180.50, low: 173.90, open: 179.60, previousClose: 180.00, marketCap: 558000000000 },
  AMZN: { price: 183.75, change: 1.85, changePercent: 1.02, volume: 35600000, high: 185.20, low: 182.10, open: 182.40, previousClose: 181.90, marketCap: 1910000000000 },
  GOOGL: { price: 172.40, change: 0.90, changePercent: 0.52, volume: 22400000, high: 173.80, low: 171.20, open: 171.60, previousClose: 171.50, marketCap: 2140000000000 },
  META: { price: 519.80, change: 8.20, changePercent: 1.60, volume: 15800000, high: 523.40, low: 514.60, open: 515.20, previousClose: 511.60, marketCap: 1320000000000 },
  SPY: { price: 527.30, change: 3.10, changePercent: 0.59, volume: 78500000, high: 529.10, low: 525.40, open: 525.80, previousClose: 524.20, marketCap: null as unknown as number },
  QQQ: { price: 448.60, change: 4.20, changePercent: 0.94, volume: 45200000, high: 450.80, low: 446.30, open: 446.80, previousClose: 444.40, marketCap: null as unknown as number },
  AMD: { price: 158.90, change: 3.40, changePercent: 2.19, volume: 67800000, high: 161.20, low: 156.70, open: 157.10, previousClose: 155.50, marketCap: 256000000000 },
};

function getSimulatedQuote(symbol: string) {
  const base = MARKET_DATA[symbol.toUpperCase()];
  if (base) {
    // Add small random noise to simulate live data
    const noise = (Math.random() - 0.5) * 0.5;
    return { ...base, price: +(base.price + noise).toFixed(2), symbol: symbol.toUpperCase() };
  }
  // Generate a random plausible quote for unknown symbols
  const price = +(50 + Math.random() * 500).toFixed(2);
  const change = +(Math.random() * 10 - 5).toFixed(2);
  return {
    symbol: symbol.toUpperCase(),
    price,
    change,
    changePercent: +((change / price) * 100).toFixed(2),
    volume: Math.floor(1000000 + Math.random() * 50000000),
    high: +(price * 1.02).toFixed(2),
    low: +(price * 0.98).toFixed(2),
    open: +(price - change * 0.5).toFixed(2),
    previousClose: +(price - change).toFixed(2),
    marketCap: Math.floor(1000000000 + Math.random() * 100000000000),
  };
}

router.get("/quote", async (req, res) => {
  const symbol = req.query.symbol as string;
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  const quote = getSimulatedQuote(symbol);
  res.json({ ...quote, timestamp: new Date().toISOString() });
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
