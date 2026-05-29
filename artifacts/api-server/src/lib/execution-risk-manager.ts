/**
 * ═══════════════════════════════════════════════════════════
 *  AEGIS EXECUTION RISK MANAGER
 *  Runs every scheduler tick BEFORE agent logic.
 *  Handles:
 *   1. Stop Loss / Take Profit on stock positions
 *   2. Options lifecycle (close at profit target, close before expiry)
 *   3. Circuit breaker (halt if -25% day loss)
 *   4. Expired options cleanup
 * ═══════════════════════════════════════════════════════════
 */

import { db } from "@workspace/db";
import { ordersTable, agentsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import * as alpaca from "./alpaca.js";
import { logger } from "./logger.js";

export interface RiskCheckResult {
  halted: boolean;
  haltReason?: string;
  closedPositions: { symbol: string; reason: string; pnl: number }[];
  closedOptions: { symbol: string; optionSymbol: string; reason: string; pnl: number }[];
}

// ─── Circuit Breaker ─────────────────────────────────────────

async function checkAndTripCircuitBreaker(account: any): Promise<{ halt: boolean; reason: string }> {
  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dayPnlPct = lastEquity > 0 ? (equity - lastEquity) / lastEquity : 0;

  if (dayPnlPct <= -0.25) {
    return { halt: true, reason: `Day loss ${(dayPnlPct * 100).toFixed(1)}% exceeds -25% circuit breaker` };
  }
  if (equity < 50000) {
    return { halt: true, reason: `Portfolio below $50K safety floor (current: $${equity.toFixed(0)})` };
  }
  return { halt: false, reason: "" };
}

// ─── Stock Position Manager ───────────────────────────────────

async function manageStockPositions(positions: alpaca.AlpacaPosition[]): Promise<{ symbol: string; reason: string; pnl: number }[]> {
  const closed: { symbol: string; reason: string; pnl: number }[] = [];

  for (const pos of positions) {
    if (pos.asset_class === "us_option") continue; // handled separately

    const unrealizedPlPct = parseFloat(pos.unrealized_plpc) * 100;
    const unrealizedPl = parseFloat(pos.unrealized_pl);
    const symbol = pos.symbol;

    let closeReason = "";

    // Stop loss: -8% or worse
    if (unrealizedPlPct <= -8) {
      closeReason = `Stop loss hit: ${unrealizedPlPct.toFixed(1)}%`;
    }
    // Take profit: +15% or better
    else if (unrealizedPlPct >= 15) {
      closeReason = `Take profit hit: +${unrealizedPlPct.toFixed(1)}%`;
    }
    // Time stop: position held > 5 days — check via age would need createdAt, skip for now

    if (closeReason) {
      try {
        await alpaca.closePosition(symbol);
        // Log to DB
        const qty = parseFloat(pos.qty);
        const currentPrice = parseFloat(pos.current_price);
        await db.insert(ordersTable).values({
          symbol,
          assetType: "stock",
          side: "sell",
          orderType: "market",
          quantity: qty.toString(),
          filledPrice: currentPrice.toString(),
          status: "filled",
          agentId: null,
          agentName: "Risk Manager",
          reason: closeReason,
          filledAt: new Date(),
        });
        closed.push({ symbol, reason: closeReason, pnl: unrealizedPl });
        logger.info({ symbol, reason: closeReason, pnl: unrealizedPl }, "Risk Manager: closed stock position");
      } catch (e: any) {
        logger.error({ e: e.message, symbol }, "Risk Manager: failed to close stock position");
      }
    }
  }

  return closed;
}

// ─── Options Lifecycle Manager ────────────────────────────────

async function manageOptionsPositions(): Promise<{ symbol: string; optionSymbol: string; reason: string; pnl: number }[]> {
  const closed: { symbol: string; optionSymbol: string; reason: string; pnl: number }[] = [];
  const now = new Date();

  // Get all open option buys (simulated — not in Alpaca)
  const allOrders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt));
  const optionBuys = allOrders.filter(o => o.assetType === "option" && o.side === "buy");
  const optionSells = new Set(allOrders.filter(o => o.assetType === "option" && o.side === "sell")
    .map(o => `${o.symbol}_${o.optionType}_${o.strikePrice}_${o.expirationDate}`));

  // Get current prices for underlying
  let currentPrices: Record<string, number> = {};
  try {
    const positions = await alpaca.getPositions();
    for (const p of positions) currentPrices[p.symbol] = parseFloat(p.current_price);
  } catch { /* ignore */ }

  // Also try to get live quotes for option underlyings
  const uniqueSymbols = [...new Set(optionBuys.map(o => o.symbol))];
  for (const sym of uniqueSymbols.slice(0, 10)) {
    if (!currentPrices[sym]) {
      try {
        const snap = await alpaca.getSnapshot(sym);
        currentPrices[sym] = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
      } catch { /* ignore */ }
    }
  }

  for (const order of optionBuys) {
    const key = `${order.symbol}_${order.optionType}_${order.strikePrice}_${order.expirationDate}`;
    if (optionSells.has(key)) continue; // already closed

    const entryPremium = order.filledPrice ? parseFloat(order.filledPrice) : 0;
    const contracts = parseFloat(order.quantity);
    const strike = order.strikePrice ? parseFloat(order.strikePrice) : 0;
    const expiry = order.expirationDate ? new Date(order.expirationDate) : null;
    const optType = order.optionType as "call" | "put" | null;

    if (!expiry || !optType || !strike || entryPremium === 0) continue;

    const daysToExpiry = (expiry.getTime() - now.getTime()) / (1000 * 3600 * 24);

    // Current value via Black-Scholes
    const S = currentPrices[order.symbol] ?? 0;
    let currentValue = entryPremium;
    let closeReason = "";

    if (S > 0) {
      currentValue = calcOptionValue(S, strike, daysToExpiry / 365, optType);
      const pnlPct = entryPremium > 0 ? (currentValue - entryPremium) / entryPremium : 0;

      // Close at 50% profit target
      if (pnlPct >= 0.50) {
        closeReason = `Profit target hit: +${(pnlPct * 100).toFixed(0)}%`;
      }
      // Stop at 50% loss
      else if (pnlPct <= -0.50) {
        closeReason = `Stop loss hit: ${(pnlPct * 100).toFixed(0)}%`;
      }
    }

    // Close 2 days before expiry regardless (avoid pin risk)
    if (daysToExpiry <= 2 && !closeReason) {
      closeReason = `Expiry in ${daysToExpiry.toFixed(0)} days — closing to avoid pin risk`;
      currentValue = S > 0 ? Math.max(0, optType === "call" ? S - strike : strike - S) : 0; // intrinsic value
    }

    // Mark as expired
    if (daysToExpiry < 0 && !closeReason) {
      closeReason = `Expired worthless`;
      currentValue = 0;
    }

    if (closeReason) {
      const pnl = (currentValue - entryPremium) * contracts * 100;
      try {
        // Log closing sell to DB
        await db.insert(ordersTable).values({
          symbol: order.symbol,
          assetType: "option",
          side: "sell",
          orderType: "market",
          quantity: contracts.toString(),
          filledPrice: currentValue.toFixed(4),
          status: "simulated",
          agentId: order.agentId,
          agentName: "Risk Manager",
          reason: closeReason,
          optionType: order.optionType,
          strikePrice: order.strikePrice,
          expirationDate: order.expirationDate,
          filledAt: new Date(),
        });

        // Update agent P&L
        if (order.agentId) {
          const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, order.agentId));
          if (agent) {
            const newPnl = parseFloat(agent.totalPnl) + pnl;
            const newTrades = agent.totalTrades + 1;
            const oldWins = Math.round((parseFloat(agent.winRate) / 100) * agent.totalTrades);
            const newWins = oldWins + (pnl > 0 ? 1 : 0);
            await db.update(agentsTable).set({
              totalPnl: newPnl.toFixed(4),
              totalTrades: newTrades,
              winRate: ((newWins / newTrades) * 100).toFixed(2),
              lastRunAt: new Date(),
            }).where(eq(agentsTable.id, order.agentId));
          }
        }

        closed.push({
          symbol: order.symbol,
          optionSymbol: `${order.symbol}${order.optionType?.toUpperCase()}${strike}`,
          reason: closeReason,
          pnl,
        });
        logger.info({ symbol: order.symbol, reason: closeReason, pnl: pnl.toFixed(2) }, "Risk Manager: closed option position");
      } catch (e: any) {
        logger.error({ e: e.message, symbol: order.symbol }, "Risk Manager: failed to close option");
      }
    }
  }

  return closed;
}

// ─── Black-Scholes helper ─────────────────────────────────────

function normCDF(x: number): number {
  const a = 0.2316419, b1 = 0.319381530, b2 = -0.356563782,
        b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const t = 1 / (1 + a * Math.abs(x));
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))));
  const n = 1 - (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x) * poly;
  return x >= 0 ? n : 1 - n;
}

function calcOptionValue(S: number, K: number, T: number, type: "call" | "put", iv = 0.35): number {
  if (T <= 0) return Math.max(0, type === "call" ? S - K : K - S);
  if (S <= 0 || K <= 0) return 0;
  const r = 0.05;
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  if (type === "call") return Math.max(0, S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2));
  return Math.max(0, K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1));
}

// ─── Main Entry ───────────────────────────────────────────────

export async function runRiskManagement(): Promise<RiskCheckResult> {
  const result: RiskCheckResult = {
    halted: false,
    closedPositions: [],
    closedOptions: [],
  };

  if (!alpaca.isConfigured()) return result;

  try {
    // 1. Get account + check circuit breaker
    const account = await alpaca.getAccount();
    const cb = await checkAndTripCircuitBreaker(account);
    if (cb.halt) {
      result.halted = true;
      result.haltReason = cb.reason;
      logger.warn({ reason: cb.reason }, "Risk Manager: CIRCUIT BREAKER TRIPPED");
      return result;
    }

    // 2. Manage stock positions (stop loss / take profit)
    const positions = await alpaca.getPositions();
    result.closedPositions = await manageStockPositions(positions);

    // 3. Manage options lifecycle
    result.closedOptions = await manageOptionsPositions();

    if (result.closedPositions.length > 0 || result.closedOptions.length > 0) {
      logger.info({
        closedStocks: result.closedPositions.length,
        closedOptions: result.closedOptions.length,
        totalPnl: [...result.closedPositions, ...result.closedOptions].reduce((s, c) => s + c.pnl, 0).toFixed(2),
      }, "Risk Manager: completed position management");
    }

  } catch (e: any) {
    logger.error({ e: e.message }, "Risk Manager: error during risk check");
  }

  return result;
}
