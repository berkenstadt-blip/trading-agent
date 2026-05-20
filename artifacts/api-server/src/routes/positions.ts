import { Router } from "express";
import { db } from "@workspace/db";
import { positionsTable } from "@workspace/db";
import { getSimulatedQuote } from "../lib/market-data.js";
import * as alpaca from "../lib/alpaca.js";

const router = Router();

router.get("/", async (req, res) => {
  if (alpaca.isConfigured()) {
    try {
      const [alpacaPositions, account] = await Promise.all([
        alpaca.getPositions(),
        alpaca.getAccount(),
      ]);

      const enriched = alpacaPositions.map((p) => {
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
          quantity: qty,
          avgCost,
          currentPrice,
          marketValue,
          unrealizedPnl,
          unrealizedPnlPercent,
          optionType: null,
          strikePrice: null,
          expirationDate: null,
          openedAt: new Date().toISOString(),
          _alpacaId: p.asset_id,
        };
      });

      res.json(enriched);
      return;
    } catch (err: any) {
      req.log.warn({ err }, "Alpaca positions fetch failed, falling back to simulated");
    }
  }

  // Fallback: local DB + simulated prices
  const positions = await db.select().from(positionsTable);
  const enriched = positions.map((p) => {
    const quote = getSimulatedQuote(p.symbol);
    const currentPrice = quote.price;
    const avgCost = parseFloat(p.avgCost);
    const quantity = parseFloat(p.quantity);
    const marketValue = currentPrice * quantity;
    const costBasis = avgCost * quantity;
    const unrealizedPnl = marketValue - costBasis;
    const unrealizedPnlPercent = costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : 0;
    return {
      id: p.id,
      symbol: p.symbol,
      assetType: p.assetType,
      quantity,
      avgCost,
      currentPrice,
      marketValue,
      unrealizedPnl,
      unrealizedPnlPercent,
      optionType: p.optionType,
      strikePrice: p.strikePrice ? parseFloat(p.strikePrice) : null,
      expirationDate: p.expirationDate,
      openedAt: p.openedAt.toISOString(),
    };
  });
  res.json(enriched);
});

export { router as positionsRouter };
