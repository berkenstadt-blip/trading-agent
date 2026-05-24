import { db } from "@workspace/db";
import { agentsTable, ordersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import OpenAI from "openai";
import * as alpaca from "./alpaca.js";
import { getSimulatedQuote } from "./market-data.js";
import { logger } from "./logger.js";

const HERMES_MODEL = "nousresearch/hermes-4-70b";

// Lazy-init OpenRouter client so the server still boots if env vars are missing
let _openrouter: OpenAI | null = null;
function getOpenRouter(): OpenAI | null {
  if (_openrouter) return _openrouter;
  const baseURL = process.env.AI_INTEGRATIONS_OPENROUTER_BASE_URL;
  const apiKey = process.env.AI_INTEGRATIONS_OPENROUTER_API_KEY;
  if (!baseURL || !apiKey) return null;
  _openrouter = new OpenAI({ baseURL, apiKey });
  return _openrouter;
}

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
        symbol: symbol.toUpperCase(), price, changePercent, change,
        high: snap.dailyBar?.h ?? price, low: snap.dailyBar?.l ?? price,
        open: snap.dailyBar?.o ?? price, prevClose,
        volume: snap.dailyBar?.v ?? 0, source: "alpaca",
      };
    } catch (err) {
      logger.warn({ err, symbol }, "Alpaca snapshot failed, using simulated quote");
    }
  }
  const q = getSimulatedQuote(symbol);
  return {
    symbol: symbol.toUpperCase(), price: q.price, changePercent: q.changePercent,
    change: q.change, high: q.high, low: q.low, open: q.open,
    prevClose: q.previousClose, volume: q.volume, source: "simulated",
  };
}

async function getAlpacaPosition(symbol: string): Promise<{ qty: number; avgCost: number } | null> {
  if (!alpaca.isConfigured()) return null;
  try {
    const pos = await alpaca.getPosition(symbol);
    return { qty: parseFloat(pos.qty), avgCost: parseFloat(pos.avg_entry_price) };
  } catch {
    return null;
  }
}

// ─── Place order via Alpaca ───────────────────────────────────────────────────
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
    const alpacaOrder = await alpaca.placeOrder({ symbol, qty: quantity, side, type: "market", time_in_force: "day" });
    alpacaId = alpacaOrder.id;
    if (alpacaOrder.filled_avg_price) filledPrice = parseFloat(alpacaOrder.filled_avg_price);
    logger.info({ alpacaId, symbol, side, quantity }, "Agent placed real Alpaca order");
  }

  const [order] = await db.insert(ordersTable).values({
    symbol, assetType: "stock", side, orderType: "market",
    quantity: quantity.toString(), filledPrice: filledPrice.toString(),
    status: "filled", agentId: agent.id, agentName: agent.name,
    reason: reason.slice(0, 300), filledAt: new Date(),
  }).returning();

  return { orderId: order.id, alpacaId, filledPrice };
}

async function updateAgentStats(
  agent: typeof agentsTable.$inferSelect,
  traded: boolean,
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
    totalTrades: newTrades, winRate: newWinRate.toFixed(2),
    totalPnl: newTotalPnl.toFixed(4), lastRunAt: new Date(),
  }).where(eq(agentsTable.id, agent.id));
}

// ─── Hermes LLM decision ──────────────────────────────────────────────────────
interface HermesDecision {
  action: "buy" | "sell" | "hold";
  quantity: number;
  confidence: number; // 0–100
  reasoning: string;
}

const STRATEGY_PERSONAS: Record<string, string> = {
  momentum: `You are Hermes running a MOMENTUM strategy. You buy when price shows strong upward momentum (typically >1% gain from previous close) and sell positions when momentum reverses (<-1%). You are aggressive and conviction-driven. You never hold losing positions for long.`,
  mean_reversion: `You are Hermes running a MEAN REVERSION strategy. You buy oversold dips (>1.5% below previous close) expecting price to recover, and sell overbought conditions (>1.5% above previous close). You are patient and disciplined. You wait for clear extremes.`,
  breakout: `You are Hermes running a BREAKOUT strategy. You buy when price is within 0.5% of its session high, confirming breakout momentum. You exit if the breakout fails (>2.5% pullback from high). You are fast and decisive — breakouts require immediate action.`,
  trend_following: `You are Hermes running a TREND FOLLOWING strategy. You enter trends early (>0.8% positive movement) and ride them. You exit only when the trend clearly breaks (<-1%). You are systematic and avoid over-trading.`,
  options_selling: `You are Hermes running an OPTIONS SELLING / PREMIUM COLLECTION strategy. You buy the underlying stock when implied volatility is elevated (intraday range >1.2% of price) to set up covered calls. You are conservative and income-focused.`,
};

async function hermesDecide(
  agent: typeof agentsTable.$inferSelect,
  symbol: string,
  q: ResolvedQuote,
  existingPos: { qty: number; avgCost: number } | null,
  maxPos: number,
): Promise<HermesDecision> {
  const client = getOpenRouter();
  if (!client) throw new Error("OpenRouter not configured");

  const maxQty = Math.max(1, Math.floor(maxPos / q.price));
  const persona = STRATEGY_PERSONAS[agent.strategy] ?? `You are Hermes, an AI trading agent running a ${agent.strategy} strategy.`;

  const systemPrompt = `${persona}

RULES:
- Respond ONLY with a valid JSON object, nothing else.
- "action": "buy" | "sell" | "hold"
- "quantity": integer between 1 and ${maxQty} (only matters when action is buy or sell)
- "confidence": integer 0-100
- "reasoning": one concise sentence explaining your decision (max 200 chars)
- Only recommend "sell" if there is an existing position to sell.
- Only recommend "buy" if there is NO existing position (avoid doubling up).
- When in doubt, hold.`;

  const userPrompt = `Symbol: ${symbol}
Current price: $${q.price.toFixed(2)}
Previous close: $${q.prevClose.toFixed(2)}
Change: ${q.change >= 0 ? "+" : ""}${q.change.toFixed(2)} (${q.changePercent >= 0 ? "+" : ""}${q.changePercent.toFixed(2)}%)
Session high: $${q.high.toFixed(2)}
Session low: $${q.low.toFixed(2)}
Open: $${q.open.toFixed(2)}
Volume: ${(q.volume / 1_000_000).toFixed(2)}M
Data source: ${q.source}
Existing position: ${existingPos ? `${existingPos.qty} shares @ avg $${existingPos.avgCost.toFixed(2)}` : "none"}
Max position size: $${maxPos.toFixed(0)} (max ${maxQty} shares)

What is your trading decision?`;

  const response = await client.chat.completions.create({
    model: HERMES_MODEL,
    max_completion_tokens: 256,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  // Strip any markdown code fences
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const parsed = JSON.parse(cleaned) as HermesDecision;

  // Sanitize
  if (!["buy", "sell", "hold"].includes(parsed.action)) parsed.action = "hold";
  parsed.quantity = Math.max(1, Math.min(maxQty, Math.round(parsed.quantity) || 1));
  parsed.confidence = Math.max(0, Math.min(100, parsed.confidence ?? 50));
  parsed.reasoning = String(parsed.reasoning ?? "No reasoning provided.").slice(0, 200);

  return parsed;
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

  const symbol = symbols[Math.floor(Math.random() * symbols.length)];
  const maxPos = parseFloat(agent.maxPositionSize);

  let quote: ResolvedQuote;
  try {
    quote = await resolveQuote(symbol);
  } catch (err: any) {
    return { action: "error", analysis: `Failed to fetch quote for ${symbol}: ${err.message}`, orderPlaced: null };
  }

  const existingPos = await getAlpacaPosition(symbol);

  logger.info({
    agentId: agent.id, strategy: agent.strategy, symbol,
    price: quote.price, changePercent: quote.changePercent,
    source: quote.source, hasPosition: !!existingPos,
  }, "Hermes agent running");

  let decision: HermesDecision;
  try {
    decision = await hermesDecide(agent, symbol, quote, existingPos, maxPos);
    logger.info({ agentId: agent.id, decision }, "Hermes decision received");
  } catch (err: any) {
    logger.error({ err, agentId: agent.id }, "Hermes LLM call failed");
    return { action: "error", analysis: `Hermes could not reach a decision: ${err.message}`, orderPlaced: null };
  }

  const analysis = `[${decision.confidence}% confidence] ${decision.reasoning}`;

  // Execute buy
  if (decision.action === "buy" && !existingPos) {
    try {
      const result = await placeAgentOrder(agent, symbol, "buy", decision.quantity, quote.price, analysis);
      await updateAgentStats(agent, true, 0, false);
      return {
        action: "bought", analysis,
        orderPlaced: { symbol, side: "buy", quantity: decision.quantity, price: result.filledPrice, alpacaId: result.alpacaId },
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  // Execute sell
  if (decision.action === "sell" && existingPos) {
    const qty = Math.min(decision.quantity, existingPos.qty);
    try {
      const result = await placeAgentOrder(agent, symbol, "sell", qty, quote.price, analysis);
      const pnl = (result.filledPrice - existingPos.avgCost) * qty;
      await updateAgentStats(agent, true, pnl, pnl > 0);
      return {
        action: "sold", analysis,
        orderPlaced: { symbol, side: "sell", quantity: qty, price: result.filledPrice, alpacaId: result.alpacaId },
      };
    } catch (err: any) {
      return { action: "error", analysis: `${analysis} — Order failed: ${err.message}`, orderPlaced: null };
    }
  }

  // Hold or no-signal
  await updateAgentStats(agent, false, 0, false);
  const finalAction = decision.action === "hold" ? "held" : "no_signal";
  return { action: finalAction, analysis, orderPlaced: null };
}
