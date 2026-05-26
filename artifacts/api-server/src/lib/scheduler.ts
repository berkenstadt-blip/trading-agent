import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runAgentLogic } from "./agent-engine.js";
import { logger } from "./logger.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes between runs
const DAILY_LOSS_LIMIT_PCT = 3.0;  // Stop trading if portfolio down >3% on the day

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let dailyLossLimitHit = false;
let lastResetDate = new Date().toDateString();

// ─── Market Hours ─────────────────────────────────────────────────────────────

function isMarketOpen(): boolean {
  const now = new Date();
  const etOffset = isDST(now) ? -4 : -5;
  const etHour = (now.getUTCHours() + 24 + etOffset) % 24;
  const etMin  = now.getUTCMinutes();
  const etMins = etHour * 60 + etMin;
  const day    = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  return etMins >= 570 && etMins < 945; // 9:30–15:45 ET (buffer before close)
}

function isDST(date: Date): boolean {
  const jan = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
  return date.getTimezoneOffset() < Math.max(jan, jul);
}

function resetDailyLimitIfNewDay() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyLossLimitHit = false;
    lastResetDate = today;
    logger.info("New trading day — daily loss limit reset");
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────

async function runAllActiveAgents() {
  resetDailyLimitIfNewDay();

  if (!isMarketOpen()) {
    logger.debug("Scheduler: market closed, skipping");
    return;
  }

  if (dailyLossLimitHit) {
    logger.warn("Scheduler: daily loss limit hit — no trading today");
    return;
  }

  const agents = await db.select().from(agentsTable).where(eq(agentsTable.isActive, true));

  if (agents.length === 0) {
    logger.debug("Scheduler: no active agents");
    return;
  }

  logger.info({ count: agents.length }, "Scheduler: running active agents");

  for (const agent of agents) {
    try {
      const result = await runAgentLogic(agent);
      logger.info(
        {
          agentId: agent.id,
          agentName: agent.name,
          action: result.action,
          orderPlaced: !!result.orderPlaced,
          compositeScore: result.pipeline?.compositeScore,
          confidence: result.pipeline?.trader.confidence,
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
  logger.info({ intervalMs: INTERVAL_MS }, "Aegis scheduler started — 4-agent pipeline active");

  // First run 30s after startup
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
    logger.info("Aegis scheduler stopped");
  }
}

/** Trigger a single agent immediately (used by the manual /run endpoint). */
export { runAgentLogic };
