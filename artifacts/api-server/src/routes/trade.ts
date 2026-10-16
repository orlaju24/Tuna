import { Router } from "express";
import { bitunixPost, bitunixGet } from "../lib/bitunix";
import { randomUUID } from "node:crypto";
import { db } from "../lib/db";
import { eventLogTable, tradeJournalTable, tradePlansTable, tradeEventsTable } from "@workspace/db/schema";
import { desc, eq } from "drizzle-orm";
import { notifyPostClose } from "../lib/postCloseNotifier";
import { priceStream } from "../lib/priceStream";
import {
  getStructureContext,
  htfAlignmentLabel,
  patienceLabel,
} from "../lib/signalScore";
import { computeEdgeScore } from "../lib/edgeScore";
import { positionTracker } from "../lib/positionTracker";

const router = Router();

interface PositionItem {
  positionId: string;
  symbol: string;
  side?: string;
  entryPrice?: string;
  openPrice?: string;
  leverage?: string;
  qty?: string;
}

async function logEvent(symbol: string, eventType: string, message: string, source: string) {
  try {
    await db.insert(eventLogTable).values({ symbol, eventType, eventMessage: message, source });
  } catch (_) {}
}

async function pollPositionFlat(symbol: string, positionId?: string, maxAttempts = 6): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));
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

async function readPositions(symbol: string): Promise<PositionItem[]> {
  const data = await bitunixGet<PositionItem[]>("/api/v1/futures/position/get_pending_positions", { symbol });
  return Array.isArray(data.data) ? data.data : [];
}

async function pollForNewPosition(symbol: string, maxAttempts = 10): Promise<PositionItem | null> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const data = await bitunixGet<PositionItem[]>("/api/v1/futures/position/get_pending_positions", { symbol });
      const list = Array.isArray(data.data) ? data.data : [];
      if (list.length > 0) return list[0];
    } catch (_) {}
  }
  return null;
}

function manualVerdict(exitRoiPct: number | null): string {
  if (exitRoiPct == null) return "Manual close — no position data available.";
  if (exitRoiPct >= 15) return "Strong manual exit at a profitable level.";
  if (exitRoiPct >= 5) return "Good manual exit — positive ROI captured.";
  if (exitRoiPct >= 0) return "Manual close at a modest gain.";
  if (exitRoiPct >= -5) return "Manual close at a small loss.";
  return "Manual close in loss territory — review decision context.";
}

/** Read-only plan snapshot — does NOT consume the plan. */
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

/**
 * Write a trade journal record for a manual close.
 *
 * Priority 1: use entry context from positionTracker (oracle score AT ENTRY,
 * real entryPrice, openedAt → holdDurationMs).  This is available whenever
 * the position was opened via the app OR detected by the background scanner.
 *
 * Priority 2 (fallback): compute oracle score at close time and fetch the
 * most recent plan.  Used only when positionId has no tracker entry.
 */
async function writeManualJournalRecord(
  symbol: string,
  pos: PositionItem,
  exitReason: "manual_flash" | "manual_close_all",
  closeMethod: "flash_close" | "close_all",
  executionLatencyMs: number,
) {
  try {
    const closePrice = priceStream.getLatest(symbol) ?? null;

    // Use Bitunix's entryPrice/openPrice; tracker is the canonical fallback
    const posEntryStr = pos.entryPrice ?? pos.openPrice ?? null;
    const side        = pos.side ?? "LONG";
    const lev         = pos.leverage ? parseInt(pos.leverage) : 1;

    // ── Attempt to look up entry context from position tracker ───────────────
    const entryCtx = positionTracker.consumeContext(pos.positionId);

    const entryPrice  = entryCtx?.entryPrice
                        ?? (posEntryStr ? parseFloat(posEntryStr) : null);
    const armedAt     = entryCtx?.openedAt ?? null;
    const holdDurationMs = armedAt != null ? Date.now() - armedAt.getTime() : null;

    let exitRoiPct: number | null = null;
    if (entryPrice != null && entryPrice > 0 && closePrice != null) {
      const diff = side === "SHORT" ? entryPrice - closePrice : closePrice - entryPrice;
      exitRoiPct = (diff / entryPrice) * lev * 100;
    }

    // nearMiss: small loss that could have been saved (−3 % < ROI < 0)
    const nearMiss = exitRoiPct != null && exitRoiPct < 0 && exitRoiPct > -3;

    // ── Oracle context: use entry-time snapshot when available ───────────────
    let edgeScore: number;
    let walletSizeScore: number;
    let wholeNumberPlayType: string | null;
    let signalScore: number;
    let htfAlignment: string;
    let patienceLevel: string;
    let threeMinLead: boolean;
    let fifteenMinConfirm: boolean;
    let fourBarStreak: number;
    let pivotState: string | null;
    let velocityState: string | null;
    let counterMove: boolean;
    let resumption: boolean;
    let patienceBoost: number;
    let trailWidth: number | null;
    let tradePlanId: number | null;
    let uploadUsed: boolean;
    let uploadKey: string | null;
    let channelZoneAtPlan: string | null;
    let userBiasAtPlan: string | null;
    let agreementScoreAtPlan: number | null;
    let continuationProbAtPlan: number | null;
    let recommendedPatienceAtPlan: string | null;
    let outcomeVsPlan: string | null;

    if (entryCtx) {
      // Rich path: all context from entry-time snapshot
      edgeScore               = entryCtx.edgeScore;
      walletSizeScore         = entryCtx.walletSizeScore;
      wholeNumberPlayType     = entryCtx.wholeNumberPlayType;
      signalScore             = entryCtx.signalScore;
      htfAlignment            = entryCtx.htfAlignment;
      patienceLevel           = entryCtx.patienceLevel;
      threeMinLead            = entryCtx.threeMinLead;
      fifteenMinConfirm       = entryCtx.fifteenMinConfirm;
      fourBarStreak           = entryCtx.fourBarStreak;
      pivotState              = entryCtx.pivotState;
      velocityState           = entryCtx.velocityState;
      counterMove             = entryCtx.counterMove;
      resumption              = entryCtx.resumption;
      patienceBoost           = entryCtx.patienceBoost;
      trailWidth              = entryCtx.trailWidth;
      tradePlanId             = entryCtx.tradePlanId;
      uploadUsed              = entryCtx.uploadUsed;
      uploadKey               = entryCtx.uploadKey;
      channelZoneAtPlan       = entryCtx.channelZoneAtPlan;
      userBiasAtPlan          = entryCtx.userBiasAtPlan;
      agreementScoreAtPlan    = entryCtx.agreementScoreAtPlan;
      continuationProbAtPlan  = entryCtx.continuationProbAtPlan;
      recommendedPatienceAtPlan = entryCtx.recommendedPatienceAtPlan;
      // Compute outcome vs the entry-time plan
      const entryPlan = tradePlanId != null
        ? await fetchLatestPlan(symbol).catch(() => null)
        : null;
      outcomeVsPlan = computeOutcomeVsPlan(entryPlan, exitRoiPct);
    } else {
      // Fallback: compute from close-time state
      const s = getStructureContext(symbol);
      const [wallet, plan] = await Promise.all([
        bitunixGet<{ available: string; margin: string }>(
          "/api/v1/futures/account",
          { marginCoin: "USDT" },
        ).then((r) => ({
          available:      parseFloat(r.data.available ?? "0") || 0,
          positionMargin: parseFloat(r.data.margin    ?? "0") || 0,
        })).catch(() => ({ available: 0, positionMargin: 0 })),
        fetchLatestPlan(symbol),
      ]);
      const edgeCtx = computeEdgeScore(s, wallet);
      edgeScore               = edgeCtx.edgeScore;
      walletSizeScore         = edgeCtx.components.walletReadiness.score;
      wholeNumberPlayType     = s.wholeNumberPlayType ?? null;
      signalScore             = s.signalScore;
      htfAlignment            = htfAlignmentLabel(s);
      patienceLevel           = patienceLabel(s.signalScore);
      threeMinLead            = s.threeMinLeads ?? false;
      fifteenMinConfirm       = s.fifteenMinConfirms ?? false;
      fourBarStreak           = s.fourBarStreak ?? 0;
      pivotState              = s.pivotState ?? null;
      velocityState           = s.velocityState ?? null;
      counterMove             = s.counterMove ?? false;
      resumption              = s.resumption ?? false;
      patienceBoost           = s.patienceBoost ?? 0;
      trailWidth              = s.trailWidth ?? null;
      tradePlanId             = plan?.id ?? null;
      uploadUsed              = plan != null;
      uploadKey               = plan?.uploadKey ?? null;
      channelZoneAtPlan       = plan?.channelZone ?? null;
      userBiasAtPlan          = plan?.userBias ?? null;
      agreementScoreAtPlan    = plan?.agreementScore ?? null;
      continuationProbAtPlan  = plan?.continuationProbPct ?? null;
      recommendedPatienceAtPlan = plan?.recommendedPatience ?? null;
      outcomeVsPlan           = computeOutcomeVsPlan(plan, exitRoiPct);
    }

    const tradeId = entryCtx?.tradeId ?? randomUUID();
    const dataConfidence = entryCtx ? "full" : "partial";

    await db.insert(tradeJournalTable).values({
      tradeId,
      openedBy:       entryCtx?.source ?? null,
      dataConfidence,
      symbol,
      side,
      leverage: lev,
      positionId: pos.positionId || null,
      entryPrice: entryPrice != null ? String(entryPrice) : null,
      exitPrice:  closePrice  != null ? String(closePrice)  : null,
      armedAt,
      exitAt: new Date(),
      holdDurationMs,
      mfePct: null,
      maePct: null,
      peakRoiPct:      exitRoiPct != null ? String(exitRoiPct) : null,
      protectedRoiPct: null,
      exitRoiPct:      exitRoiPct != null ? String(exitRoiPct) : null,
      givebackPct: null,
      givebackRating: null,
      nearMiss,
      safeguardUsed: false,
      ratchetCount: 0,
      threshold1Pct: null,
      exitReason,
      closeMethod,
      executionLatencyMs,
      verdict: manualVerdict(exitRoiPct),
      setupFingerprint: `${side} · ${lev}x · manual · ${htfAlignment}`,
      // ── Market-structure snapshot ──────────────────────────────────────────
      htfAlignment,
      threeMinLead:      threeMinLead,
      fifteenMinConfirm: fifteenMinConfirm,
      fourBarStreak,
      pivotState,
      velocityState,
      counterMove,
      resumption,
      patienceBoost,
      trailWidth: trailWidth != null ? String(trailWidth) : null,
      signalScore: String(signalScore),
      patienceLevel,
      wholeNumberPlayType,
      // ── Oracle score ───────────────────────────────────────────────────────
      edgeScore,
      walletSizeScore,
      // ── Plan snapshot ─────────────────────────────────────────────────────
      tradePlanId,
      uploadUsed,
      uploadKey,
      channelZoneAtPlan,
      userBiasAtPlan,
      agreementScoreAtPlan,
      continuationProbAtPlan,
      recommendedPatienceAtPlan,
      outcomeVsPlan,
      // ─────────────────────────────────────────────────────────────────────
      sourceType: "manual",
      sourceId: null,
    });

    // Append manual_close event to the unified trade event stream
    await db.insert(tradeEventsTable).values({
      tradeId,
      symbol,
      eventType: closeMethod === "flash_close" ? "manual_close_flash" : "manual_close_all",
      source: "manual",
      price: closePrice != null ? String(closePrice) : null,
      roiPct: exitRoiPct != null ? String(exitRoiPct) : null,
      payload: JSON.stringify({ positionId: pos.positionId, executionLatencyMs }),
    }).catch(() => {});
  } catch (_) {}
}

router.post("/trade/flash-close", async (req, res) => {
  const { symbol, positionId } = req.body;
  if (!symbol || !positionId) {
    res.status(400).json({ code: -1, msg: "symbol and positionId are required", data: null });
    return;
  }
  const firedAt = Date.now();
  try {
    const before = await readPositions(symbol);
    const pos = before.find((p) => p.positionId === positionId);
    if (!pos) {
      await logEvent(symbol, "flash_close_no_position", `No live position with id ${positionId} on ${symbol}`, "trade");
      res.json({
        code: 0,
        msg: "no_position",
        data: { result: null, status: "no_position", message: "No matching open position on Bitunix" },
      });
      return;
    }

    const result = await bitunixPost("/api/v1/futures/trade/flash_close_position", {
      symbol,
      positionId,
    });
    if (result.code !== 0) {
      await logEvent(symbol, "flash_close_rejected", `Bitunix rejected: ${result.msg}`, "trade");
      res.json({ code: result.code, msg: result.msg, data: { result, status: "rejected" } });
      return;
    }
    await logEvent(symbol, "flash_close", `Flash close submitted for ${symbol} positionId=${positionId}`, "trade");
    const flat = await pollPositionFlat(symbol, positionId);
    const executionLatencyMs = Date.now() - firedAt;
    if (flat) {
      await logEvent(symbol, "flash_close_confirmed", `Position ${positionId} confirmed flat`, "trade");
      await writeManualJournalRecord(symbol, pos, "manual_flash", "flash_close", executionLatencyMs);
      notifyPostClose(symbol, "trigger");
      res.json({ code: 0, msg: "ok", data: { result, status: "confirmed_flat" } });
    } else {
      await logEvent(symbol, "flash_close_pending", `Position ${positionId} still open after poll`, "trade");
      res.json({ code: 0, msg: "still_open", data: { result, status: "still_open" } });
    }
  } catch (err) {
    req.log.error({ err }, "Flash close failed");
    await logEvent(symbol, "flash_close_error", String(err), "trade");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

router.post("/trade/close-all", async (req, res) => {
  const { symbol } = req.body;
  if (!symbol) {
    res.status(400).json({ code: -1, msg: "symbol is required", data: null });
    return;
  }
  const firedAt = Date.now();
  try {
    const before = await readPositions(symbol);
    if (before.length === 0) {
      await logEvent(symbol, "close_all_no_position", `No live positions on ${symbol}`, "trade");
      res.json({
        code: 0,
        msg: "no_position",
        data: { result: null, status: "no_position", message: "No open positions on Bitunix" },
      });
      return;
    }

    const result = await bitunixPost("/api/v1/futures/trade/close_all_position", { symbol });
    if (result.code !== 0) {
      await logEvent(symbol, "close_all_rejected", `Bitunix rejected: ${result.msg}`, "trade");
      res.json({ code: result.code, msg: result.msg, data: { result, status: "rejected" } });
      return;
    }
    await logEvent(symbol, "close_all", `Close all submitted for ${symbol} (${before.length} positions)`, "trade");
    const flat = await pollPositionFlat(symbol);
    const executionLatencyMs = Date.now() - firedAt;
    if (flat) {
      await logEvent(symbol, "close_all_confirmed", `All positions for ${symbol} confirmed flat`, "trade");
      for (const pos of before) {
        await writeManualJournalRecord(symbol, pos, "manual_close_all", "close_all", executionLatencyMs);
      }
      notifyPostClose(symbol, "trigger");
      res.json({ code: 0, msg: "ok", data: { result, status: "confirmed_flat" } });
    } else {
      await logEvent(symbol, "close_all_pending", `Positions for ${symbol} still open after poll`, "trade");
      res.json({ code: 0, msg: "still_open", data: { result, status: "still_open" } });
    }
  } catch (err) {
    req.log.error({ err }, "Close all failed");
    await logEvent(symbol, "close_all_error", String(err), "trade");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

router.post("/trade/open", async (req, res) => {
  const { symbol, side, size, orderType } = req.body;
  if (!symbol || !side || !size) {
    res.status(400).json({ code: -1, msg: "symbol, side, size required", data: null });
    return;
  }
  try {
    const result = await bitunixPost("/api/v1/futures/trade/place_order", {
      symbol,
      side: side.toUpperCase(),
      qty: String(size),
      orderType: orderType || "MARKET",
      tradeSide: "OPEN",
    });
    if (result.code !== 0) {
      await logEvent(symbol, "open_rejected", `Bitunix rejected: ${result.msg}`, "trade");
      res.json({ code: result.code, msg: result.msg, data: result });
      return;
    }
    await logEvent(symbol, "open_position", `Open ${side} ${size} ${symbol}`, "trade");
    res.json({ code: 0, msg: "ok", data: result.data });

    // Fire-and-forget: poll for the position that just filled and record entry context.
    // Done after response so it doesn't slow down the UX.
    pollForNewPosition(symbol).then(async (pos) => {
      if (!pos?.positionId) return;
      const lev = pos.leverage ? parseInt(pos.leverage) : 1;
      const entryStr = pos.entryPrice ?? pos.openPrice ?? null;
      const ctx = await positionTracker.buildContext(
        pos.positionId,
        symbol,
        pos.side ?? side.toUpperCase(),
        lev,
        entryStr ? parseFloat(entryStr) : null,
        "app_open",
      );
      await positionTracker.recordOpen(ctx);
    }).catch(() => {});
  } catch (err) {
    req.log.error({ err }, "Open position failed");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
