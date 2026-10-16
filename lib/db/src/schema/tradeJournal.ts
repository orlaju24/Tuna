import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

export const tradeJournalTable = pgTable("trade_journal", {
  id: serial("id").primaryKey(),

  // Canonical trade identity
  // UUID generated when the position opened. Shared by positionEntryLog,
  // trade_events, and this row so the full lifecycle can be reconstructed
  // even when the open and close paths were different (e.g. auto-open + manual close).
  tradeId: text("trade_id"),

  // Who opened this trade (sourced from positionTracker at close time)
  openedBy: text("opened_by"),           // manual | auto_entry | detected | null (unknown)

  // How complete the entry-time data is.
  //   full      — oracle score, entry price, hold duration all from positionTracker at-entry snapshot
  //   partial   — some fields derived at close time (no tracker entry for this positionId)
  //   inferred  — no position data at all; price/ROI fields may be null
  dataConfidence: text("data_confidence").default("full"),

  // Position identity
  symbol: text("symbol").notNull(),
  side: text("side").notNull(),         // LONG | SHORT
  leverage: integer("leverage").notNull().default(1),
  positionId: text("position_id"),

  // Prices — nullable so trigger-only exits can omit entry if unavailable
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),
  exitPrice: numeric("exit_price", { precision: 20, scale: 8 }),

  // Timing
  armedAt: timestamp("armed_at"),
  exitAt: timestamp("exit_at"),
  holdDurationMs: integer("hold_duration_ms"),

  // Excursion tracking
  mfePct: numeric("mfe_pct", { precision: 10, scale: 4 }),     // max favorable excursion ROI%
  maePct: numeric("mae_pct", { precision: 10, scale: 4 }),     // max adverse excursion ROI%
  peakRoiPct: numeric("peak_roi_pct", { precision: 10, scale: 4 }),       // highest ROI seen
  protectedRoiPct: numeric("protected_roi_pct", { precision: 10, scale: 4 }), // what safeguard locked in
  exitRoiPct: numeric("exit_roi_pct", { precision: 10, scale: 4 }),       // ROI at close price

  // Giveback
  givebackPct: numeric("giveback_pct", { precision: 10, scale: 4 }),  // peakRoi - exitRoi
  givebackRating: text("giveback_rating"),                             // low | moderate | high

  // Quality flags
  nearMiss: boolean("near_miss").default(false),

  // Safeguard
  safeguardUsed: boolean("safeguard_used").notNull().default(false),
  ratchetCount: integer("ratchet_count").notNull().default(0),
  threshold1Pct: numeric("threshold1_pct", { precision: 10, scale: 4 }),

  // Exit classification
  exitReason: text("exit_reason").notNull(),
  // original_trigger | safeguard_protection | safeguard_ratchet | manual_flash | manual_all
  closeMethod: text("close_method"),

  // Execution trace
  executionLatencyMs: integer("execution_latency_ms"),

  // Context
  walkAwayActive: boolean("walk_away_active").default(false),

  // Signal context at time of fire
  patienceLevel: text("patience_level"),   // tight | standard | good | strong | exceptional
  signalScore: numeric("signal_score", { precision: 4, scale: 1 }),  // -8..+8 at time of close

  // Market-structure context at time of fire
  htfAlignment: text("htf_alignment"),                    // aligned-up | aligned-down | 1h-up | 1h-down | mixed
  threeMinLead: boolean("three_min_lead").default(false), // 3m direction matched HTF before 15m did
  fifteenMinConfirm: boolean("fifteen_min_confirm").default(false), // 15m had confirmed 3m + HTF
  fourBarStreak: integer("four_bar_streak").default(0),   // signed: positive=up, negative=down
  pivotState: text("pivot_state"),                        // clear | approach | stall | bounce | break
  velocityState: text("velocity_state"),                  // fast | slow | normal
  counterMove: boolean("counter_move").default(false),    // LTF flipped against an aligned HTF
  resumption: boolean("resumption").default(false),       // counter-move resolved back into HTF
  patienceBoost: integer("patience_boost").default(0),    // structure-derived adjustment to base trail
  trailWidth: numeric("trail_width", { precision: 5, scale: 2 }), // actual trail % at fire time

  // Pre-trade plan (from a chart-screenshot upload, optional)
  tradePlanId: integer("trade_plan_id"),
  uploadUsed: boolean("upload_used").default(false),
  uploadKey: text("upload_key"),                          // /objects/... if any
  channelZoneAtPlan: text("channel_zone_at_plan"),
  userBiasAtPlan: text("user_bias_at_plan"),
  agreementScoreAtPlan: integer("agreement_score_at_plan"),// -100..+100
  continuationProbAtPlan: integer("continuation_prob_at_plan"),// 0..100
  recommendedPatienceAtPlan: text("recommended_patience_at_plan"),
  outcomeVsPlan: text("outcome_vs_plan"),                 // confirmed | partial | rejected | unknown

  // Edge score at time of arm
  edgeScore: integer("edge_score"),                 // 0-100 composite setup quality
  wholeNumberPlayType: text("whole_number_play_type"), // over_key | under_key | transition | rejection | retest | none
  walletSizeScore: integer("wallet_size_score"),    // 0-20 wallet-exposure component

  // Post-trade analysis
  verdict: text("verdict"),
  setupFingerprint: text("setup_fingerprint"),

  // Trigger floor provenance — populated when this trade's safeguard floor was
  // established by a trigger-price cross rather than the normal threshold1 path.
  // Used by the Oracle Learning panel to measure how well trigger floors perform
  // vs. standard threshold1 floors and which wave phases are best for conversion.
  triggerFloorUsed:  boolean("trigger_floor_used").default(false),
  floorWavePhase:    text("floor_wave_phase"),        // HA wave phase at floor activation
  floorOracleScore:  integer("floor_oracle_score"),   // oracle composite score at floor activation

  // Extension wave health at trade lifecycle moments.
  // extensionScoreAtArm:   captured the first time the HA wave enters 'extended'
  //   phase during the trade — measures how strong the extension was when detected.
  // extensionPhaseAtClose: the phase (alive/peaking/dying/dead) at the moment the
  //   safeguard actually fired — tells the oracle whether it closed into strength
  //   or waited correctly for the dying extension.
  extensionScoreAtArm:   integer("extension_score_at_arm"),
  extensionPhaseAtClose: text("extension_phase_at_close"),

  // Source record
  sourceType: text("source_type").notNull(), // safeguard | trigger
  sourceId: integer("source_id"),

  // Exchange enrichment — backfilled from Bitunix history API
  enrichedAt: timestamp("enriched_at"),
  realizedPnl: text("realized_pnl"),   // exchange-reported net PnL (string for precision)
  entryFee: text("entry_fee"),          // entry-side fee
  exitFee: text("exit_fee"),            // exit-side fee (combined in some APIs)

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TradeJournal = typeof tradeJournalTable.$inferSelect;
export type InsertTradeJournal = typeof tradeJournalTable.$inferInsert;
