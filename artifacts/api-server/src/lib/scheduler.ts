import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runAgentLogic } from "./agent-engine.js";
import { logger } from "./logger.js";

// ─── Config — Beast Mode ──────────────────────────────────────
const INTERVAL_MS = 3 * 60 * 1000; // 3 minutes between runs (was 5 — more active)

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

// ─── Market Hours ─────────────────────────────────────────────

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function isMarketOpen(): boolean {
  const now = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
  const etMin  = now.getUTCMinutes();
  const etMins = etHour * 60 + etMin;
  const day    = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  return etMins >= 570 && etMins < 945; // 9:30–15:45 ET
}

// ─── Main loop — No daily loss limit, no external stops ───────

async function runAllActiveAgents() {
  // No daily loss limit check — beast mode runs all day
  if (!isMarketOpen()) {
    logger.debug("Scheduler: market closed, skipping");
    return;
  }

  const agents = await db.select().from(agentsTable).where(eq(agentsTable.isActive, true));
  if (agents.length === 0) {
    logger.debug("Scheduler: no active agents");
    return;
  }

  logger.info({ count: agents.length }, "Scheduler: running active agents — BEAST MODE");

  for (const agent of agents) {
    try {
      const result = await runAgentLogic(agent);
      logger.info(
        {
          agentId: agent.id,
          agentName: agent.name,
          action: result.action,
          orderPlaced: !!result.orderPlaced,
          optionPlaced: !!result.optionOrderPlaced,
          compositeScore: result.pipeline?.compositeScore,
          confidence: result.pipeline?.confidence,
          ivRank: result.pipeline?.ivRank,
          ivRegime: result.pipeline?.ivRegime,
          optionSuggestion: result.pipeline?.optionSuggestion,
          positionsActive: result.pipeline?.positionsActive,
        },
        "Scheduler: agent run complete"
      );
    } catch (err) {
      logger.error({ err, agentId: agent.id, agentName: agent.name }, "Scheduler: agent threw");
    }
  }
}

export function startScheduler() {
  if (schedulerHandle) return;
  logger.info({ intervalMs: INTERVAL_MS }, "Aegis BEAST MODE scheduler started — 3min cycles, no limits");

  // First run 15s after startup (was 30s)
  setTimeout(() => {
    runAllActiveAgents().catch(err => logger.error({ err }, "Scheduler: initial run failed"));
  }, 15_000);

  schedulerHandle = setInterval(() => {
    runAllActiveAgents().catch(err => logger.error({ err }, "Scheduler: interval run failed"));
  }, INTERVAL_MS);
}

export function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    logger.info("Aegis scheduler stopped");
  }
}

/** Trigger a single agent immediately (used by the manual /run endpoint). */
export { runAgentLogic };
