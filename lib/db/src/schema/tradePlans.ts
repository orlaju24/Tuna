import {
  pgTable,
  serial,
  text,
  numeric,
  integer,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Pre-trade structural plans derived from a chart screenshot upload.
 *
 * Each row represents one expert-feedback assessment of a chart image:
 * - what zone of the channel price is sitting in,
 * - what the user's apparent bias is,
 * - how well that bias agrees with the structure (-100..+100),
 * - how patient the safeguard should be once a trade is opened,
 * - return-to-zone estimate, entry zone, invalidation zone,
 * - overall confidence level and a recommended action signal.
 *
 * When a safeguard is later armed for the same symbol, the most recent
 * unconsumed plan is linked via `consumedBySafeguardId` and its patience /
 * agreement context is folded into the per-tick trail-width formula.
 *
 * The auto-entry watcher also reads the latest unconsumed plan: if
 * `likelyAction` is "wait" or "stand-down", the entry is blocked until
 * the plan expires or the user uploads a fresh chart.
 */
export const tradePlansTable = pgTable("trade_plans", {
  id: serial("id").primaryKey(),

  // What the plan is about
  symbol: text("symbol").notNull(),
  side: text("side"),                                  // intended side: LONG | SHORT | null = unknown
  userBias: text("user_bias"),                         // long | short | unclear (declared by user)

  // The uploaded chart
  uploadKey: text("upload_key").notNull(),             // /objects/uploads/<uuid>
  uploadContentType: text("upload_content_type"),
  uploadBytes: integer("upload_bytes"),

  // Derived assessment — structural context
  channelZone: text("channel_zone"),                   // lower | middle | upper | unknown
  channelTilt: text("channel_tilt"),                   // up | down | flat | unknown
  trendPosture: text("trend_posture"),                 // continuation | mean-reversion | range | unclear
  detectedBias: text("detected_bias"),                 // long | short | mixed | unclear (model's read)
  agreementScore: integer("agreement_score"),          // -100..+100  (user_bias vs structure)
  continuationProbPct: integer("continuation_prob_pct"),// 0..100
  pivotProximityNote: text("pivot_proximity_note"),    // free text from the model

  recommendedPatience: text("recommended_patience"),   // tight | standard | patient | very-patient
  recommendedTightening: text("recommended_tightening"),// none | normal | aggressive
  setupQuality: text("setup_quality"),                 // weak | mixed | clean | strong
  riskNote: text("risk_note"),                         // short cautionary line, may be null

  // Image-to-self-trade intelligence layer
  // These fields make the uploaded image an active input to the auto-entry brain,
  // not just a pre-trade attachment.
  priceAtUpload: numeric("price_at_upload", { precision: 20, scale: 8 }),   // live price captured at upload time — used by watcher to detect wait resolution
  returnToZonePct: numeric("return_to_zone_pct", { precision: 10, scale: 4 }), // expected retrace depth % before continuation; 0 = enter now
  returnToZoneNote: text("return_to_zone_note"),       // "price may return to 81,000 before resuming"
  entryZoneNote: text("entry_zone_note"),              // "81,000-81,200 on a reclaim"
  invalidationZoneNote: text("invalidation_zone_note"),// "close below 80,500 invalidates the long"
  confidenceLevel: integer("confidence_level"),        // 0-100 composite plan confidence
  likelyAction: text("likely_action"),                 // enter | wait | stand-down

  summary: text("summary"),                            // 2-3 sentence plain-English readout
  rawAnalysis: jsonb("raw_analysis"),                  // full structured model response

  // Lifecycle
  createdAt: timestamp("created_at").notNull().defaultNow(),
  consumedAt: timestamp("consumed_at"),                // set when an arming safeguard claims it
  consumedBySafeguardId: integer("consumed_by_safeguard_id"),
});

export type TradePlan = typeof tradePlansTable.$inferSelect;
export type InsertTradePlan = typeof tradePlansTable.$inferInsert;
