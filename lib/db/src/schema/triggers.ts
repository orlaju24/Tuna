import { pgTable, serial, text, numeric, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const triggersTable = pgTable("triggers", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull(),
  triggerPrice: numeric("trigger_price", { precision: 20, scale: 8 }).notNull(),
  direction: text("direction").notNull(), // "cross_above" | "cross_below"
  closeMethod: text("close_method").notNull(), // "flash_close" | "close_all"
  armed: boolean("armed").notNull().default(false),
  watcherStatus: text("watcher_status").notNull().default("draft"),
  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  triggeredAt: timestamp("triggered_at"),
  completedAt: timestamp("completed_at"),
});

export const insertTriggerSchema = createInsertSchema(triggersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  triggeredAt: true,
  completedAt: true,
});
export type InsertTrigger = z.infer<typeof insertTriggerSchema>;
export type Trigger = typeof triggersTable.$inferSelect;
