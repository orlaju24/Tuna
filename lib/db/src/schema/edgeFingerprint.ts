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
 * Edge Fingerprint Store.
 *
 * Stores compact, comparable representations of every completed trade setup.
 * Used by the Oracle to compare live conditions against historical patterns
 * (both live trade outcomes and manually curated mentor examples) to assess
 * whether the current moment resembles a real repeatable edge or a noisy one-off.
 *
 * Philosophy: the system remembers QUALITY, not just outcome.
 * A clean structured win and a lucky mess can both be "wins" — only the
 * fingerprint + quality label can tell them apart.
 */
export const edgeFingerprintsTable = pgTable("edge_fingerprints", {
  id: serial("id").primaryKey(),

  // Link to live trade journal row (null for manually added mentor examples)
  journalId: integer("journal_id"),

  symbol: text("symbol").notNull().default("BTCUSDT"),

  // How this record was created
  source: text("source").notNull().default("auto"), // auto | mentor

  // ── Compact fingerprint vector (JSONB) ────────────────────────────────────
  // Fields: timeBucket, btcRegion, wholeNumberRelation, wholeNumberFraction,
  //         direction, velocityFeel, oracleScoreBucket, htfAlignmentStr, haAligned
  fingerprint: jsonb("fingerprint").notNull(),

  // ── Quality label ─────────────────────────────────────────────────────────
  // Auto-derived from journal data or user-assigned for mentor examples.
  // clean | messy | forced | high-conviction | late | transitional
  qualityLabel: text("quality_label").notNull().default("transitional"),

  // ── Outcome ───────────────────────────────────────────────────────────────
  outcome: text("outcome").notNull().default("unknown"), // win | loss | breakeven | unknown
  roiPct:  numeric("roi_pct", { precision: 10, scale: 4 }),

  // ── Mentor example metadata ───────────────────────────────────────────────
  // null = normal auto-promoted trade
  // ideal_entry | ideal_exit | near_miss | false_breakout | regret_sample
  exampleType:     text("example_type"),
  isMentorExample: boolean("is_mentor_example").notNull().default(false),

  // User notes (for mentor examples)
  notes: text("notes"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type EdgeFingerprintRow    = typeof edgeFingerprintsTable.$inferSelect;
export type InsertEdgeFingerprint = typeof edgeFingerprintsTable.$inferInsert;
