/**
 * Edge Fingerprint API.
 *
 * GET  /api/fingerprint?symbol=BTCUSDT      — list stored fingerprints
 * POST /api/fingerprint                      — add a mentor example manually
 * DELETE /api/fingerprint/:id                — remove a fingerprint
 */

import { Router } from "express";
import { db } from "../lib/db";
import { edgeFingerprintsTable } from "@workspace/db/schema";
import { eq, desc } from "drizzle-orm";

const router = Router();

// ── List ─────────────────────────────────────────────────────────────────────

router.get("/fingerprint", async (req, res) => {
  const symbol = ((req.query["symbol"] as string) ?? "BTCUSDT").toUpperCase();
  try {
    const rows = await db
      .select()
      .from(edgeFingerprintsTable)
      .orderBy(desc(edgeFingerprintsTable.createdAt))
      .limit(100);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list fingerprints");
    res.status(502).json({ error: String(err) });
  }
});

// ── Add mentor example ────────────────────────────────────────────────────────

router.post("/fingerprint", async (req, res) => {
  const {
    symbol = "BTCUSDT",
    fingerprint,
    qualityLabel = "transitional",
    outcome = "unknown",
    roiPct,
    exampleType,
    isMentorExample = true,
    notes,
  } = req.body as {
    symbol?:          string;
    fingerprint:      object;
    qualityLabel?:    string;
    outcome?:         string;
    roiPct?:          number;
    exampleType?:     string;
    isMentorExample?: boolean;
    notes?:           string;
  };

  if (!fingerprint || typeof fingerprint !== "object") {
    res.status(400).json({ error: "fingerprint object is required" });
    return;
  }

  try {
    const [row] = await db
      .insert(edgeFingerprintsTable)
      .values({
        symbol:          symbol.toUpperCase(),
        source:          "mentor",
        fingerprint,
        qualityLabel,
        outcome,
        roiPct:          roiPct != null ? String(roiPct) : undefined,
        exampleType:     exampleType ?? null,
        isMentorExample,
        notes:           notes ?? null,
      })
      .returning();
    res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to insert fingerprint");
    res.status(502).json({ error: String(err) });
  }
});

// ── Delete ────────────────────────────────────────────────────────────────────

router.delete("/fingerprint/:id", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    await db.delete(edgeFingerprintsTable).where(eq(edgeFingerprintsTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete fingerprint");
    res.status(502).json({ error: String(err) });
  }
});

export default router;
