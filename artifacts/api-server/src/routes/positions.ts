import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, positionsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { getSimulatedQuote } from "../lib/market-data.js";
import * as alpaca from "../lib/alpaca.js";

const router = Router();

// Black-Scholes to value open options positions
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

router.get("/", async (req, res) => {
  // ── 1. Get real stock positions from Alpaca ──────────────
  let stockPositions: any[] = [];
  let currentPrices: Record<string, number> = {};

  if (alpaca.isConfigured()) {
    try {
      const [alpacaPositions, account] = await Promise.all([
        alpaca.getPositions(),
        alpaca.getAccount(),
      ]);
      for (const p of alpacaPositions) {
        currentPrices[p.symbol] = parseFloat(p.current_price);
      }
      stockPositions = alpacaPositions.map((p) => {
        const qty = parseFloat(p.qty);
        const avgCost = parseFloat(p.avg_entry_price);
        const currentPrice = parseFloat(p.current_price);
        const marketValue = parseFloat(p.market_value);
        const unrealizedPnl = parseFloat(p.unrealized_pl);
        const costBasis = avgCost * qty;
        const unrealizedPnlPercent = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;
        return {
          id: p.asset_id.replace(/-/g, "").slice(0, 8),
          symbol: p.symbol,
          assetType: p.asset_class === "us_option" ? "option" : "stock",
          quantity: qty, avgCost, currentPrice, marketValue,
          unrealizedPnl, unrealizedPnlPercent,
          optionType: null, strikePrice: null, expirationDate: null,
          openedAt: new Date().toISOString(),
        };
      });
    } catch (err: any) {
      req.log.warn({ err }, "Alpaca positions fetch failed");
    }
  }

  // ── 2. Build option positions from DB orders ─────────────
  // Options are stored as orders (simulated) — reconstruct open positions
  const allOptionOrders = await db.select().from(ordersTable)
    .orderBy(desc(ordersTable.createdAt));

  const optionBuys: Record<string, {
    symbol: string; qty: number; entryPremium: number;
    optionType: string; strike: number; expiry: string;
    contracts: number; openedAt: any; agentName: string | null;
    strategy: string;
  }> = {};

  for (const o of allOptionOrders) {
    if (o.assetType !== "option") continue;
    const key = `${o.symbol}_${o.optionType}_${o.strikePrice}_${o.expirationDate}`;
    const qty = parseFloat(o.quantity);
    const fp = o.filledPrice ? parseFloat(o.filledPrice) : 0;

    if (o.side === "buy") {
      optionBuys[key] = {
        symbol: o.symbol,
        qty, entryPremium: fp,
        optionType: o.optionType ?? "call",
        strike: o.strikePrice ? parseFloat(o.strikePrice) : 0,
        expiry: o.expirationDate ?? "",
        contracts: qty,
        openedAt: o.filledAt ?? o.createdAt,
        agentName: o.agentName,
        strategy: o.reason?.match(/\[(.*?)\]/)?.[1] ?? "Option Trade",
      };
    } else if (o.side === "sell") {
      delete optionBuys[key]; // closed position
    }
  }

  // Value open option positions
  const optionPositions = Object.values(optionBuys)
    .filter(op => {
      // Filter out expired options
      if (!op.expiry) return true;
      return new Date(op.expiry) > new Date();
    })
    .map(op => {
      const S = currentPrices[op.symbol] ?? getSimulatedQuote(op.symbol).price;
      const T = op.expiry
        ? Math.max(0, (new Date(op.expiry).getTime() - Date.now()) / (365 * 24 * 3600 * 1000))
        : 21 / 365;
      const iv = 0.35; // assume 35% IV for valuation
      const currentValue = bsPrice(S, op.strike, T, iv, op.optionType as "call" | "put");
      const marketValue = currentValue * op.contracts * 100;
      const costBasis = op.entryPremium * op.contracts * 100;
      const unrealizedPnl = marketValue - costBasis;
      const unrealizedPnlPercent = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;

      return {
        id: `opt_${op.symbol}_${op.strike}`,
        symbol: op.symbol,
        assetType: "option",
        quantity: op.contracts,
        avgCost: op.entryPremium,
        currentPrice: +currentValue.toFixed(4),
        marketValue: +marketValue.toFixed(2),
        unrealizedPnl: +unrealizedPnl.toFixed(2),
        unrealizedPnlPercent: +unrealizedPnlPercent.toFixed(2),
        optionType: op.optionType,
        strikePrice: op.strike,
        expirationDate: op.expiry,
        openedAt: op.openedAt?.toISOString?.() ?? new Date().toISOString(),
        agentName: op.agentName,
        strategy: op.strategy,
        underlyingPrice: +S.toFixed(2),
      };
    });

  // ── 3. Merge stock + options ─────────────────────────────
  const all = [...stockPositions, ...optionPositions];
  res.json(all);
});

export { router as positionsRouter };
