import { Router } from "express";
import { db } from "@workspace/db";
import { agentsTable, ordersTable, portfolioTable, positionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { CreateAgentBody, UpdateAgentBody } from "@workspace/api-zod";
import { getSimulatedQuote } from "./market.js";

const router = Router();

function parseSymbols(val: string): string[] {
  try { return JSON.parse(val); } catch { return []; }
}

function serializeAgent(a: typeof agentsTable.$inferSelect) {
  return {
    id: a.id,
    name: a.name,
    strategy: a.strategy,
    description: a.description,
    isActive: a.isActive,
    symbols: parseSymbols(a.symbols),
    riskLevel: a.riskLevel,
    maxPositionSize: parseFloat(a.maxPositionSize),
    totalTrades: a.totalTrades,
    winRate: parseFloat(a.winRate),
    totalPnl: parseFloat(a.totalPnl),
    lastRunAt: a.lastRunAt ? a.lastRunAt.toISOString() : null,
    createdAt: a.createdAt.toISOString(),
  };
}

router.get("/", async (req, res) => {
  const agents = await db.select().from(agentsTable);
  res.json(agents.map(serializeAgent));
});

router.post("/", async (req, res) => {
  const parsed = CreateAgentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { name, strategy, description, symbols, riskLevel, maxPositionSize } = parsed.data;
  const [agent] = await db.insert(agentsTable).values({
    name,
    strategy,
    description: description ?? `${strategy} strategy agent`,
    symbols: JSON.stringify(symbols),
    riskLevel,
    maxPositionSize: maxPositionSize.toString(),
  }).returning();
  res.status(201).json(serializeAgent(agent));
});

router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(serializeAgent(agent));
});

router.patch("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const parsed = UpdateAgentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid input" }); return; }
  const updates: Record<string, unknown> = {};
  const d = parsed.data;
  if (d.name !== undefined) updates.name = d.name;
  if (d.description !== undefined) updates.description = d.description;
  if (d.symbols !== undefined) updates.symbols = JSON.stringify(d.symbols);
  if (d.riskLevel !== undefined) updates.riskLevel = d.riskLevel;
  if (d.maxPositionSize !== undefined) updates.maxPositionSize = d.maxPositionSize.toString();
  if (d.isActive !== undefined) updates.isActive = d.isActive;
  const [agent] = await db.update(agentsTable).set(updates).where(eq(agentsTable.id, id)).returning();
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  res.json(serializeAgent(agent));
});

router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  await db.delete(agentsTable).where(eq(agentsTable.id, id));
  res.status(204).send();
});

router.post("/:id/toggle", async (req, res) => {
  const id = parseInt(req.params.id);
  const [current] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!current) { res.status(404).json({ error: "Agent not found" }); return; }
  const [agent] = await db.update(agentsTable).set({ isActive: !current.isActive }).where(eq(agentsTable.id, id)).returning();
  res.json(serializeAgent(agent));
});

async function runAgentLogic(agent: typeof agentsTable.$inferSelect) {
  const symbols = parseSymbols(agent.symbols);
  if (symbols.length === 0) {
    return { action: "no_signal" as const, analysis: "No symbols configured for this agent.", orderPlaced: null };
  }

  const symbol = symbols[Math.floor(Math.random() * symbols.length)];
  const quote = getSimulatedQuote(symbol);
  const maxPos = parseFloat(agent.maxPositionSize);

  const strategy = agent.strategy;
  let action: "bought" | "sold" | "held" | "no_signal" = "held";
  let analysis = "";
  let orderPlaced = null;

  const bullSignal = quote.changePercent > 0.5;
  const bearSignal = quote.changePercent < -0.5;

  if (strategy === "momentum") {
    if (bullSignal) {
      analysis = `${symbol} shows strong momentum with +${quote.changePercent.toFixed(2)}% gain. Volume at ${(quote.volume / 1000000).toFixed(1)}M confirms the move. Entering long position.`;
      action = "bought";
    } else if (bearSignal) {
      analysis = `${symbol} showing negative momentum at ${quote.changePercent.toFixed(2)}%. Momentum signals do not favor a long entry. Standing aside.`;
      action = "held";
    } else {
      analysis = `${symbol} momentum is neutral at ${quote.changePercent.toFixed(2)}%. Waiting for a stronger directional signal.`;
      action = "no_signal";
    }
  } else if (strategy === "mean_reversion") {
    if (bearSignal) {
      analysis = `${symbol} dropped ${quote.changePercent.toFixed(2)}% today, now near support at $${quote.low.toFixed(2)}. Mean reversion setup — buying the dip.`;
      action = "bought";
    } else if (bullSignal) {
      analysis = `${symbol} up ${quote.changePercent.toFixed(2)}%, approaching resistance. Mean reversion suggests potential pullback — reducing exposure.`;
      action = "sold";
    } else {
      analysis = `${symbol} trading near fair value. No mean reversion opportunity at current price $${quote.price.toFixed(2)}.`;
      action = "no_signal";
    }
  } else if (strategy === "breakout") {
    const nearHigh = quote.price >= quote.high * 0.99;
    if (nearHigh) {
      analysis = `${symbol} breaking above $${quote.high.toFixed(2)} intraday high with volume confirmation. Entering breakout position.`;
      action = "bought";
    } else {
      analysis = `${symbol} at $${quote.price.toFixed(2)}, ${((1 - quote.price / quote.high) * 100).toFixed(1)}% below session high. No breakout signal yet.`;
      action = "no_signal";
    }
  } else if (strategy === "trend_following") {
    if (bullSignal) {
      analysis = `${symbol} maintains upward trend (+${quote.changePercent.toFixed(2)}%). Adding to trending position following the trend.`;
      action = "bought";
    } else {
      analysis = `${symbol} trend unclear at ${quote.changePercent.toFixed(2)}%. Trend-following strategy requires clearer directional move.`;
      action = "held";
    }
  } else if (strategy === "options_selling") {
    analysis = `Selling covered call on ${symbol} at $${(quote.price * 1.05).toFixed(2)} strike, 30 DTE. Implied volatility elevated, premium collection opportunity.`;
    action = "bought";
  }

  if (action === "bought" || action === "sold") {
    const quantity = Math.max(1, Math.floor(maxPos / quote.price));
    const portfolio = await db.select().from(portfolioTable).limit(1);
    if (portfolio.length === 0) return { action, analysis, orderPlaced: null };

    const cashBalance = parseFloat(portfolio[0].cashBalance);
    const cost = quote.price * quantity;

    if (action === "bought" && cashBalance < cost) {
      analysis += " Insufficient funds — order skipped.";
      action = "held";
      return { action, analysis, orderPlaced: null };
    }

    // Place the order
    const side = action === "bought" ? "buy" : "sell";
    const [order] = await db.insert(ordersTable).values({
      symbol,
      assetType: "stock",
      side,
      orderType: "market",
      quantity: quantity.toString(),
      filledPrice: quote.price.toString(),
      status: "filled",
      agentId: agent.id,
      agentName: agent.name,
      reason: analysis.slice(0, 200),
      filledAt: new Date(),
    }).returning();

    // Update cash balance
    const newCash = side === "buy" ? cashBalance - cost : cashBalance + cost;
    await db.update(portfolioTable).set({ cashBalance: newCash.toString() }).where(eq(portfolioTable.id, portfolio[0].id));

    // Update position
    const existingPos = await db.select().from(positionsTable).where(eq(positionsTable.symbol, symbol));
    if (side === "buy") {
      if (existingPos.length > 0) {
        const existing = existingPos[0];
        const oldQty = parseFloat(existing.quantity);
        const oldCost = parseFloat(existing.avgCost);
        const newQty = oldQty + quantity;
        const newAvgCost = (oldQty * oldCost + quantity * quote.price) / newQty;
        await db.update(positionsTable).set({ quantity: newQty.toString(), avgCost: newAvgCost.toString(), currentPrice: quote.price.toString() }).where(eq(positionsTable.id, existing.id));
      } else {
        await db.insert(positionsTable).values({ symbol, assetType: "stock", quantity: quantity.toString(), avgCost: quote.price.toString(), currentPrice: quote.price.toString() });
      }
    } else {
      if (existingPos.length > 0) {
        const existing = existingPos[0];
        const oldQty = parseFloat(existing.quantity);
        const newQty = oldQty - quantity;
        if (newQty <= 0) {
          await db.delete(positionsTable).where(eq(positionsTable.id, existing.id));
        } else {
          await db.update(positionsTable).set({ quantity: newQty.toString(), currentPrice: quote.price.toString() }).where(eq(positionsTable.id, existing.id));
        }
      }
    }

    // Update agent stats
    const winningTrade = (side === "buy" && quote.changePercent > 0) || (side === "sell" && quote.changePercent < 0);
    const pnl = side === "sell" ? cost - quantity * parseFloat(existingPos[0]?.avgCost ?? quote.price.toString()) : 0;
    const newTrades = agent.totalTrades + 1;
    const currentWinRate = parseFloat(agent.winRate);
    const newWinRate = ((currentWinRate / 100) * agent.totalTrades + (winningTrade ? 1 : 0)) / newTrades * 100;
    const newTotalPnl = parseFloat(agent.totalPnl) + pnl;
    await db.update(agentsTable).set({ totalTrades: newTrades, winRate: newWinRate.toFixed(2), totalPnl: newTotalPnl.toString(), lastRunAt: new Date() }).where(eq(agentsTable.id, agent.id));

    orderPlaced = { id: order.id, symbol, side, quantity, price: quote.price };
  } else {
    await db.update(agentsTable).set({ lastRunAt: new Date() }).where(eq(agentsTable.id, agent.id));
  }

  return { action, analysis, orderPlaced };
}

router.post("/:id/run", async (req, res) => {
  const id = parseInt(req.params.id);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

  const result = await runAgentLogic(agent);
  res.json({
    agentId: agent.id,
    agentName: agent.name,
    analysis: result.analysis,
    action: result.action,
    orderPlaced: result.orderPlaced,
    timestamp: new Date().toISOString(),
  });
});

export { router as agentsRouter };
