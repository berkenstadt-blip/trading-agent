import { Router } from "express";
import { db } from "@workspace/db";
import { positionsTable } from "@workspace/db";
import { getSimulatedQuote } from "./market.js";

const router = Router();

router.get("/", async (req, res) => {
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
