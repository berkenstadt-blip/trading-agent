import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, portfolioTable, positionsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { PlaceOrderBody } from "@workspace/api-zod";
import { getSimulatedQuote } from "./market.js";

const router = Router();

function serializeOrder(o: typeof ordersTable.$inferSelect) {
  return {
    id: o.id,
    symbol: o.symbol,
    assetType: o.assetType,
    side: o.side,
    orderType: o.orderType,
    quantity: parseFloat(o.quantity),
    limitPrice: o.limitPrice ? parseFloat(o.limitPrice) : null,
    stopPrice: o.stopPrice ? parseFloat(o.stopPrice) : null,
    filledPrice: o.filledPrice ? parseFloat(o.filledPrice) : null,
    status: o.status,
    agentId: o.agentId,
    agentName: o.agentName,
    reason: o.reason,
    optionType: o.optionType,
    strikePrice: o.strikePrice ? parseFloat(o.strikePrice) : null,
    expirationDate: o.expirationDate,
    createdAt: o.createdAt.toISOString(),
    filledAt: o.filledAt ? o.filledAt.toISOString() : null,
  };
}

router.get("/", async (req, res) => {
  const status = req.query.status as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;

  let query = db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(limit);
  if (status && status !== "all") {
    const results = await db.select().from(ordersTable).where(eq(ordersTable.status, status)).orderBy(desc(ordersTable.createdAt)).limit(limit);
    res.json(results.map(serializeOrder));
    return;
  }
  const results = await query;
  res.json(results.map(serializeOrder));
});

router.post("/", async (req, res) => {
  const parsed = PlaceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  // For market orders, fill immediately
  let filledPrice: number | null = null;
  let status = "pending";
  let filledAt: Date | null = null;

  if (d.orderType === "market") {
    const quote = getSimulatedQuote(d.symbol);
    filledPrice = quote.price;
    status = "filled";
    filledAt = new Date();

    // Update portfolio cash
    const [portfolio] = await db.select().from(portfolioTable).limit(1);
    if (!portfolio) {
      res.status(500).json({ error: "Portfolio not initialized" });
      return;
    }
    const cashBalance = parseFloat(portfolio.cashBalance);
    const cost = filledPrice * d.quantity;

    if (d.side === "buy" && cashBalance < cost) {
      const [order] = await db.insert(ordersTable).values({
        symbol: d.symbol,
        assetType: d.assetType,
        side: d.side,
        orderType: d.orderType,
        quantity: d.quantity.toString(),
        limitPrice: d.limitPrice?.toString(),
        stopPrice: d.stopPrice?.toString(),
        status: "rejected",
        reason: "Insufficient funds",
        optionType: d.optionType,
        strikePrice: d.strikePrice?.toString(),
        expirationDate: d.expirationDate,
      }).returning();
      res.status(201).json(serializeOrder(order));
      return;
    }

    // Update cash
    const newCash = d.side === "buy" ? cashBalance - cost : cashBalance + cost;
    await db.update(portfolioTable).set({ cashBalance: newCash.toString() }).where(eq(portfolioTable.id, portfolio.id));

    // Update positions
    const existingPos = await db.select().from(positionsTable).where(eq(positionsTable.symbol, d.symbol.toUpperCase()));
    if (d.side === "buy") {
      if (existingPos.length > 0) {
        const ex = existingPos[0];
        const oldQty = parseFloat(ex.quantity);
        const oldCost = parseFloat(ex.avgCost);
        const newQty = oldQty + d.quantity;
        const newAvgCost = (oldQty * oldCost + d.quantity * filledPrice) / newQty;
        await db.update(positionsTable).set({ quantity: newQty.toString(), avgCost: newAvgCost.toFixed(4), currentPrice: filledPrice.toString() }).where(eq(positionsTable.id, ex.id));
      } else {
        await db.insert(positionsTable).values({
          symbol: d.symbol.toUpperCase(),
          assetType: d.assetType,
          quantity: d.quantity.toString(),
          avgCost: filledPrice.toString(),
          currentPrice: filledPrice.toString(),
          optionType: d.optionType,
          strikePrice: d.strikePrice?.toString(),
          expirationDate: d.expirationDate,
        });
      }
    } else {
      if (existingPos.length > 0) {
        const ex = existingPos[0];
        const oldQty = parseFloat(ex.quantity);
        const newQty = oldQty - d.quantity;
        if (newQty <= 0) {
          await db.delete(positionsTable).where(eq(positionsTable.id, ex.id));
        } else {
          await db.update(positionsTable).set({ quantity: newQty.toString(), currentPrice: filledPrice.toString() }).where(eq(positionsTable.id, ex.id));
        }
      }
    }
  }

  const [order] = await db.insert(ordersTable).values({
    symbol: d.symbol.toUpperCase(),
    assetType: d.assetType,
    side: d.side,
    orderType: d.orderType,
    quantity: d.quantity.toString(),
    limitPrice: d.limitPrice?.toString(),
    stopPrice: d.stopPrice?.toString(),
    filledPrice: filledPrice?.toString(),
    status,
    optionType: d.optionType,
    strikePrice: d.strikePrice?.toString(),
    expirationDate: d.expirationDate,
    filledAt,
  }).returning();

  res.status(201).json(serializeOrder(order));
});

router.post("/:id/cancel", async (req, res) => {
  const id = parseInt(req.params.id);
  const [existing] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
  if (!existing) { res.status(404).json({ error: "Order not found" }); return; }
  if (existing.status !== "pending") { res.status(400).json({ error: "Only pending orders can be cancelled" }); return; }
  const [order] = await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, id)).returning();
  res.json(serializeOrder(order));
});

export { router as ordersRouter };
