import { pgTable, serial, text, numeric, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ordersTable = pgTable("orders", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  assetType: text("asset_type").notNull().default("stock"),
  side: text("side").notNull(), // buy | sell
  orderType: text("order_type").notNull().default("market"), // market | limit | stop
  quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
  limitPrice: numeric("limit_price", { precision: 18, scale: 4 }),
  stopPrice: numeric("stop_price", { precision: 18, scale: 4 }),
  filledPrice: numeric("filled_price", { precision: 18, scale: 4 }),
  status: text("status").notNull().default("pending"), // pending | filled | cancelled | rejected
  agentId: integer("agent_id"),
  agentName: text("agent_name"),
  reason: text("reason"),
  optionType: text("option_type"),
  strikePrice: numeric("strike_price", { precision: 18, scale: 4 }),
  expirationDate: text("expiration_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  filledAt: timestamp("filled_at", { withTimezone: true }),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({ id: true, createdAt: true });
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type Order = typeof ordersTable.$inferSelect;
