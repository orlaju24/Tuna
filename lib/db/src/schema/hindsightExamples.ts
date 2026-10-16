import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Hindsight trade examples — mentor-style historical patterns.
 *
 * Each row is a structured record extracted from a historical screenshot or
 * completed live trade. The auto-trader uses these to compare new live setups
 * against prior winning/losing contexts without a heavy ML model.
 *
 * Population paths:
 *   1. Manual upload  — user uploads a historical Bitunix screenshot; AI vision
 *      extracts the structured fields.
 *   2. Auto-promoted  — completed live trades are optionally promoted here with
 *      richer pattern tagging once outcome is known.
 *
 * Storage is intentionally lean (staged design from PDF):
 *   Stage 1: capture + extract only the most important fields.
 *   Stage 2: tag for retrieval (outcome class, time bucket, whole-number relation).
 *   Stage 3: deeper similarity analysis only when dataset is large enough.
 */
export const hindsightExamplesTable = pgTable("hindsight_examples", {
  id: serial("id").primaryKey(),

  // ── Identity ──────────────────────────────────────────────────────────────
  symbol:    text("symbol").notNull().default("BTCUSDT"),
  source:    text("source").notNull().default("upload"), // upload | auto_promoted

  // ── Position facts (extracted from screenshot or trade record) ────────────
  direction:  text("direction"),        // LONG | SHORT
  leverage:   integer("leverage"),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),
  exitPrice:  numeric("exit_price",  { precision: 20, scale: 8 }),
  roiPct:     numeric("roi_pct",     { precision: 10, scale: 4 }), // realized or unrealized

  // ── BTC context ───────────────────────────────────────────────────────────
  btcSpotPrice:         numeric("btc_spot_price", { precision: 20, scale: 8 }),
  wholeNumberNearest:   numeric("whole_number_nearest", { precision: 20, scale: 2 }),
  wholeNumberRelation:  text("whole_number_relation"),   // above | below | at
  wholeNumberDistPct:   numeric("whole_number_dist_pct", { precision: 6, scale: 3 }),

  // ── Session context ───────────────────────────────────────────────────────
  tradeTimestamp:  timestamp("trade_timestamp"),         // extracted from image (best effort)
  sessionBucket:   text("session_bucket"),               // asian | london | ny | pre-market
  timeOfDayLabel:  text("time_of_day_label"),            // e.g. "21:05 UTC-4"

  // ── Entry / exit style ────────────────────────────────────────────────────
  closeType:    text("close_type"),      // flash_close | tp | safeguard | manual | unknown
  triggerType:  text("trigger_type"),    // auto_entry | manual | unknown

  // ── Outcome ───────────────────────────────────────────────────────────────
  profitStatus:  text("profit_status"),   // win | loss | partial | open | unknown
  outcomeClass:  text("outcome_class"),   // strong_win | win | scratch | loss | strong_loss

  // ── Market regime (from chart reading or AI inference) ───────────────────
  marketRegime:  text("market_regime"),   // trending_up | trending_down | ranging | volatile

  // ── AI extraction metadata ────────────────────────────────────────────────
  confidenceScore:  integer("confidence_score"),   // 0-100 model-assigned extraction confidence
  extractionNotes:  text("extraction_notes"),      // AI explanation of what it saw
  rawExtraction:    jsonb("raw_extraction"),        // full JSON blob from AI for future re-processing

  // ── Image storage ─────────────────────────────────────────────────────────
  imageKey:  text("image_key"),   // object storage key, e.g. /objects/private/hindsight/xxx.png

  // ── User annotation ───────────────────────────────────────────────────────
  userNotes:  text("user_notes"),
  tags:       text("tags"),        // comma-separated free-form tags

  // ── Link to live journal record (if auto-promoted) ────────────────────────
  journalId:  integer("journal_id"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type HindsightExample = typeof hindsightExamplesTable.$inferSelect;
export type InsertHindsightExample = typeof hindsightExamplesTable.$inferInsert;
