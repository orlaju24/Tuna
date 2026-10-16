import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";

/**
 * Trade Events — append-only event log anchored by trade_id.
 *
 * Every significant action in a trade's lifecycle is appended here with the
 * same trade_id, regardless of whether the action was manual, automatic,
 * safeguard-driven, or oracle-triggered.
 *
 * This makes it possible to reconstruct the full story of any trade:
 *   position_opened → safeguard_armed → ratchet → safeguard_close
 *   position_opened → trigger_close
 *   position_opened → manual_close
 *   position_opened (auto) → manual_close    ← mixed path, still one story
 *   position_opened (manual) → safeguard_close ← mixed path, still one story
 *
 * The trade_journal table holds the final materialized summary (one row per
 * trade). This table holds the full sequence.
 *
 * Event types (not exhaustive — new types can be added without schema changes):
 *   position_opened    — position first detected / opened
 *   safeguard_armed    — profit guard activated
 *   safeguard_ratchet  — ladder advanced to next rung
 *   safeguard_close    — safeguard fired and closed the trade
 *   trigger_armed      — price-cross trigger activated
 *   trigger_close      — trigger fired and closed the trade
 *   manual_close       — operator manually closed via flash_close or close_all
 *   cooldown_started   — post-close re-entry block started
 *   walk_away_engaged  — operator walk-away mode activated
 *   freeze_activated   — session hard-freeze activated
 *
 * Source values:
 *   manual | auto | safeguard | trigger | oracle | system
 */
export const tradeEventsTable = pgTable("trade_events", {
  id:       serial("id").primaryKey(),
  tradeId:  text("trade_id").notNull(),     // UUID — the canonical anchor
  symbol:   text("symbol").notNull(),
  eventType: text("event_type").notNull(),
  source:   text("source").notNull(),       // manual | auto | safeguard | trigger | oracle | system
  price:    numeric("price",   { precision: 20, scale: 8 }),
  roiPct:   numeric("roi_pct", { precision: 10, scale: 4 }),
  payload:  text("payload"),               // JSON blob for extra event-specific data
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TradeEvent       = typeof tradeEventsTable.$inferSelect;
export type InsertTradeEvent = typeof tradeEventsTable.$inferInsert;
