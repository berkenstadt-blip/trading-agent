import { db } from "@workspace/db";
import { agentsTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import * as alpaca from "./alpaca.js";
import { getSimulatedQuote } from "./market-data.js";
import { logger } from "./logger.js";

export interface AgentRunResult {
  action: "bought" | "sold" | "held" | "no_signal" | "error";
  analysis: string;
  orderPlaced: {
    symbol: string;
    side: "buy" | "sell";
    quantity: number;
    price: number;
    alpacaId?: string;
  } | null;
}

// ─── Quote helper ─────────────────────────────────────────────────────────────
interface ResolvedQuote {
  symbol: string;
  price: number;
  changePercent: number;
  change: number;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  volume: number;
  source: "alpaca" | "simulated";
}

async function resolveQuote(symbol: string): Promise<ResolvedQuote> {
  if (alpaca.isConfigured()) {
    try {
      const snap = await alpaca.getSnapshot(symbol);
      const price = snap.latestTrade?.p ?? snap.minuteBar?.c ?? snap.dailyBar?.c ?? 0;
      const prevClose = snap.prevDailyBar?.c ?? snap.dailyBar?.o ?? price;
      const change = +(price - prevClose).toFixed(4);
      const changePercent = prevClose > 0 ? +((change / prevClose) * 100).toFixed(4) : 0;
      return {
        symbol: symbol.toUpperCase(),
        price,
        changePercent,
        change,
        high: snap.dailyBar?.h ?? price,
        low: snap.dailyBar?.l ?? price,
        open: snap.dailyBar?.o ?? price,
        prevClose,
        volume: snap.dailyBar?.v ?? 0,
        source: "alpaca",
      };
    } catch (err) {
      logger.warn({ err, symbol }, "Alpaca snapshot failed, using simulated quote");
    }
  }
  const q = getSimulatedQuote(symbol);
  return {
    symbol: symbol.toUpperCase(),
    price: q.price,
    changePercent: q.changePercent,
    change: q.change,
    high: q.high,
    low: q.low,
    open: q.open,
    prevClose: q.previousClose,
    volume: q.volume,
    source: "simulated",
  };
}

// ─── Check current Alpaca positions ──────────────────────────────────────────
async function getAlpacaPosition(symbol: string): Promise<{ qty: number; avgCost: number } | null> {
  if (!alpaca.isConfigured()) return null;
  try {
    const pos = await alpaca.getPosition(symbol);
    return { qty: parseFloat(pos.qty), avgCost: parseFloat(pos.avg_entry_price) };
  } catch {
    return null;
  }
}

// ─── Place order (Alpaca first, local DB fallback) ────────────────────────────
async function placeAgentOrder(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  side: "buy" | "sell",
  quantity: number,
  price: number,
  reason: string,
): Promise<{ orderId: number; alpacaId?: string; filledPrice: number }> {
  let alpacaId: string | undefined;
  let filledPrice = price;

  if (alpaca.isConfigured()) {
    try {
      const alpacaOrder = await alpaca.placeOrder({
        symbol,
        qty: quantity,
        side,
        type: "market",
        time_in_force: "day",
      });
      alpacaId = alpacaOrder.id;
      if (alpacaOrder.filled_avg_price) {
        filledPrice = parseFloat(alpacaOrder.filled_avg_price);
      }
      logger.info({ alpacaId, symbol, side, quantity }, "Agent placed real Alpaca order");
    } catch (err) {
      logger.error({ err, symbol, side }, "Alpaca order failed in agent run");
      throw err;
    }
  }

  const [order] = await db.insert(ordersTable).values({
    symbol,
    assetType: "stock",
    side,
    orderType: "market",
    quantity: quantity.toString(),
    filledPrice: filledPrice.toString(),
    status: "filled",
    agentId: agent.id,
    agentName: agent.name,
    reason: reason.slice(0, 300),
    filledAt: new Date(),
  }).returning();

  return { orderId: order.id, alpacaId, filledPrice };
}

// ─── Update agent stats ───────────────────────────────────────────────────────
async function updateAgentStats(
  agent: typeof agentsTable.$inferSelect,
  traded: boolean,
  side: "buy" | "sell" | null,
  pnl: number,
  isWin: boolean,
) {
  if (!traded) {
    await db.update(agentsTable).set({ lastRunAt: new Date() }).where(eq(agentsTable.id, agent.id));
    return;
  }
  const newTrades = agent.totalTrades + 1;
  const oldWins = Math.round((parseFloat(agent.winRate) / 100) * agent.totalTrades);
  const newWins = oldWins + (isWin ? 1 : 0);
  const newWinRate = newTrades > 0 ? (newWins / newTrades) * 100 : 0;
  const newTotalPnl = parseFloat(agent.totalPnl) + pnl;
  await db.update(agentsTable).set({
    totalTrades: newTrades,
    winRate: newWinRate.toFixed(2),
    totalPnl: newTotalPnl.toFixed(4),
    lastRunAt: new Date(),
  }).where(eq(agentsTable.id, agent.id));
}

// ─── Strategy implementations ─────────────────────────────────────────────────

async function strategyMomentum(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  q: ResolvedQuote,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<AgentRunResult> {
  const BUY_THRESHOLD = 1.2;
  const SELL_THRESHOLD = -1.2;

  if (q.changePercent >= BUY_THRESHOLD && !existingPos) {
    const quantity = Math.max(1, Math.floor(maxPos / q.price));
    const analysis = `${symbol} surging +${q.changePercent.toFixed(2)}% today (${q.source} data). ` +
      `Price $${q.price.toFixed(2)} breaking above open $${q.open.toFixed(2)}. ` +
      `Volume ${(q.volume / 1_000_000).toFixed(1)}M confirms momentum. Entering long position, ${quantity} shares.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "buy", quantity, q.price, analysis);
      await updateAgentStats(agent, true, "buy", 0, false);
      return { action: "bought", analysis, orderPlaced: { symbol, side: "buy", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  if (q.changePercent <= SELL_THRESHOLD && existingPos) {
    const quantity = existingPos.qty;
    const analysis = `${symbol} momentum reversing at ${q.changePercent.toFixed(2)}%. ` +
      `Closing ${quantity}-share position opened at $${existingPos.avgCost.toFixed(2)}.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "sell", quantity, q.price, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * quantity;
      await updateAgentStats(agent, true, "sell", pnl, pnl > 0);
      return { action: "sold", analysis, orderPlaced: { symbol, side: "sell", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  const analysis = existingPos
    ? `${symbol} at +${q.changePercent.toFixed(2)}%, holding ${existingPos.qty} shares. No exit signal yet.`
    : `${symbol} at ${q.changePercent.toFixed(2)}% — momentum below ${BUY_THRESHOLD}% entry threshold. Waiting.`;
  await updateAgentStats(agent, false, null, 0, false);
  return { action: q.changePercent > 0 ? "held" : "no_signal", analysis, orderPlaced: null };
}

async function strategyMeanReversion(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  q: ResolvedQuote,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<AgentRunResult> {
  const OVERSOLD = -1.5;
  const OVERBOUGHT = 1.5;

  if (q.changePercent <= OVERSOLD && !existingPos) {
    const quantity = Math.max(1, Math.floor(maxPos / q.price));
    const analysis = `${symbol} dropped ${q.changePercent.toFixed(2)}% to $${q.price.toFixed(2)}, ` +
      `touching intraday low $${q.low.toFixed(2)}. Mean reversion buy — ${quantity} shares at oversold level.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "buy", quantity, q.price, analysis);
      await updateAgentStats(agent, true, "buy", 0, false);
      return { action: "bought", analysis, orderPlaced: { symbol, side: "buy", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  if (q.changePercent >= OVERBOUGHT && existingPos) {
    const quantity = existingPos.qty;
    const analysis = `${symbol} up ${q.changePercent.toFixed(2)}% — approaching overbought. ` +
      `Selling ${quantity} shares at $${q.price.toFixed(2)} (entered at $${existingPos.avgCost.toFixed(2)}).`;
    try {
      const result = await placeAgentOrder(agent, symbol, "sell", quantity, q.price, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * quantity;
      await updateAgentStats(agent, true, "sell", pnl, pnl > 0);
      return { action: "sold", analysis, orderPlaced: { symbol, side: "sell", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  const analysis = existingPos
    ? `${symbol} at ${q.changePercent.toFixed(2)}% — holding ${existingPos.qty} shares, waiting for ${OVERBOUGHT}%+ to take profit.`
    : `${symbol} at ${q.changePercent.toFixed(2)}% — not yet oversold (need <${OVERSOLD}%). Current price $${q.price.toFixed(2)}.`;
  await updateAgentStats(agent, false, null, 0, false);
  return { action: "no_signal", analysis, orderPlaced: null };
}

async function strategyBreakout(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  q: ResolvedQuote,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<AgentRunResult> {
  const distFromHigh = q.high > 0 ? ((q.high - q.price) / q.high) * 100 : 100;
  const BREAKOUT_THRESHOLD = 0.4; // within 0.4% of high = breakout

  if (distFromHigh <= BREAKOUT_THRESHOLD && !existingPos) {
    const quantity = Math.max(1, Math.floor(maxPos / q.price));
    const analysis = `${symbol} breaking out at $${q.price.toFixed(2)}, only ${distFromHigh.toFixed(2)}% below session high $${q.high.toFixed(2)}. ` +
      `Volume ${(q.volume / 1_000_000).toFixed(1)}M. Entering breakout long — ${quantity} shares.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "buy", quantity, q.price, analysis);
      await updateAgentStats(agent, true, "buy", 0, false);
      return { action: "bought", analysis, orderPlaced: { symbol, side: "buy", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  if (distFromHigh > 2.5 && existingPos) {
    const quantity = existingPos.qty;
    const analysis = `${symbol} pulled back ${distFromHigh.toFixed(1)}% from session high — breakout failed. ` +
      `Exiting ${quantity} shares at $${q.price.toFixed(2)}.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "sell", quantity, q.price, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * quantity;
      await updateAgentStats(agent, true, "sell", pnl, pnl > 0);
      return { action: "sold", analysis, orderPlaced: { symbol, side: "sell", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  const analysis = existingPos
    ? `${symbol} at $${q.price.toFixed(2)}, holding position. ${distFromHigh.toFixed(1)}% below high.`
    : `${symbol} at $${q.price.toFixed(2)}, ${distFromHigh.toFixed(1)}% below session high $${q.high.toFixed(2)}. No breakout yet.`;
  await updateAgentStats(agent, false, null, 0, false);
  return { action: "no_signal", analysis, orderPlaced: null };
}

async function strategyTrendFollowing(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  q: ResolvedQuote,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<AgentRunResult> {
  const TREND_UP = 0.8;
  const TREND_DOWN = -1.0;

  if (q.changePercent >= TREND_UP && !existingPos) {
    const quantity = Math.max(1, Math.floor(maxPos / q.price));
    const analysis = `${symbol} trending up ${q.changePercent.toFixed(2)}% today. ` +
      `Price $${q.price.toFixed(2)} above open $${q.open.toFixed(2)}. Trend-following entry — ${quantity} shares.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "buy", quantity, q.price, analysis);
      await updateAgentStats(agent, true, "buy", 0, false);
      return { action: "bought", analysis, orderPlaced: { symbol, side: "buy", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  if (q.changePercent <= TREND_DOWN && existingPos) {
    const quantity = existingPos.qty;
    const analysis = `${symbol} trend broken at ${q.changePercent.toFixed(2)}%. ` +
      `Exiting ${quantity}-share position at $${q.price.toFixed(2)}.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "sell", quantity, q.price, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * quantity;
      await updateAgentStats(agent, true, "sell", pnl, pnl > 0);
      return { action: "sold", analysis, orderPlaced: { symbol, side: "sell", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  const analysis = existingPos
    ? `${symbol} at ${q.changePercent.toFixed(2)}%, riding trend. Holding ${existingPos.qty} shares @ $${existingPos.avgCost.toFixed(2)}.`
    : `${symbol} at ${q.changePercent.toFixed(2)}% — below ${TREND_UP}% trend entry threshold. Waiting.`;
  await updateAgentStats(agent, false, null, 0, false);
  return { action: existingPos ? "held" : "no_signal", analysis, orderPlaced: null };
}

async function strategyOptionsSelling(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  q: ResolvedQuote,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<AgentRunResult> {
  // Options selling strategy: own the underlying, collect premium on covered calls
  // Signal: buy underlying when IV proxy high (big intraday range vs price)
  const intradayRange = q.high - q.low;
  const ivProxy = q.price > 0 ? (intradayRange / q.price) * 100 : 0;
  const HIGH_IV = 1.2; // 1.2% intraday range = elevated IV

  if (ivProxy >= HIGH_IV && !existingPos) {
    const quantity = Math.max(1, Math.floor(maxPos / q.price));
    const strikePrice = +(q.price * 1.03).toFixed(2);
    const analysis = `${symbol} intraday range is ${ivProxy.toFixed(2)}% (high: $${q.high.toFixed(2)}, low: $${q.low.toFixed(2)}). ` +
      `Elevated IV proxy favors premium selling. Buying ${quantity} shares as underlying for covered call at $${strikePrice} strike.`;
    try {
      const result = await placeAgentOrder(agent, symbol, "buy", quantity, q.price, analysis);
      await updateAgentStats(agent, true, "buy", 0, false);
      return { action: "bought", analysis, orderPlaced: { symbol, side: "buy", quantity, price: result.filledPrice, alpacaId: result.alpacaId } };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  const analysis = existingPos
    ? `${symbol}: holding ${existingPos.qty} underlying shares for covered calls. IV proxy at ${ivProxy.toFixed(2)}%.`
    : `${symbol} IV proxy at ${ivProxy.toFixed(2)}% — below ${HIGH_IV}% threshold for premium entry. Range: $${q.low.toFixed(2)}–$${q.high.toFixed(2)}.`;
  await updateAgentStats(agent, false, null, 0, false);
  return { action: "no_signal", analysis, orderPlaced: null };
}

// ─── Public API ───────────────────────────────────────────────────────────────
function parseSymbols(val: string): string[] {
  try { return JSON.parse(val); } catch { return []; }
}

export async function runAgentLogic(agent: typeof agentsTable.$inferSelect): Promise<AgentRunResult> {
  const symbols = parseSymbols(agent.symbols);
  if (symbols.length === 0) {
    return { action: "no_signal", analysis: "No symbols configured for this agent.", orderPlaced: null };
  }

  // Pick symbol with most activity (or random if equal)
  const symbol = symbols[Math.floor(Math.random() * symbols.length)];
  const maxPos = parseFloat(agent.maxPositionSize);

  let quote: ResolvedQuote;
  try {
    quote = await resolveQuote(symbol);
  } catch (err: any) {
    return { action: "error", analysis: `Failed to fetch quote for ${symbol}: ${err.message}`, orderPlaced: null };
  }

  // Check current Alpaca position
  const existingPos = await getAlpacaPosition(symbol);

  logger.info({ agentId: agent.id, strategy: agent.strategy, symbol, price: quote.price, changePercent: quote.changePercent, source: quote.source, hasPosition: !!existingPos }, "Running agent strategy");

  switch (agent.strategy) {
    case "momentum":      return strategyMomentum(agent, symbol, quote, existingPos, maxPos);
    case "mean_reversion": return strategyMeanReversion(agent, symbol, quote, existingPos, maxPos);
    case "breakout":      return strategyBreakout(agent, symbol, quote, existingPos, maxPos);
    case "trend_following": return strategyTrendFollowing(agent, symbol, quote, existingPos, maxPos);
    case "options_selling": return strategyOptionsSelling(agent, symbol, quote, existingPos, maxPos);
    default: {
      await updateAgentStats(agent, false, null, 0, false);
      return { action: "no_signal", analysis: `Unknown strategy: ${agent.strategy}.`, orderPlaced: null };
    }
  }
}
