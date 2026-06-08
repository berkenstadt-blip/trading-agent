export interface MarketSnapshot {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  previousClose: number;
  marketCap: number | null;
}

const BASE_DATA: Record<string, Omit<MarketSnapshot, "symbol">> = {
  // ⚠️ Updated June 2026 — NVDA post-10:1 split (Jun 2024), TSLA/AMZN post-split adjusted
  AAPL:  { price: 211.00, change: 1.80,  changePercent: 0.86,  volume: 52000000,  high: 213.00, low: 209.50, open: 210.00, previousClose: 209.20, marketCap: 3200000000000 },
  MSFT:  { price: 470.00, change: 2.50,  changePercent: 0.53,  volume: 19000000,  high: 472.00, low: 468.00, open: 468.50, previousClose: 467.50, marketCap: 3500000000000 },
  NVDA:  { price: 135.00, change: 3.20,  changePercent: 2.43,  volume: 280000000, high: 137.00, low: 133.00, open: 133.50, previousClose: 131.80, marketCap: 3300000000000 },
  TSLA:  { price: 340.00, change: -5.00, changePercent: -1.45, volume: 95000000,  high: 347.00, low: 338.00, open: 345.00, previousClose: 345.00, marketCap: 1090000000000 },
  AMZN:  { price: 225.00, change: 2.10,  changePercent: 0.94,  volume: 38000000,  high: 227.00, low: 223.00, open: 223.50, previousClose: 222.90, marketCap: 2400000000000 },
  GOOGL: { price: 185.00, change: 1.20,  changePercent: 0.65,  volume: 24000000,  high: 186.50, low: 183.50, open: 184.00, previousClose: 183.80, marketCap: 2300000000000 },
  META:  { price: 650.00, change: 9.00,  changePercent: 1.40,  volume: 17000000,  high: 655.00, low: 644.00, open: 645.00, previousClose: 641.00, marketCap: 1650000000000 },
  SPY:   { price: 597.00, change: 3.50,  changePercent: 0.59,  volume: 80000000,  high: 599.00, low: 594.50, open: 595.00, previousClose: 593.50, marketCap: null },
  QQQ:   { price: 527.00, change: 4.80,  changePercent: 0.92,  volume: 48000000,  high: 529.00, low: 524.00, open: 524.50, previousClose: 522.20, marketCap: null },
  AMD:   { price: 168.00, change: 3.80,  changePercent: 2.32,  volume: 65000000,  high: 170.00, low: 165.50, open: 166.00, previousClose: 164.20, marketCap: 272000000000  },
};

// Mutable live prices that drift over time — seeded from BASE_DATA
const livePrices: Record<string, { price: number; previousClose: number }> = {};
for (const [symbol, data] of Object.entries(BASE_DATA)) {
  livePrices[symbol] = { price: data.price, previousClose: data.previousClose };
}

export function getSimulatedQuote(symbol: string): MarketSnapshot & { timestamp: string } {
  const key = symbol.toUpperCase();
  const base = BASE_DATA[key];

  if (base) {
    const live = livePrices[key]!;
    const price = +live.price.toFixed(2);
    const change = +(price - live.previousClose).toFixed(2);
    const changePercent = +((change / live.previousClose) * 100).toFixed(2);
    return {
      symbol: key,
      price,
      change,
      changePercent,
      volume: base.volume + Math.floor(Math.random() * 100000),
      high: Math.max(base.high, price),
      low: Math.min(base.low, price),
      open: base.open,
      previousClose: live.previousClose,
      marketCap: base.marketCap,
      timestamp: new Date().toISOString(),
    };
  }

  // Unknown symbol — generate plausible random data
  const price = +(50 + Math.random() * 500).toFixed(2);
  const change = +(Math.random() * 10 - 5).toFixed(2);
  return {
    symbol: key,
    price,
    change,
    changePercent: +((change / price) * 100).toFixed(2),
    volume: Math.floor(1000000 + Math.random() * 50000000),
    high: +(price * 1.02).toFixed(2),
    low: +(price * 0.98).toFixed(2),
    open: +(price - change * 0.5).toFixed(2),
    previousClose: +(price - change).toFixed(2),
    marketCap: null,
    timestamp: new Date().toISOString(),
  };
}

export interface PriceTick {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  direction: "up" | "down" | "flat";
}

/** Drift all live prices by a tiny random amount and return ticks */
export function tickAllPrices(): PriceTick[] {
  const ticks: PriceTick[] = [];
  for (const [symbol, live] of Object.entries(livePrices)) {
    const drift = (Math.random() - 0.499) * 0.3; // slight upward bias
    const newPrice = Math.max(1, +(live.price + drift).toFixed(2));
    const direction: PriceTick["direction"] =
      newPrice > live.price ? "up" : newPrice < live.price ? "down" : "flat";
    live.price = newPrice;
    const change = +(newPrice - live.previousClose).toFixed(2);
    const changePercent = +((change / live.previousClose) * 100).toFixed(2);
    ticks.push({ symbol, price: newPrice, change, changePercent, direction });
  }
  return ticks;
}

export { BASE_DATA };
