/**
 * Flat-Only Auto-Entry Watcher.
 *
 * Evaluates entry conditions on a configurable interval and opens a position
 * only when ALL guardrails pass:
 *
 *   1. Enabled toggle is ON (explicit user activation required)
 *   2. Account is flat — no open position on the configured symbol
 *   3. Current ET time is not in a blocked window
 *   4. Current ET time is in an allowed window (if any are configured)
 *   5. Price is NOT in the "middles" zone (dangerous 30–70% between whole numbers)
 *  5b. Price IS within 20% of the nearest whole-number level (proximity gate,
 *      always-on). "Close to the whole number is key." — Oracle Method.
 *   6. Edge score >= configured minimum (default 65 = "good")
 *   7. Estimated liquidation gap >= configured minimum (default $3,000)
 *   8. A clear directional signal exists (for SIGNAL mode)
 *   9. Plan gate — evaluates the latest unconsumed trade plan (if any):
 *
 *      "stand-down" → hard block (chart contradicts bias or setup is stretched)
 *
 *      "wait"       → SMART resolution:
 *                      If priceAtUpload is known, check whether price has already
 *                      moved ≥80% of the expected returnToZonePct in the plan's
 *                      bias direction. If yes, the retrace occurred — auto-promote
 *                      to an "enter" check (no fresh upload needed).
 *                      If not, block and note how far the retrace has progressed.
 *
 *      "enter"      → pass if confidenceLevel >= MIN_PLAN_CONFIDENCE (55)
 *
 *      Stale plan   → treated as no plan (gate open) after PLAN_MAX_AGE_MS (8h).
 *                      Market structure changes; a chart from yesterday is noise.
 *
 *      No plan      → gate open (plans are informational, not mandatory).
 *
 * The safe default is always NO ACTION. Only opens when every check passes.
 * After a successful entry the natural cooldown is the open position itself —
 * the flat-check blocks all subsequent cycles until the trade exits.
 */

import { db } from "./db";
import { logger } from "./logger";
import { bitunixGet, bitunixPost, toPositionDirection } from "./bitunix";
import { positionTracker } from "./positionTracker";
import {
  safeguardsTable,
  eventLogTable,
  autoEntryConfigTable,
  autoEntryLogTable,
  tradePlansTable,
} from "@workspace/db/schema";
import { safeguardManager } from "./safeguardWatcher";
import { getStructureContext } from "./signalScore";
import { computeEdgeScore } from "./edgeScore";
import { getCachedGovernorAdjustments } from "./behaviorGovernor";
import { priceStream } from "./priceStream";
import { desc, and, isNull, eq } from "drizzle-orm";
import { registerPostCloseHandler, type CloseReason } from "./postCloseNotifier";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Plans older than this are treated as stale and ignored (gate open).
 * 8 hours covers a full trading session. Any chart uploaded the day before
 * describes a different market and should not gate today's entry.
 */
const PLAN_MAX_AGE_MS = 8 * 60 * 60 * 1000;

/**
 * Minimum plan confidence to allow entry.
 * Below 55 the image assessment is too ambiguous to act on safely.
 * Range: 0–100 (model-assigned). Typical clean setup: 65–80.
 */
const MIN_PLAN_CONFIDENCE = 55;

/**
 * What fraction of the expected retrace depth must have occurred before a
 * "wait" plan is considered resolved. 0.80 = 80%.
 * Using slightly less than 100% so the system catches the zone before price
 * snaps back — consistent with trading at the zone, not after it.
 */
const WAIT_RESOLVE_THRESHOLD = 0.80;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TimeWindow {
  label: string;
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

interface PositionItem {
  positionId: string;
  symbol: string;
  side: string;        // BUY/SELL or LONG/SHORT (Bitunix direction)
  qty: string;
  entryPrice?: string;
  avgOpenPrice?: string;
  openPrice?: string;
  leverage?: number;
  margin?: string;
}

export interface EvalResult {
  evaluatedAt: Date;
  allowed: boolean;
  blockReasons: string[];
  positionFlat: boolean;
  timeWindowOk: boolean;
  avoidMiddlesOk: boolean;
  /** Price is within 20% of the nearest whole-number level. Always evaluated. */
  wholeNumberProximityOk: boolean;
  /**
   * Price is on the correct side of the nearest whole number for the detected
   * trade direction (over the level for LONG, under for SHORT).
   * null when side is unresolved (SIGNAL with no HTF direction).
   */
  wholeNumberDirectionOk: boolean | null;
  edgeOk: boolean;
  liqGapOk: boolean;
  // Plan gate (null = no plan or stale plan, gate open)
  planGateOk: boolean | null;
  planLikelyAction: string | null;
  planConfidenceLevel: number | null;
  planAgreementScore: number | null;
  planReturnToZoneNote: string | null;
  edgeScore: number | null;
  edgeGrade: string | null;
  liqGapEstimate: number | null;
  detectedSide: string | null;
  currentPrice: number | null;
  entryOpened: boolean;
  entrySymbol: string | null;
  entrySide: string | null;
  entryPrice: number | null;
  entryQty: number | null;
  marginUsed: number | null;
  positionId: string | null;
  safeguardArmed: boolean;
  safeguardId: number | null;
  errorMessage: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns current time in America/New_York as total minutes since midnight. */
function etMinutesSinceMidnight(): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const h = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const m = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  return h * 60 + m;
}

function inWindow(minutesSinceMidnight: number, w: TimeWindow): boolean {
  const start = w.startHour * 60 + w.startMin;
  const end   = w.endHour   * 60 + w.endMin;
  if (start <= end) {
    return minutesSinceMidnight >= start && minutesSinceMidnight < end;
  }
  // Overnight window (e.g., 23:00–01:00)
  return minutesSinceMidnight >= start || minutesSinceMidnight < end;
}

/**
 * Returns true if price is in the "middles" — 30–70% between consecutive
 * whole-number levels, the most dangerous zone per the Oracle Method.
 *
 * Examples for BTC at ~81,000 (step = 1,000):
 *   $81,456 → 456 / 1000 = 0.456 → in middle ⚠
 *   $81,050 → 050 / 1000 = 0.050 → safe (near whole number)
 *   $81,960 → 960 / 1000 = 0.960 → safe (near next whole number)
 */
function isInMiddle(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const step = price >= 10000 ? 1000
             : price >= 1000  ? 100
             : price >= 100   ? 10
             : price >= 10    ? 1
             : 0.1;
  const sub = price % step;
  const fraction = sub / step;
  return fraction >= 0.3 && fraction <= 0.7;
}

/**
 * Returns true if price is within 20% of the nearest whole-number level.
 *
 * "Close to the whole number is key, that should be a check prior to entry."
 * This is a POSITIVE confirmation: price must be AT the key zone, not merely
 * outside the middle. Threshold: within 20% of the $1,000 step.
 *
 * Examples for BTC at ~81,000 (step = 1,000):
 *   $81,150 → 150/1000 = 0.15 → near $81,000 ✓  (within 20%)
 *   $81,950 → 950/1000 = 0.95 → near $82,000 ✓  (within 5% from above)
 *   $81,280 → 280/1000 = 0.28 → too far ✗        (28%, outside 20% zone)
 */
function isNearWholeNumber(price: number): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  const step = price >= 10000 ? 1000
             : price >= 1000  ? 100
             : price >= 100   ? 10
             : price >= 10    ? 1
             : 0.1;
  const sub = price % step;
  const fraction = sub / step;
  return fraction <= 0.2 || fraction >= 0.8;
}

/** Human-readable description of where price is in the whole-number span. */
function wholeNumberSpanLabel(price: number): string {
  const step = price >= 10000 ? 1000 : price >= 1000 ? 100 : price >= 100 ? 10 : price >= 10 ? 1 : 0.1;
  const sub = price % step;
  const fraction = Math.round((sub / step) * 100);
  const lower = Math.floor(price / step) * step;
  const upper = lower + step;
  return `${fraction}% into $${lower.toLocaleString()}–$${upper.toLocaleString()}`;
}

/**
 * Estimated liquidation gap (in USD price distance) for isolated margin.
 * Simplified: gap ≈ entryPrice / leverage.
 * Actual gap depends on maintenance margin rate; this is conservative.
 */
function estimateLiqGap(price: number, leverage: number): number {
  if (leverage <= 0 || price <= 0) return 0;
  return price / leverage;
}

/** Round quantity to Bitunix-compatible precision (4 decimal places). */
function roundQty(qty: number): number {
  return Math.floor(qty * 10000) / 10000;
}

/**
 * Evaluate whether a "wait" plan's expected retrace has already occurred.
 *
 * Returns a fraction 0..∞ representing how much of the expected move has
 * happened (1.0 = exactly the expected depth; >0.80 = resolved).
 * Returns null if there is not enough data to compute.
 */
function computeRetraceProgress(
  uploadPrice: number,
  currentPrice: number,
  retracePct: number,
  bias: string,
): number | null {
  if (!Number.isFinite(uploadPrice) || uploadPrice <= 0) return null;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;
  if (!Number.isFinite(retracePct) || retracePct <= 0) return null;
  if (bias !== "long" && bias !== "short") return null;

  const movePct = ((currentPrice - uploadPrice) / uploadPrice) * 100;

  // Long bias: expected retrace = price falls (movePct < 0)
  // Short bias: expected retrace = price rises (movePct > 0)
  const signedMove = bias === "long" ? -movePct : movePct;

  // Fraction of expected retrace that has occurred (0 = none, 1 = full, >1 = overshot)
  return signedMove / retracePct;
}

/**
 * Whole-number direction gate — Oracle Method rule:
 *   LONG  (BUY):  price must be OVER the whole number  (fraction 0.00–0.20)
 *   SHORT (SELL): price must be UNDER the whole number (fraction 0.80–1.00)
 *
 * "Under-number shorts and over-number longs" — you only go short after a
 * level has broken to the downside and price is approaching from below; you
 * only go long after a break to the upside and price is approaching from above.
 * Being on the wrong side of a level is the fastest way to get caught in a trap.
 *
 * This is a refinement of isNearWholeNumber (proximity check). Both must pass:
 * proximity confirms you are close to a key level; direction confirms you are
 * on the correct side of it given your intended trade direction.
 *
 * Returns true (gate open) when side is unresolved — SIGNAL mode with no
 * detected direction falls through to other blocks.
 */
function isCorrectSideOfWhole(price: number, side: string): boolean {
  if (!Number.isFinite(price) || price <= 0) return true;
  const step = price >= 10000 ? 1000
             : price >= 1000  ? 100
             : price >= 100   ? 10
             : price >= 10    ? 1
             : 0.1;
  const fraction = (price % step) / step;
  // LONG: price approaching from BELOW the whole number (fraction 0.80–1.00)
  //   e.g. BTC at $78,802 closing in on $79,000 from below → long the breakout attempt
  // SHORT: price approaching from ABOVE the whole number (fraction 0.00–0.20)
  //   e.g. BTC at $79,039 near $79,000 from above → short the rejection / failed break
  //
  // Confirmed against live trade data: $79,039 SHORT (fraction 0.039 ✓),
  // $78,802 LONG (fraction 0.802 ✓). Inverse would block both of these.
  return side === "LONG" ? fraction >= 0.8 : fraction <= 0.2;
}

// ── Main watcher class ────────────────────────────────────────────────────────

class AutoEntryWatcher {
  private readonly intervalMs = 60_000;      // default poll interval
  private nextIntervalMs     = 60_000;       // adaptive — extends during quiet periods
  private timer: NodeJS.Timeout | null = null;
  private lastResult: EvalResult | null = null;
  private cooldownUntil: number = 0;         // epoch ms — brief post-entry cooldown
  // Last successfully fetched wallet state — reused during early-block cycles
  // so we avoid a Bitunix account API call when we cannot open anyway.
  private lastKnownWallet: { available: number; positionMargin: number } | null = null;

  // ── Log-throttle state ─────────────────────────────────────────────────────
  // Fingerprint of the last written auto_entry_log row so we can skip writes
  // when nothing meaningful has changed between cycles.
  private lastLoggedAllowed: boolean | null = null;
  private lastLoggedReasons = "";
  private lastLoggedPositionFlat: boolean | null = null;

  // ── Post-close revalidation state ──────────────────────────────────────────
  // Set by notifyClose() when safeguard or trigger confirms a flat close.
  // Blocks auto-entry for a mandatory cool-down window so the oracle can
  // verify that structure + timing genuinely support a new setup rather than
  // immediately re-entering the same level that just printed a close.
  private postCloseWaitUntil = 0;
  private postCloseSymbol: string | null = null;
  private postCloseReason: CloseReason | null = null;

  // ── Session freeze state tracking ──────────────────────────────────────────
  // Tracks whether we've already logged the freeze_activated event for the
  // current freeze session, to avoid spamming the event log every cycle.
  private lastFrozenLogged: boolean = false;

  // ── Public API ──────────────────────────────────────────────────────────────

  start() {
    if (this.timer) return;
    // Register the post-close notification bridge so safeguard and trigger
    // watchers can signal this watcher without a circular import.
    registerPostCloseHandler((symbol, reason) => this.notifyClose(symbol, reason));
    logger.info("Auto-entry watcher started");
    this.scheduleNext();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info("Auto-entry watcher stopped");
  }

  getLastResult(): EvalResult | null {
    return this.lastResult;
  }

  /**
   * Called by the post-close notifier when a safeguard or trigger confirms
   * the position is flat. Enforces a mandatory revalidation window:
   *   • safeguard (protected trade) → 5 min — the level closed profitably
   *     and must re-prove itself before the oracle commits again.
   *   • trigger (explicit close)    → 3 min — structure may still be intact
   *     but timing needs one full candle to reset.
   */
  notifyClose(symbol: string, reason: CloseReason): void {
    const waitMs = reason === "safeguard" ? 5 * 60_000 : 3 * 60_000;
    this.postCloseWaitUntil = Date.now() + waitMs;
    this.postCloseSymbol    = symbol.toUpperCase();
    this.postCloseReason    = reason;
    logger.info(
      { symbol, reason, waitMs },
      "Auto-entry post-close revalidation window started",
    );

    // Log to event log so the cooldown is visible in the UI.
    const mins = Math.round(waitMs / 60_000);
    const exitLabel = reason === "safeguard" ? "safeguard exit" : "trigger close";
    db.insert(eventLogTable).values({
      symbol: symbol.toUpperCase(),
      eventType: "cooldown_started",
      eventMessage:
        `[COOLDOWN] ${mins}-minute revalidation window started after ${exitLabel}. ` +
        `Oracle will wait for Heikin Ashi resumption and structure to reconfirm before considering a new entry.`,
      source: "auto_entry",
    }).catch(() => {});
  }

  // ── Private: scheduling ─────────────────────────────────────────────────────

  private scheduleNext() {
    const delay = this.nextIntervalMs;
    this.nextIntervalMs = this.intervalMs; // reset to default; runCycle may override
    this.timer = setTimeout(() => {
      this.runCycle().catch((err) => {
        logger.error({ err }, "Auto-entry cycle error");
      }).finally(() => {
        this.scheduleNext();
      });
    }, delay);
  }

  // ── Private: main evaluation cycle ─────────────────────────────────────────

  private async runCycle() {
    // Load config fresh on every cycle so UI changes take effect immediately
    const [config] = await db
      .select()
      .from(autoEntryConfigTable)
      .limit(1);

    if (!config || !config.enabled) return; // watcher is off, nothing to do

    // ── Session freeze (kill-switch) ────────────────────────────────────────
    // DB-persisted hard block. Survives server restarts. Requires manual
    // unfreeze from the UI. Log once per freeze session to avoid spam.
    if (config.sessionFrozen) {
      if (!this.lastFrozenLogged) {
        this.lastFrozenLogged = true;
        await db.insert(eventLogTable).values({
          symbol: config.symbol,
          eventType: "freeze_activated",
          eventMessage:
            `[FROZEN] Session freeze is active — all auto-entry blocked. ` +
            `Unfreeze via the Auto Entry card when conditions improve.`,
          source: "auto_entry",
        }).catch(() => {});
      }
      return;
    }
    // Clear the flag when unfrozen so the next freeze logs correctly.
    this.lastFrozenLogged = false;

    // ── Behavioral Governor hard block ───────────────────────────────────────
    // If the governor has detected severely degraded trading behavior (score < 20)
    // it issues a hard auto-entry block regardless of other config. This is purely
    // additive — the user's own session-freeze is the authoritative kill-switch;
    // the governor acts as an automatic circuit-breaker for behavioral drift.
    const gov = getCachedGovernorAdjustments();
    if (gov.autoBlocked) {
      logger.debug("Auto-entry blocked by behavioral governor — score too low");
      return;
    }

    if (Date.now() < this.cooldownUntil) {
      logger.debug("Auto-entry in cooldown, skipping cycle");
      return;
    }

    const result = await this.evaluate(config);
    this.lastResult = result;

    // Adaptive interval — stay lighter during guaranteed no-trade periods.
    // Time-window blocks are predictable (e.g. witching hour lasts hours);
    // no need to burn a cycle every 60s just to confirm the clock hasn't changed.
    // Position-running is the most common state; 90s is enough to detect closure.
    if (!result.timeWindowOk) {
      this.nextIntervalMs = 5 * 60_000; // 5 min during blocked time windows
    } else if (!result.positionFlat) {
      this.nextIntervalMs = 30_000;     // 30s while position running — resumes scanning quickly after close
    }
    // otherwise: stays at default 60s

    // Persist log row — only when something meaningful changed.
    // Skipping identical consecutive rows (same allowed flag + same block reasons)
    // cuts DB writes during long blocked periods without losing signal.
    if (!this.shouldLogResult(result)) return;
    try {
      await db.insert(autoEntryLogTable).values({
        evaluatedAt: result.evaluatedAt,
        allowed: result.allowed,
        blockReasons: result.blockReasons,
        positionFlat: result.positionFlat,
        timeWindowOk: result.timeWindowOk,
        avoidMiddlesOk: result.avoidMiddlesOk,
        edgeOk: result.edgeOk,
        liqGapOk: result.liqGapOk,
        planGateOk: result.planGateOk,
        planLikelyAction: result.planLikelyAction,
        planConfidenceLevel: result.planConfidenceLevel,
        planAgreementScore: result.planAgreementScore,
        planReturnToZoneNote: result.planReturnToZoneNote,
        edgeScore: result.edgeScore,
        edgeGrade: result.edgeGrade,
        liqGapEstimate: result.liqGapEstimate != null ? String(result.liqGapEstimate) : null,
        detectedSide: result.detectedSide,
        currentPrice: result.currentPrice != null ? String(result.currentPrice) : null,
        entryOpened: result.entryOpened,
        entrySymbol: result.entrySymbol,
        entrySide: result.entrySide,
        entryPrice: result.entryPrice != null ? String(result.entryPrice) : null,
        entryQty: result.entryQty != null ? String(result.entryQty) : null,
        marginUsed: result.marginUsed != null ? String(result.marginUsed) : null,
        positionId: result.positionId,
        safeguardArmed: result.safeguardArmed,
        safeguardId: result.safeguardId,
        errorMessage: result.errorMessage,
      });
      // Record what we just persisted so future cycles can skip identical rows.
      this.lastLoggedAllowed       = result.allowed;
      this.lastLoggedReasons       = (result.blockReasons ?? []).join("|");
      this.lastLoggedPositionFlat  = result.positionFlat;
    } catch (err) {
      logger.error({ err }, "Auto-entry log write failed");
    }
  }

  /**
   * Returns true when a new auto_entry_log row should be written.
   *
   * Rules:
   *  - Always write if an entry was actually opened (the most important event).
   *  - Always write on the first cycle (no previous row to compare against).
   *  - Write whenever the gate outcome (allowed), position state, or the set of
   *    block reasons changes — these are meaningful transitions.
   *  - Skip identical consecutive rows (same allowed + same position + same
   *    reasons) to avoid a constant write storm during long blocked periods.
   */
  private shouldLogResult(result: EvalResult): boolean {
    if (result.entryOpened) return true;
    if (this.lastLoggedAllowed === null) return true;
    if (result.allowed        !== this.lastLoggedAllowed)      return true;
    if (result.positionFlat   !== this.lastLoggedPositionFlat) return true;
    const reasons = (result.blockReasons ?? []).join("|");
    return reasons !== this.lastLoggedReasons;
  }

  // ── Private: full guardrail evaluation ─────────────────────────────────────

  private async evaluate(config: typeof autoEntryConfigTable.$inferSelect): Promise<EvalResult> {
    const result: EvalResult = {
      evaluatedAt: new Date(),
      allowed: false,
      blockReasons: [],
      positionFlat: false,
      timeWindowOk: false,
      avoidMiddlesOk: false,
      wholeNumberProximityOk: false,
      wholeNumberDirectionOk: null,
      edgeOk: false,
      liqGapOk: false,
      planGateOk: null,
      planLikelyAction: null,
      planConfidenceLevel: null,
      planAgreementScore: null,
      planReturnToZoneNote: null,
      edgeScore: null,
      edgeGrade: null,
      liqGapEstimate: null,
      detectedSide: null,
      currentPrice: null,
      entryOpened: false,
      entrySymbol: null,
      entrySide: null,
      entryPrice: null,
      entryQty: null,
      marginUsed: null,
      positionId: null,
      safeguardArmed: false,
      safeguardId: null,
      errorMessage: null,
    };

    const symbol = config.symbol.toUpperCase();
    const leverage = config.leverage;
    const maxMargin = parseFloat(String(config.maxMarginUsdt));
    const minLiqGap = parseFloat(String(config.minLiqGapUsdt));
    const minEdge = config.minEdgeScore;

    try {
      // ── 1. Position flat check ──────────────────────────────────────────────
      const posResp = await bitunixGet<PositionItem[]>(
        "/api/v1/futures/position/get_pending_positions",
        { symbol },
      );
      const positions = Array.isArray(posResp.data) ? posResp.data : [];
      result.positionFlat = positions.length === 0;
      if (!result.positionFlat) {
        result.blockReasons.push("Active position running — oracle does not open while a trade is live.");
      }

      // ── 1.5. Post-close revalidation wait ─────────────────────────────────
      // After a safeguard or trigger close the oracle enforces a mandatory wait.
      // The level that just closed needs to re-declare itself: Heikin Ashi must
      // resume, session timing must reset, and the oracle score must reconfirm
      // independently — not driven by recency bias from the prior trade.
      //
      // Only applies when the account is flat (guarded above). If a different
      // symbol's close fired the notifier, the symbol check keeps it isolated.
      if (
        result.positionFlat &&
        this.postCloseWaitUntil > Date.now() &&
        (this.postCloseSymbol === null || this.postCloseSymbol === symbol)
      ) {
        const secsLeft = Math.ceil((this.postCloseWaitUntil - Date.now()) / 1000);
        const mins = Math.floor(secsLeft / 60);
        const secs = secsLeft % 60;
        const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
        const exitLabel = this.postCloseReason === "safeguard" ? "safeguard exit" : "trigger close";
        result.blockReasons.push(
          `Post-close revalidation: ${timeStr} remaining after ${exitLabel}. ` +
          `Oracle is waiting for Heikin Ashi resumption and session structure ` +
          `to reconfirm the setup independently — not re-entering the same ` +
          `level on momentum from the prior trade.`,
        );
        result.allowed = false;
        return result;
      }

      // ── 1.6. Walk Away mode ────────────────────────────────────────────────
      // User-engaged "stand down" after a close. Unlike the automatic post-close
      // revalidation wait, this stays active until the user manually taps Resume.
      // Only applies when flat — if a position is already open it runs to completion.
      if (config.walkAwayMode && result.positionFlat) {
        result.blockReasons.push(
          "Walk Away active — oracle standing down until you engage a fresh setup. " +
          "Tap Resume in the Auto Entry card when ready.",
        );
        result.allowed = false;
        return result;
      }

      // ── 2. Time window check ────────────────────────────────────────────────
      const etMin = etMinutesSinceMidnight();
      const blocked: TimeWindow[] = Array.isArray(config.blockedWindowsJson)
        ? (config.blockedWindowsJson as unknown as TimeWindow[])
        : [];
      const allowed: TimeWindow[] = Array.isArray(config.allowedWindowsJson)
        ? (config.allowedWindowsJson as unknown as TimeWindow[])
        : [];

      const inBlocked = blocked.some((w) => inWindow(etMin, w));
      const inAllowed = allowed.length === 0 || allowed.some((w) => inWindow(etMin, w));
      result.timeWindowOk = !inBlocked && inAllowed;

      if (inBlocked) {
        const matchedLabel = blocked.find((w) => inWindow(etMin, w))?.label ?? "blocked window";
        result.blockReasons.push(`Time gate: ${matchedLabel} — oracle stands aside during this window.`);
      } else if (!inAllowed) {
        result.blockReasons.push("Outside the allowed trading window — oracle only acts during configured hours.");
      }

      // ── 3. Current price + middles check ───────────────────────────────────
      const livePrice = priceStream.getLatest(symbol) ?? null;
      result.currentPrice = livePrice;

      if (livePrice && config.avoidMiddles) {
        result.avoidMiddlesOk = !isInMiddle(livePrice);
        if (!result.avoidMiddlesOk) {
          result.blockReasons.push(
            "Price is mid-range between key levels (30–70% of the whole-number span) — the oracle waits for price to reach a defined zone before committing.",
          );
        }
      } else {
        result.avoidMiddlesOk = true;
      }

      // ── 3b. Whole-number proximity (always-on gate) ────────────────────────
      // "Close to the whole number is key, that should be a check prior to entry."
      // Positive confirmation: price must be WITHIN 20% of the nearest level.
      // Separate from avoidMiddles (which blocks the middle); this requires
      // price to be actively close to a key level, not merely outside the middle.
      result.wholeNumberProximityOk = livePrice ? isNearWholeNumber(livePrice) : false;
      if (livePrice && !result.wholeNumberProximityOk) {
        result.blockReasons.push(
          `Price at ${wholeNumberSpanLabel(livePrice)} — oracle needs price within 20% of the key level. Waiting for price to return to the zone.`,
        );
      }

      // ── 4. Edge score check ─────────────────────────────────────────────────
      // Efficiency gate: when early checks already block entry (position live
      // or time window closed) reuse the last-known wallet snapshot instead of
      // making a Bitunix API roundtrip. Display-only accuracy is sufficient —
      // we cannot open a position anyway, so stale wallet data is fine.
      const earlyBlocked = !result.positionFlat || !result.timeWindowOk;
      let available: number;
      let positionMargin: number;
      if (earlyBlocked && this.lastKnownWallet !== null) {
        ({ available, positionMargin } = this.lastKnownWallet);
      } else {
        const accountResp = await bitunixGet<{ available: string; margin: string }>(
          "/api/v1/futures/account",
          { marginCoin: "USDT" },
        );
        available = parseFloat(accountResp.data.available);
        positionMargin = parseFloat(accountResp.data.margin);
        this.lastKnownWallet = { available, positionMargin };
      }
      const structCtx = getStructureContext(symbol);
      const edgeCtx = computeEdgeScore(structCtx, { available, positionMargin });

      result.edgeScore = edgeCtx.edgeScore;
      result.edgeGrade = edgeCtx.grade;

      // Apply behavioral governor oracle floor penalty (synchronous, uses cache)
      const govAdj = getCachedGovernorAdjustments();
      const effectiveMinEdge = minEdge + govAdj.oracleFloorDelta;
      result.edgeOk = edgeCtx.edgeScore >= effectiveMinEdge;
      if (!result.edgeOk) {
        const gap = effectiveMinEdge - edgeCtx.edgeScore;
        const govNote = govAdj.oracleFloorDelta > 0
          ? ` (floor raised +${govAdj.oracleFloorDelta} by behavioral governor)`
          : "";
        const prefix = gap <= 5
          ? `Oracle score ${edgeCtx.edgeScore} — just ${gap} point${gap === 1 ? "" : "s"} below the gate (needs ${effectiveMinEdge}${govNote}). `
          : `Oracle score ${edgeCtx.edgeScore} — needs ${effectiveMinEdge} before committing wallet${govNote}. `;
        result.blockReasons.push(`${prefix}${edgeCtx.oracleNarration}`);
      }

      // ── 5. Liquidation gap check ────────────────────────────────────────────
      if (livePrice) {
        const liqGap = estimateLiqGap(livePrice, leverage);
        result.liqGapEstimate = liqGap;
        result.liqGapOk = liqGap >= minLiqGap;
        if (!result.liqGapOk) {
          result.blockReasons.push(
            `Liquidation buffer $${liqGap.toFixed(0)} — oracle needs at least $${minLiqGap.toFixed(0)} of gap. Reduce leverage or add margin.`,
          );
        }
      } else {
        result.liqGapOk = false;
        result.blockReasons.push("No live price — oracle cannot evaluate the setup without market data.");
      }

      // ── 6. Side detection ───────────────────────────────────────────────────
      let side = config.side.toUpperCase();
      if (side === "SIGNAL") {
        if (structCtx.htfDirection === 1) {
          side = "LONG";
        } else if (structCtx.htfDirection === -1) {
          side = "SHORT";
        } else {
          side = "NONE";
          result.blockReasons.push("Higher timeframes split — oracle cannot determine direction. Watching for alignment before opening.");
        }
      }
      result.detectedSide = side;

      // ── 6.5. Whole-number direction gate ──────────────────────────────────
      // Under-number shorts and over-number longs — Oracle Method precision.
      // The proximity check (3b) confirmed price is NEAR a key level.
      // This check confirms price is on the CORRECT SIDE of that level for
      // the intended direction.
      //
      // LONG: price approaching from BELOW (fraction 0.8–1.0, just under the number)
      //   BTC at $78,802 approaching $79k → long the breakout attempt ✓
      //   BTC at $79,050 already above $79k → wrong side for a long, blocked ✗
      //
      // SHORT: price approaching from ABOVE (fraction 0.0–0.2, just above the number)
      //   BTC at $79,039 near $79k from above → short the rejection ✓
      //   BTC at $78,800 approaching from below → wrong side for a short, blocked ✗
      //
      // Only evaluated when side is resolved AND proximity already passed.
      // If proximity failed, direction is moot (proximity block already fires).
      let wholeNumberDirectionOk: boolean | null = null;
      if (livePrice && (side === "LONG" || side === "SHORT") && result.wholeNumberProximityOk) {
        wholeNumberDirectionOk = isCorrectSideOfWhole(livePrice, side);
        result.wholeNumberDirectionOk = wholeNumberDirectionOk;
        if (!wholeNumberDirectionOk) {
          const step = livePrice >= 10000 ? 1000 : livePrice >= 1000 ? 100 : livePrice >= 100 ? 10 : 1;
          const nearest = Math.round(livePrice / step) * step;
          // LONG needs price below the level (approaching from below); SHORT needs price above it
          const posLabel = side === "LONG" ? "below" : "above";
          result.blockReasons.push(
            `Direction gate: ${side} requires price ${posLabel} $${nearest.toLocaleString()} — ` +
            `oracle only enters a ${side.toLowerCase()} approaching the level from the correct side.`,
          );
        }
      }

      // ── 7. Plan gate — image-to-self-trade intelligence ─────────────────────
      //
      // The most recent unconsumed trade plan provides a human-vision-informed
      // read of the current chart structure. Three possible signals:
      //
      //   "stand-down" → contradicts bias / stretched → hard block, no override
      //   "wait"       → better zone expected via retrace →
      //                  SMART: auto-resolve when price has moved ≥80% of the
      //                  expected retrace depth (priceAtUpload + returnToZonePct).
      //                  Eliminates the need for a fresh upload after the retrace.
      //   "enter"      → structure aligned → pass if confidence ≥ MIN_PLAN_CONFIDENCE
      //
      // Stale plans (> PLAN_MAX_AGE_MS) are silently ignored. Market structure
      // from yesterday describes yesterday, not today.
      //
      // No plan at all → gate is OPEN. Plans are informational, never mandatory.

      // Efficiency gate: if there is already a position, the plan gate is
      // irrelevant — skip the DB query entirely.
      if (!result.positionFlat) {
        result.planGateOk = null;
        // Jump to verdict — position block already covers everything.
        result.allowed = false;
        return result;
      }

      const [latestPlan] = await db
        .select()
        .from(tradePlansTable)
        .where(and(
          eq(tradePlansTable.symbol, symbol),
          isNull(tradePlansTable.consumedAt),
        ))
        .orderBy(desc(tradePlansTable.createdAt))
        .limit(1);

      if (latestPlan) {
        const planAgeMs = Date.now() - new Date(latestPlan.createdAt).getTime();

        // Always capture plan metadata for log visibility even if stale
        result.planLikelyAction    = latestPlan.likelyAction;
        result.planConfidenceLevel = latestPlan.confidenceLevel;
        result.planAgreementScore  = latestPlan.agreementScore;
        result.planReturnToZoneNote = latestPlan.returnToZoneNote;

        if (planAgeMs > PLAN_MAX_AGE_MS) {
          // Stale plan — market structure has changed, treat as no plan
          result.planGateOk = null;
          logger.debug(
            {
              planId: latestPlan.id,
              ageHours: (planAgeMs / 3_600_000).toFixed(1),
              action: latestPlan.likelyAction,
            },
            "Plan gate: stale plan, gate open",
          );
        } else if (latestPlan.likelyAction === "stand-down") {
          // Hard block — image directly contradicts the entry
          result.planGateOk = false;
          result.blockReasons.push(
            `Plan: STAND DOWN — ${latestPlan.riskNote ?? "chart structure contradicts entry here"}`,
          );

        } else if (latestPlan.likelyAction === "wait") {
          // ── Smart wait resolution ─────────────────────────────────────────
          // If the AI said "wait for a pullback", check whether that pullback
          // has already happened using the price at upload time as the anchor.
          const priceAtUpload = latestPlan.priceAtUpload != null
            ? parseFloat(String(latestPlan.priceAtUpload))
            : null;
          const retracePct = latestPlan.returnToZonePct != null
            ? parseFloat(String(latestPlan.returnToZonePct))
            : null;
          const planBias = latestPlan.detectedBias ?? null;

          const retraceProgress = (priceAtUpload && retracePct && planBias && livePrice)
            ? computeRetraceProgress(priceAtUpload, livePrice, retracePct, planBias)
            : null;

          const waitResolved = retraceProgress !== null && retraceProgress >= WAIT_RESOLVE_THRESHOLD;

          if (waitResolved) {
            // Retrace has occurred — promote to an enter check
            logger.info(
              {
                planId: latestPlan.id,
                priceAtUpload,
                livePrice,
                retraceProgress: retraceProgress?.toFixed(2),
                retracePct,
                planBias,
              },
              "Plan gate: WAIT auto-resolved — price has reached the return zone",
            );
            const confidence = latestPlan.confidenceLevel ?? 100;
            if (confidence >= MIN_PLAN_CONFIDENCE) {
              result.planGateOk = true;
              result.planReturnToZoneNote = `↓ RESOLVED: ${latestPlan.returnToZoneNote ?? "return zone reached"}`;
            } else {
              result.planGateOk = false;
              result.blockReasons.push(
                `Plan: wait resolved but confidence ${confidence}% below ${MIN_PLAN_CONFIDENCE}%`,
              );
            }
          } else {
            // Still waiting — report how far the retrace has progressed
            result.planGateOk = false;
            const progressNote = retraceProgress != null
              ? ` (${(retraceProgress * 100).toFixed(0)}% of expected retrace complete)`
              : "";
            result.blockReasons.push(
              `Plan: WAIT — ${latestPlan.returnToZoneNote ?? "awaiting return to a better zone"}${progressNote}`,
            );
          }

        } else if (latestPlan.likelyAction === "probe") {
          // ── Probe / "toss a dwarf" ────────────────────────────────────────
          // The oracle sees price near a key level with mixed structure — the
          // level hasn't confirmed which way it'll break yet. The Oracle Method
          // recommends a manual probe: a tiny position (~20% of normal size) to
          // discover whether the level holds. Auto-entry NEVER fires on a probe
          // because the defining feature of a dwarf toss is deliberate manual
          // sizing — the operator must consciously choose to risk a small amount.
          result.planGateOk = false;
          result.blockReasons.push(
            "Plan: PROBE — Oracle recommends a manual dwarf position to test the level. " +
            "Auto-entry blocked: probe positions must be sized down manually (~20%). " +
            (latestPlan.entryZoneNote ? `Zone: ${latestPlan.entryZoneNote}` : ""),
          );

        } else {
          // likelyAction === "enter" — confidence gate
          const confidence = latestPlan.confidenceLevel ?? 100;
          if (confidence < MIN_PLAN_CONFIDENCE) {
            result.planGateOk = false;
            result.blockReasons.push(
              `Plan confidence ${confidence}% below minimum ${MIN_PLAN_CONFIDENCE}% — image is too ambiguous to trade on`,
            );
          } else {
            result.planGateOk = true;

            // High-conviction composite: both vision and edge score strongly agree
            const edgeScore = result.edgeScore ?? 0;
            if (confidence >= 70 && edgeScore >= 75) {
              logger.info(
                { planId: latestPlan.id, confidence, edgeScore, symbol },
                "Plan gate: HIGH CONVICTION — image confidence ≥70 AND edge ≥75 both aligned",
              );
            } else {
              logger.debug(
                { planId: latestPlan.id, confidence, edgeScore },
                "Plan gate: pass",
              );
            }
          }
        }
      } else {
        // No plan uploaded — gate is open (plans are informational, not mandatory)
        result.planGateOk = null;
      }

      // ── 7.3. Wave phase gate — do not enter an exhausted move ──────────────
      // The oracle catches the resumption BEFORE the large candle becomes
      // obvious. When the HA 3m wave is already 'extended' (5+ bars in the same
      // direction without a reset), the best entry opportunity has passed.
      // Better to wait for a controlled pullback and a fresh resumption than
      // to chase an already-expanded wave where risk/reward is worst.
      //
      // This gate is silent during 'pullback' — the oracle already handles that
      // via the counter-move penalty in the oracle score. It only fires when the
      // move is undeniably extended, which the oracle score alone may not catch.
      let wavePhaseOk = true;
      const wavePhase = structCtx.wavePhase;
      if (wavePhase === "extended") {
        wavePhaseOk = false;
        const barCount = structCtx.wave2Length > 0 ? structCtx.wave2Length : structCtx.wave1Length;
        result.blockReasons.push(
          `Wave extended — ${barCount} consecutive HA bars without a reset. ` +
          `Oracle waits for a controlled pullback and fresh resumption before committing. ` +
          `Entering here means chasing the obvious candle, not catching the restart.`,
        );
      }

      // ── 7.5. Pattern memory gate + post-win humility ────────────────────────
      //
      // When enough trade history exists (≥5 fingerprints), the oracle compares
      // the live setup to all historical fingerprints. A very low similarity score
      // means the current setup resembles no proven pattern — the oracle doesn't
      // recognise this territory and stands aside.
      //
      // Post-win humility: after a strong gain (≥30% ROI) the oracle temporarily
      // requires a higher oracle score, preventing overconfidence from a
      // profitable trade creating a reckless follow-up.
      let patternGateOk = true;
      const fpc = structCtx.fingerprintConfidence;
      if (fpc !== null && structCtx.fingerprintSampleCount >= 5 && fpc < 28) {
        patternGateOk = false;
        result.blockReasons.push(
          `Pattern memory (${structCtx.fingerprintSampleCount} trades): similarity ${fpc}/100 is too low — ` +
          `the oracle doesn't recognise this setup type. Waiting for familiar territory before committing.`,
        );
      }
      if (structCtx.postWinHumility) {
        const effectiveMin = minEdge + 8;
        const score = result.edgeScore ?? 0;
        if (score < effectiveMin) {
          patternGateOk = false;
          result.blockReasons.push(
            `Post-win caution — oracle needs ${effectiveMin} to enter after a strong recent gain ` +
            `(normal threshold ${minEdge} + 8 humility). ` +
            `Current score: ${score}/100. ${structCtx.postWinMinutesLeft}m of caution remaining.`,
          );
        }
      }

      // ── Verdict ─────────────────────────────────────────────────────────────
      // planGateOk === null    → no plan or stale plan, gate open
      // planGateOk === true    → plan says enter (or wait resolved), gate passes
      // planGateOk === false   → plan actively blocks entry
      // wholeNumberDirectionOk === null  → proximity failed or side unresolved;
      //   proximity already blocks in that case, so treat null as non-blocking
      //   here (the proximity check in the condition covers it).
      result.allowed =
        result.positionFlat &&
        result.timeWindowOk &&
        result.avoidMiddlesOk &&
        result.wholeNumberProximityOk &&          // was evaluated but never actually gated — fixed
        wholeNumberDirectionOk !== false &&       // correct side of the level (null = pass-through)
        result.edgeOk &&
        result.liqGapOk &&
        (side === "LONG" || side === "SHORT") &&
        result.planGateOk !== false &&
        patternGateOk &&                          // fingerprint confidence + post-win humility
        wavePhaseOk;                              // wave not extended — catch resumption, not the chase

      // ── 8. Open position if all checks pass ────────────────────────────────
      if (result.allowed && livePrice) {
        await this.openPosition(result, config, symbol, side, livePrice, maxMargin, leverage);
      }
    } catch (err) {
      result.errorMessage = String(err);
      result.allowed = false;
      result.blockReasons.push(`Evaluation error: ${String(err)}`);
      logger.error({ err, symbol }, "Auto-entry evaluation error");
    }

    return result;
  }

  // ── Private: position opening + safeguard arming ───────────────────────────

  private async openPosition(
    result: EvalResult,
    config: typeof autoEntryConfigTable.$inferSelect,
    symbol: string,
    side: string,
    livePrice: number,
    maxMargin: number,
    leverage: number,
  ) {
    // qty in base-asset units: margin * leverage / price
    const rawQty = (maxMargin * leverage) / livePrice;
    const qty = roundQty(rawQty);

    if (qty <= 0) {
      result.blockReasons.push("Computed qty is zero — increase max margin");
      result.allowed = false;
      return;
    }

    // Bitunix uses BUY/SELL for order side
    const bitunixSide = side === "LONG" ? "BUY" : "SELL";

    logger.info(
      { symbol, side, qty, livePrice, leverage, margin: maxMargin },
      "Auto-entry: opening position",
    );

    const orderResp = await bitunixPost("/api/v1/futures/trade/place_order", {
      symbol,
      side: bitunixSide,
      qty: String(qty),
      orderType: "MARKET",
      tradeSide: "OPEN",
    });

    if (orderResp.code !== 0) {
      result.errorMessage = `Order rejected: ${orderResp.msg}`;
      result.entryOpened = false;
      logger.warn({ symbol, msg: orderResp.msg }, "Auto-entry order rejected");

      await db.insert(eventLogTable).values({
        symbol,
        eventType: "auto_entry_rejected",
        eventMessage: `[AUTO] Order rejected: ${orderResp.msg}`,
        source: "auto_entry",
      });
      return;
    }

    result.entryOpened = true;
    result.entrySymbol = symbol;
    result.entrySide = side;
    result.entryQty = qty;
    result.marginUsed = maxMargin;

    await db.insert(eventLogTable).values({
      symbol,
      eventType: "auto_entry_opened",
      eventMessage: `[AUTO] Opened ${side} ${qty} ${symbol} @ ~${livePrice.toFixed(2)} · margin ~$${maxMargin}`,
      source: "auto_entry",
    });

    // Post-entry cooldown: 5 minutes to let the position register properly
    this.cooldownUntil = Date.now() + 5 * 60 * 1000;

    // Poll for the actual position to get entry price + positionId
    const actualPosition = await this.pollForPosition(symbol, 10, side);

    const entryPrice = actualPosition
      ? parseFloat(actualPosition.avgOpenPrice ?? actualPosition.entryPrice ?? actualPosition.openPrice ?? String(livePrice))
      : livePrice;
    const positionId = actualPosition?.positionId ?? null;

    result.entryPrice = entryPrice;
    result.positionId = positionId;

    // Record entry context immediately so the tradeId is available to whichever
    // close path fires (safeguard, trigger, or manual). The position scanner
    // would detect this position in ≤60 s, but recording it now means the tradeId
    // is guaranteed to be present before the safeguard is even armed.
    if (positionId) {
      try {
        const lev = actualPosition?.leverage ?? leverage;
        const ctx = await positionTracker.buildContext(
          positionId, symbol, side, lev, entryPrice, "auto_entry",
        );
        await positionTracker.recordOpen(ctx);
      } catch (err) {
        logger.warn({ err, positionId }, "Auto-entry: failed to record position tracker context");
      }
    }

    // Auto-arm safeguard
    if (config.autoArmSafeguard) {
      const liveQty = Number(actualPosition?.qty);
      const liveLeverage = Number(actualPosition?.leverage);
      await this.armSafeguard(
        result,
        symbol,
        side,
        entryPrice,
        Number.isFinite(liveQty) && liveQty > 0 ? liveQty : qty,
        Number.isFinite(liveLeverage) && liveLeverage > 0 ? Math.round(liveLeverage) : leverage,
        positionId,
        config,
      );
    }
  }

  private async pollForPosition(
    symbol: string,
    maxAttempts: number,
    expectedSide: string,
  ): Promise<PositionItem | null> {
    const expectedDirection = toPositionDirection(expectedSide);
    if (!expectedDirection) return null;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const resp = await bitunixGet<PositionItem[]>(
          "/api/v1/futures/position/get_pending_positions",
          { symbol },
        );
        const list = Array.isArray(resp.data) ? resp.data : [];
        const matchingPosition = list.find(
          (position) => toPositionDirection(position.side) === expectedDirection,
        );
        if (matchingPosition) return matchingPosition;
      } catch (_) {}
    }
    return null;
  }

  private async armSafeguard(
    result: EvalResult,
    symbol: string,
    side: string,
    entryPrice: number,
    qty: number,
    leverage: number,
    positionId: string | null,
    config: typeof autoEntryConfigTable.$inferSelect,
  ) {
    try {
      if (!positionId) {
        result.safeguardArmed = false;
        logger.error({ symbol }, "Auto-entry safeguard not armed: Bitunix position id was not found");
        await db.insert(eventLogTable).values({
          symbol,
          eventType: "auto_entry_safeguard_failed",
          eventMessage: `[AUTO] Safeguard not armed for ${symbol}: Bitunix did not return a position id. Arm it manually from the open positions list.`,
          source: "auto_entry",
        });
        return;
      }
      const threshold1 = parseFloat(String(config.safeguardThreshold1Pct));
      const trailStep  = parseFloat(String(config.safeguardTrailPct));

      const [row] = await db
        .insert(safeguardsTable)
        .values({
          symbol,
          side,
          entryPrice: String(entryPrice),
          qty: String(qty),
          leverage,
          positionId,
          threshold1Pct: String(threshold1),
          threshold2Pct: String(threshold1 + 6),
          trailStepPct: String(trailStep),
          closeMethod: "flash_close",
          state: "armed",
        })
        .returning();

      safeguardManager.arm(row);

      await db.insert(eventLogTable).values({
        symbol,
        eventType: "auto_entry_safeguard_armed",
        eventMessage: `[AUTO] Safeguard armed for ${symbol} ${side} @ ${entryPrice.toFixed(2)} (t1=${threshold1}%, trail=${trailStep}%)`,
        source: "auto_entry",
      });

      result.safeguardArmed = true;
      result.safeguardId = row.id;

      logger.info(
        { safeguardId: row.id, symbol, side, entryPrice, threshold1, trailStep },
        "Auto-entry safeguard armed",
      );
    } catch (err) {
      logger.error({ err }, "Auto-entry safeguard arm failed");
      result.errorMessage = (result.errorMessage ? result.errorMessage + "; " : "") +
        `Safeguard arm failed: ${String(err)}`;
    }
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

export const autoEntryWatcher = new AutoEntryWatcher();

// ── Startup restore ───────────────────────────────────────────────────────────

export async function initAutoEntryWatcher(): Promise<void> {
  // Ensure exactly one config row exists (upsert-style)
  const existing = await db.select().from(autoEntryConfigTable).limit(1);
  if (existing.length === 0) {
    await db.insert(autoEntryConfigTable).values({
      enabled: false,
      symbol: "BTCUSDT",
      side: "SIGNAL",
      maxMarginUsdt: "500",
      leverage: 50,
      minLiqGapUsdt: "3000",
      minEdgeScore: 65,
      avoidMiddles: true,
      // Pre-block the witching hour by default — safest option
      blockedWindowsJson: [
        { label: "Witching Hour", startHour: 1, startMin: 0, endHour: 4, endMin: 0 },
      ],
      allowedWindowsJson: null,
      autoArmSafeguard: true,
      safeguardThreshold1Pct: "17",
      safeguardTrailPct: "3",
    });
    logger.info("Auto-entry config initialised with defaults");
  }

  autoEntryWatcher.start();
  logger.info("Auto-entry watcher initialised");
}

// ── Log helpers for routes ────────────────────────────────────────────────────

export async function getRecentAutoEntryLog(limit = 20) {
  return db
    .select()
    .from(autoEntryLogTable)
    .orderBy(desc(autoEntryLogTable.createdAt))
    .limit(limit);
}
