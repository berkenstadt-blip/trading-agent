import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { runAgentLogic } from "./agent-engine.js";
import { runRiskManagement } from "./execution-risk-manager.js";
import { logger } from "./logger.js";

// ─── Config — Beast Mode ──────────────────────────────────────
const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes — reduces OpenRouter costs 5x

let schedulerHandle: ReturnType<typeof setInterval> | null = null;

// ─── Market Hours ─────────────────────────────────────────────

function isMarketOpen(): boolean {
  const now = new Date();
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  // Use Intl to get actual ET time — handles DST automatically, works on UTC servers
  const etTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(now);
  const etHour = parseInt(etTime.find(p => p.type === "hour")!.value, 10);
  const etMin  = parseInt(etTime.find(p => p.type === "minute")!.value, 10);
  const etMins = etHour * 60 + etMin;

  return etMins >= 570 && etMins < 945; // 9:30–15:45 ET
}

// ─── Main loop — cost-optimized: max 3 agents per tick ────────

async function runAllActiveAgents() {
  if (!isMarketOpen()) {
    logger.debug("Scheduler: market closed, skipping");
    return;
  }

  const allAgents = await db.select().from(agentsTable).where(eq(agentsTable.isActive, true));
  if (allAgents.length === 0) {
    logger.debug("Scheduler: no active agents");
    return;
  }

  // Cost optimization: rotate through agents, max 3 per cycle
  // Priority: Options Hunter, Earnings Sniper, Volatility Crusher first
  const PRIORITY = ["Options Hunter", "Earnings Sniper", "Volatility Crusher"];
  const priority = allAgents.filter(a => PRIORITY.includes(a.name));
  const rest = allAgents.filter(a => !PRIORITY.includes(a.name));
  // Pick 1 random non-priority agent per cycle to rotate coverage
  const tickIdx = Math.floor(Date.now() / INTERVAL_MS) % Math.max(1, rest.length);
  const agents = [...priority, ...(rest[tickIdx] ? [rest[tickIdx]] : [])].slice(0, 4);

  logger.info({ count: agents.length, names: agents.map((a: any) => a.name) }, "Scheduler: running agents (cost-optimized)");

  // ── RISK MANAGEMENT FIRST — stop losses, take profits, option lifecycle ──
  const riskResult = await runRiskManagement().catch(e => {
    logger.error({ e: e.message }, "Risk management failed");
    return { halted: false, closedPositions: [], closedOptions: [] };
  });

  if (riskResult.halted) {
    logger.warn({ reason: riskResult.haltReason }, "CIRCUIT BREAKER — skipping agent runs this cycle");
    return;
  }

  // ── AGENT LOGIC ──

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
