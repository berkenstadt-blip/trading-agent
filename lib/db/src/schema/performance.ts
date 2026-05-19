import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const performanceTable = pgTable("performance_snapshots", {
  id: serial("id").primaryKey(),
  date: text("date").notNull(), // ISO date string YYYY-MM-DD
  portfolioValue: numeric("portfolio_value", { precision: 18, scale: 4 }).notNull(),
  cashBalance: numeric("cash_balance", { precision: 18, scale: 4 }).notNull(),
  pnl: numeric("pnl", { precision: 18, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPerformanceSchema = createInsertSchema(performanceTable).omit({ id: true, createdAt: true });
export type InsertPerformance = z.infer<typeof insertPerformanceSchema>;
export type Performance = typeof performanceTable.$inferSelect;
