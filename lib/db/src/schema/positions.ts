import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const positionsTable = pgTable("positions", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  assetType: text("asset_type").notNull().default("stock"), // stock | option
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  avgCost: numeric("avg_cost", { precision: 18, scale: 4 }).notNull(),
  currentPrice: numeric("current_price", { precision: 18, scale: 4 }).notNull().default("0"),
  optionType: text("option_type"), // call | put | null
  strikePrice: numeric("strike_price", { precision: 18, scale: 4 }),
  expirationDate: text("expiration_date"),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertPositionSchema = createInsertSchema(positionsTable).omit({ id: true, openedAt: true, updatedAt: true });
export type InsertPosition = z.infer<typeof insertPositionSchema>;
export type Position = typeof positionsTable.$inferSelect;
