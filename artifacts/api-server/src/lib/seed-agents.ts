import { db } from "@workspace/db";
import { agentsTable } from "@workspace/db";
import { logger } from "./logger.js";

const AGENTS = [
  {
    name: "Trend Rider",
    strategy: "momentum",
    description: "Rides strong momentum with full Kelly sizing. Options on breakouts.",
    riskLevel: "high",
    symbols: ["AAPL","NVDA","TSLA","AMD","META","MSFT","GOOGL","AMZN"],
    maxPositionSize: "25000",
  },
  {
    name: "Reversion King",
    strategy: "mean_reversion",
    description: "Fades overextended moves. Sells premium when IV spikes.",
    riskLevel: "medium",
    symbols: ["SPY","QQQ","MSFT","AMZN","GOOGL","JPM","V","JNJ"],
    maxPositionSize: "20000",
  },
  {
    name: "Beast Mode",
    strategy: "aggressive",
    description: "Max aggression. High-beta plays, full Kelly, no mercy.",
    riskLevel: "high",
    symbols: ["PLTR","SOFI","MARA","COIN","RIVN","LCID","HOOD","UPST"],
    maxPositionSize: "30000",
  },
  {
    name: "Options Hunter",
    strategy: "options",
    description: "Primary options specialist. Hunts IV dislocations, earnings plays, and spreads.",
    riskLevel: "high",
    symbols: ["SPY","QQQ","AAPL","NVDA","TSLA","AMD","META","AMZN","MSFT","GOOGL"],
    maxPositionSize: "30000",
  },
  {
    name: "Earnings Sniper",
    strategy: "earnings_play",
    description: "Buys cheap IV before earnings, sells premium post-announcement.",
    riskLevel: "high",
    symbols: ["NVDA","AAPL","META","GOOGL","MSFT","AMZN","NFLX","CRM","ORCL","ADBE"],
    maxPositionSize: "25000",
  },
  {
    name: "Volatility Crusher",
    strategy: "vol_arb",
    description: "Sells elevated IV via condors and spreads. Theta decay machine.",
    riskLevel: "high",
    symbols: ["SPY","QQQ","IWM","GLD","TLT","XLF","XLE","XLK","EEM","GDX"],
    maxPositionSize: "20000",
  },
  {
    name: "Momentum Scalper",
    strategy: "scalping",
    description: "Fast momentum plays on high-beta names. Quick in, quick out.",
    riskLevel: "high",
    symbols: ["TSLA","NVDA","AMD","COIN","MARA","PLTR","SOFI","RIVN","LCID","HOOD"],
    maxPositionSize: "20000",
  },
  {
    name: "Macro Trader",
    strategy: "macro",
    description: "Trades macro themes — rates, commodities, dollar, global equity.",
    riskLevel: "medium",
    symbols: ["TLT","GLD","SLV","USO","FXI","EEM","SPY","DIA","IWM","XLE"],
    maxPositionSize: "20000",
  },
  {
    name: "Short Squeeze Hunter",
    strategy: "squeeze",
    description: "Detects high short interest + momentum = explosive squeeze plays.",
    riskLevel: "high",
    symbols: ["GME","AMC","PLTR","SOFI","MARA","RIOT","COIN","BBBY","SPWR","NKLA"],
    maxPositionSize: "15000",
  },
  {
    name: "Sector Rotator",
    strategy: "rotation",
    description: "Rotates into strongest sectors using ETFs and options.",
    riskLevel: "medium",
    symbols: ["XLK","XLF","XLE","XLV","XLU","XLB","XLC","XLRE","XLI","XLP"],
    maxPositionSize: "20000",
  },
];

export async function seedAgents() {
  const existing = await db.select().from(agentsTable);
  const existingNames = new Set(existing.map(a => a.name));

  const toInsert = AGENTS.filter(a => !existingNames.has(a.name));

  if (toInsert.length === 0) {
    logger.info("All agents already seeded — skipping");
    return;
  }

  for (const a of toInsert) {
    await db.insert(agentsTable).values({
      name: a.name,
      strategy: a.strategy,
      description: a.description,
      symbols: JSON.stringify(a.symbols),
      riskLevel: a.riskLevel,
      maxPositionSize: a.maxPositionSize,
      isActive: true,
      totalTrades: 0,
      winRate: "0",
      totalPnl: "0",
      lastRunAt: new Date(),
    });
    logger.info({ name: a.name }, "Agent seeded");
  }

  logger.info({ count: toInsert.length }, "Agents seeded successfully");
}
