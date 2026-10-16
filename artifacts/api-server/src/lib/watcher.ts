import { randomUUID } from "node:crypto";
import { db } from "./db";
import { triggersTable, eventLogTable, tradeJournalTable, tradePlansTable, tradeEventsTable } from "@workspace/db/schema";
import { positionTracker } from "./positionTracker";
import { eq, desc } from "drizzle-orm";
import { bitunixPost, bitunixGet } from "./bitunix";
import { logger } from "./logger";
import type { Trigger } from "@workspace/db/schema";
import { priceStream } from "./priceStream";
import { notifyPostClose } from "./postCloseNotifier";
import {
  getStructureContext,
  htfAlignmentLabel,
  patienceLabel,
} from "./signalScore";
import { safeguardManager } from "./safeguardWatcher";

type WatcherState =
  | "draft"
  | "armed"
  | "watching"
  | "triggered"
  | "closing"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

interface ActiveWatcher {
  trigger: Trigger;
  fired: boolean;
  armedAt: Date;
  listener: (symbol: string, price: number) => void;
  // Momentum-gate absorption: when a protecting safeguard absorbs a trigger touch,
  // the trigger is suppressed for a short window (3 min) to prevent thrashing.
  // Only one absorption is granted per trigger arm (absorptionCount tracks this).
  suppressedUntil: number | null;
  absorptionCount: number;
}

interface PositionItem {
  positionId: string;
  symbol: string;
  side?: string;
  entryPrice?: string;
  leverage?: string;
}

async function logEvent(symbol: string | null, type: string, message: string) {
  try {
    await db.insert(eventLogTable).values({
      symbol,
      eventType: type,
      eventMessage: message,
      source: "watcher",
    });
  } catch (_) {}
}

async function updateTriggerStatus(id: number, status: WatcherState, extra: Partial<Trigger> = {}) {
  await db
    .update(triggersTable)
    .set({ watcherStatus: status, updatedAt: new Date(), ...extra })
    .where(eq(triggersTable.id, id));
}

async function pollFlat(symbol: string, positionId?: string, attempts = 6): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const data = await bitunixGet<PositionItem[]>("/api/v1/futures/position/get_pending_positions", { symbol });
      const list = Array.isArray(data.data) ? data.data : [];
      if (positionId) {
        if (!list.find((p) => p.positionId === positionId)) return true;
      } else {
        if (list.length === 0) return true;
      }
    } catch (_) {}
  }
  return false;
}

// Deterministic verdict for trigger-based exits
function triggerVerdict(exitRoiPct: number | null): string {
  if (exitRoiPct == null) return "Trigger fired as configured.";
  if (exitRoiPct >= 15) return "Strong exit: original trigger fired at a healthy profit level.";
  if (exitRoiPct >= 5) return "Clean exit: original trigger worked well.";
  if (exitRoiPct >= 0) return "Exit completed at the trigger level with modest gain.";
  if (exitRoiPct >= -5) return "Trigger fired at a small loss — within acceptable range.";
  return "Trigger fired in loss territory — review trigger placement.";
}

// Read-only plan snapshot for journal context — does NOT claim/consume the plan
async function fetchLatestPlan(symbol: string) {
  try {
    const rows = await db
      .select()
      .from(tradePlansTable)
      .where(eq(tradePlansTable.symbol, symbol))
      .orderBy(desc(tradePlansTable.createdAt))
      .limit(1);
    return rows[0] ?? null;
  } catch (_) {
    return null;
  }
}

function computeOutcomeVsPlan(
  plan: typeof tradePlansTable.$inferSelect | null,
  exitRoiPct: number | null,
): string | null {
  if (!plan || plan.agreementScore == null || exitRoiPct == null) return null;
  const agreement = Number(plan.agreementScore);
  if (exitRoiPct <= 0 && agreement >= 25) return "rejected";
  if (exitRoiPct > 0 && agreement >= 25) return "confirmed";
  if (exitRoiPct > 0) return "partial";
  return "rejected";
}

class WatcherManager {
  private watchers = new Map<number, ActiveWatcher>();

  arm(trigger: Trigger) {
    if (this.watchers.has(trigger.id)) {
      this.disarm(trigger.id);
    }

    const targetSymbol = trigger.symbol;
    const tp = parseFloat(String(trigger.triggerPrice));
    const watcher: ActiveWatcher = {
      trigger,
      fired: false,
      armedAt: new Date(),
      suppressedUntil: null,
      absorptionCount: 0,
      listener: (symbol: string, price: number) => {
        if (symbol !== targetSymbol || watcher.fired) return;

        // Skip if in a safeguard-absorption suppression window
        if (watcher.suppressedUntil != null && Date.now() < watcher.suppressedUntil) return;

        const shouldFire =
          trigger.direction === "cross_above" ? price >= tp : price <= tp;
        if (!shouldFire) return;

        // ── Momentum gate: ask the safeguard manager whether to absorb ───────
        // If a protecting safeguard is active and momentum is intact, the trigger
        // touch is suppressed for 3 minutes. Only one absorption is granted per
        // trigger arm — after that, any cross fires the trigger unconditionally.
        if (watcher.absorptionCount === 0) {
          const absorbed = safeguardManager.handleTriggerTouch(targetSymbol, price);
          if (absorbed) {
            watcher.absorptionCount++;
            watcher.suppressedUntil = Date.now() + 3 * 60_000; // 3-min suppression
            // Do NOT set watcher.fired — the trigger stays alive for the next cross
            return;
          }
        }

        watcher.fired = true;
        this.fire(watcher, price).catch((err) =>
          logger.error({ err }, "Watcher fire failed")
        );
      },
    };

    this.watchers.set(trigger.id, watcher);
    priceStream.subscribe(targetSymbol);
    priceStream.addListener(watcher.listener);

    updateTriggerStatus(trigger.id, "watching").catch(() => {});
    logEvent(targetSymbol, "watcher_connected",
      `[${targetSymbol}] trigger armed · ${trigger.direction === "cross_above" ? "↑" : "↓"} ${tp.toFixed(2)} · ${trigger.closeMethod}`
    ).catch(() => {});
    logger.info({ triggerId: trigger.id, symbol: trigger.symbol }, "Watcher armed");
  }

  disarm(id: number) {
    const w = this.watchers.get(id);
    if (!w) return;
    priceStream.removeListener(w.listener);
    priceStream.unsubscribe(w.trigger.symbol);
    this.watchers.delete(id);
    logger.info({ triggerId: id }, "Watcher disarmed");
  }

  private async fire(watcher: ActiveWatcher, price: number) {
    const t = watcher.trigger;
    const firedAt = Date.now();
    priceStream.removeListener(watcher.listener);
    priceStream.unsubscribe(t.symbol);

    const tp = parseFloat(String(t.triggerPrice));

    // ── Trigger-to-safeguard-floor conversion ─────────────────────────────────
    // When a profit safeguard is active on the same symbol, the trigger price
    // becomes the new protected-profit floor instead of hard-closing the trade.
    // The ratchet ladder then continues upward from that floor. The position
    // stays open — the safeguard now owns the exit decision from this level.
    // If no safeguard is active, fall through to the standard hard-close below.
    const convertedToFloor = safeguardManager.absorbTriggerAsFloor(t.symbol, tp);
    if (convertedToFloor) {
      await updateTriggerStatus(t.id, "completed", { completedAt: new Date(), armed: false });
      await logEvent(t.symbol, "trigger_converted_to_floor",
        `[${t.symbol}] trigger @ ${tp.toFixed(2)} crossed · floor set on safeguard ladder · position continues under protection`
      );
      logger.info({ triggerId: t.id, symbol: t.symbol, triggerPrice: tp }, "Trigger converted to safeguard floor — no hard close");
      this.watchers.delete(t.id);
      return;
    }

    // No active safeguard — standard hard close
    logger.info({ triggerId: t.id, price }, "Trigger fired");
    await updateTriggerStatus(t.id, "triggered", { triggeredAt: new Date() });
    await logEvent(t.symbol, "trigger_fired",
      `[${t.symbol}] trigger fired · price ${price.toFixed(2)} · target was ${tp.toFixed(2)} · ${t.closeMethod}`
    );

    // Fetch position data + context in parallel before closing
    let posEntry: number | null = null;
    let posLeverage = 1;
    let posSide = "LONG";
    let positionId: string | undefined;
    const positions: PositionItem[] = [];
    try {
      const posData = await bitunixGet<PositionItem[]>(
        "/api/v1/futures/position/get_pending_positions",
        { symbol: t.symbol }
      );
      const list = Array.isArray(posData.data) ? posData.data : [];
      positions.push(...list);
      if (list.length > 0) {
        posEntry = list[0].entryPrice ? parseFloat(list[0].entryPrice) : null;
        posLeverage = list[0].leverage ? parseInt(list[0].leverage) : 1;
        posSide = list[0].side || "LONG";
        positionId = list[0].positionId;
      }
    } catch (_) {}

    // Fetch structure context + plan snapshot in parallel (both are read-only/cached)
    const [structure, plan] = await Promise.all([
      Promise.resolve(getStructureContext(t.symbol)),
      fetchLatestPlan(t.symbol),
    ]);

    try {
      await updateTriggerStatus(t.id, "closing");
      if (t.closeMethod === "flash_close") {
        for (const pos of positions.length > 0 ? positions : [{ positionId: "", symbol: t.symbol }]) {
          if (pos.positionId) {
            await bitunixPost("/api/v1/futures/trade/flash_close_position", {
              symbol: t.symbol,
              positionId: pos.positionId,
            });
          }
        }
        if (positions.length === 0) {
          await bitunixPost("/api/v1/futures/trade/close_all_position", { symbol: t.symbol });
        }
      } else {
        await bitunixPost("/api/v1/futures/trade/close_all_position", { symbol: t.symbol });
      }

      await updateTriggerStatus(t.id, "verifying");
      const flat = await pollFlat(t.symbol, positionId);
      const executionLatencyMs = Date.now() - firedAt;

      // Compute ROI if we have position data
      let exitRoiPct: number | null = null;
      if (posEntry != null && posEntry > 0) {
        const priceDiff = posSide === "SHORT" ? posEntry - price : price - posEntry;
        exitRoiPct = (priceDiff / posEntry) * posLeverage * 100;
      }

      const holdDurationMs = Date.now() - watcher.armedAt.getTime();
      const verdict = triggerVerdict(exitRoiPct);
      const outcomeVsPlan = computeOutcomeVsPlan(plan, exitRoiPct);
      const fingerprint = [
        posSide,
        `${posLeverage}x`,
        "trigger",
        htfAlignmentLabel(structure),
      ].join(" · ");

      if (flat) {
        await updateTriggerStatus(t.id, "completed", { completedAt: new Date(), armed: false });
        await logEvent(t.symbol, "trigger_completed",
          `[${t.symbol}] position flat · price ${price.toFixed(2)} · latency ${executionLatencyMs}ms`
        );
        notifyPostClose(t.symbol, "trigger");
      } else {
        await updateTriggerStatus(t.id, "failed", { lastError: "Position still open after close attempts", armed: false });
        await logEvent(t.symbol, "trigger_failed",
          `[${t.symbol}] position not flat after trigger close`
        );
      }

      // Resolve canonical trade identity from the position tracker.
      const entryCtx      = positionTracker.getContext(positionId ?? "");
      const tradeId       = entryCtx?.tradeId ?? randomUUID();
      const openedBy      = entryCtx?.source ?? null;
      const dataConfidence = entryCtx ? "full" : "inferred";

      // Write journal record — now includes structure snapshot + plan snapshot
      await db.insert(tradeJournalTable).values({
        tradeId,
        openedBy,
        dataConfidence,
        symbol: t.symbol,
        side: posSide,
        leverage: posLeverage,
        positionId: positionId ?? null,
        entryPrice: posEntry != null ? String(posEntry) : null,
        exitPrice: String(price),
        armedAt: watcher.armedAt,
        exitAt: new Date(),
        holdDurationMs,
        // MFE/MAE not tracked for trigger exits (no live price listener during the trade)
        mfePct: null,
        maePct: null,
        peakRoiPct: exitRoiPct != null ? String(exitRoiPct) : null,
        protectedRoiPct: null,
        exitRoiPct: exitRoiPct != null ? String(exitRoiPct) : null,
        // Giveback requires MFE baseline — unavailable without a live listener
        givebackPct: null,
        givebackRating: null,
        nearMiss: false,
        safeguardUsed: false,
        ratchetCount: 0,
        threshold1Pct: null,
        exitReason: "original_trigger",
        closeMethod: t.closeMethod,
        executionLatencyMs,
        verdict,
        setupFingerprint: fingerprint,
        // ── Market-structure snapshot at fire time ─────────────────────────
        htfAlignment:      htfAlignmentLabel(structure),
        threeMinLead:      structure.threeMinLeads ?? false,
        fifteenMinConfirm: structure.fifteenMinConfirms ?? false,
        fourBarStreak:     structure.fourBarStreak ?? 0,
        pivotState:        structure.pivotState ?? null,
        velocityState:     structure.velocityState ?? null,
        counterMove:       structure.counterMove ?? false,
        resumption:        structure.resumption ?? false,
        patienceBoost:     structure.patienceBoost ?? 0,
        trailWidth:           structure.trailWidth != null ? String(structure.trailWidth) : null,
        signalScore:          String(structure.signalScore),
        patienceLevel:        patienceLabel(structure.signalScore),
        wholeNumberPlayType:  structure.wholeNumberPlayType ?? null,
        // ── Pre-trade plan snapshot (read-only — not consumed) ─────────────
        tradePlanId:               plan?.id ?? null,
        uploadUsed:                plan != null,
        uploadKey:                 plan?.uploadKey ?? null,
        channelZoneAtPlan:         plan?.channelZone ?? null,
        userBiasAtPlan:            plan?.userBias ?? null,
        agreementScoreAtPlan:      plan?.agreementScore ?? null,
        continuationProbAtPlan:    plan?.continuationProbPct ?? null,
        recommendedPatienceAtPlan: plan?.recommendedPatience ?? null,
        outcomeVsPlan,
        // ──────────────────────────────────────────────────────────────────
        sourceType: "trigger",
        sourceId: t.id,
      }).catch((err) => logger.error({ err }, "Failed to write trigger journal"));

      // Append trigger_close event to the unified trade event stream
      db.insert(tradeEventsTable).values({
        tradeId,
        symbol:    t.symbol,
        eventType: "trigger_close",
        source:    "trigger",
        price:     String(price),
        roiPct:    exitRoiPct != null ? String(exitRoiPct) : null,
        payload:   JSON.stringify({ triggerId: t.id, direction: t.direction, executionLatencyMs }),
      }).catch(() => {});

    } catch (err) {
      await updateTriggerStatus(t.id, "failed", { lastError: String(err), armed: false });
      await logEvent(t.symbol, "trigger_error",
        `[${t.symbol}] trigger close error: ${String(err)}`
      );
    }

    this.watchers.delete(t.id);
  }
}

export const watcherManager = new WatcherManager();

export async function restoreArmedWatchers() {
  try {
    const armed = await db
      .select()
      .from(triggersTable)
      .where(eq(triggersTable.armed, true));
    for (const t of armed) {
      if (t.watcherStatus === "completed" || t.watcherStatus === "failed") continue;
      logger.info({ triggerId: t.id }, "Restoring armed watcher after restart");
      watcherManager.arm(t);
    }
  } catch (err) {
    logger.error({ err }, "Failed to restore armed watchers");
  }
}
