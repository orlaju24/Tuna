import {
  pgTable,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Position Entry Log
 *
 * Stores the oracle context captured at the moment a position is first
 * detected/opened — whether via the app's manual open route, auto-entry,
 * or external interaction on Bitunix directly.
 *
 * Keyed by Bitunix's positionId (string primary key) so it survives
 * restarts and can be looked up when the position closes.
 *
 * Used by writeManualJournalRecord and any other close handler that needs
 * the entry-time oracle score, structure snapshot, and plan context.
 */
export const positionEntryLogTable = pgTable("position_entry_log", {
  positionId: text("position_id").primaryKey(),

  // Position identity
  symbol:    text("symbol").notNull(),
  side:      text("side").notNull(),      // LONG | SHORT
  leverage:  integer("leverage").notNull().default(1),
  entryPrice: numeric("entry_price", { precision: 20, scale: 8 }),

  openedAt: timestamp("opened_at").notNull().defaultNow(),

  // Oracle score at open time
  edgeScore:          integer("edge_score"),
  walletSizeScore:    integer("wallet_size_score"),
  wholeNumberPlayType: text("whole_number_play_type"),
  signalScore:        numeric("signal_score", { precision: 4, scale: 1 }),
  htfAlignment:       text("htf_alignment"),
  patienceLevel:      text("patience_level"),

  // Full structure snapshot at open time
  threeMinLead:      boolean("three_min_lead").default(false),
  fifteenMinConfirm: boolean("fifteen_min_confirm").default(false),
  fourBarStreak:     integer("four_bar_streak").default(0),
  pivotState:        text("pivot_state"),
  velocityState:     text("velocity_state"),
  counterMove:       boolean("counter_move").default(false),
  resumption:        boolean("resumption").default(false),
  patienceBoost:     integer("patience_boost").default(0),
  trailWidth:        numeric("trail_width", { precision: 5, scale: 2 }),

  // Plan snapshot at open time
  tradePlanId:               integer("trade_plan_id"),
  uploadUsed:                boolean("upload_used").default(false),
  uploadKey:                 text("upload_key"),
  channelZoneAtPlan:         text("channel_zone_at_plan"),
  userBiasAtPlan:            text("user_bias_at_plan"),
  agreementScoreAtPlan:      integer("agreement_score_at_plan"),
  continuationProbAtPlan:    integer("continuation_prob_at_plan"),
  recommendedPatienceAtPlan: text("recommended_patience_at_plan"),

  // Canonical trade identity — UUID generated at open time, shared by all
  // events and the final journal row for this trade regardless of close path.
  tradeId: text("trade_id"),

  // How the position was first detected
  source: text("source").notNull().default("detected"), // app_open | auto_entry | detected

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PositionEntryLog    = typeof positionEntryLogTable.$inferSelect;
export type InsertPositionEntryLog = typeof positionEntryLogTable.$inferInsert;
