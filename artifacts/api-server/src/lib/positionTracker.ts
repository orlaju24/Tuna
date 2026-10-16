/**
 * Position Tracker
 *
 * Maintains an in-memory + DB-backed record of oracle context captured the
 * moment each Bitunix position is first detected or opened.  Keyed by
 * Bitunix's positionId string.
 *
 * Purpose
 * ───────
 * When a position closes (manual flash, close-all, trigger, safeguard) the
 * close handler can call getContext(positionId) to retrieve:
 *   • entry price at the moment Bitunix filled the order
 *   • openedAt timestamp  →  holdDurationMs is now computable
 *   • oracle score and full structure snapshot AT ENTRY (not at close)
 *   • pre-trade plan snapshot linked at the time of entry
 *
 * This makes every journal record — regardless of who initiated the trade —
 * carry accurate, entry-time data instead of stale close-time approximations.
 *
 * External position scanner
 * ─────────────────────────
 * Every 60 s the tracker polls Bitunix for open positions on the configured
 * symbol.  Any position whose positionId is not already in the map is treated
 * as externally opened (e.g. directly on the exchange) and a minimal entry
 * context is captured immediately so the close path still has useful data.
 */

import { randomUUID } from "node:crypto";
import { db } from "./db";
import { positionEntryLogTable, tradePlansTable, tradeEventsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";
import { computeEdgeScore } from "./edgeScore";
import { getStructureContext, htfAlignmentLabel, patienceLabel } from "./signalScore";
import { bitunixGet } from "./bitunix";
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PositionEntryContext {
  positionId: string;
  /** UUID generated at open time — the canonical anchor for this trade across all paths. */
  tradeId: string;
  symbol: string;
  side: string;
  leverage: number;
  entryPrice: number | null;
  openedAt: Date;
  // Oracle context at entry
  edgeScore: number;
  walletSizeScore: number;
  wholeNumberPlayType: string | null;
  signalScore: number;
  htfAlignment: string;
  patienceLevel: string;
  // Structure snapshot at entry
  threeMinLead: boolean;
  fifteenMinConfirm: boolean;
  fourBarStreak: number;
  pivotState: string | null;
  velocityState: string | null;
  counterMove: boolean;
  resumption: boolean;
  patienceBoost: number;
  trailWidth: number | null;
  // Plan at entry
  tradePlanId: number | null;
  uploadUsed: boolean;
  uploadKey: string | null;
  channelZoneAtPlan: string | null;
  userBiasAtPlan: string | null;
  agreementScoreAtPlan: number | null;
  continuationProbAtPlan: number | null;
  recommendedPatienceAtPlan: string | null;
  source: "app_open" | "auto_entry" | "detected";
}

interface BitunixPositionItem {
  positionId: string;
  symbol?: string;
  side?: string;
  entryPrice?: string;
  openPrice?: string;
  leverage?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchWallet(): Promise<{ available: number; positionMargin: number }> {
  try {
    const resp = await bitunixGet<{ available: string; margin: string }>(
      "/api/v1/futures/account",
      { marginCoin: "USDT" },
    );
    return {
      available:      parseFloat(resp.data.available ?? "0") || 0,
      positionMargin: parseFloat(resp.data.margin      ?? "0") || 0,
    };
  } catch (_) {
    return { available: 0, positionMargin: 0 };
  }
}

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

// ── Singleton ─────────────────────────────────────────────────────────────────

class PositionTracker {
  private contexts = new Map<string, PositionEntryContext>();
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private scanSymbol = "BTCUSDT";

  // ── Startup restore ────────────────────────────────────────────────────────

  async restore() {
    try {
      const rows = await db.select().from(positionEntryLogTable);
      for (const row of rows) {
        this.contexts.set(row.positionId, this.rowToContext(row));
      }
      logger.info({ count: this.contexts.size }, "Position entry log restored");
    } catch (err) {
      logger.error({ err }, "Failed to restore position entry log");
    }
  }

  private rowToContext(row: typeof positionEntryLogTable.$inferSelect): PositionEntryContext {
    return {
      positionId:               row.positionId,
      tradeId:                  row.tradeId ?? randomUUID(),
      symbol:                   row.symbol,
      side:                     row.side,
      leverage:                 row.leverage,
      entryPrice:               row.entryPrice != null ? parseFloat(String(row.entryPrice)) : null,
      openedAt:                 row.openedAt,
      edgeScore:                row.edgeScore ?? 0,
      walletSizeScore:          row.walletSizeScore ?? 0,
      wholeNumberPlayType:      row.wholeNumberPlayType ?? null,
      signalScore:              row.signalScore != null ? parseFloat(String(row.signalScore)) : 0,
      htfAlignment:             row.htfAlignment ?? "mixed",
      patienceLevel:            row.patienceLevel ?? "standard",
      threeMinLead:             row.threeMinLead ?? false,
      fifteenMinConfirm:        row.fifteenMinConfirm ?? false,
      fourBarStreak:            row.fourBarStreak ?? 0,
      pivotState:               row.pivotState ?? null,
      velocityState:            row.velocityState ?? null,
      counterMove:              row.counterMove ?? false,
      resumption:               row.resumption ?? false,
      patienceBoost:            row.patienceBoost ?? 0,
      trailWidth:               row.trailWidth != null ? parseFloat(String(row.trailWidth)) : null,
      tradePlanId:              row.tradePlanId ?? null,
      uploadUsed:               row.uploadUsed ?? false,
      uploadKey:                row.uploadKey ?? null,
      channelZoneAtPlan:        row.channelZoneAtPlan ?? null,
      userBiasAtPlan:           row.userBiasAtPlan ?? null,
      agreementScoreAtPlan:     row.agreementScoreAtPlan ?? null,
      continuationProbAtPlan:   row.continuationProbAtPlan ?? null,
      recommendedPatienceAtPlan: row.recommendedPatienceAtPlan ?? null,
      source:                   (row.source as PositionEntryContext["source"]) ?? "detected",
    };
  }

  // ── Context API ───────────────────────────────────────────────────────────

  /** Read context without removing it (safe for safeguard / trigger paths). */
  getContext(positionId: string): PositionEntryContext | undefined {
    return this.contexts.get(positionId);
  }

  /**
   * Read and REMOVE context.  Call this from the manual close path so the
   * entry log row is cleaned up after the journal record is written.
   * Safeguard / trigger paths should use getContext() since they manage their
   * own lifecycle.
   */
  consumeContext(positionId: string): PositionEntryContext | undefined {
    const ctx = this.contexts.get(positionId);
    if (ctx) {
      this.contexts.delete(positionId);
      db.delete(positionEntryLogTable)
        .where(eq(positionEntryLogTable.positionId, positionId))
        .catch((err) => logger.error({ err }, "Failed to delete position entry log row"));
    }
    return ctx;
  }

  /** Record a new position open.  Idempotent — safe to call multiple times for the same ID. */
  async recordOpen(ctx: PositionEntryContext) {
    if (this.contexts.has(ctx.positionId)) return; // already tracked
    this.contexts.set(ctx.positionId, ctx);
    try {
      await db.insert(positionEntryLogTable).values({
        positionId:               ctx.positionId,
        tradeId:                  ctx.tradeId,
        symbol:                   ctx.symbol,
        side:                     ctx.side,
        leverage:                 ctx.leverage,
        entryPrice:               ctx.entryPrice != null ? String(ctx.entryPrice) : null,
        openedAt:                 ctx.openedAt,
        edgeScore:                ctx.edgeScore,
        walletSizeScore:          ctx.walletSizeScore,
        wholeNumberPlayType:      ctx.wholeNumberPlayType,
        signalScore:              String(ctx.signalScore),
        htfAlignment:             ctx.htfAlignment,
        patienceLevel:            ctx.patienceLevel,
        threeMinLead:             ctx.threeMinLead,
        fifteenMinConfirm:        ctx.fifteenMinConfirm,
        fourBarStreak:            ctx.fourBarStreak,
        pivotState:               ctx.pivotState,
        velocityState:            ctx.velocityState,
        counterMove:              ctx.counterMove,
        resumption:               ctx.resumption,
        patienceBoost:            ctx.patienceBoost,
        trailWidth:               ctx.trailWidth != null ? String(ctx.trailWidth) : null,
        tradePlanId:              ctx.tradePlanId,
        uploadUsed:               ctx.uploadUsed,
        uploadKey:                ctx.uploadKey,
        channelZoneAtPlan:        ctx.channelZoneAtPlan,
        userBiasAtPlan:           ctx.userBiasAtPlan,
        agreementScoreAtPlan:     ctx.agreementScoreAtPlan,
        continuationProbAtPlan:   ctx.continuationProbAtPlan,
        recommendedPatienceAtPlan: ctx.recommendedPatienceAtPlan,
        source:                   ctx.source,
      });
      // Emit position_opened event to the unified trade event stream
      await db.insert(tradeEventsTable).values({
        tradeId:   ctx.tradeId,
        symbol:    ctx.symbol,
        eventType: "position_opened",
        source:    ctx.source === "auto_entry" ? "auto" : ctx.source === "app_open" ? "manual" : "system",
        price:     ctx.entryPrice != null ? String(ctx.entryPrice) : null,
        payload:   JSON.stringify({ positionId: ctx.positionId, leverage: ctx.leverage, side: ctx.side, edgeScore: ctx.edgeScore }),
      });
    } catch (err) {
      logger.error({ err, positionId: ctx.positionId }, "Failed to persist position entry log");
    }
  }

  // ── Build a context from live market data ─────────────────────────────────

  async buildContext(
    positionId: string,
    symbol: string,
    side: string,
    leverage: number,
    entryPrice: number | null,
    source: PositionEntryContext["source"],
  ): Promise<PositionEntryContext> {
    const s = getStructureContext(symbol);
    const [wallet, plan] = await Promise.all([fetchWallet(), fetchLatestPlan(symbol)]);
    const edgeCtx = computeEdgeScore(s, wallet);
    return {
      positionId,
      tradeId:    randomUUID(),
      symbol,
      side,
      leverage,
      entryPrice,
      openedAt: new Date(),
      edgeScore:          edgeCtx.edgeScore,
      walletSizeScore:    edgeCtx.components.walletReadiness.score,
      wholeNumberPlayType: s.wholeNumberPlayType ?? null,
      signalScore:        s.signalScore,
      htfAlignment:       htfAlignmentLabel(s),
      patienceLevel:      patienceLabel(s.signalScore),
      threeMinLead:       s.threeMinLeads ?? false,
      fifteenMinConfirm:  s.fifteenMinConfirms ?? false,
      fourBarStreak:      s.fourBarStreak ?? 0,
      pivotState:         s.pivotState ?? null,
      velocityState:      s.velocityState ?? null,
      counterMove:        s.counterMove ?? false,
      resumption:         s.resumption ?? false,
      patienceBoost:      s.patienceBoost ?? 0,
      trailWidth:         s.trailWidth ?? null,
      tradePlanId:        plan?.id ?? null,
      uploadUsed:         plan != null,
      uploadKey:          plan?.uploadKey ?? null,
      channelZoneAtPlan:  plan?.channelZone ?? null,
      userBiasAtPlan:     plan?.userBias ?? null,
      agreementScoreAtPlan:      plan?.agreementScore ?? null,
      continuationProbAtPlan:    plan?.continuationProbPct ?? null,
      recommendedPatienceAtPlan: plan?.recommendedPatience ?? null,
      source,
    };
  }

  // ── External position scanner ─────────────────────────────────────────────

  startScanner(symbol: string, intervalMs = 60_000) {
    this.scanSymbol = symbol;
    if (this.scanInterval) clearInterval(this.scanInterval);
    this.scanInterval = setInterval(
      () => this.scan(symbol).catch((err) => logger.error({ err }, "Position scan failed")),
      intervalMs,
    );
    // Run immediately on start
    this.scan(symbol).catch((err) => logger.error({ err }, "Initial position scan failed"));
  }

  private async scan(symbol: string) {
    try {
      const resp = await bitunixGet<BitunixPositionItem[]>(
        "/api/v1/futures/position/get_pending_positions",
        { symbol },
      );
      const live = Array.isArray(resp.data) ? resp.data : [];
      const liveIds = new Set(live.map((p) => p.positionId));

      // Detect positions not yet in map (opened externally)
      for (const pos of live) {
        if (!pos.positionId || this.contexts.has(pos.positionId)) continue;
        const entryStr = pos.entryPrice ?? pos.openPrice ?? null;
        const ctx = await this.buildContext(
          pos.positionId,
          pos.symbol ?? symbol,
          pos.side ?? "LONG",
          pos.leverage ? parseInt(pos.leverage) : 1,
          entryStr ? parseFloat(entryStr) : null,
          "detected",
        );
        await this.recordOpen(ctx);
        logger.info({ positionId: pos.positionId, symbol }, "External position detected");
      }

      // Evict stale entries for positions that are now flat.
      // These are positions that closed externally (directly on Bitunix) while
      // the server was running — no close handler will call consumeContext, so
      // we must clean up the DB row here to avoid leaking it indefinitely.
      for (const [pid, ctx] of this.contexts.entries()) {
        if (ctx.symbol === symbol && !liveIds.has(pid)) {
          this.contexts.delete(pid);
          if (ctx.source !== "app_open" && ctx.source !== "auto_entry") {
            // External close: no journal writer will consume this row, so delete it now.
            db.delete(positionEntryLogTable)
              .where(eq(positionEntryLogTable.positionId, pid))
              .catch((err) => logger.error({ err, positionId: pid }, "Failed to evict stale position entry log"));
          }
          // app_open / auto_entry rows: consumed by the close handler (consumeContext)
          // which fires from the flash_close / safeguard / trigger paths.
        }
      }
    } catch (err) {
      logger.error({ err }, "Position scan error");
    }
  }
}

export const positionTracker = new PositionTracker();
