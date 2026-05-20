import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runAgentLogic } from "./agent-engine.js";
import { logger } from "./logger.js";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let schedulerHandle: ReturnType<typeof setInterval> | null = null;

async function runAllActiveAgents() {
  const agents = await db.select().from(agentsTable).where(eq(agentsTable.isActive, true));

  if (agents.length === 0) {
    logger.debug("Scheduler: no active agents to run");
    return;
  }

  logger.info({ count: agents.length }, "Scheduler: running active agents");

  for (const agent of agents) {
    try {
      const result = await runAgentLogic(agent);
      logger.info(
        { agentId: agent.id, agentName: agent.name, action: result.action, orderPlaced: !!result.orderPlaced },
        "Scheduler: agent run complete"
      );
    } catch (err) {
      logger.error({ err, agentId: agent.id, agentName: agent.name }, "Scheduler: agent run threw");
    }
  }
}

export function startScheduler() {
  if (schedulerHandle) return;
  logger.info({ intervalMs: INTERVAL_MS }, "Agent scheduler started");

  // Run once shortly after startup (30s delay so server is fully ready)
  setTimeout(() => {
    runAllActiveAgents().catch(err => logger.error({ err }, "Scheduler: initial run failed"));
  }, 30_000);

  schedulerHandle = setInterval(() => {
    runAllActiveAgents().catch(err => logger.error({ err }, "Scheduler: interval run failed"));
  }, INTERVAL_MS);
}

export function stopScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
    logger.info("Agent scheduler stopped");
  }
}

/** Trigger a single agent immediately (used by the manual run endpoint). */
export { runAgentLogic };
