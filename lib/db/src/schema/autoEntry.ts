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

// ── Auto-Entry Config (single row, single-user app) ──────────────────────────

export const autoEntryConfigTable = pgTable("auto_entry_config", {
  id: serial("id").primaryKey(),

  enabled: boolean("enabled").notNull().default(false),

  // Which symbol and direction to trade
  symbol: text("symbol").notNull().default("BTCUSDT"),
  side: text("side").notNull().default("SIGNAL"), // LONG | SHORT | SIGNAL (auto)

  // Risk parameters
  maxMarginUsdt: numeric("max_margin_usdt", { precision: 20, scale: 4 })
    .notNull()
    .default("500"),
  leverage: integer("leverage").notNull().default(50),

  // Anti-liquidation: estimated liq gap = entryPrice / leverage must be >= this
  minLiqGapUsdt: numeric("min_liq_gap_usdt", { precision: 20, scale: 4 })
    .notNull()
    .default("3000"),

  // Quality gate
  minEdgeScore: integer("min_edge_score").notNull().default(65),

  // "Middles" filter — block entry when price is in the 30%-70% zone
  // between consecutive whole-number levels (most dangerous zone per PDF)
  avoidMiddles: boolean("avoid_middles").notNull().default(true),

  // Time-of-day windows (America/New_York).
  // allowedWindows: must be in at least one window to enter.
  // blockedWindows: always blocked regardless of allowed list.
  // Format: [{label, startHour, startMin, endHour, endMin}]
  // null = no filtering (all times allowed / nothing blocked).
  allowedWindowsJson: jsonb("allowed_windows_json"),
  blockedWindowsJson: jsonb("blocked_windows_json"),

  // Safeguard auto-arm after entry
  autoArmSafeguard: boolean("auto_arm_safeguard").notNull().default(true),
  safeguardThreshold1Pct: numeric("safeguard_threshold1_pct", {
    precision: 10,
    scale: 4,
  })
    .notNull()
    .default("17"),
  safeguardTrailPct: numeric("safeguard_trail_pct", { precision: 10, scale: 4 })
    .notNull()
    .default("3"),

  // ── Governance states ─────────────────────────────────────────────────────
  // sessionFrozen: hard kill-switch — blocks all auto-entry regardless of
  // signal quality. Persists across restarts. Requires manual unfreeze.
  sessionFrozen: boolean("session_frozen").notNull().default(false),

  // walkAwayMode: user-engaged "stand down" signal. Set after a clean close
  // to explicitly prevent re-entry until the user confirms a fresh setup.
  // Unlike the automatic post-close revalidation wait, this stays active
  // until the user manually resumes.
  walkAwayMode: boolean("walk_away_mode").notNull().default(false),

  // Post-win humility: after a strong gain (≥30% ROI), the oracle becomes
  // briefly more selective for 4 hours. Prevents overconfidence from a
  // profitable trade creating a reckless follow-up.
  // null = humility not active.
  postWinHumilityUntil: timestamp("post_win_humility_until"),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type AutoEntryConfig = typeof autoEntryConfigTable.$inferSelect;

// ── Auto-Entry Log (one row per evaluation cycle) ────────────────────────────

export const autoEntryLogTable = pgTable("auto_entry_log", {
  id: serial("id").primaryKey(),

  evaluatedAt: timestamp("evaluated_at").notNull().defaultNow(),

  // Overall verdict
  allowed: boolean("allowed").notNull(),
  blockReasons: text("block_reasons").array().notNull().default([]),

  // Per-check results
  positionFlat: boolean("position_flat").notNull(),
  timeWindowOk: boolean("time_window_ok").notNull(),
  avoidMiddlesOk: boolean("avoid_middles_ok").notNull(),
  edgeOk: boolean("edge_ok").notNull(),
  liqGapOk: boolean("liq_gap_ok").notNull(),

  // Plan gate — null when no plan exists (gate open by default)
  planGateOk: boolean("plan_gate_ok"),
  planLikelyAction: text("plan_likely_action"),      // enter | wait | stand-down
  planConfidenceLevel: integer("plan_confidence_level"),
  planAgreementScore: integer("plan_agreement_score"),
  planReturnToZoneNote: text("plan_return_to_zone_note"),

  // Computed values at evaluation time
  edgeScore: integer("edge_score"),
  edgeGrade: text("edge_grade"),
  liqGapEstimate: numeric("liq_gap_estimate", { precision: 20, scale: 4 }),
  detectedSide: text("detected_side"),   // what side was determined/used
  currentPrice: numeric("current_price", { precision: 20, scale: 8 }),

  // Entry result (only if allowed === true and entry was attempted)
  entryOpened: boolean("entry_opened").notNull().default(false),
  entrySymbol: text("entry_symbol"),
  entrySide: text("entry_side"),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),
  entryQty: numeric("entry_qty", { precision: 20, scale: 8 }),
  marginUsed: numeric("margin_used", { precision: 20, scale: 4 }),
  positionId: text("position_id"),

  safeguardArmed: boolean("safeguard_armed").notNull().default(false),
  safeguardId: integer("safeguard_id"),

  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type AutoEntryLog = typeof autoEntryLogTable.$inferSelect;
