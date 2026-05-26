const BASE_URL = "https://paper-api.alpaca.markets/v2";
const DATA_URL = "https://data.alpaca.markets/v2";

function headers() {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET;
  if (!key || !secret) throw new Error("ALPACA_API_KEY / ALPACA_API_SECRET not set");
  return {
    "APCA-API-KEY-ID": key,
    "APCA-API-SECRET-KEY": secret,
    "Content-Type": "application/json",
  };
}

async function alpacaFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw Object.assign(new Error(`Alpaca ${res.status}: ${text}`), { status: res.status, body: text });
  }
  return res.json() as Promise<T>;
}

// ─── Broker API ──────────────────────────────────────────────────────────────

export interface AlpacaAccount {
  id: string;
  cash: string;
  portfolio_value: string;
  equity: string;
  last_equity: string;
  buying_power: string;
  currency: string;
  status: string;
}

export interface AlpacaPosition {
  asset_id: string;
  symbol: string;
  asset_class: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  market_value: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  side: string;
  cost_basis: string;
}

export interface AlpacaOrder {
  id: string;
  client_order_id: string;
  symbol: string;
  asset_class: string;
  qty: string;
  filled_qty: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";
  time_in_force: string;
  limit_price: string | null;
  stop_price: string | null;
  filled_avg_price: string | null;
  status: string;
  created_at: string;
  filled_at: string | null;
  canceled_at: string | null;
  submitted_at: string;
}

export interface AlpacaSnapshot {
  latestTrade: { p: number; s: number; t: string };
  latestQuote: { ap: number; bp: number; as: number; bs: number; t: string };
  dailyBar: { o: number; h: number; l: number; c: number; v: number; t: string };
  prevDailyBar: { o: number; h: number; l: number; c: number; v: number; t: string };
  minuteBar: { o: number; h: number; l: number; c: number; v: number; t: string };
}

export function getAccount() {
  return alpacaFetch<AlpacaAccount>(`${BASE_URL}/account`);
}

export function getPositions() {
  return alpacaFetch<AlpacaPosition[]>(`${BASE_URL}/positions`);
}

export function getPosition(symbol: string) {
  return alpacaFetch<AlpacaPosition>(`${BASE_URL}/positions/${symbol.toUpperCase()}`);
}

export function closePosition(symbol: string, qty?: number) {
  const url = qty
    ? `${BASE_URL}/positions/${symbol.toUpperCase()}?qty=${qty}`
    : `${BASE_URL}/positions/${symbol.toUpperCase()}`;
  return alpacaFetch<AlpacaOrder>(url, { method: "DELETE" });
}

export function getOrders(params?: { status?: string; limit?: number; direction?: string }) {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.direction) qs.set("direction", params.direction);
  const q = qs.toString();
  return alpacaFetch<AlpacaOrder[]>(`${BASE_URL}/orders${q ? `?${q}` : ""}`);
}

export function getOrder(orderId: string) {
  return alpacaFetch<AlpacaOrder>(`${BASE_URL}/orders/${orderId}`);
}

export interface PlaceOrderParams {
  symbol: string;
  qty: number;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop";
  time_in_force: "day" | "gtc" | "ioc" | "fok";
  limit_price?: string;
  stop_price?: string;
}

export function placeOrder(params: PlaceOrderParams) {
  return alpacaFetch<AlpacaOrder>(`${BASE_URL}/orders`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function cancelOrder(orderId: string) {
  return alpacaFetch<void>(`${BASE_URL}/orders/${orderId}`, { method: "DELETE" });
}

// ─── Market Data API ─────────────────────────────────────────────────────────

export function getSnapshots(symbols: string[]) {
  const s = symbols.map(s => s.toUpperCase()).join(",");
  return alpacaFetch<Record<string, AlpacaSnapshot>>(
    `${DATA_URL}/stocks/snapshots?symbols=${encodeURIComponent(s)}&feed=iex`
  );
}

export function getSnapshot(symbol: string) {
  return alpacaFetch<AlpacaSnapshot>(
    `${DATA_URL}/stocks/${symbol.toUpperCase()}/snapshot?feed=iex`
  );
}

export function isConfigured() {
  return !!(process.env.ALPACA_API_KEY && process.env.ALPACA_API_SECRET);
}

// ─── Historical Bars ──────────────────────────────────────────────────────────

export interface AlpacaBar {
  t: string;  // ISO timestamp
  o: number;  // open
  h: number;  // high
  l: number;  // low
  c: number;  // close
  v: number;  // volume
}

export interface BarsResponse {
  bars: AlpacaBar[];
  symbol: string;
  next_page_token: string | null;
}

/** Fetch up to `limit` daily bars for a symbol */
export function getDailyBars(symbol: string, limit = 60): Promise<AlpacaBar[]> {
  const url = `${DATA_URL}/stocks/${symbol.toUpperCase()}/bars?timeframe=1Day&limit=${limit}&feed=iex&sort=asc`;
  return alpacaFetch<BarsResponse>(url).then(r => r.bars ?? []);
}

/** Fetch intraday bars (5m) for same-day analysis */
export function getIntradayBars(symbol: string, limit = 78): Promise<AlpacaBar[]> {
  const url = `${DATA_URL}/stocks/${symbol.toUpperCase()}/bars?timeframe=5Min&limit=${limit}&feed=iex&sort=asc`;
  return alpacaFetch<BarsResponse>(url).then(r => r.bars ?? []);
}

// ─── News / Sentiment ────────────────────────────────────────────────────────

export interface AlpacaNewsArticle {
  id: number;
  headline: string;
  summary: string;
  author: string;
  created_at: string;
  updated_at: string;
  url: string;
  content: string;
  symbols: string[];
  source: string;
}

/** Fetch latest N news articles for a symbol */
export async function getNews(symbol: string, limit = 10): Promise<AlpacaNewsArticle[]> {
  const url = `https://data.alpaca.markets/v1beta1/news?symbols=${symbol.toUpperCase()}&limit=${limit}&sort=desc`;
  try {
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) return [];
    const data = await res.json() as { news: AlpacaNewsArticle[] };
    return data.news ?? [];
  } catch {
    return [];
  }
}

