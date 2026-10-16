import { Router } from "express";
import { db } from "../lib/db";
import { tradeJournalTable, edgeFingerprintsTable } from "@workspace/db/schema";
import { desc, eq, and, type SQL } from "drizzle-orm";
import { bitunixGet, unwrap } from "../lib/bitunix";

// ── Bitunix history-position shape ───────────────────────────────────────────
interface BitunixHistPos {
  positionId:  string;
  symbol:      string;
  side:        string;        // "BUY" | "SELL"
  leverage:    string;
  qty:         string;
  entryPrice:  string;
  exitPrice:   string;
  realizedPnl: string;
  fee:         string;
  openTime:    number;        // epoch ms
  closeTime:   number;        // epoch ms
}

interface KlineEntry {
  open:   string;
  high:   string;
  low:    string;
  close:  string;
  time:   number;            // epoch ms
  volume: string;
}

const router = Router();

/**
 * GET /api/journal/learning-digest[?symbol=BTCUSDT]
 *
 * Statistical analysis of all journal entries + fingerprints.
 * Used by the Oracle Learning panel to surface "what the oracle has learned"
 * and to auto-calibrate future entries.
 *
 * Computes win rates, avg ROI, and recommendations across:
 *   - Trading session (asian / london / overlap / ny)
 *   - Entry velocity (slow / normal / fast)
 *   - Oracle score bucket at arm time (poor / moderate / good / exceptional)
 *   - HTF alignment (aligned-up / aligned-down / mixed)
 *
 * Recommendations are emitted when a pattern has enough data (≥3 samples)
 * and a clear signal (≥20pp win-rate gap vs the baseline).
 */
function getSessionBucket(isoTimestamp: string | Date): string {
  const d = new Date(isoTimestamp as string);
  const et = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = et.getHours();
  if (h >= 9  && h < 12) return "overlap";
  if (h >= 12 && h < 16) return "ny";
  if (h >= 3  && h < 9)  return "london";
  return "asian";
}

type StatBucket = { wins: number; total: number; roiSum: number };

function toStats(map: Record<string, StatBucket>) {
  return Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, {
      wins:    v.wins,
      total:   v.total,
      winRate: v.total > 0 ? Math.round((v.wins / v.total) * 100) : 0,
      avgRoi:  v.total > 0 ? Math.round((v.roiSum / v.total) * 10) / 10 : 0,
    }]),
  );
}

function accum(map: Record<string, StatBucket>, key: string, roi: number, isWin: boolean) {
  if (!key) return;
  if (!map[key]) map[key] = { wins: 0, total: 0, roiSum: 0 };
  map[key].total++;
  map[key].roiSum += roi;
  if (isWin) map[key].wins++;
}

router.get("/journal/learning-digest", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  try {
    const whereClause = symbol ? eq(tradeJournalTable.symbol, symbol) : undefined;
    const allRows = await db
      .select()
      .from(tradeJournalTable)
      .where(whereClause)
      .orderBy(desc(tradeJournalTable.createdAt))
      .limit(500);

    const fingerprints = await db
      .select()
      .from(edgeFingerprintsTable)
      .orderBy(desc(edgeFingerprintsTable.createdAt))
      .limit(200);

    if (allRows.length < 3) {
      res.json({
        sampleSize: allRows.length,
        insufficientData: true,
        recommendations: [],
        sessionStats: {}, velocityStats: {}, oracleBucketStats: {}, htfStats: {},
        qualityDistribution: {}, suggestedMinEdge: null, bestSession: null,
        bestVelocity: null, winningOracleRange: null, allWinRate: null,
      });
      return;
    }

    const bySession:   Record<string, StatBucket> = {};
    const byVelocity:  Record<string, StatBucket> = {};
    const byOracle:    Record<string, StatBucket> = {};
    const byHtf:       Record<string, StatBucket> = {};
    const byFloorWave: Record<string, StatBucket> = {};
    const winningScores: number[] = [];
    let floorTotal = 0, floorWins = 0, floorRoiSum = 0;

    for (const row of allRows) {
      const roi   = parseFloat(String(row.exitRoiPct ?? "0"));
      const isWin = roi > 0;

      if (row.exitAt) accum(bySession, getSessionBucket(row.exitAt as unknown as string), roi, isWin);
      if (row.velocityState) accum(byVelocity, row.velocityState, roi, isWin);
      if (row.htfAlignment)  accum(byHtf, row.htfAlignment, roi, isWin);

      const o = row.edgeScore ?? 0;
      const ob = o >= 80 ? "exceptional" : o >= 65 ? "good" : o >= 45 ? "moderate" : "poor";
      accum(byOracle, ob, roi, isWin);

      if (isWin && row.edgeScore != null) winningScores.push(row.edgeScore);

      // Trigger floor learning — track outcomes when a trigger converted to floor
      if (row.triggerFloorUsed) {
        floorTotal++;
        floorRoiSum += roi;
        if (isWin) floorWins++;
        if (row.floorWavePhase) accum(byFloorWave, row.floorWavePhase, roi, isWin);
      }
    }

    winningScores.sort((a, b) => a - b);

    // Trigger floor aggregate stats
    const triggerFloorStats = floorTotal > 0
      ? {
          total:   floorTotal,
          wins:    floorWins,
          winRate: Math.round((floorWins / floorTotal) * 100),
          avgRoi:  Math.round((floorRoiSum / floorTotal) * 10) / 10,
        }
      : null;

    // 20th-percentile floor of winning oracle scores → suggested minimum
    const suggestedMinEdge = winningScores.length >= 5
      ? Math.floor(winningScores[Math.floor(winningScores.length * 0.20)])
      : null;

    // Best session / velocity by win rate (min 2 trades)
    const bestSession = Object.entries(bySession)
      .filter(([, v]) => v.total >= 2)
      .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0]?.[0] ?? null;

    const bestVelocity = Object.entries(byVelocity)
      .filter(([, v]) => v.total >= 2)
      .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0]?.[0] ?? null;

    // Quality distribution from fingerprints
    const qualityDistribution: Record<string, number> = {};
    for (const fp of fingerprints) {
      const ql = fp.qualityLabel ?? "transitional";
      qualityDistribution[ql] = (qualityDistribution[ql] ?? 0) + 1;
    }

    // ── Recommendations ──────────────────────────────────────────────────────
    const recommendations: Array<{
      type: string; insight: string; confidence: string;
      actionable: boolean; suggestedValue?: number | string;
    }> = [];

    const allWins = allRows.filter((r) => parseFloat(String(r.exitRoiPct ?? "0")) > 0).length;
    const allWinRate = allRows.length > 0 ? allWins / allRows.length : null;

    // Oracle threshold
    if (suggestedMinEdge != null && suggestedMinEdge >= 55) {
      recommendations.push({
        type: "oracle_threshold",
        insight: `Winning trades start at oracle ${suggestedMinEdge}+ — raising the minimum filters out marginal setups`,
        confidence: winningScores.length >= 10 ? "high" : "medium",
        actionable: true,
        suggestedValue: suggestedMinEdge,
      });
    }

    // Best session
    if (bestSession && bySession[bestSession]) {
      const s   = bySession[bestSession];
      const wr  = Math.round((s.wins / s.total) * 100);
      const base = allWinRate ? Math.round(allWinRate * 100) : 50;
      if (wr >= 60 && s.total >= 3 && wr > base + 15) {
        recommendations.push({
          type: "time_window",
          insight: `${bestSession.toUpperCase()} session wins ${wr}% (${s.wins}/${s.total} trades, avg ${Math.round((s.roiSum / s.total) * 10) / 10}% ROI)`,
          confidence: s.total >= 8 ? "high" : "medium",
          actionable: true,
          suggestedValue: bestSession,
        });
      }
    }

    // Velocity preference
    if (bestVelocity && byVelocity[bestVelocity]?.total >= 3) {
      const v  = byVelocity[bestVelocity];
      const wr = Math.round((v.wins / v.total) * 100);
      if (wr >= 60) {
        recommendations.push({
          type: "velocity",
          insight: `${bestVelocity.toUpperCase()} entries win ${wr}% (${v.wins}/${v.total}) — oracle rewards patience`,
          confidence: v.total >= 8 ? "high" : "medium",
          actionable: false,
        });
      }
    }

    // HTF alignment value
    const alignedTotal = (byHtf["aligned-up"]?.total ?? 0) + (byHtf["aligned-down"]?.total ?? 0);
    const alignedWins  = (byHtf["aligned-up"]?.wins  ?? 0) + (byHtf["aligned-down"]?.wins  ?? 0);
    const mixedTotal   = byHtf["mixed"]?.total ?? 0;
    const mixedWins    = byHtf["mixed"]?.wins  ?? 0;
    if (alignedTotal >= 3 && mixedTotal >= 2) {
      const awr = alignedWins / alignedTotal;
      const mwr = mixedWins  / mixedTotal;
      if (awr > mwr + 0.20) {
        recommendations.push({
          type: "htf_alignment",
          insight: `HTF-aligned trades win ${Math.round(awr * 100)}% vs ${Math.round(mwr * 100)}% when mixed — alignment is genuinely predictive`,
          confidence: "medium",
          actionable: false,
        });
      }
    }

    // Quality distribution warning
    const forcedCount = qualityDistribution["forced"] ?? 0;
    const totalFp = fingerprints.length;
    if (totalFp >= 5 && forcedCount / totalFp > 0.3) {
      recommendations.push({
        type: "quality_warning",
        insight: `${Math.round((forcedCount / totalFp) * 100)}% of trades are labelled "forced" (oracle < 55 at entry). Raise the minimum or trade less.`,
        confidence: "high",
        actionable: true,
      });
    }

    // Trigger floor insight — is the floor mechanic adding or removing value?
    if (triggerFloorStats && triggerFloorStats.total >= 3 && allWinRate != null) {
      const floorWr = triggerFloorStats.wins / triggerFloorStats.total;
      const baseline = allWinRate / 100;
      if (floorWr >= 0.60 && floorWr > baseline + 0.15) {
        recommendations.push({
          type: "trigger_floor",
          insight: `Trigger floors win ${triggerFloorStats.winRate}% (${triggerFloorStats.wins}/${triggerFloorStats.total} trades, avg ${triggerFloorStats.avgRoi >= 0 ? "+" : ""}${triggerFloorStats.avgRoi.toFixed(1)}% ROI) vs ${Math.round(baseline * 100)}% baseline — the ladder is protecting profit well`,
          confidence: triggerFloorStats.total >= 8 ? "high" : "medium",
          actionable: false,
        });
      } else if (floorWr < 0.40 && floorWr < baseline - 0.15 && triggerFloorStats.total >= 5) {
        recommendations.push({
          type: "trigger_floor_warning",
          insight: `Trigger floors win only ${triggerFloorStats.winRate}% (${triggerFloorStats.wins}/${triggerFloorStats.total}) vs ${Math.round(baseline * 100)}% baseline — review floor level placement or reduce trigger use with safeguards active`,
          confidence: triggerFloorStats.total >= 8 ? "high" : "medium",
          actionable: true,
        });
      }
    }

    res.json({
      sampleSize:         allRows.length,
      insufficientData:   allRows.length < 5,
      sessionStats:       toStats(bySession),
      velocityStats:      toStats(byVelocity),
      oracleBucketStats:  toStats(byOracle),
      htfStats:           toStats(byHtf),
      qualityDistribution,
      suggestedMinEdge,
      bestSession,
      bestVelocity,
      winningOracleRange: winningScores.length >= 3
        ? { min: winningScores[0], max: winningScores[winningScores.length - 1] }
        : null,
      recommendations,
      allWinRate:        allWinRate != null ? Math.round(allWinRate * 100) : null,
      triggerFloorStats,
      byFloorWavePhase:  toStats(byFloorWave),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute learning digest");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/journal/wallet-summary", async (req, res) => {
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  try {
    const whereClause = symbol ? eq(tradeJournalTable.symbol, symbol) : undefined;
    const allRows = await db
      .select()
      .from(tradeJournalTable)
      .where(whereClause)
      .orderBy(desc(tradeJournalTable.createdAt))
      .limit(500);

    const protected_ = allRows.filter((r) => r.safeguardUsed);
    const triggerRows = allRows.filter((r) => r.sourceType === "trigger");
    const manualRows  = allRows.filter((r) => r.sourceType === "manual");

    const wins = protected_.filter((r) => parseFloat(String(r.exitRoiPct ?? "0")) > 0);
    const withUpload = protected_.filter((r) => r.uploadUsed);
    const withUploadWins = withUpload.filter((r) => parseFloat(String(r.exitRoiPct ?? "0")) > 0);

    const triggerWins = triggerRows.filter((r) => r.exitRoiPct != null && parseFloat(String(r.exitRoiPct)) > 0);
    const manualWins  = manualRows.filter((r) => r.exitRoiPct != null && parseFloat(String(r.exitRoiPct)) > 0);

    const avgExitRoiPct = protected_.length > 0
      ? protected_.reduce((s, r) => s + parseFloat(String(r.exitRoiPct ?? "0")), 0) / protected_.length
      : 0;

    const avgRatchetCount = protected_.length > 0
      ? protected_.reduce((s, r) => s + (r.ratchetCount ?? 0), 0) / protected_.length
      : 0;

    res.json({
      totalTrades:          allRows.length,
      protectedTrades:      protected_.length,
      triggerTrades:        triggerRows.length,
      manualTrades:         manualRows.length,
      winCount:             wins.length,
      winRate:              protected_.length > 0 ? wins.length / protected_.length : null,
      avgExitRoiPct,
      avgRatchetCount,
      uploadGuidedTrades:   withUpload.length,
      uploadGuidedWinRate:  withUpload.length > 0 ? withUploadWins.length / withUpload.length : null,
      triggerWinRate:       triggerRows.length > 0 ? triggerWins.length / triggerRows.length : null,
      manualWinRate:        manualRows.length > 0 ? manualWins.length / manualRows.length : null,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute wallet summary");
    res.status(500).json({ error: String(err) });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Compute approximate ROI% from exchange fill data. */
function computeExchangeRoi(
  side: string,
  entryPrice: string,
  exitPrice: string,
  leverage: number,
): number | null {
  const entry = parseFloat(entryPrice);
  const exit  = parseFloat(exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return null;
  const raw = side === "BUY"
    ? (exit - entry) / entry
    : (entry - exit) / entry;
  return Math.round(raw * leverage * 10000) / 100;
}

/**
 * Try to match a Bitunix history position to a journal record.
 * Prefers positionId match; falls back to side + open-time proximity.
 */
function matchPosition(
  candidates: BitunixHistPos[],
  positionId: string | null,
  side: string,
  openMs: number,
): BitunixHistPos | null {
  if (positionId) {
    const exact = candidates.find((p) => p.positionId === positionId);
    if (exact) return exact;
  }
  const bitunixSide = side === "LONG" ? "BUY" : "SELL";
  const sameDir = candidates.filter((p) => p.side === bitunixSide);
  if (sameDir.length === 0) return candidates[0] ?? null;
  // Pick closest openTime to our armedAt
  return sameDir.sort((a, b) =>
    Math.abs(a.openTime - openMs) - Math.abs(b.openTime - openMs)
  )[0];
}

// ── GET /api/journal/:id  ─────────────────────────────────────────────────────
router.get("/journal/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });
  try {
    const [entry] = await db
      .select()
      .from(tradeJournalTable)
      .where(eq(tradeJournalTable.id, id));
    if (!entry) return void res.status(404).json({ error: "Not found" });
    res.json(entry);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch journal entry");
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/journal/:id/debrief ─────────────────────────────────────────────
/**
 * Returns the journal record enriched with live Bitunix history data:
 *   - exchange: matched history position (entryPrice, exitPrice, fee, realizedPnl, qty…)
 *   - candles:  3m klines covering the hold window (entry→exit) newest-first
 *   - computed: recalculated ROI from exchange fills, net PnL after fees
 *
 * Non-fatal: if Bitunix calls fail the response still returns { journal, exchange: null, candles: [] }.
 */
router.get("/journal/:id/debrief", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

  try {
    const [entry] = await db
      .select()
      .from(tradeJournalTable)
      .where(eq(tradeJournalTable.id, id));
    if (!entry) return void res.status(404).json({ error: "Not found" });

    const openMs  = entry.armedAt  ? new Date(entry.armedAt as unknown as string).getTime()  : null;
    const closeMs = entry.exitAt   ? new Date(entry.exitAt  as unknown as string).getTime()  : null;

    // ── Fetch history position ───────────────────────────────────────────────
    let exchangePos: BitunixHistPos | null = null;
    try {
      const startMs = openMs  != null ? openMs  - 5 * 60_000 : Date.now() - 24 * 3600_000;
      const endMs   = closeMs != null ? closeMs + 5 * 60_000 : Date.now();
      const resp = await bitunixGet<BitunixHistPos[]>(
        "/api/v1/futures/position/get_history_positions",
        {
          symbol:    entry.symbol,
          startTime: String(startMs),
          endTime:   String(endMs),
          limit:     "20",
        },
      );
      const candidates = Array.isArray(resp.data) ? resp.data : [];
      exchangePos = matchPosition(candidates, entry.positionId, entry.side, openMs ?? Date.now());
    } catch (err) {
      req.log.warn({ err }, "debrief: history positions fetch failed — non-fatal");
    }

    // ── Fetch 3m klines for the hold window ─────────────────────────────────
    let candles: KlineEntry[] = [];
    try {
      const startMs = openMs  != null ? openMs  - 3 * 60_000  : Date.now() - 3600_000;
      const endMs   = closeMs != null ? closeMs + 3 * 60_000  : Date.now();
      const kResp = await bitunixGet<KlineEntry[]>(
        "/api/v1/futures/market/kline",
        {
          symbol:    entry.symbol,
          interval:  "3m",
          startTime: String(startMs),
          endTime:   String(endMs),
          limit:     "200",
        },
      );
      candles = Array.isArray(kResp.data) ? kResp.data : [];
    } catch (err) {
      req.log.warn({ err }, "debrief: kline fetch failed — non-fatal");
    }

    // ── Derived computations ─────────────────────────────────────────────────
    let computed: {
      exchangeRoiPct:   number | null;
      netPnl:           number | null;
      totalFee:         number | null;
      holdDurationMs:   number | null;
      priceDelta:       number | null;
      entryConfirmed:   boolean;
    } = {
      exchangeRoiPct: null,
      netPnl:         null,
      totalFee:       null,
      holdDurationMs: null,
      priceDelta:     null,
      entryConfirmed: false,
    };

    if (exchangePos) {
      const fee      = parseFloat(exchangePos.fee ?? "0");
      const pnl      = parseFloat(exchangePos.realizedPnl ?? "0");
      const entryP   = parseFloat(exchangePos.entryPrice);
      const exitP    = parseFloat(exchangePos.exitPrice);

      computed.totalFee       = Number.isFinite(fee) ? fee : null;
      computed.netPnl         = Number.isFinite(pnl) ? pnl : null;
      computed.exchangeRoiPct = computeExchangeRoi(
        exchangePos.side,
        exchangePos.entryPrice,
        exchangePos.exitPrice,
        entry.leverage,
      );
      computed.holdDurationMs =
        exchangePos.closeTime && exchangePos.openTime
          ? exchangePos.closeTime - exchangePos.openTime
          : null;
      computed.priceDelta =
        Number.isFinite(entryP) && Number.isFinite(exitP)
          ? exitP - entryP
          : null;
      computed.entryConfirmed = entry.dataConfidence !== "full" || entry.entryPrice == null;
    }

    res.json({ journal: entry, exchange: exchangePos, candles, computed });
  } catch (err) {
    req.log.error({ err }, "Failed to build trade debrief");
    res.status(500).json({ error: String(err) });
  }
});

// ── POST /api/journal/:id/enrich ─────────────────────────────────────────────
/**
 * Fetches exchange data for the trade and writes back:
 *   entryPrice (if currently null), realizedPnl, entryFee, exitFee, enrichedAt.
 * Also recalculates exitRoiPct / peakRoiPct / holdDurationMs from exchange fills
 * when the record is flagged dataConfidence = "inferred".
 */
router.post("/journal/:id/enrich", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return void res.status(400).json({ error: "Invalid id" });

  try {
    const [entry] = await db
      .select()
      .from(tradeJournalTable)
      .where(eq(tradeJournalTable.id, id));
    if (!entry) return void res.status(404).json({ error: "Not found" });

    const openMs  = entry.armedAt ? new Date(entry.armedAt as unknown as string).getTime() : null;
    const closeMs = entry.exitAt  ? new Date(entry.exitAt  as unknown as string).getTime() : null;

    const startMs = openMs  != null ? openMs  - 5 * 60_000 : Date.now() - 24 * 3600_000;
    const endMs   = closeMs != null ? closeMs + 5 * 60_000 : Date.now();

    const resp = await bitunixGet<BitunixHistPos[]>(
      "/api/v1/futures/position/get_history_positions",
      {
        symbol:    entry.symbol,
        startTime: String(startMs),
        endTime:   String(endMs),
        limit:     "20",
      },
    );
    const candidates = Array.isArray(resp.data) ? resp.data : [];
    const pos = matchPosition(candidates, entry.positionId, entry.side, openMs ?? Date.now());

    if (!pos) {
      return void res.status(404).json({
        error: "No matching position found in exchange history for this time window",
        candidates: candidates.length,
      });
    }

    // Build the update patch
    const patch: Partial<typeof tradeJournalTable.$inferInsert> = {
      enrichedAt:  new Date(),
      realizedPnl: pos.realizedPnl ?? null,
      entryFee:    null,           // Bitunix combines fees into single `fee` field
      exitFee:     pos.fee ?? null,
    };

    // Backfill entry/exit price when missing (inferred records)
    if (entry.entryPrice == null && pos.entryPrice) {
      patch.entryPrice = pos.entryPrice;
    }
    if (entry.exitPrice == null && pos.exitPrice) {
      patch.exitPrice = pos.exitPrice;
    }

    // Recalculate hold duration from exchange times when we only had it via armedAt
    if (pos.openTime && pos.closeTime) {
      const exchangeHold = pos.closeTime - pos.openTime;
      if (!entry.holdDurationMs) {
        patch.holdDurationMs = exchangeHold;
      }
    }

    // Recalculate exitRoiPct from actual fills if inferred
    if (entry.dataConfidence === "inferred" && pos.entryPrice && pos.exitPrice) {
      const roiPct = computeExchangeRoi(pos.side, pos.entryPrice, pos.exitPrice, entry.leverage);
      if (roiPct != null) {
        patch.exitRoiPct = String(roiPct);
        if (entry.peakRoiPct == null) {
          patch.peakRoiPct = String(roiPct);
        }
      }
    }

    await db.update(tradeJournalTable).set(patch).where(eq(tradeJournalTable.id, id));

    res.json({ ok: true, enriched: patch, exchange: pos });
  } catch (err) {
    req.log.error({ err }, "Failed to enrich journal entry");
    res.status(500).json({ error: String(err) });
  }
});

router.get("/journal", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "50")), 200);
  const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
  const side = req.query.side ? String(req.query.side).toUpperCase() : null;
  const exitReason = req.query.exitReason ? String(req.query.exitReason) : null;
  const safeguardUsed = req.query.safeguardUsed != null
    ? req.query.safeguardUsed === "true"
    : null;

  try {
    const conditions: SQL[] = [];
    if (symbol) conditions.push(eq(tradeJournalTable.symbol, symbol));
    if (side) conditions.push(eq(tradeJournalTable.side, side));
    if (exitReason) conditions.push(eq(tradeJournalTable.exitReason, exitReason));
    if (safeguardUsed != null) conditions.push(eq(tradeJournalTable.safeguardUsed, safeguardUsed));

    const rows = await db
      .select()
      .from(tradeJournalTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(tradeJournalTable.createdAt))
      .limit(limit);

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch trade journal");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
