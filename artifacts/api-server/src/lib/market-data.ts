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
  AAPL:  { price: 189.30, change: 2.15,  changePercent: 1.15,  volume: 54200000,  high: 191.05, low: 187.50, open: 187.90, previousClose: 187.15, marketCap: 2920000000000 },
  MSFT:  { price: 415.60, change: -1.30, changePercent: -0.31, volume: 18700000,  high: 418.20, low: 413.40, open: 416.80, previousClose: 416.90, marketCap: 3090000000000 },
  NVDA:  { price: 875.40, change: 22.60, changePercent: 2.65,  volume: 42100000,  high: 882.50, low: 860.10, open: 862.00, previousClose: 852.80, marketCap: 2160000000000 },
  TSLA:  { price: 175.20, change: -4.80, changePercent: -2.67, volume: 89300000,  high: 180.50, low: 173.90, open: 179.60, previousClose: 180.00, marketCap: 558000000000  },
  AMZN:  { price: 183.75, change: 1.85,  changePercent: 1.02,  volume: 35600000,  high: 185.20, low: 182.10, open: 182.40, previousClose: 181.90, marketCap: 1910000000000 },
  GOOGL: { price: 172.40, change: 0.90,  changePercent: 0.52,  volume: 22400000,  high: 173.80, low: 171.20, open: 171.60, previousClose: 171.50, marketCap: 2140000000000 },
  META:  { price: 519.80, change: 8.20,  changePercent: 1.60,  volume: 15800000,  high: 523.40, low: 514.60, open: 515.20, previousClose: 511.60, marketCap: 1320000000000 },
  SPY:   { price: 527.30, change: 3.10,  changePercent: 0.59,  volume: 78500000,  high: 529.10, low: 525.40, open: 525.80, previousClose: 524.20, marketCap: null },
  QQQ:   { price: 448.60, change: 4.20,  changePercent: 0.94,  volume: 45200000,  high: 450.80, low: 446.30, open: 446.80, previousClose: 444.40, marketCap: null },
  AMD:   { price: 158.90, change: 3.40,  changePercent: 2.19,  volume: 67800000,  high: 161.20, low: 156.70, open: 157.10, previousClose: 155.50, marketCap: 256000000000  },
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
