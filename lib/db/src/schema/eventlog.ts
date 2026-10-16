import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const eventLogTable = pgTable("event_log", {
  id: serial("id").primaryKey(),
  symbol: text("symbol"),
  eventType: text("event_type").notNull(),
  eventMessage: text("event_message").notNull(),
  source: text("source"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertEventLogSchema = createInsertSchema(eventLogTable).omit({ id: true, createdAt: true });
export type InsertEventLog = z.infer<typeof insertEventLogSchema>;
export type EventLog = typeof eventLogTable.$inferSelect;
