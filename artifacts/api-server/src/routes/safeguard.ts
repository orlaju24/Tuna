import { Router } from "express";
import { db } from "../lib/db";
import { safeguardsTable, eventLogTable } from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { safeguardManager } from "../lib/safeguardWatcher";
import { getOpenPositions, toPositionDirection } from "../lib/bitunix";

const router = Router();

// Return all safeguards, enriched with the live in-memory ROI where available.
router.get("/safeguard", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(safeguardsTable)
      .orderBy(safeguardsTable.createdAt);

    const enriched = rows.map((row) => {
      const live = safeguardManager.getLiveState(row.id);
      return {
        ...row,
        liveRoiPct:          live?.liveRoiPct ?? null,
        ratchetCount:        live?.ratchetCount ?? 0,
        nextMilestoneRoiPct: live?.nextMilestoneRoiPct ?? null,
        patienceLevel:       live?.patienceLevel ?? null,
        signalScore:         live?.signalScore ?? null,
        structure:           live?.structure ?? null,
        // Pre-trade plan fields — drive the PlanBadge in the UI
        plan:                live?.plan ?? null,
        planTrailDelta:      live?.planTrailDelta ?? 0,
        // Edge score — computed at arm time, null until ready
        edgeContext:         live?.edgeContext ?? null,
      };
    });

    res.json(enriched);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch safeguards");
    res.status(500).json({ error: String(err) });
  }
});

// Create and immediately arm a safeguard.
router.post("/safeguard", async (req, res) => {
  const {
    symbol,
    side,
    leverage,
    positionId,
    threshold1Pct,
    threshold2Pct,
    trailStepPct,
    closeMethod,
    trailingMode,
  } = req.body;

  const normalizedSymbol = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";
  const normalizedPositionId = typeof positionId === "string" ? positionId.trim() : "";
  if (!normalizedSymbol || !normalizedPositionId) {
    res.status(400).json({ error: "symbol and positionId are required to protect an open position" });
    return;
  }
  if (closeMethod && closeMethod !== "flash_close") {
    res.status(400).json({ error: "Stepped protection only supports closing its attached position" });
    return;
  }

  try {
    const livePositions = await getOpenPositions({ symbol: normalizedSymbol });
    const livePosition = livePositions.find(
      (position) => String(position.positionId ?? "") === normalizedPositionId,
    );
    if (!livePosition) {
      res.status(409).json({ error: "That position is no longer open on Bitunix" });
      return;
    }

    const positionSymbol = String(livePosition.symbol ?? normalizedSymbol).toUpperCase();
    const positionSide = toPositionDirection(livePosition.side);
    const entry = Number(livePosition.avgOpenPrice ?? livePosition.entryPrice ?? livePosition.openPrice);
    const quantity = Number(livePosition.qty);
    const positionLeverage = Number(livePosition.leverage ?? leverage ?? 1);
    if (positionSymbol !== normalizedSymbol || !positionSide) {
      res.status(409).json({ error: "Bitunix returned an unsupported position identity" });
      return;
    }
    if (side && toPositionDirection(side) !== positionSide) {
      res.status(409).json({ error: "The selected position direction changed; refresh positions and try again" });
      return;
    }
    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
      res.status(409).json({ error: "Bitunix returned invalid entry price or position size" });
      return;
    }
    if (!Number.isFinite(positionLeverage) || positionLeverage <= 0) {
      res.status(409).json({ error: "Bitunix returned invalid position leverage" });
      return;
    }
    const leverageValue = Math.max(1, Math.round(positionLeverage));

    const [existing] = await db
      .select({ id: safeguardsTable.id })
      .from(safeguardsTable)
      .where(and(
        eq(safeguardsTable.positionId, normalizedPositionId),
        inArray(safeguardsTable.state, ["armed", "protecting", "triggered", "closing"]),
      ))
      .limit(1);
    if (existing) {
      res.status(409).json({ error: "This position already has an active stepped safeguard" });
      return;
    }

    const [row] = await db
      .insert(safeguardsTable)
      .values({
        symbol: normalizedSymbol,
        side: positionSide,
        entryPrice: String(entry),
        qty: String(quantity),
        leverage: leverageValue,
        positionId: normalizedPositionId,
        threshold1Pct: String(threshold1Pct ?? "17"),
        threshold2Pct: String(threshold2Pct ?? "23"),
        trailStepPct: String(trailStepPct ?? "3"),
        closeMethod: "flash_close",
        trailingMode: (["tight","standard","wide","structure","adaptive"].includes(trailingMode)
          ? trailingMode : "adaptive"),
        state: "armed",
      })
      .returning();

    safeguardManager.arm(row);

    await db.insert(eventLogTable).values({
      symbol: row.symbol,
      eventType: "safeguard_created",
      eventMessage: `Safeguard created for ${row.symbol} ${row.side} position ${normalizedPositionId} @ entry ${entry} · arm at ${threshold1Pct ?? 17}% ROI · ${row.trailingMode} trail`,
      source: "safeguard",
    });

    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create safeguard");
    res.status(500).json({ error: String(err) });
  }
});

// Hot-swap the close method on an active (armed/protecting) safeguard.
router.patch("/safeguard/:id/method", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  const { closeMethod } = req.body;
  if (closeMethod !== "flash_close") {
    res.status(400).json({ error: "Stepped protection closes only its attached position" });
    return;
  }

  try {
    const [row] = await db
      .update(safeguardsTable)
      .set({ closeMethod, updatedAt: new Date() })
      .where(eq(safeguardsTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "not found" }); return; }

    // Update in-memory watcher so the next fire() uses the new method
    safeguardManager.updateCloseMethod(id, closeMethod);

    await db.insert(eventLogTable).values({
      symbol: row.symbol,
      eventType: "safeguard_method_changed",
      eventMessage: `Safeguard ${id} close method → position-specific flash close`,
      source: "safeguard",
    });

    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to update safeguard close method");
    res.status(500).json({ error: String(err) });
  }
});

// Disarm (cancel) a safeguard — stops watching but keeps the record.
router.post("/safeguard/:id/disarm", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  try {
    safeguardManager.disarm(id);
    const [row] = await db
      .update(safeguardsTable)
      .set({ state: "cancelled", updatedAt: new Date() })
      .where(eq(safeguardsTable.id, id))
      .returning();
    if (!row) { res.status(404).json({ error: "not found" }); return; }

    await db.insert(eventLogTable).values({
      symbol: row.symbol,
      eventType: "safeguard_disarmed",
      eventMessage: `Safeguard ${id} disarmed`,
      source: "safeguard",
    });

    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to disarm safeguard");
    res.status(500).json({ error: String(err) });
  }
});

// Delete a safeguard entirely.
router.delete("/safeguard/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

  try {
    safeguardManager.disarm(id);
    await db.delete(safeguardsTable).where(eq(safeguardsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete safeguard");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
