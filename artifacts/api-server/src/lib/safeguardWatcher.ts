/**
 * Server-side profit safeguard watcher (v4 step ladder).
 *
 * Behaviour summary:
 *   1. Once a safeguard is armed, subscribe to the live price stream and
 *      continuously compute the position's unrealized ROI %.
 *   2. When ROI first reaches threshold1 (default 17 %): enter "protecting"
 *      state, lock in threshold1 as the safeguard ROI level.
 *   3. As the trade improves, ratchet the safeguard forward in ladder steps
 *      (2 → 4 → 6 → 10 → 10 → … pp) — the final 10 pp step repeats
 *      indefinitely so there is no cap on bluesky gains. Never moves backward.
 *   4. When the live price retraces back to the safeguardPrice level, fire
 *      the close immediately.
 *   5. Bitunix only receives the close action at step 4 — the safeguardPrice
 *      is never exposed to the exchange beforehand ("ninja" handling).
 *   6. On completion, writes a structured TradeJournal record with MFE/MAE,
 *      giveback, ratchet count, execution latency, verdict and fingerprint.
 */

import { randomUUID } from "node:crypto";
import { db } from "./db";
import { safeguardsTable, eventLogTable, tradeJournalTable, tradePlansTable, tradeEventsTable } from "@workspace/db/schema";
import { positionTracker } from "./positionTracker";
import { eq, and, isNull, desc } from "drizzle-orm";
import { bitunixPost, bitunixGet, getOpenPositions, flashClosePosition } from "./bitunix";
import { logger } from "./logger";
import { priceStream } from "./priceStream";
import type { Safeguard, TradePlan } from "@workspace/db/schema";
import { notifyPostClose } from "./postCloseNotifier";
import {
  getStructureContext,
  primeSignalScore,
  patienceLabel,
  adaptiveTrail,
  htfAlignmentLabel,
  checkMomentumIntact,
  type StructureContext,
} from "./signalScore";
import { computeEdgeScore, edgeScoreDelta, type EdgeContext } from "./edgeScore";
import { promoteFingerprintFromJournal } from "./fingerprintEngine";

// ── Plan-derived trail adjustment ───────────────────────────────────────────
// Maps a pre-trade plan into a small trail-width delta (-2.0..+2.5 pp), then
// the existing 2..12 clamp re-applies. Bounds:
//   • agreement -100..+100  → -2.0..+2.0
//   • channelZone "upper"   → -0.5  (stretched, give back faster)
//   • channelZone "lower"   → +0.25 (early in the move, breathe)
//   • recommendedPatience   → -0.5..+0.5 nudge
function planTrailDelta(plan: TradePlan | null): number {
  if (!plan) return 0;
  let d = ((plan.agreementScore ?? 0) / 100) * 2;
  if (plan.channelZone === "upper") d -= 0.5;
  else if (plan.channelZone === "lower") d += 0.25;
  switch (plan.recommendedPatience) {
    case "tight":         d -= 0.5; break;
    case "very-patient":  d += 0.5; break;
  }
  return Math.max(-2.0, Math.min(2.5, d));
}

function applyPlanToContext(ctx: StructureContext, plan: TradePlan | null): StructureContext {
  if (!plan) return ctx;
  const delta = planTrailDelta(plan);
  if (delta === 0) return ctx;
  const adjusted = Math.max(2, Math.min(12, ctx.trailWidth + delta));
  return { ...ctx, trailWidth: adjusted };
}

function applyEdgeToContext(ctx: StructureContext, edge: EdgeContext | null): StructureContext {
  if (!edge) return ctx;
  const delta = edgeScoreDelta(edge.edgeScore);
  if (delta === 0) return ctx;
  const adjusted = Math.max(2, Math.min(12, ctx.trailWidth + delta));
  return { ...ctx, trailWidth: adjusted };
}

// ── Oracle sub-level target capture (4th trail layer) ────────────────────────
//
// The Oracle Method places the first meaningful sub-target at the .888 level
// within the range that was just broken. A break of $109,000 heading SHORT
// produces a .888 target at $108,888 and a deeper whole-number target at
// $108,000. The system rewards capturing those levels by tightening the trail
// — "be intuitive to how you compliment attaining it."
//
// A break at the exact boundary counts: $109,000 → $108,999 IS the break.
// The capture check is simply: has price moved past the .888 level?
//
//   .888 captured                → trail −1.0 pp
//   next whole number also taken → trail −0.75 pp (total −1.75 pp)
//
// All changes still pass through the 2..12 global clamp. The trail never
// tightens beyond the minimum, but having crossed .888 means the trade is
// working — the safeguard appropriately compresses to protect those gains.

function oracleStep(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 10000) return 1000;
  if (abs >= 1000)  return 100;
  if (abs >= 100)   return 10;
  if (abs >= 10)    return 1;
  if (abs >= 1)     return 0.1;
  return 0.01;
}

/**
 * Compute the Oracle Method's key sub-level targets for a position.
 *
 * After a whole-number break the first meaningful target is always at .888
 * of the range in the direction of travel:
 *   SHORT from ~$109,050 (break of $109k ↓): target888 = $108,888, deeperTarget = $108,000
 *   LONG  from ~$107,950 (break of $108k ↑): target888 = $108,888, deeperTarget = $109,000
 */
function computeOracleTargets(
  side: string,
  entryPrice: number,
): { target888: number; deeperTarget: number } {
  const step = oracleStep(entryPrice);
  const breakWhole = Math.round(entryPrice / step) * step;
  if (side === "SHORT") {
    return {
      target888:    breakWhole - step + step * 0.888,
      deeperTarget: breakWhole - step,
    };
  }
  return {
    target888:    breakWhole + step * 0.888,
    deeperTarget: breakWhole + step,
  };
}

function applySubLevelCapture(
  ctx: StructureContext,
  side: string,
  livePrice: number,
  entryPrice: number,
): StructureContext {
  const { target888, deeperTarget } = computeOracleTargets(side, entryPrice);
  const isShort = side === "SHORT";
  const t888Captured    = isShort ? livePrice <= target888  : livePrice >= target888;
  const deeperCaptured  = isShort ? livePrice <= deeperTarget : livePrice >= deeperTarget;
  let delta = 0;
  if (t888Captured)   delta -= 1.0;   // .888 reached — tighten to protect sub-target
  if (deeperCaptured) delta -= 0.75;  // next whole captured — tighten further
  if (delta === 0) return ctx;
  const adjusted = Math.max(2, Math.min(12, ctx.trailWidth + delta));
  return { ...ctx, trailWidth: adjusted };
}

// ── Trailing mode ────────────────────────────────────────────────────────────

type TrailingMode = "tight" | "standard" | "wide" | "structure" | "adaptive";

/**
 * Extension wave trail delta — applied as the 5th trail layer when the HA 3m
 * wave classifier reports wavePhase === 'extended'.
 *
 * When FLAT: extension penalises entry (oracle score -4). This layer is only
 * active when a safeguard is armed (trade is live). Extension is the PROFIT
 * WAVE — the system holds through it and closes only as the extension DIES.
 *
 *   alive   (≥70) → +1.5 pp  extension expanding — let it breathe
 *   peaking (≥50) → +0.25 pp  slight room — stay alert
 *   dying   (≥30) → −1.0 pp  bodies shrinking — tighten now
 *   dead    (<30) → −2.0 pp  extension collapsed — aggressive protection
 */
function extensionTrailDelta(ctx: StructureContext): number {
  if (ctx.wavePhase !== "extended") return 0;
  const score = ctx.extensionScore ?? 50; // default: peaking if not yet computed
  if (score >= 70) return  1.5;
  if (score >= 50) return  0.25;
  if (score >= 30) return -1.0;
  return -2.0;
}

/**
 * Profit quality bias — reads the live structure context to estimate whether
 * the unrealized gain came from a strong directional move, a fast flush, or
 * choppy indecision. Returns a trail-width delta applied on top of the mode's
 * base width (negative = tighten protection, positive = give more room).
 *
 *  strong_continuation  HTF aligned + 4-bar streak + no counter-move
 *    → +0.5 pp  (trend is healthy — let the trade breathe)
 *  flush_move           fast velocity + near pivot + (counter or misaligned)
 *    → −0.75 pp (looks like a spike — tighten to protect the gain)
 *  chop                 counter-move present or slow + not HTF-aligned
 *    → −0.5 pp  (market indecision — protect sooner)
 *  normal               default → 0 pp
 */
function profitQualityBias(ctx: StructureContext): number {
  if (ctx.htfAligned && ctx.fourBarRule && !ctx.counterMove) return 0.5;
  if (ctx.velocityState === "fast" && ctx.nearPivot && (!ctx.htfAligned || ctx.counterMove)) return -0.75;
  if (ctx.counterMove || (ctx.velocityState === "slow" && !ctx.htfAligned)) return -0.5;
  return 0;
}

/**
 * Compute the StructureContext (with the correct trailWidth) for the chosen
 * trailing mode. Called inside the 1 s-throttled block so all helpers here
 * run at most once per second, not on every price tick.
 *
 * Mode behaviors:
 *   tight     — 2 pp constant; sub-level capture only; NO momentum hold gate
 *               (fire immediately on any retrace — maximum profit protection)
 *   standard  — 3 pp base; profit-quality bias; sub-level capture;
 *               momentum hold gate: 2-minute window (shorter = faster exit)
 *   wide      — 5 pp base; plan delta; profit-quality bias; sub-level capture;
 *               momentum hold gate: 4-minute window (more room to breathe)
 *   structure — adaptiveTrail(signalScore) + plan delta + profit-quality bias;
 *               momentum hold gate: 4-minute window; NO oracle score delta
 *   adaptive  — full stack: structure + plan + oracle + sub-level capture;
 *               momentum hold gate: 4-minute window (oracle delta already covers)
 */
function computeTrailContext(
  baseCtx: StructureContext,
  plan: TradePlan | null,
  edge: EdgeContext | null,
  side: string,
  price: number,
  entry: number,
  mode: TrailingMode,
): StructureContext {
  const bias = profitQualityBias(baseCtx);

  switch (mode) {
    case "tight": {
      // Hard 2 pp floor — maximum protection, no adjustments except sub-levels.
      return applySubLevelCapture({ ...baseCtx, trailWidth: 2 }, side, price, entry);
    }
    case "standard": {
      const w = Math.max(2, Math.min(12, 3 + bias + extensionTrailDelta(baseCtx)));
      return applySubLevelCapture({ ...baseCtx, trailWidth: w }, side, price, entry);
    }
    case "wide": {
      const w = Math.max(2, Math.min(12, 5 + planTrailDelta(plan) + bias + extensionTrailDelta(baseCtx)));
      return applySubLevelCapture({ ...baseCtx, trailWidth: w }, side, price, entry);
    }
    case "structure": {
      const w = Math.max(2, Math.min(12, adaptiveTrail(baseCtx.signalScore) + planTrailDelta(plan) + bias + extensionTrailDelta(baseCtx)));
      return applySubLevelCapture({ ...baseCtx, trailWidth: w }, side, price, entry);
    }
    case "adaptive":
    default: {
      // 5-layer chain: structure + plan + oracle + sub-level capture + extension health.
      // Extension layer widens trail when the extension wave is alive (profit wave),
      // and aggressively tightens when the extension starts dying.
      const afterEdge    = applyEdgeToContext(applyPlanToContext(baseCtx, plan), edge);
      const afterCapture = applySubLevelCapture(afterEdge, side, price, entry);
      const extDelta     = extensionTrailDelta(baseCtx);
      if (extDelta === 0) return afterCapture;
      return { ...afterCapture, trailWidth: Math.max(2, Math.min(12, afterCapture.trailWidth + extDelta)) };
    }
  }
}

// Only write to DB when ROI high-water advances by at least this many
// percentage points — avoids write storms on volatile ticks.
const UPDATE_ROI_STEP_PCT = 0.5;

// v5 step ladder: coarse early rungs to lock in the initial gain quickly,
// then fine-grained 2.5 pp steps forever above 29 % — no cap on bluesky gains.
//
// Milestones from threshold1 (17%):
//   +2  → 19%        (ratchet 1 — first lock-in)
//   +4  → 23%        (ratchet 2)
//   +6  → 29%        (ratchet 3)
//   +2.5→ 31.5%      (ratchet 4 — fine-grained from here on)
//   +2.5→ 34%        (ratchet 5)
//   +2.5→ 36.5%      (ratchet 6)  … repeating every 2.5 pp indefinitely
//
// Rationale: once above 30% ROI every 2.5 pp of locked gain is meaningful.
// The coarser early steps let the trade breathe without micro-ratcheting; the
// fine-grained tail ensures the floor tracks peak ROI closely at high altitude.
const LADDER_STEPS = [2, 4, 6, 2.5];

function ladderStep(ratchetCount: number): number {
  return LADDER_STEPS[Math.min(ratchetCount, LADDER_STEPS.length - 1)];
}

// Derive which ladder rung we're already on from the persisted safeguardPrice ROI.
// Used on server restart to restore in-memory state without a schema change.
// Uses the same ladderStep() logic as the live ticker so it handles any number
// of ratchets correctly — including trades that have advanced past the 4th rung.
function deriveRatchetState(
  threshold1: number,
  currentRoiLevel: number
): { ratchetCount: number; safeguardRoiLevel: number } {
  let level = threshold1;
  let count = 0;
  const MAX_RATCHETS = 500; // safety cap — unreachable in practice
  while (count < MAX_RATCHETS) {
    const step = ladderStep(count);
    const next = level + step;
    if (currentRoiLevel < next - 0.01) break;
    level = next;
    count++;
  }
  return { ratchetCount: count, safeguardRoiLevel: level };
}

// ── ROI helpers ──────────────────────────────────────────────────────────────

function computeRoi(side: string, entry: number, price: number, leverage: number): number {
  if (!Number.isFinite(entry) || entry === 0 || !Number.isFinite(price)) return 0;
  const priceDiff = side === "SHORT" ? entry - price : price - entry;
  return (priceDiff / entry) * leverage * 100;
}

function priceAtRoi(side: string, entry: number, leverage: number, targetRoi: number): number {
  const fraction = targetRoi / (leverage * 100);
  return side === "SHORT" ? entry * (1 - fraction) : entry * (1 + fraction);
}

function hasRetraced(side: string, livePrice: number, safeguardPrice: number): boolean {
  return side === "SHORT" ? livePrice >= safeguardPrice : livePrice <= safeguardPrice;
}

// ── Journal helpers ──────────────────────────────────────────────────────────

function tradeVerdict(
  givebackPct: number,
  safeguardUsed: boolean,
  ratchetCount: number,
  nearMiss: boolean
): string {
  if (nearMiss && !safeguardUsed)
    return "Near-miss: trade approached the target but reversed before trigger fired.";
  if (safeguardUsed && ratchetCount >= 3 && givebackPct < 4)
    return "Strong exit: ladder climbed well with low giveback.";
  if (safeguardUsed && ratchetCount >= 1 && givebackPct < 5)
    return "Good protection: safeguard locked in profit with low giveback.";
  if (safeguardUsed && givebackPct >= 10)
    return "High giveback: trade gave back meaningful profit before close.";
  if (safeguardUsed && ratchetCount === 0)
    return "First protection: safeguard fired at initial threshold — no ladder advance.";
  if (!safeguardUsed && givebackPct < 2)
    return "Clean exit: original trigger worked well.";
  if (!safeguardUsed && givebackPct >= 8)
    return "Late trigger: significant giveback before the original trigger fired.";
  return "Exit completed at the configured trigger level.";
}

function givebackRating(pct: number): "low" | "moderate" | "high" {
  if (pct < 3) return "low";
  if (pct < 8) return "moderate";
  return "high";
}

/**
 * Grade the realized exit against what the plan expected. Mostly relevant
 * for safeguard-protected trades that started with a chart upload.
 *   • confirmed: plan was bullish/clean and the trade ended profitably with
 *     low giveback;
 *   • partial: profitable but high giveback or against a low-agreement plan;
 *   • rejected: trade closed at/under entry while the plan was bullish,
 *     or with very high giveback;
 *   • unknown: no plan, can't grade.
 */
function computeOutcomeVsPlan(
  plan: TradePlan | null,
  exitRoiPct: number,
  givebackPct: number,
): string | null {
  if (!plan) return null;
  const agreement = plan.agreementScore ?? 0;
  if (exitRoiPct <= 0 && agreement >= 25) return "rejected";
  if (exitRoiPct > 0 && givebackPct < 5 && agreement >= 25) return "confirmed";
  if (exitRoiPct > 0 && givebackPct < 8) return "partial";
  if (exitRoiPct <= 0) return "rejected";
  return "partial";
}

function buildFingerprint(
  side: string,
  leverage: number,
  safeguardUsed: boolean,
  ratchetCount: number
): string {
  return [
    side,
    `${leverage}x`,
    safeguardUsed
      ? `safeguard · ${ratchetCount} ratchet${ratchetCount !== 1 ? "s" : ""}`
      : "no safeguard",
  ].join(" · ");
}

// ── Types ────────────────────────────────────────────────────────────────────

interface LiveState {
  liveRoiPct: number;
  safeguardPrice: number | null;
  highWaterRoiPct: number | null;
  state: string;
  ratchetCount: number;
  nextMilestoneRoiPct: number | null;
  patienceLevel: string;   // tight | standard | good | strong | exceptional
  signalScore: number;     // -8..+8
  // Market structure layer
  structure: StructureContext | null;
  // Pre-trade plan layer (null until/unless the user uploaded a chart)
  plan: TradePlan | null;
  planTrailDelta: number;
  // Edge score layer (null until background compute resolves)
  edgeContext: EdgeContext | null;
}

interface ActiveSafeguard {
  sg: Safeguard;
  fired: boolean;
  liveRoiPct: number;
  mfe: number;    // max favorable excursion ROI% (best ROI seen)
  mae: number;    // max adverse excursion ROI% (worst ROI seen, may be negative)
  armedAt: Date;
  listener: (symbol: string, price: number) => void;
  plan: TradePlan | null;
  // Periodic oracle score refresh while protecting — keeps adaptive trail fresh.
  // Cleared in disarm() and fire() so it never leaks after a trade closes.
  edgeRefreshTimer?: NodeJS.Timeout;
}

// ── Manager ──────────────────────────────────────────────────────────────────

class SafeguardManager {
  private active = new Map<number, ActiveSafeguard>();

  arm(sg: Safeguard) {
    if (!sg.positionId) {
      logger.error(
        { safeguardId: sg.id, symbol: sg.symbol },
        "Refusing to arm safeguard without a position id",
      );
      return;
    }
    if (this.active.has(sg.id)) this.disarm(sg.id);

    const entry = parseFloat(String(sg.entryPrice));
    const leverage = sg.leverage;
    const threshold1 = parseFloat(String(sg.threshold1Pct));
    const symbol = sg.symbol;
    const mode = ((sg.trailingMode ?? "adaptive") as TrailingMode);

    // In-memory mutable state for this safeguard (avoid repeated DB reads)
    let internalState = sg.state;
    let highWater = sg.highWaterRoiPct != null ? parseFloat(String(sg.highWaterRoiPct)) : null;
    let safeguardPrice = sg.safeguardPrice != null ? parseFloat(String(sg.safeguardPrice)) : null;
    let lastPersistedHighWater = highWater ?? -Infinity;

    // v4 ladder state — derived from persisted safeguardPrice on restore
    let safeguardRoiLevel = threshold1;
    let ratchetCount = 0;
    if (safeguardPrice != null && internalState === "protecting") {
      const existingRoi = computeRoi(sg.side, entry, safeguardPrice, leverage);
      const derived = deriveRatchetState(threshold1, existingRoi);
      safeguardRoiLevel = derived.safeguardRoiLevel;
      ratchetCount = derived.ratchetCount;
    }

    // Adaptive trail tracking — maxProtectedRoi only ever increases.
    // On restore, the persisted safeguardPrice may already be higher than the
    // bare ratchet level (adaptive trail advanced it before the last restart).
    // Seed maxProtectedRoi from the higher of the two so the trail doesn't
    // momentarily drop the protection level on the first post-restart tick.
    let maxProtectedRoi = safeguardRoiLevel;
    if (safeguardPrice != null && internalState === "protecting") {
      const persistedRoi = computeRoi(sg.side, entry, safeguardPrice, leverage);
      if (persistedRoi > maxProtectedRoi) maxProtectedRoi = persistedRoi;
    }
    let lastPersistedMaxRoi = maxProtectedRoi;
    let cachedPatienceLabel = "standard";
    let cachedSignalScore = 0;
    let cachedStructure: StructureContext | null = null;
    let cachedEdgeContext: EdgeContext | null = null;

    // ── Momentum-gate retrace state ──────────────────────────────────────────
    // The safeguard grants ONE retrace allowance per trade: when price first
    // touches the protection level after ≥1 ratchet and momentum is still intact,
    // the close is suppressed and a 4-minute hold window is started. If momentum
    // holds through the window the trade continues; if it fades the system closes.
    // After the allowance is consumed or the hold window expires, any subsequent
    // retrace closes unconditionally (no second chances — the oracle has spoken).
    let retraceAllowanceUsed = false;
    let retraceHoldExpiry: number | null = null;
    let lastRetraceLogAt = 0;
    // Throttle the applySubLevelCapture chain to ≤1 recompute per second.
    // Structure context is 60s-cached and edge context refreshes every 5 min,
    // so running the full chain on every 500ms BTC tick is wasteful.
    // The fire-check (hasRetraced) still runs on every tick below.
    let trailComputedAt = 0;

    // When a trigger price is absorbed as a safeguard floor via setFloor(),
    // this flag is set to true for ONE tick so the retrace check does not
    // fire on the very same tick the floor is established (livePrice == floor).
    // Cleared automatically inside the listener on the next tick.
    let floorJustSet = false;

    // Knowledge-base metadata — populated when this safeguard floor was
    // established via a trigger-price cross rather than the threshold1 path.
    // Captured at the moment setFloor() fires and written to the trade journal
    // at close so the Oracle Learning panel can compare trigger-floor outcomes.
    let triggerFloorUsed  = false;
    let floorWavePhase:    string | null = null;
    let floorOracleScore:  number | null = null;

    // Extension wave foreknowledge — captured once, the first tick after the HA
    // 3m wave enters 'extended' phase while the trade is live. Measures how
    // healthy the extension wave was when first detected during this trade.
    // extensionPhaseAtClose is read live from cachedStructure at fire() time.
    let extensionScoreAtArm: number | undefined = undefined;

    // Expose live ladder + patience + structure + edge state for getLiveState()
    const getLadderState = () => ({
      ratchetCount,
      safeguardRoiLevel,
      patienceLevel: cachedPatienceLabel,
      signalScore: cachedSignalScore,
      structure: cachedStructure,
      edgeContext: cachedEdgeContext,
      triggerFloorUsed,
      floorWavePhase,
      floorOracleScore,
      extensionScoreAtArm,
      extensionPhaseAtClose: cachedStructure?.extensionPhase ?? undefined,
    });

    const record: ActiveSafeguard = {
      sg,
      fired: false,
      liveRoiPct: 0,
      mfe: 0,
      mae: 0,
      armedAt: new Date(),
      listener: () => {},
      plan: null,
    };

    // Background-claim the latest unconsumed plan for this symbol — never
    // blocks arming. Once the row is loaded, the next tick will start
    // applying the plan-derived trail delta automatically.
    void this.claimLatestPlan(sg, record);

    // Reusable oracle score refresh — called at arm AND every 5 min while
    // protecting. This keeps the adaptive trail working with current market
    // intelligence rather than a snapshot frozen at entry time. When the 1h
    // and 6h stay aligned through the trade, the trail breathes more; if
    // structure weakens mid-trade, the trail tightens to protect gains.
    const refreshEdgeScore = async () => {
      if (record.fired) return;
      try {
        const accountResp = await bitunixGet<{ available: string; margin: string }>(
          "/api/v1/futures/account", { marginCoin: "USDT" }
        );
        const acct = accountResp.data;
        const available      = acct ? (parseFloat(acct.available) || 0) : 0;
        const positionMargin = acct ? (parseFloat(acct.margin)    || 0) : 0;
        const structCtx = getStructureContext(symbol);
        cachedEdgeContext = computeEdgeScore(structCtx, { available, positionMargin });
        logger.debug(
          { safeguardId: sg.id, edgeScore: cachedEdgeContext.edgeScore, grade: cachedEdgeContext.grade },
          "Safeguard oracle score refreshed",
        );
      } catch (err) {
        logger.warn({ err, safeguardId: sg.id }, "Oracle score refresh failed — last cached value retained");
      }
    };

    // Background-compute edge score at arm time. Non-blocking — next tick applies it.
    void refreshEdgeScore();

    // Restore path: if this safeguard is being re-armed after a server restart
    // and was already in "protecting" state, start the oracle refresh timer now.
    // The normal flow starts the timer inside the Phase 1 → Phase 2 transition,
    // but that block is never reached for safeguards restored directly as
    // "protecting" — they skip Phase 1 entirely and jump straight to Phase 2.
    if (internalState === "protecting" && !record.edgeRefreshTimer) {
      record.edgeRefreshTimer = setInterval(() => void refreshEdgeScore(), 5 * 60_000);
      logger.debug({ safeguardId: sg.id }, "Oracle refresh timer started for restored protecting safeguard");
    }

    // ── Trigger floor absorption callback ─────────────────────────────────────
    // Called by safeguardManager.absorbTriggerAsFloor() when a trigger price
    // crosses and this safeguard should use that price as its new profit floor.
    // The ratchet ladder restarts from this floor; the trade stays open.
    //
    // Returns true  → floor applied (or already better — no-op).
    // Returns false → floor would be a downgrade; caller should hard-close.
    const setFloor = (floorPrice: number, triggerRoiLevel: number): boolean => {
      if (record.fired) return false;

      // Never downgrade an already-better floor
      if (internalState === "protecting" && safeguardPrice != null) {
        const alreadyBetter = sg.side === "LONG"
          ? safeguardPrice >= floorPrice
          : safeguardPrice <= floorPrice;
        if (alreadyBetter) return false;
      }

      // Establish or upgrade the protection floor to the trigger price
      const wasArmed = internalState === "armed";
      internalState      = "protecting";
      safeguardRoiLevel  = triggerRoiLevel;
      ratchetCount       = 0;           // ladder starts fresh from this floor
      safeguardPrice     = floorPrice;
      if (highWater === null || highWater < triggerRoiLevel) highWater = triggerRoiLevel;
      if (triggerRoiLevel > maxProtectedRoi) maxProtectedRoi = triggerRoiLevel;
      lastPersistedHighWater = triggerRoiLevel;
      lastPersistedMaxRoi    = maxProtectedRoi;

      // Prevent an immediate retrace fire on the very tick the floor is set
      // (livePrice == safeguardPrice at the moment of conversion).
      floorJustSet = true;

      // Capture the market context at floor activation for knowledge-base learning.
      // Recorded in the trade journal at close so the Oracle Learning panel can
      // correlate wave phase and oracle score with trigger-floor trade outcomes.
      triggerFloorUsed = true;
      const confirmCtx = getStructureContext(symbol);
      floorWavePhase   = confirmCtx?.wavePhase ?? null;
      floorOracleScore = cachedEdgeContext?.edgeScore ?? null;

      // Start oracle refresh timer when transitioning from armed state
      if (wasArmed && !record.edgeRefreshTimer) {
        primeSignalScore(symbol);
        void refreshEdgeScore();
        record.edgeRefreshTimer = setInterval(() => void refreshEdgeScore(), 5 * 60_000);
      }

      this.persistState(sg.id, {
        state:            "protecting",
        safeguardPrice:   String(floorPrice),
        highWaterRoiPct:  String(highWater),
      }).catch(() => {});

      logger.info(
        { safeguardId: sg.id, floorPrice, triggerRoiPct: triggerRoiLevel.toFixed(2) },
        "Trigger price absorbed as safeguard floor — ladder restarts from here",
      );
      this.logEvent(symbol, "safeguard_floor_set",
        `[${symbol} ${sg.side}] trigger floor @ ${floorPrice.toFixed(2)} · locked ${triggerRoiLevel.toFixed(1)}% ROI · ratchet ladder starts here`,
      ).catch(() => {});

      return true;
    };

    const listener = (sym: string, price: number) => {
      if (sym !== symbol || record.fired) return;

      const liveRoi = computeRoi(sg.side, entry, price, leverage);
      record.liveRoiPct = liveRoi;

      // Track MFE and MAE on every tick
      if (liveRoi > record.mfe) record.mfe = liveRoi;
      if (liveRoi < record.mae) record.mae = liveRoi;

      // ── PHASE 1: waiting for first protection threshold ──────────────────
      if (internalState === "armed") {
        if (liveRoi < threshold1) return;

        // First milestone — lock in at threshold1 (step 0 of the ladder)
        internalState = "protecting";
        highWater = liveRoi;
        safeguardRoiLevel = threshold1;
        ratchetCount = 0;
        maxProtectedRoi = threshold1;
        lastPersistedMaxRoi = threshold1;
        primeSignalScore(symbol);  // warm up the signal cache immediately
        safeguardPrice = priceAtRoi(sg.side, entry, leverage, safeguardRoiLevel);

        // Start periodic oracle score refresh — trail stays intelligent for
        // the full life of the trade, not just the moment of entry.
        // One Bitunix account API call every 5 min per active protected trade.
        if (!record.edgeRefreshTimer) {
          record.edgeRefreshTimer = setInterval(() => void refreshEdgeScore(), 5 * 60_000);
        }

        logger.info(
          { safeguardId: sg.id, symbol, roi: liveRoi.toFixed(2), safeguardRoiLevel, safeguardPrice },
          "Safeguard threshold1 reached — protecting (ratchet 0)"
        );

        this.persistState(sg.id, {
          state: "protecting",
          safeguardPrice: String(safeguardPrice),
          highWaterRoiPct: String(highWater),
        }).catch(() => {});

        this.logEvent(symbol, "safeguard_protecting",
          `[${symbol} ${sg.side}] ROI +${liveRoi.toFixed(1)}% crossed threshold · locked ${safeguardRoiLevel.toFixed(1)}% ROI · close @ ${safeguardPrice.toFixed(4)} · entry ${entry.toFixed(2)}`
        ).catch(() => {});
      }

      // ── PHASE 2: protecting — ladder ratchet + watch for retrace ─────────
      if (internalState === "protecting" && safeguardPrice !== null) {
        if (liveRoi > (highWater ?? -Infinity)) {
          highWater = liveRoi;

          // Check if high-water has advanced enough for the next ladder rung
          const nextStep = ladderStep(ratchetCount);
          const nextMilestone = safeguardRoiLevel + nextStep;

          if (highWater >= nextMilestone) {
            // Advance to next rung — lock in a larger slice of profit
            safeguardRoiLevel = nextMilestone;
            ratchetCount++;
            safeguardPrice = priceAtRoi(sg.side, entry, leverage, safeguardRoiLevel);

            logger.info(
              { safeguardId: sg.id, ratchetCount, safeguardRoiLevel, safeguardPrice },
              "Safeguard ladder ratchet"
            );

            // Always persist on a ratchet advance
            this.persistState(sg.id, {
              safeguardPrice: String(safeguardPrice),
              highWaterRoiPct: String(highWater),
            }).catch(() => {});

            this.logEvent(symbol, "safeguard_ratchet",
              `[${symbol} ${sg.side}] ratchet #${ratchetCount} · locked ${safeguardRoiLevel.toFixed(1)}% ROI · hw +${highWater.toFixed(1)}% · close @ ${safeguardPrice.toFixed(4)}`
            ).catch(() => {});
          } else {
            // No ratchet yet — just track high-water with throttled DB writes
            if (highWater - lastPersistedHighWater >= UPDATE_ROI_STEP_PCT) {
              lastPersistedHighWater = highWater;
              this.persistState(sg.id, {
                highWaterRoiPct: String(highWater),
              }).catch(() => {});
            }
          }
        }

        // ── Adaptive trail: adjust safeguard patience to signal strength ──────
        // Layers applied in order (each re-clamps to 2..12):
        //   1. Base structure (signalScore + HTF/LTF/velocity/pivot)
        //   2. Pre-trade plan delta (agreementScore + channelZone + patience)
        //   3. Oracle score delta (composite 0-100 quality score)
        //   4. Sub-level capture: tighten when .888 or next whole number taken
        //      • .888 captured            → −1.0 pp (reward catching the extra)
        //      • next whole also captured → −0.75 pp additional
        // maxProtectedRoi is monotonically non-decreasing — never retreats.
        //
        // Trail context is throttled to ≤1 recompute/second. Structure context
        // has a 60 s TTL and edge context refreshes every 5 min, so repeating
        // the full applySubLevelCapture chain on every 500 ms BTC tick is
        // redundant. The fire-check (hasRetraced) below runs on every tick.
        if (highWater !== null) {
          const tickNow = Date.now();
          if (tickNow - trailComputedAt >= 1_000) {
            trailComputedAt = tickNow;
            const baseCtx = getStructureContext(symbol);
            const ctx = computeTrailContext(
              baseCtx,
              record.plan,
              cachedEdgeContext,
              sg.side,
              price,
              entry,
              mode,
            );
            cachedPatienceLabel = patienceLabel(ctx.signalScore);
            cachedSignalScore = ctx.signalScore;
            cachedStructure = ctx;

            // First time the wave enters 'extended' during this trade — snapshot
            // the extension health score so the journal can show what condition
            // the extension was in when it was first detected on this position.
            if (cachedStructure.wavePhase === "extended" && extensionScoreAtArm === undefined) {
              extensionScoreAtArm = cachedStructure.extensionScore;
            }
          }

          // Use the most recently derived trail width; fall back to the simple
          // adaptive formula if the first throttled compute hasn't run yet.
          const trail = cachedStructure?.trailWidth ?? adaptiveTrail(cachedSignalScore);
          const candidateRoi = Math.max(safeguardRoiLevel, highWater - trail);
          if (candidateRoi > maxProtectedRoi) {
            maxProtectedRoi = candidateRoi;
            const newSafeguardPrice = priceAtRoi(sg.side, entry, leverage, maxProtectedRoi);
            safeguardPrice = newSafeguardPrice;
            if (maxProtectedRoi - lastPersistedMaxRoi >= UPDATE_ROI_STEP_PCT) {
              lastPersistedMaxRoi = maxProtectedRoi;
              this.persistState(sg.id, {
                safeguardPrice: String(newSafeguardPrice),
              }).catch(() => {});
            }
          }
        }

        // ── Fire check — price retraced back to the adaptive safeguard level ──
        // One-tick grace: when a trigger floor was just set this tick,
        // livePrice == safeguardPrice — skip the fire check to avoid an
        // immediate false retrace. floorJustSet is cleared on the next tick.
        if (floorJustSet) {
          floorJustSet = false;
          return;
        }

        if (hasRetraced(sg.side, price, safeguardPrice)) {

          // ── Momentum hold gate (TIGHT mode bypasses this entirely) ───────────
          //
          // For STANDARD / WIDE / STRUCTURE / ADAPTIVE: if the ladder has advanced
          // at least one rung, grant ONE free retrace allowance.  Verify momentum;
          // if intact, absorb the touch and open a hold window.  After the window
          // expires or momentum cracks → close unconditionally.
          //
          // For TIGHT: the user explicitly chose maximum protection.  Fire immediately
          // on any retrace — no holds, no momentum evaluation, no second chances.
          // This ensures the 2 pp trail is honoured with zero slippage delay from
          // a hold window that could allow price to fall much further.
          //
          // Hold window durations by mode:
          //   standard  → 2 min (shorter window = faster exit, less exposure)
          //   wide / structure / adaptive → 4 min (more room to breathe)

          if (mode !== "tight" && !retraceAllowanceUsed && ratchetCount >= 1) {
            // First retrace touch after at least one ratchet — evaluate momentum
            const { intact, confidence, reason } = checkMomentumIntact(sg.symbol, sg.side);
            if (intact) {
              retraceAllowanceUsed = true;
              const holdMinutes = mode === "standard" ? 2 : 4;
              retraceHoldExpiry = Date.now() + holdMinutes * 60_000;
              lastRetraceLogAt = Date.now();
              this.logEvent(sg.symbol, "safeguard_retrace_held",
                `[${sg.symbol} ${sg.side}] retrace to ${price.toFixed(2)} — momentum ${confidence}: ${reason} · hold window ${holdMinutes} min · one allowance used`
              ).catch(() => {});
              logger.info(
                { safeguardId: sg.id, confidence, reason, holdExpiry: new Date(retraceHoldExpiry).toISOString() },
                "Safeguard retrace absorbed — momentum intact",
              );
              return; // Stay in the trade — do NOT fire
            }
            // Momentum failing on first touch — close immediately
            this.logEvent(sg.symbol, "safeguard_momentum_failed",
              `[${sg.symbol} ${sg.side}] retrace to ${price.toFixed(2)} — momentum fading (${reason}) · closing now`
            ).catch(() => {});

          } else if (mode !== "tight" && retraceHoldExpiry != null && Date.now() < retraceHoldExpiry) {
            // Inside the hold window — re-check momentum on every tick
            const { intact, reason } = checkMomentumIntact(sg.symbol, sg.side);
            if (intact) {
              if (Date.now() - lastRetraceLogAt > 30_000) {
                lastRetraceLogAt = Date.now();
                logger.debug({ safeguardId: sg.id, reason }, "Retrace hold active — momentum still intact");
              }
              return; // Stay in the trade
            }
            // Momentum cracked during hold window — close now
            this.logEvent(sg.symbol, "safeguard_momentum_failed",
              `[${sg.symbol} ${sg.side}] momentum failed during retrace hold · closing · ${reason}`
            ).catch(() => {});

          } else if (mode !== "tight" && retraceHoldExpiry != null && Date.now() >= retraceHoldExpiry) {
            // Hold window expired — close unconditionally regardless of momentum
            this.logEvent(sg.symbol, "safeguard_hold_expired",
              `[${sg.symbol} ${sg.side}] retrace hold window expired · closing at ${price.toFixed(2)}`
            ).catch(() => {});
          }

          // ── All gates cleared — execute the close ────────────────────────
          record.fired = true;
          this.fire(record, price, {
            ratchetCount,
            safeguardRoiLevel:    maxProtectedRoi,
            patienceLevel:        cachedPatienceLabel,
            signalScore:          cachedSignalScore,
            structure:            cachedStructure,
            edgeContext:          cachedEdgeContext,
            triggerFloorUsed,
            floorWavePhase,
            floorOracleScore,
            extensionScoreAtArm,
            extensionPhaseAtClose: cachedStructure?.extensionPhase ?? undefined,
          }).catch((err) => logger.error({ err }, "Safeguard fire failed"));
        }
      }
    };

    // Attach getter so getLiveState() can read current ladder + structure + edge
    (record as ActiveSafeguard & {
      getLadderState: () => {
        ratchetCount: number;
        safeguardRoiLevel: number;
        patienceLevel: string;
        signalScore: number;
        structure: StructureContext | null;
        edgeContext: EdgeContext | null;
      };
    }).getLadderState = getLadderState;

    (record as ActiveSafeguard & { setFloor: typeof setFloor }).setFloor = setFloor;

    record.listener = listener;
    this.active.set(sg.id, record);
    priceStream.subscribe(symbol);
    priceStream.addListener(listener);

    logger.info({ safeguardId: sg.id, symbol, side: sg.side, entry, threshold1, mode }, "Safeguard armed (v5 ladder)");
    this.logEvent(symbol, "safeguard_armed",
      `[${symbol} ${sg.side} @ ${entry.toFixed(2)} · ${leverage}x · ${mode}] safeguard armed (threshold ${threshold1}%, ladder 2→4→6→2.5→… · ${mode === "tight" ? "no momentum gate" : `momentum gate ${mode === "standard" ? "2min" : "4min"}`})`
    ).catch(() => {});
  }

  disarm(id: number) {
    const r = this.active.get(id);
    if (!r) return;
    if (r.edgeRefreshTimer) {
      clearInterval(r.edgeRefreshTimer);
      r.edgeRefreshTimer = undefined;
    }
    priceStream.removeListener(r.listener);
    priceStream.unsubscribe(r.sg.symbol);
    this.active.delete(id);
    logger.info({ safeguardId: id }, "Safeguard disarmed");
  }

  /**
   * Called by the trigger watcher when a trigger price is crossed.
   * Returns true if the event is "absorbed" — i.e. a protecting safeguard
   * has locked profit AND momentum is still intact, so the trigger should
   * not close the trade right now.
   *
   * A single event-log entry is written so the operator can see exactly
   * why the trigger was held (or why it was allowed through).
   */
  handleTriggerTouch(symbol: string, triggerPrice: number): boolean {
    for (const [, r] of this.active) {
      if (r.sg.symbol !== symbol || r.fired) continue;
      if (r.sg.state !== "protecting") continue;

      // There is a protecting safeguard — check momentum
      const { intact, confidence, reason } = checkMomentumIntact(symbol, r.sg.side);

      if (intact) {
        this.logEvent(symbol, "trigger_absorbed_momentum_ok",
          `[${symbol}] trigger at ${triggerPrice.toFixed(2)} absorbed — safeguard protecting · momentum ${confidence}: ${reason} · trigger stays active for next cross`
        ).catch(() => {});
        logger.info({ symbol, triggerPrice, confidence, reason }, "Trigger absorbed — safeguard protecting with intact momentum");
        return true; // suppress the trigger close
      }

      // Momentum is fading — let the trigger close
      this.logEvent(symbol, "trigger_allowed_momentum_fading",
        `[${symbol}] trigger at ${triggerPrice.toFixed(2)} allowed — safeguard protecting but momentum fading: ${reason}`
      ).catch(() => {});
      logger.info({ symbol, triggerPrice, reason }, "Trigger allowed through — momentum fading despite active safeguard");
      return false;
    }

    // No protecting safeguard for this symbol — trigger fires normally
    return false;
  }

  // Return whether any safeguard is currently in "protecting" state for a symbol
  isProtecting(symbol: string): boolean {
    for (const [, r] of this.active) {
      if (r.sg.symbol === symbol && !r.fired && r.sg.state === "protecting") return true;
    }
    return false;
  }

  /**
   * Called by the trigger watcher when a price-cross trigger fires AND an
   * active safeguard exists for the same symbol.
   *
   * Instead of hard-closing the position, the trigger price becomes the new
   * protected-profit floor of the safeguard ladder. The ratchet then continues
   * upward from that floor. The position stays open under safeguard control.
   *
   * Returns true  → trigger was absorbed as a floor (do NOT hard-close).
   * Returns false → no active safeguard, or trigger price is at/below entry
   *                 (caller should proceed with the normal hard-close).
   *
   * Absorption rules:
   *   • triggerRoiLevel <= 0 → floor would be at a loss — skip, return false.
   *   • safeguard already at a tighter/better floor → no downgrade, still return
   *     true (trigger is "done" — no point hard-closing when safeguard is already
   *     protecting at a superior level).
   *   • otherwise → call setFloor() on the active safeguard closure, return true.
   */
  absorbTriggerAsFloor(symbol: string, triggerPrice: number): boolean {
    for (const [, r] of this.active) {
      if (r.sg.symbol !== symbol || r.fired) continue;

      const entry    = parseFloat(String(r.sg.entryPrice));
      const leverage = r.sg.leverage;

      // Compute what ROI% the trigger price locks in for this position
      const triggerRoiLevel = computeRoi(r.sg.side, entry, triggerPrice, leverage);

      // Only convert if the trigger price represents a profitable exit level
      if (triggerRoiLevel <= 0) {
        this.logEvent(symbol, "trigger_floor_rejected",
          `[${symbol}] trigger @ ${triggerPrice.toFixed(2)} not converted — represents ${triggerRoiLevel.toFixed(1)}% ROI (at or below entry)`,
        ).catch(() => {});
        logger.info({ symbol, triggerPrice, triggerRoiLevel }, "Trigger floor rejected — below entry");
        return false;
      }

      // ── Structure quality gate ────────────────────────────────────────────────
      // The PDF states: "Update the floor only after the trade proves itself with
      // structure, velocity, and resumption quality." If the wave is clearly
      // counter-directional at the moment of trigger-cross AND the ROI level is
      // still low (< 12%, barely in profit), the move has not proven itself —
      // a hard close is more protective than setting a floor on a stalling trade.
      //
      // Resuming waves, first waves, and any high-ROI crosses always get floor
      // treatment — the trigger-price cross is itself sufficient proof at that point.
      const sCtx       = getStructureContext(symbol);
      const wavePhase  = sCtx?.wavePhase ?? null;
      const counterMove = sCtx?.counterMove ?? false;
      const waveProven =
        wavePhase === "resumption_forming"   ||
        wavePhase === "resumption_confirmed" ||
        wavePhase === "extended"             ||
        wavePhase === "first_wave"           ||
        wavePhase === null;                     // no data → benefit of the doubt

      if (!waveProven && counterMove && wavePhase === "pressure_building" && triggerRoiLevel < 12) {
        this.logEvent(symbol, "trigger_floor_rejected",
          `[${symbol}] trigger @ ${triggerPrice.toFixed(2)} · wave ${wavePhase} + counter-move · ROI ${triggerRoiLevel.toFixed(1)}% too low — move unproven, hard close preferred`,
        ).catch(() => {});
        logger.info(
          { symbol, triggerPrice, wavePhase, counterMove, triggerRoiLevel },
          "Trigger floor rejected — structure counter-directional before proof",
        );
        return false;
      }

      // Delegate floor mutation to the closure-level callback (has direct
      // access to the safeguard's in-memory state variables)
      const sf = (r as ActiveSafeguard & { setFloor?: (p: number, roi: number) => boolean }).setFloor;
      if (!sf) return false;

      const applied = sf(triggerPrice, triggerRoiLevel);

      if (!applied) {
        // setFloor returned false → safeguard already has a tighter floor.
        // Still absorb the trigger (no hard-close needed).
        this.logEvent(symbol, "trigger_floor_skipped",
          `[${symbol}] trigger @ ${triggerPrice.toFixed(2)} crossed · safeguard floor already tighter · no downgrade`,
        ).catch(() => {});
        logger.info({ symbol, triggerPrice }, "Trigger floor skipped — safeguard already tighter");
      }

      return true; // always absorb: either floor was set, or safeguard already better
    }

    // No active safeguard for this symbol — trigger should hard-close normally
    return false;
  }

  // Hot-swap the close method while the safeguard is running.
  updateCloseMethod(id: number, method: string) {
    const r = this.active.get(id);
    if (!r) return false;
    r.sg.closeMethod = method;
    logger.info({ safeguardId: id, method }, "Safeguard close method updated");
    return true;
  }

  // Enrich a DB row with live in-memory ROI + ladder + structure + edge for the UI
  getLiveState(id: number): LiveState | null {
    const r = this.active.get(id);
    if (!r) return null;
    const ladder = (r as ActiveSafeguard & {
      getLadderState?: () => {
        ratchetCount: number;
        safeguardRoiLevel: number;
        patienceLevel: string;
        signalScore: number;
        structure: StructureContext | null;
        edgeContext: EdgeContext | null;
      };
    }).getLadderState?.();
    const ratchetCount = ladder?.ratchetCount ?? 0;
    const safeguardRoiLevel = ladder?.safeguardRoiLevel ?? null;
    const nextMilestoneRoiPct = safeguardRoiLevel != null
      ? safeguardRoiLevel + ladderStep(ratchetCount)
      : null;
    return {
      liveRoiPct: r.liveRoiPct,
      safeguardPrice: r.sg.safeguardPrice != null ? parseFloat(String(r.sg.safeguardPrice)) : null,
      highWaterRoiPct: r.sg.highWaterRoiPct != null ? parseFloat(String(r.sg.highWaterRoiPct)) : null,
      state: r.sg.state,
      ratchetCount,
      nextMilestoneRoiPct,
      patienceLevel: ladder?.patienceLevel ?? "standard",
      signalScore: ladder?.signalScore ?? 0,
      structure: ladder?.structure ?? null,
      plan: r.plan,
      planTrailDelta: planTrailDelta(r.plan),
      edgeContext: ladder?.edgeContext ?? null,
    };
  }

  /**
   * Find the most recent unconsumed plan for the symbol and link it to this
   * safeguard. Best-effort — any DB hiccup just leaves the watcher running
   * without a plan boost (the structure layer continues to work as before).
   */
  private async claimLatestPlan(sg: Safeguard, record: ActiveSafeguard) {
    try {
      const [plan] = await db
        .select()
        .from(tradePlansTable)
        .where(and(
          eq(tradePlansTable.symbol, sg.symbol),
          isNull(tradePlansTable.consumedAt),
        ))
        .orderBy(desc(tradePlansTable.createdAt))
        .limit(1);
      if (!plan) return;

      // Atomic claim — re-check consumedAt IS NULL in the UPDATE so that
      // if two safeguards arm concurrently for the same symbol, only the
      // first one to reach this UPDATE will get the plan. The second will
      // get an empty RETURNING and bail out cleanly.
      const [updated] = await db
        .update(tradePlansTable)
        .set({ consumedAt: new Date(), consumedBySafeguardId: sg.id })
        .where(and(
          eq(tradePlansTable.id, plan.id),
          isNull(tradePlansTable.consumedAt),
        ))
        .returning();
      if (!updated) {
        logger.info({ safeguardId: sg.id, planId: plan.id }, "Trade plan already claimed by another safeguard");
        return;
      }
      record.plan = updated;

      logger.info(
        {
          safeguardId: sg.id,
          planId: plan.id,
          agreement: plan.agreementScore,
          zone: plan.channelZone,
          recommendedPatience: plan.recommendedPatience,
          delta: planTrailDelta(plan).toFixed(2),
        },
        "Safeguard claimed pre-trade plan",
      );
      this.logEvent(sg.symbol, "safeguard_plan_linked",
        `[${sg.symbol} ${sg.side}] linked plan #${plan.id} · agreement ${plan.agreementScore} · zone ${plan.channelZone} · patience ${plan.recommendedPatience}`,
      ).catch(() => {});
    } catch (err) {
      logger.warn({ err, safeguardId: sg.id }, "Failed to claim trade plan");
    }
  }

  private async fire(
    record: ActiveSafeguard,
    price: number,
    ctx: {
      ratchetCount: number;
      safeguardRoiLevel: number;
      patienceLevel: string;
      signalScore: number;
      structure: StructureContext | null;
      edgeContext: EdgeContext | null;
      triggerFloorUsed:       boolean;
      floorWavePhase:         string | null;
      floorOracleScore:       number | null;
      extensionScoreAtArm:    number | undefined;
      extensionPhaseAtClose:  string | undefined;
    }
  ) {
    const sg = record.sg;
    const firedAt = Date.now();
    const entry = parseFloat(String(sg.entryPrice));
    const leverage = sg.leverage;

    // Stop oracle score refresh immediately — trade is closing
    if (record.edgeRefreshTimer) {
      clearInterval(record.edgeRefreshTimer);
      record.edgeRefreshTimer = undefined;
    }

    logger.info({ safeguardId: sg.id, price }, "Safeguard retrace trigger fired");
    priceStream.removeListener(record.listener);
    priceStream.unsubscribe(sg.symbol);
    this.active.delete(sg.id);

    const hwRoi = sg.highWaterRoiPct != null ? parseFloat(String(sg.highWaterRoiPct)) : record.mfe;

    await this.persistState(sg.id, { state: "triggered", triggeredAt: new Date() });
    await this.logEvent(sg.symbol, "safeguard_triggered",
      `[${sg.symbol} ${sg.side}] retrace fired · price ${price.toFixed(2)} · locked ${ctx.safeguardRoiLevel.toFixed(1)}% ROI · hw +${hwRoi.toFixed(1)}%`
    );

    try {
      await this.persistState(sg.id, { state: "closing" } as Partial<Safeguard>);
      const positionId = sg.positionId;
      if (!positionId) {
        throw new Error("Safeguard has no position id; refusing an unscoped close");
      }

      const livePositions = await getOpenPositions({ symbol: sg.symbol });
      const targetStillOpen = livePositions.some(
        (position) => String(position.positionId ?? "") === positionId,
      );
      if (!targetStillOpen) {
        await this.persistState(sg.id, { state: "completed", completedAt: new Date() });
        await this.logEvent(
          sg.symbol,
          "safeguard_position_already_flat",
          `[${sg.symbol} ${sg.side}] position ${positionId} was already closed before the safeguard close`,
        );
        return;
      }

      // A stepped safeguard belongs to one exchange position, never every
      // position sharing its symbol. The legacy closeMethod field is ignored.
      await flashClosePosition(positionId);

      const flat = await this.pollFlat(sg.symbol, positionId);
      const executionLatencyMs = Date.now() - firedAt;

      // ── Compute journal data ─────────────────────────────────────────────
      const exitRoiPct = computeRoi(sg.side, entry, price, leverage);
      const peakRoiPct = sg.highWaterRoiPct != null
        ? parseFloat(String(sg.highWaterRoiPct))
        : record.mfe;
      const givebackPct = Math.max(0, peakRoiPct - exitRoiPct);
      const nearMiss =
        record.mfe >= parseFloat(String(sg.threshold1Pct)) * 0.9 && ctx.ratchetCount === 0;
      const exitReason = ctx.ratchetCount > 0 ? "safeguard_ratchet" : "safeguard_protection";
      const verdict = tradeVerdict(givebackPct, true, ctx.ratchetCount, nearMiss);
      const fingerprint = buildFingerprint(sg.side, leverage, true, ctx.ratchetCount);
      const holdDurationMs = Date.now() - record.armedAt.getTime();

      if (flat) {
        await this.persistState(sg.id, { state: "completed", completedAt: new Date() });
        await this.logEvent(sg.symbol, "safeguard_completed",
          `[${sg.symbol} ${sg.side}] closed · exit ${price.toFixed(2)} · giveback ${givebackPct.toFixed(1)}% (${givebackRating(givebackPct)}) · ratchets ${ctx.ratchetCount} · latency ${executionLatencyMs}ms`
        );
        // Notify auto-entry watcher: enforce post-close revalidation wait before
        // allowing re-entry on the same symbol. A safeguard close is always
        // a profitable exit — the level needs to re-prove itself before committing again.
        notifyPostClose(sg.symbol, "safeguard");
      } else {
        await this.persistState(sg.id, {
          state: "failed",
          lastError: "Position still open after safeguard close attempt",
        });
        await this.logEvent(sg.symbol, "safeguard_failed",
          `[${sg.symbol} ${sg.side}] position not flat after close attempt`
        );
      }

      // Always write journal record (with full market-structure snapshot
      // AND pre-trade plan snapshot, if a plan was claimed at arming).
      const s = ctx.structure;
      const plan = record.plan;
      const edgeCtx = ctx.edgeContext;
      const outcomeVsPlan = computeOutcomeVsPlan(plan, exitRoiPct, givebackPct);

      // Resolve canonical trade identity from the position tracker.
      // If the position was opened via app/auto-entry, the tradeId was generated
      // at open time and is already stored in positionTracker.
      // If the position was opened externally (detected), we fall back to a fresh UUID
      // so the journal still gets a stable identity — marked as "inferred".
      const entryCtx = positionTracker.getContext(sg.positionId ?? "");
      const tradeId        = entryCtx?.tradeId ?? randomUUID();
      const openedBy       = entryCtx?.source ?? null;
      const dataConfidence = entryCtx ? "full" : "inferred";

      let journalId = 0;
      try {
        const [jr] = await db.insert(tradeJournalTable).values({
        tradeId,
        openedBy,
        dataConfidence,
        symbol: sg.symbol,
        side: sg.side,
        leverage,
        positionId: sg.positionId,
        entryPrice: String(entry),
        exitPrice: String(price),
        armedAt: record.armedAt,
        exitAt: new Date(),
        holdDurationMs,
        mfePct: String(record.mfe),
        maePct: String(record.mae),
        peakRoiPct: String(peakRoiPct),
        protectedRoiPct: String(ctx.safeguardRoiLevel),
        exitRoiPct: String(exitRoiPct),
        givebackPct: String(givebackPct),
        givebackRating: givebackRating(givebackPct),
        nearMiss,
        safeguardUsed: true,
        ratchetCount: ctx.ratchetCount,
        threshold1Pct: String(sg.threshold1Pct),
        exitReason,
        patienceLevel: ctx.patienceLevel,
        signalScore: String(ctx.signalScore),
        // ── Market-structure snapshot ─────────────────────────────────
        htfAlignment:      s ? htfAlignmentLabel(s) : null,
        threeMinLead:      s?.threeMinLeads ?? false,
        fifteenMinConfirm: s?.fifteenMinConfirms ?? false,
        fourBarStreak:     s?.fourBarStreak ?? 0,
        pivotState:        s?.pivotState ?? null,
        velocityState:     s?.velocityState ?? null,
        counterMove:       s?.counterMove ?? false,
        resumption:        s?.resumption ?? false,
        patienceBoost:     s?.patienceBoost ?? 0,
        trailWidth:        s ? String(s.trailWidth) : null,
        // ── Pre-trade plan snapshot ───────────────────────────────────
        tradePlanId:               plan?.id ?? null,
        uploadUsed:                plan != null,
        uploadKey:                 plan?.uploadKey ?? null,
        channelZoneAtPlan:         plan?.channelZone ?? null,
        userBiasAtPlan:            plan?.userBias ?? null,
        agreementScoreAtPlan:      plan?.agreementScore ?? null,
        continuationProbAtPlan:    plan?.continuationProbPct ?? null,
        recommendedPatienceAtPlan: plan?.recommendedPatience ?? null,
        outcomeVsPlan,
        // ── Edge score snapshot ───────────────────────────────────────
        edgeScore:           edgeCtx?.edgeScore ?? null,
        wholeNumberPlayType: s?.wholeNumberPlayType ?? null,
        walletSizeScore:     edgeCtx?.components.walletReadiness.score ?? null,
        // ──────────────────────────────────────────────────────────────
        closeMethod: sg.closeMethod,
        executionLatencyMs,
        verdict,
        setupFingerprint: fingerprint,
        // Trigger floor provenance — non-null only when the floor was
        // established by a trigger-price cross (not the normal threshold1 path).
        triggerFloorUsed:       ctx.triggerFloorUsed,
        floorWavePhase:         ctx.floorWavePhase,
        floorOracleScore:       ctx.floorOracleScore,
        extensionScoreAtArm:    ctx.extensionScoreAtArm ?? null,
        extensionPhaseAtClose:  ctx.extensionPhaseAtClose ?? null,
        sourceType: "safeguard",
        sourceId: sg.id,
      }).returning({ id: tradeJournalTable.id });
        journalId = jr?.id ?? 0;
      } catch (err) {
        logger.error({ err }, "Failed to write trade journal");
      }

      // Append safeguard_close event to the unified trade event stream
      db.insert(tradeEventsTable).values({
        tradeId,
        symbol:    sg.symbol,
        eventType: "safeguard_close",
        source:    "safeguard",
        price:     String(price),
        roiPct:    String(exitRoiPct),
        payload:   JSON.stringify({ ratchetCount: ctx.ratchetCount, safeguardRoiLevel: ctx.safeguardRoiLevel, executionLatencyMs }),
      }).catch(() => {});

      // Promote completed trade to edge fingerprint memory (best-effort, non-blocking).
      // Builds a compact setup fingerprint + auto-labels quality so future setups
      // can be compared against this example.
      promoteFingerprintFromJournal({
        id:            journalId,
        symbol:        sg.symbol,
        side:          sg.side,
        edgeScore:     edgeCtx?.edgeScore ?? null,
        safeguardUsed: true,
        exitRoiPct,
        givebackPct,
        maePct:         record.mae,
        fourBarStreak:  s?.fourBarStreak ?? 0,
        walkAwayActive: false,
        velocityState:  s?.velocityState ?? null,
        htfAlignment:   s ? htfAlignmentLabel(s) : null,
        haStreak3m:     s?.haStreak3m ?? 0,
        price,
      }).catch(() => {});

    } catch (err) {
      await this.persistState(sg.id, { state: "failed", lastError: String(err) });
      await this.logEvent(sg.symbol, "safeguard_error",
        `[${sg.symbol}] safeguard close error: ${String(err)}`
      );
    }
  }

  private async persistState(id: number, patch: Partial<Safeguard>) {
    await db
      .update(safeguardsTable)
      .set({ ...patch, updatedAt: new Date() } as Partial<Safeguard>)
      .where(eq(safeguardsTable.id, id));
  }

  private async logEvent(symbol: string, type: string, message: string) {
    try {
      await db.insert(eventLogTable).values({
        symbol,
        eventType: type,
        eventMessage: message,
        source: "safeguard",
      });
    } catch (_) {}
  }

  private async pollFlat(symbol: string, positionId: string, attempts = 6): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const positions = await getOpenPositions({ symbol });
        if (!positions.some((position) => String(position.positionId ?? "") === positionId)) return true;
      } catch (_) {}
    }
    return false;
  }
}

export const safeguardManager = new SafeguardManager();

export async function restoreArmedSafeguards() {
  try {
    const armed = await db
      .select()
      .from(safeguardsTable)
      .where(eq(safeguardsTable.state, "armed"));
    const protecting = await db
      .select()
      .from(safeguardsTable)
      .where(eq(safeguardsTable.state, "protecting"));
    for (const sg of [...armed, ...protecting]) {
      if (!sg.positionId) {
        await db
          .update(safeguardsTable)
          .set({
            state: "failed",
            lastError: "Cannot safely restore a stepped safeguard without its Bitunix position id",
            updatedAt: new Date(),
          })
          .where(eq(safeguardsTable.id, sg.id));
        logger.error(
          { safeguardId: sg.id, symbol: sg.symbol },
          "Legacy safeguard has no position id and was not restored",
        );
        continue;
      }
      logger.info({ safeguardId: sg.id }, "Restoring safeguard after restart");
      safeguardManager.arm(sg);
    }
  } catch (err) {
    logger.error({ err }, "Failed to restore safeguards");
  }
}
