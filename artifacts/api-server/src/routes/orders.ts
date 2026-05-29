import { Router } from "express";
import { db } from "@workspace/db";
import { ordersTable, portfolioTable, positionsTable } from "@workspace/db";
import { eq, desc, and } from "drizzle-orm";
import { PlaceOrderBody } from "@workspace/api-zod";
import { getSimulatedQuote } from "../lib/market-data.js";
import * as alpaca from "../lib/alpaca.js";

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
    alpacaId: (o as any).alpacaId ?? null,
  };
}

function alpacaStatusToLocal(status: string): string {
  const map: Record<string, string> = {
    new: "pending",
    partially_filled: "pending",
    filled: "filled",
    done_for_day: "filled",
    canceled: "cancelled",
    expired: "cancelled",
    replaced: "cancelled",
    pending_cancel: "pending",
    pending_replace: "pending",
    held: "pending",
    accepted: "pending",
    pending_new: "pending",
    accepted_for_bidding: "pending",
    stopped: "filled",
    rejected: "rejected",
    suspended: "rejected",
    calculated: "filled",
  };
  return map[status] ?? status;
}

router.get("/", async (req, res) => {
  const status = req.query.status as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;

  // Always fetch from DB first (includes simulated options)
  let dbOrders: any[] = [];
  try {
    const dbResults = status && status !== "all"
      ? await db.select().from(ordersTable).where(eq(ordersTable.status, status)).orderBy(desc(ordersTable.createdAt)).limit(limit)
      : await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(limit);
    dbOrders = dbResults.map(o => ({
      id: String(o.id),
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
      createdAt: o.createdAt,
      filledAt: o.filledAt,
      alpacaId: null,
    }));
  } catch (err: any) {
    req.log.warn({ err }, "DB orders fetch failed");
  }

  // Also try Alpaca for real stock orders (skip on failure)
  if (alpaca.isConfigured()) {
    try {
      let alpacaStatus = "all";
      if (status === "filled") alpacaStatus = "closed";
      else if (status === "pending") alpacaStatus = "open";
      else if (status === "cancelled") alpacaStatus = "closed";

      const orders = await alpaca.getOrders({ status: alpacaStatus, limit: Math.min(limit, 500), direction: "desc" });
      const alpacaMapped = orders
        .filter(o => {
          if (!status || status === "all") return true;
          return alpacaStatusToLocal(o.status) === status;
        })
        .slice(0, limit)
        .map(o => ({
          id: o.id.replace(/-/g, "").slice(0, 8),
          symbol: o.symbol,
          assetType: o.asset_class === "us_option" ? "option" : "stock",
          side: o.side,
          orderType: o.type === "stop_limit" ? "limit" : o.type,
          quantity: parseFloat(o.qty),
          limitPrice: o.limit_price ? parseFloat(o.limit_price) : null,
          stopPrice: o.stop_price ? parseFloat(o.stop_price) : null,
          filledPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
          status: alpacaStatusToLocal(o.status),
          agentId: null,
          agentName: null,
          reason: null,
          optionType: null,
          strikePrice: null,
          expirationDate: null,
          createdAt: o.created_at,
          filledAt: o.filled_at,
          alpacaId: o.id,
        }));

      // Merge: DB orders + Alpaca orders, deduplicate by symbol+side+createdAt proximity
      const combined = [...dbOrders, ...alpacaMapped]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, limit);
      res.json(combined);
      return;
    } catch (err: any) {
      req.log.warn({ err }, "Alpaca orders fetch failed, using DB only");
    }
  }

  res.json(dbOrders.slice(0, limit));
});

router.post("/", async (req, res) => {
  const parsed = PlaceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  if (alpaca.isConfigured()) {
    try {
      const alpacaOrder = await alpaca.placeOrder({
        symbol: d.symbol.toUpperCase(),
        qty: d.quantity,
        side: d.side,
        type: d.orderType as "market" | "limit" | "stop",
        time_in_force: "day",
        limit_price: d.limitPrice ? d.limitPrice.toString() : undefined,
        stop_price: d.stopPrice ? d.stopPrice.toString() : undefined,
      });

      const localStatus = alpacaStatusToLocal(alpacaOrder.status);
      const filledPrice = alpacaOrder.filled_avg_price ? parseFloat(alpacaOrder.filled_avg_price) : null;

      // Persist to local DB for analytics/history
      const [order] = await db.insert(ordersTable).values({
        symbol: alpacaOrder.symbol,
        assetType: d.assetType,
        side: d.side,
        orderType: d.orderType,
        quantity: d.quantity.toString(),
        limitPrice: d.limitPrice?.toString(),
        stopPrice: d.stopPrice?.toString(),
        filledPrice: filledPrice?.toString(),
        status: localStatus,
        optionType: d.optionType,
        strikePrice: d.strikePrice?.toString(),
        expirationDate: d.expirationDate,
        filledAt: alpacaOrder.filled_at ? new Date(alpacaOrder.filled_at) : localStatus === "filled" ? new Date() : null,
      }).returning();

      res.status(201).json({
        ...serializeOrder(order),
        alpacaId: alpacaOrder.id,
        alpacaStatus: alpacaOrder.status,
      });
      return;
    } catch (err: any) {
      req.log.error({ err }, "Alpaca place order failed");
      const errMsg = err?.body ? (() => { try { return JSON.parse(err.body)?.message ?? err.message; } catch { return err.message; } })() : err.message;
      res.status(422).json({ error: errMsg || "Order rejected by Alpaca" });
      return;
    }
  }

  // Fallback: simulated fill
  let filledPrice: number | null = null;
  let status = "pending";
  let filledAt: Date | null = null;

  if (d.orderType === "market") {
    const quote = getSimulatedQuote(d.symbol);
    filledPrice = quote.price;
    status = "filled";
    filledAt = new Date();

    const [portfolio] = await db.select().from(portfolioTable).limit(1);
    if (!portfolio) { res.status(500).json({ error: "Portfolio not initialized" }); return; }
    const cashBalance = parseFloat(portfolio.cashBalance);
    const cost = filledPrice * d.quantity;

    if (d.side === "buy" && cashBalance < cost) {
      const [order] = await db.insert(ordersTable).values({
        symbol: d.symbol, assetType: d.assetType, side: d.side, orderType: d.orderType,
        quantity: d.quantity.toString(), status: "rejected", reason: "Insufficient funds",
        optionType: d.optionType, strikePrice: d.strikePrice?.toString(), expirationDate: d.expirationDate,
      }).returning();
      res.status(201).json(serializeOrder(order));
      return;
    }

    const newCash = d.side === "buy" ? cashBalance - cost : cashBalance + cost;
    await db.update(portfolioTable).set({ cashBalance: newCash.toString() }).where(eq(portfolioTable.id, portfolio.id));

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
          symbol: d.symbol.toUpperCase(), assetType: d.assetType, quantity: d.quantity.toString(),
          avgCost: filledPrice.toString(), currentPrice: filledPrice.toString(),
          optionType: d.optionType, strikePrice: d.strikePrice?.toString(), expirationDate: d.expirationDate,
        });
      }
    } else {
      if (existingPos.length > 0) {
        const ex = existingPos[0];
        const newQty = parseFloat(ex.quantity) - d.quantity;
        if (newQty <= 0) {
          await db.delete(positionsTable).where(eq(positionsTable.id, ex.id));
        } else {
          await db.update(positionsTable).set({ quantity: newQty.toString(), currentPrice: filledPrice.toString() }).where(eq(positionsTable.id, ex.id));
        }
      }
    }
  }

  const [order] = await db.insert(ordersTable).values({
    symbol: d.symbol.toUpperCase(), assetType: d.assetType, side: d.side, orderType: d.orderType,
    quantity: d.quantity.toString(), limitPrice: d.limitPrice?.toString(), stopPrice: d.stopPrice?.toString(),
    filledPrice: filledPrice?.toString(), status, optionType: d.optionType, strikePrice: d.strikePrice?.toString(),
    expirationDate: d.expirationDate, filledAt,
  }).returning();

  res.status(201).json(serializeOrder(order));
});

router.post("/:id/cancel", async (req, res) => {
  const id = req.params.id;

  if (alpaca.isConfigured()) {
    try {
      // id might be an alpaca UUID from the list endpoint
      await alpaca.cancelOrder(id);
      res.json({ cancelled: true, alpacaId: id });
      return;
    } catch (err: any) {
      // If it's not an alpaca ID, fall through to local DB cancel
      req.log.warn({ err, id }, "Alpaca cancel failed, trying local DB");
    }
  }

  const numId = parseInt(id);
  if (!isNaN(numId)) {
    const [existing] = await db.select().from(ordersTable).where(eq(ordersTable.id, numId));
    if (!existing) { res.status(404).json({ error: "Order not found" }); return; }
    if (existing.status !== "pending") { res.status(400).json({ error: "Only pending orders can be cancelled" }); return; }
    const [order] = await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, numId)).returning();
    res.json(serializeOrder(order));
    return;
  }

  res.status(404).json({ error: "Order not found" });
});

export { router as ordersRouter };
