/**
 * ═══════════════════════════════════════════════════════════════
 *  AEGIS DATA FEEDS — Institutional Market Intelligence
 *
 *  Sources:
 *  - FRED API — real Fed rate, CPI, yield curve (free)
 *  - Alpha Vantage — earnings calendar, EPS data (ALPHA_VANTAGE_API_KEY)
 *  - Firecrawl — fast scraping: Finviz, OpenInsider, Benzinga (FIRECRAWL_API_KEY)
 *  - OpenInsider — SEC Form 4 insider transactions (free fallback)
 *  - Yahoo Finance — analyst targets, fundamentals (free fallback)
 * ═══════════════════════════════════════════════════════════════
 */

import { logger } from "./logger.js";

// ─── Types ────────────────────────────────────────────────────

export interface MacroContext {
  fedFundsRate: number | null;       // actual current Fed rate
  cpi: number | null;                // latest CPI YoY %
  unemployment: number | null;       // latest unemployment rate %
  tenYearYield: number | null;       // 10Y Treasury yield %
  twoYearYield: number | null;       // 2Y Treasury yield %
  yieldSpread: number | null;        // 10Y - 2Y spread (negative = inverted)
  vix: number | null;                // VIX (approx from SPX vol)
  dxy: number | null;                // USD index (approx)
  regimeLabel: string;               // human-readable regime
  dataAge: string;                   // when data was last updated
}

export interface EarningsInfo {
  symbol: string;
  earningsDate: string | null;       // ISO date string or null
  daysUntilEarnings: number | null;  // negative = already reported
  fiscalQuarter: string | null;
  estimatedEPS: number | null;
  actualEPS: number | null;
  surprise: number | null;           // % surprise vs estimate
  isEarningsSoon: boolean;           // within 14 days
}

export interface InsiderActivity {
  symbol: string;
  transactions: {
    date: string;
    insider: string;
    title: string;
    type: "buy" | "sell";
    shares: number;
    price: number;
    value: number;
  }[];
  netBuyValue: number;               // positive = net buying
  signal: "bullish" | "bearish" | "neutral";
  summary: string;
}

export interface AnalystRating {
  symbol: string;
  consensus: "strong_buy" | "buy" | "hold" | "sell" | "strong_sell" | "unknown";
  avgTarget: number | null;
  numAnalysts: number;
  upside: number | null;             // % upside to avg target
  recentChanges: string[];           // recent upgrade/downgrade descriptions
}

export interface ShortData {
  symbol: string;
  shortFloat: number | null;        // % of float that is short
  shortRatio: number | null;        // days to cover
  shortInterest: number | null;     // total shares short
  signal: "high" | "medium" | "low" | "unknown";
}

// ─── Cache — avoid hammering free APIs ───────────────────────

const cache = new Map<string, { data: unknown; ts: number }>();

function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data as T);
  return fn().then(data => {
    cache.set(key, { data, ts: Date.now() });
    return data;
  });
}

async function safeFetch<T>(url: string, opts?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AegisBot/1.0)",
        ...(opts?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

/**
 * Firecrawl scrape — bypasses bot detection on Finviz, Benzinga, etc.
 * Falls back to raw fetch if FIRECRAWL_API_KEY not set.
 */
async function firecrawlScrape(url: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 15000,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { success: boolean; data?: { markdown?: string } };
    return data?.data?.markdown ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch raw HTML with browser-like headers
 */
async function fetchHtml(url: string, extraHeaders?: Record<string, string>): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.google.com/",
        ...extraHeaders,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

// ─── FRED API — Real macro data from Federal Reserve ─────────
// No key needed for most series. FRED_API_KEY env var for higher limits.

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FRED_KEY  = process.env.FRED_API_KEY ?? ""; // optional — public data works without it
const AV_KEY    = process.env.ALPHA_VANTAGE_API_KEY ?? "103IXR0IRNPQYRSO"; // Alpha Vantage
// Note: FIRECRAWL_API_KEY is read via process.env inside firecrawlScrape()

async function fredLatest(seriesId: string): Promise<number | null> {
  const url = `${FRED_BASE}?series_id=${seriesId}&limit=1&sort_order=desc&file_type=json${FRED_KEY ? `&api_key=${FRED_KEY}` : ""}`;
  const data = await safeFetch<{ observations: { value: string }[] }>(url);
  const val = data?.observations?.[0]?.value;
  if (!val || val === ".") return null;
  return parseFloat(val);
}

export async function getMacroContext(): Promise<MacroContext> {
  return cached("macro_context", 30 * 60 * 1000, async () => { // cache 30 min
    logger.info("Fetching real macro data from FRED...");

    // Run all FRED fetches in parallel
    const [fedRate, cpi, unemployment, t10y, t2y] = await Promise.all([
      fredLatest("FEDFUNDS"),          // Fed Funds Rate
      fredLatest("CPIAUCSL"),          // CPI (level — we compute YoY below)
      fredLatest("UNRATE"),            // Unemployment rate
      fredLatest("DGS10"),             // 10Y Treasury yield
      fredLatest("DGS2"),              // 2Y Treasury yield
    ]);

    // CPI YoY: fetch last 2 readings (monthly)
    let cpiYoY: number | null = null;
    try {
      const cpiUrl = `${FRED_BASE}?series_id=CPIAUCSL&limit=13&sort_order=desc&file_type=json${FRED_KEY ? `&api_key=${FRED_KEY}` : ""}`;
      const cpiData = await safeFetch<{ observations: { value: string }[] }>(cpiUrl);
      const obs = cpiData?.observations?.filter(o => o.value !== ".") ?? [];
      if (obs.length >= 13) {
        const recent = parseFloat(obs[0].value);
        const yearAgo = parseFloat(obs[12].value);
        cpiYoY = yearAgo > 0 ? +((recent - yearAgo) / yearAgo * 100).toFixed(2) : null;
      }
    } catch { /* ignore */ }

    const yieldSpread = (t10y !== null && t2y !== null) ? +(t10y - t2y).toFixed(3) : null;

    // Regime label
    let regimeLabel = "Unknown";
    if (fedRate !== null && t10y !== null) {
      const inverted = yieldSpread !== null && yieldSpread < 0;
      const hawkish  = fedRate > 4.0;
      if (hawkish && inverted) regimeLabel = "Risk-Off: High rates + inverted curve (recession signal)";
      else if (hawkish && !inverted) regimeLabel = "Cautious: High rates, curve normalizing";
      else if (!hawkish && inverted) regimeLabel = "Mixed: Low rates but inverted curve";
      else regimeLabel = "Risk-On: Low rates, normal curve";
    }

    return {
      fedFundsRate: fedRate,
      cpi: cpiYoY,
      unemployment,
      tenYearYield: t10y,
      twoYearYield: t2y,
      yieldSpread,
      vix: null,   // would need paid data or SPX calculation
      dxy: null,   // would need market data
      regimeLabel,
      dataAge: new Date().toISOString(),
    } satisfies MacroContext;
  });
}

// ─── Earnings Calendar — StockAnalysis.com (free scraping) ───

export async function getEarningsInfo(symbol: string): Promise<EarningsInfo> {
  return cached(`earnings_${symbol}`, 4 * 60 * 60 * 1000, async () => { // cache 4h
    const base: EarningsInfo = {
      symbol, earningsDate: null, daysUntilEarnings: null,
      fiscalQuarter: null, estimatedEPS: null, actualEPS: null,
      surprise: null, isEarningsSoon: false,
    };

    // Try Alpha Vantage earnings (free tier — 500 calls/day)
    if (AV_KEY) {
      try {
        const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${symbol}&apikey=${AV_KEY}`;
        const data = await safeFetch<{
          annualEarnings?: unknown[];
          quarterlyEarnings?: { fiscalDateEnding: string; reportedDate: string; reportedEPS: string; estimatedEPS: string; surprise: string; surprisePercentage: string }[];
        }>(url);

        const quarterly = data?.quarterlyEarnings;
        if (quarterly && quarterly.length > 0) {
          const latest = quarterly[0];
          const reported = latest.reportedEPS !== "None" ? parseFloat(latest.reportedEPS) : null;
          const estimated = latest.estimatedEPS !== "None" ? parseFloat(latest.estimatedEPS) : null;
          const surprise = latest.surprisePercentage !== "None" ? parseFloat(latest.surprisePercentage) : null;

          // Next earnings: look at reportedDate of latest to estimate next
          const lastDate = new Date(latest.reportedDate);
          const nextDate = new Date(lastDate);
          nextDate.setMonth(nextDate.getMonth() + 3); // quarterly
          const daysUntil = Math.round((nextDate.getTime() - Date.now()) / 86400000);

          return {
            symbol,
            earningsDate: nextDate.toISOString().split("T")[0],
            daysUntilEarnings: daysUntil,
            fiscalQuarter: latest.fiscalDateEnding,
            estimatedEPS: estimated,
            actualEPS: reported,
            surprise,
            isEarningsSoon: daysUntil >= 0 && daysUntil <= 14,
          };
        }
      } catch { /* fall through */ }
    }

    // Fallback: Yahoo Finance earnings date (no key needed)
    try {
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=calendarEvents,earnings`;
      const data = await safeFetch<{
        quoteSummary?: {
          result?: [{
            calendarEvents?: {
              earnings?: { earningsDate?: { raw: number }[] };
            };
          }];
        };
      }>(url);

      const earningsDateRaw = data?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate?.[0]?.raw;
      if (earningsDateRaw) {
        const earningsDate = new Date(earningsDateRaw * 1000);
        const daysUntil = Math.round((earningsDate.getTime() - Date.now()) / 86400000);
        return {
          ...base,
          earningsDate: earningsDate.toISOString().split("T")[0],
          daysUntilEarnings: daysUntil,
          isEarningsSoon: daysUntil >= 0 && daysUntil <= 14,
        };
      }
    } catch { /* ignore */ }

    return base;
  });
}

// ─── OpenInsider — SEC Form 4 insider transactions ────────────
// Free, no key. Scrapes SEC data via openinsider.com JSON endpoint.

export async function getInsiderActivity(symbol: string): Promise<InsiderActivity> {
  return cached(`insiders_${symbol}`, 24 * 60 * 60 * 1000, async () => { // cache 24h
    const base: InsiderActivity = {
      symbol, transactions: [], netBuyValue: 0, signal: "neutral",
      summary: "No insider data available",
    };

    try {
      // Try Firecrawl first for OpenInsider (better parsing)
      const url = `https://openinsider.com/screener?s=${symbol}&fd=-180&td=0&fmt=json`;
      let html = await firecrawlScrape(url);
      if (!html) html = await fetchHtml(url);

      // Parse the JSON table from the HTML response
      const tableMatch = html.match(/\[.*?\]/s);
      if (!tableMatch) return base;

      const rows: string[][] = JSON.parse(tableMatch[0]);
      const transactions: InsiderActivity["transactions"] = [];
      let netBuy = 0;

      for (const row of rows.slice(1, 20)) { // skip header, limit 20
        // Row format: [#, filing, trade date, ticker, company, insider, title, type, price, qty, owned, delta%, value]
        if (!row || row.length < 13) continue;
        const type = row[7]?.includes("P") ? "buy" : "sell"; // P-Purchase, S-Sale
        const price = parseFloat(row[8]?.replace(/[$,]/g, "") ?? "0") || 0;
        const shares = parseInt(row[9]?.replace(/,/g, "") ?? "0") || 0;
        const value = price * shares;

        if (price > 0 && shares > 0) {
          transactions.push({
            date: row[2] ?? "unknown",
            insider: row[5] ?? "Unknown",
            title: row[6] ?? "",
            type,
            shares,
            price,
            value,
          });
          netBuy += type === "buy" ? value : -value;
        }
      }

      if (transactions.length === 0) return base;

      const signal: InsiderActivity["signal"] =
        netBuy > 100000 ? "bullish" :
        netBuy < -100000 ? "bearish" : "neutral";

      const buys  = transactions.filter(t => t.type === "buy");
      const sells = transactions.filter(t => t.type === "sell");
      const summary = `${buys.length} insider buys ($${(buys.reduce((a,t)=>a+t.value,0)/1000).toFixed(0)}K) vs ${sells.length} sells ($${(Math.abs(sells.reduce((a,t)=>a+t.value,0))/1000).toFixed(0)}K) in last 6 months. Net: ${netBuy > 0 ? "+" : ""}$${(netBuy/1000).toFixed(0)}K`;

      return { symbol, transactions: transactions.slice(0, 10), netBuyValue: netBuy, signal, summary };
    } catch (e) {
      logger.warn({ e, symbol }, "Insider data fetch failed");
      return base;
    }
  });
}

// ─── Short Interest — Finviz (free scraping) ─────────────────

export async function getShortData(symbol: string): Promise<ShortData> {
  return cached(`short_${symbol}`, 24 * 60 * 60 * 1000, async () => {
    const base: ShortData = { symbol, shortFloat: null, shortRatio: null, shortInterest: null, signal: "unknown" };
    const url = `https://finviz.com/quote.ashx?t=${symbol}&ty=c&p=d&b=1`;

    try {
      // Try Firecrawl first (bypasses Finviz bot detection reliably)
      let html = await firecrawlScrape(url);
      // Fallback to raw fetch with browser headers
      if (!html) html = await fetchHtml(url, { "Referer": "https://finviz.com/" });
      if (!html) return base;

      const shortFloatMatch    = html.match(/Short Float[^%\d]*(\d+\.?\d*)%/i);
      const shortRatioMatch    = html.match(/Short Ratio[^\d]*(\d+\.?\d*)/i);
      const shortInterestMatch = html.match(/Short Interest[^\d]*([\d,]+)/i);

      const shortFloat       = shortFloatMatch  ? parseFloat(shortFloatMatch[1])  : null;
      const shortRatio       = shortRatioMatch  ? parseFloat(shortRatioMatch[1])  : null;
      const shortInterestRaw = shortInterestMatch ? parseInt(shortInterestMatch[1].replace(/,/g, "")) : null;

      const signal: ShortData["signal"] =
        shortFloat !== null
          ? shortFloat > 20 ? "high" : shortFloat > 10 ? "medium" : "low"
          : "unknown";

      logger.info({ symbol, shortFloat, shortRatio, signal }, "Short data fetched");
      return { symbol, shortFloat, shortRatio, shortInterest: shortInterestRaw, signal };
    } catch (e) {
      logger.warn({ e, symbol }, "Short data fetch failed");
      return base;
    }
  });
}

// ─── Analyst Ratings — Yahoo Finance (free) ──────────────────

export async function getAnalystRatings(symbol: string): Promise<AnalystRating> {
  return cached(`analyst_${symbol}`, 24 * 60 * 60 * 1000, async () => {
    const base: AnalystRating = {
      symbol, consensus: "unknown", avgTarget: null,
      numAnalysts: 0, upside: null, recentChanges: [],
    };

    try {
      // Yahoo Finance analyst summary
      const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${symbol}?modules=recommendationTrend,financialData`;
      const data = await safeFetch<{
        quoteSummary?: {
          result?: [{
            recommendationTrend?: {
              trend?: { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }[];
            };
            financialData?: {
              targetMeanPrice?: { raw: number };
              numberOfAnalystOpinions?: { raw: number };
              currentPrice?: { raw: number };
            };
          }];
        };
      }>(url);

      const result = data?.quoteSummary?.result?.[0];
      if (!result) return base;

      const trend = result.recommendationTrend?.trend?.[0]; // most recent
      const financial = result.financialData;

      const avgTarget = financial?.targetMeanPrice?.raw ?? null;
      const currentPrice = financial?.currentPrice?.raw ?? null;
      const numAnalysts = financial?.numberOfAnalystOpinions?.raw ?? 0;
      const upside = (avgTarget && currentPrice) ? +((avgTarget - currentPrice) / currentPrice * 100).toFixed(1) : null;

      // Compute consensus
      let consensus: AnalystRating["consensus"] = "unknown";
      if (trend) {
        const total = trend.strongBuy + trend.buy + trend.hold + trend.sell + trend.strongSell;
        if (total > 0) {
          const score = (trend.strongBuy * 5 + trend.buy * 4 + trend.hold * 3 + trend.sell * 2 + trend.strongSell * 1) / total;
          consensus = score >= 4.5 ? "strong_buy" :
                      score >= 3.8 ? "buy" :
                      score >= 3.0 ? "hold" :
                      score >= 2.0 ? "sell" : "strong_sell";
        }
      }

      return { symbol, consensus, avgTarget, numAnalysts, upside, recentChanges: [] };
    } catch (e) {
      logger.warn({ e, symbol }, "Analyst ratings fetch failed");
      return base;
    }
  });
}

// ─── Composite Intelligence — all feeds in one call ──────────

export interface SymbolIntelligence {
  macro: MacroContext;
  earnings: EarningsInfo;
  insiders: InsiderActivity;
  shortData: ShortData;
  analysts: AnalystRating;
  fetchedAt: string;
}

export async function getSymbolIntelligence(symbol: string): Promise<SymbolIntelligence> {
  // Run all in parallel — individual failures return safe defaults
  const [macro, earnings, insiders, shortData, analysts] = await Promise.all([
    getMacroContext().catch(() => ({
      fedFundsRate: null, cpi: null, unemployment: null,
      tenYearYield: null, twoYearYield: null, yieldSpread: null,
      vix: null, dxy: null, regimeLabel: "Data unavailable",
      dataAge: new Date().toISOString(),
    } satisfies MacroContext)),
    getEarningsInfo(symbol).catch(() => ({
      symbol, earningsDate: null, daysUntilEarnings: null,
      fiscalQuarter: null, estimatedEPS: null, actualEPS: null,
      surprise: null, isEarningsSoon: false,
    } satisfies EarningsInfo)),
    getInsiderActivity(symbol).catch(() => ({
      symbol, transactions: [], netBuyValue: 0,
      signal: "neutral" as const, summary: "Insider data unavailable",
    } satisfies InsiderActivity)),
    getShortData(symbol).catch(() => ({
      symbol, shortFloat: null, shortRatio: null,
      shortInterest: null, signal: "unknown" as const,
    } satisfies ShortData)),
    getAnalystRatings(symbol).catch(() => ({
      symbol, consensus: "unknown" as const, avgTarget: null,
      numAnalysts: 0, upside: null, recentChanges: [],
    } satisfies AnalystRating)),
  ]);

  return { macro, earnings, insiders, shortData, analysts, fetchedAt: new Date().toISOString() };
}

// ─── Format for LLM prompt ────────────────────────────────────

export function formatIntelligenceForPrompt(intel: SymbolIntelligence): string {
  const { macro, earnings, insiders, shortData, analysts } = intel;

  const macroStr = `
── REAL MACRO DATA (FRED) ──
Fed Funds Rate: ${macro.fedFundsRate !== null ? `${macro.fedFundsRate}%` : "N/A"}
CPI (YoY): ${macro.cpi !== null ? `${macro.cpi}%` : "N/A"}
Unemployment: ${macro.unemployment !== null ? `${macro.unemployment}%` : "N/A"}
10Y Treasury: ${macro.tenYearYield !== null ? `${macro.tenYearYield}%` : "N/A"}
2Y Treasury: ${macro.twoYearYield !== null ? `${macro.twoYearYield}%` : "N/A"}
Yield Spread (10Y-2Y): ${macro.yieldSpread !== null ? `${macro.yieldSpread}% ${macro.yieldSpread < 0 ? "⚠️ INVERTED" : "normal"}` : "N/A"}
Regime: ${macro.regimeLabel}`;

  const earningsStr = earnings.earningsDate ? `
── EARNINGS CALENDAR ──
Next Earnings: ${earnings.earningsDate} (${earnings.daysUntilEarnings !== null ? `${earnings.daysUntilEarnings} days` : "unknown"})
${earnings.isEarningsSoon ? "⚠️ EARNINGS WITHIN 14 DAYS — IV expansion expected" : ""}
Last EPS: Actual $${earnings.actualEPS ?? "?"} vs Est $${earnings.estimatedEPS ?? "?"} (${earnings.surprise !== null ? `${earnings.surprise > 0 ? "+" : ""}${earnings.surprise}% surprise` : "?"})` : "";

  const insiderStr = insiders.transactions.length > 0 ? `
── INSIDER ACTIVITY (SEC Form 4) ──
${insiders.summary}
Signal: ${insiders.signal.toUpperCase()}
Recent: ${insiders.transactions.slice(0,3).map(t => `${t.insider} (${t.title}) ${t.type.toUpperCase()} ${t.shares.toLocaleString()} shares @ $${t.price} on ${t.date}`).join(" | ")}` : "";

  const shortStr = shortData.shortFloat !== null ? `
── SHORT INTEREST ──
Short Float: ${shortData.shortFloat}% ${shortData.shortFloat > 20 ? "⚠️ HIGH — squeeze potential" : shortData.shortFloat > 10 ? "elevated" : "normal"}
Days to Cover: ${shortData.shortRatio ?? "N/A"}
Signal: ${shortData.signal.toUpperCase()}` : "";

  const analystStr = analysts.numAnalysts > 0 ? `
── ANALYST CONSENSUS ──
Consensus: ${analysts.consensus.toUpperCase().replace("_", " ")} (${analysts.numAnalysts} analysts)
Avg Target: ${analysts.avgTarget ? `$${analysts.avgTarget}` : "N/A"} | Upside: ${analysts.upside !== null ? `${analysts.upside > 0 ? "+" : ""}${analysts.upside}%` : "N/A"}` : "";

  return [macroStr, earningsStr, insiderStr, shortStr, analystStr].filter(Boolean).join("\n");
}
