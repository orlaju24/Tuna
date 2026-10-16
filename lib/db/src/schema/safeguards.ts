import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// App-side profit safeguard. The exchange (Bitunix) never sees this record —
// it is purely an internal watchlist. When the retrace hits the safeguardPrice
// threshold, the watcher fires a normal flash_close / close_all call exactly
// as the trigger system does, so Bitunix only sees the final execution action.
export const safeguardsTable = pgTable("safeguards", {
  id: serial("id").primaryKey(),

  // Position identity
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),      // LONG | SHORT
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }).notNull(),
  qty: numeric("qty", { precision: 20, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull().default(1),
  positionId: text("position_id"),

  // Configurable thresholds (ROI % on margin, not price %)
  threshold1Pct: numeric("threshold1_pct", { precision: 10, scale: 4 })
    .notNull()
    .default("17"), // first protection milestone
  threshold2Pct: numeric("threshold2_pct", { precision: 10, scale: 4 })
    .notNull()
    .default("23"), // fee-aware defend zone
  trailStepPct: numeric("trail_step_pct", { precision: 10, scale: 4 })
    .notNull()
    .default("3"), // step kept below high-water ROI

  // Runtime state
  state: text("state").notNull().default("armed"),
  // armed | protecting | triggered | completed | failed | cancelled

  // The internal trailing close price — null until threshold1 is hit.
  // This is the ONLY price Bitunix will ever see, and only at the moment
  // the watcher executes the close.
  safeguardPrice: numeric("safeguard_price", { precision: 20, scale: 8 }),
  highWaterRoiPct: numeric("high_water_roi_pct", { precision: 10, scale: 4 }),

  closeMethod: text("close_method").notNull().default("flash_close"),
  // flash_close | close_all

  // Trailing mode — controls how the trail width is computed once protecting.
  // tight:     fixed 2 pp — locks gains fast, sacrifices some upside
  // standard:  fixed 3 pp — balanced default
  // wide:      fixed 5 pp — breathes on clean trends, captures more upside
  // structure: adaptiveTrail(signalScore) + plan delta — market-rhythm driven
  // adaptive:  full stack (structure + plan + oracle + profit quality + capture)
  trailingMode: text("trailing_mode").notNull().default("adaptive"),

  lastError: text("last_error"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  triggeredAt: timestamp("triggered_at"),
  completedAt: timestamp("completed_at"),
});

export const insertSafeguardSchema = createInsertSchema(safeguardsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  triggeredAt: true,
  completedAt: true,
});
export type InsertSafeguard = z.infer<typeof insertSafeguardSchema>;
export type Safeguard = typeof safeguardsTable.$inferSelect;
