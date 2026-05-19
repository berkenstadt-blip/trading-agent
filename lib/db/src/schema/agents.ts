import { pgTable, serial, text, numeric, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  strategy: text("strategy").notNull(), // momentum | mean_reversion | breakout | trend_following | options_selling
  description: text("description").notNull().default(""),
  isActive: boolean("is_active").notNull().default(false),
  symbols: text("symbols").notNull().default("[]"), // JSON array stored as text
  riskLevel: text("risk_level").notNull().default("medium"), // low | medium | high
  maxPositionSize: numeric("max_position_size", { precision: 18, scale: 4 }).notNull().default("5000"),
  totalTrades: integer("total_trades").notNull().default(0),
  winRate: numeric("win_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  totalPnl: numeric("total_pnl", { precision: 18, scale: 4 }).notNull().default("0"),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({ id: true, createdAt: true, totalTrades: true, winRate: true, totalPnl: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;
