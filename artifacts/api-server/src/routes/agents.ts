import { Router } from "express";
import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { CreateAgentBody, UpdateAgentBody } from "@workspace/api-zod";
import { runAgentLogic } from "../lib/scheduler.js";
import { ordersTable, portfolioTable, positionsTable } from "@workspace/db";

const router = Router();

// ─── Reset all simulated data ────────────────────────────────
router.post("/reset-db", async (_req, res) => {
  try {
    await db.delete(ordersTable);
    await db.delete(positionsTable);
    // Reset agent totalPnl and totalTrades
    await db.update(agentsTable).set({ totalPnl: "0", totalTrades: 0, winRate: "0" });
    res.json({ success: true, message: "DB reset: orders, positions, agent stats cleared." });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

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

router.post("/:id/run", async (req, res) => {
  const id = parseInt(req.params.id);
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, id));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

  try {
    const result = await runAgentLogic(agent);
    res.json({
      agentId: agent.id,
      agentName: agent.name,
      strategy: agent.strategy,
      analysis: result.analysis,
      action: result.action,
      orderPlaced: result.orderPlaced,
      optionOrderPlaced: result.optionOrderPlaced ?? null,
      pipeline: result.pipeline ?? null,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[run] agent error:", err);
    res.status(500).json({ error: err?.message ?? "Unknown error", action: "error" });
  }
});

export { router as agentsRouter };
