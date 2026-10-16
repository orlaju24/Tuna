/**
 * Trade Plan Routes
 *
 * Storage and persistence contract (the "last mile"):
 *
 *   1. IMAGE IS STORED DURABLY FIRST.
 *      The chart screenshot goes to App Storage (GCS private bucket) before any
 *      analysis is attempted. The object key is deterministic (uuid) so it can
 *      be referenced by the plan row even if the analysis step fails.
 *
 *   2. PLAN ROW IS CREATED BEFORE ANALYSIS.
 *      Immediately after GCS upload, a partial plan row is inserted into
 *      `trade_plans` with uploadKey, priceAtUpload, and user metadata.
 *      This makes the plan object durable independently of the AI call.
 *
 *   3. ANALYSIS IS BEST-EFFORT; FAILURE NEVER LOSES THE PLAN.
 *      The vision analysis (OpenAI gpt-5.4) runs after the row is created.
 *      If it fails (timeout, rate-limit, API error), the partial row is
 *      returned with analysisError set in the response body. The chart is
 *      still saved. The user can view the image and re-submit for analysis
 *      by deleting and re-uploading — or the frontend can show a retry UI.
 *      The plan row remains unconsumed and visible in the trade plan card.
 *
 *   4. AUTO-ENTRY AND SAFEGUARD READ FROM THE SAME PERSISTED OBJECT.
 *      The auto-entry watcher queries `trade_plans` (not an in-memory cache)
 *      so it sees exactly the same plan data the UI shows. The safeguard
 *      atomically claims the plan with a DB write (consumedAt + consumedBySafeguardId).
 *      Both subsystems share a single source of truth — the `trade_plans` row.
 *
 *   5. PLAN REUSE — NO REPEATED AI CALLS.
 *      Analysis runs exactly once (at upload time). The resulting JSON is
 *      stored in `rawAnalysis` (JSONB). All subsequent reads (auto-entry cycles,
 *      safeguard arming, frontend display) simply read the persisted row —
 *      no re-analysis, no repeated OpenAI calls, no re-computation.
 */

import { Router } from "express";
import multer from "multer";
import { Readable } from "stream";
import { randomUUID } from "crypto";
import { db } from "../lib/db";
import { tradePlansTable } from "@workspace/db/schema";
import { desc, eq, and, isNull } from "drizzle-orm";
import { objectStorageClient, ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { analyzeChartScreenshot } from "../lib/tradePlanAnalyzer";
import { priceStream } from "../lib/priceStream";
import { logger } from "../lib/logger";

const router = Router();
const objectStorageService = new ObjectStorageService();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — generous for phone screenshots
});

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

function privateObjectPath(): string {
  const dir = process.env["PRIVATE_OBJECT_DIR"];
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function parseBucketAndKey(fullPath: string): { bucketName: string; objectName: string } {
  const trimmed = fullPath.startsWith("/") ? fullPath.slice(1) : fullPath;
  const parts = trimmed.split("/");
  if (parts.length < 2) throw new Error("invalid object path");
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

/**
 * POST /api/trade-plan
 *
 * Two-phase resilient upload:
 *   Phase 1 (guaranteed): store image in GCS + insert plan row.
 *   Phase 2 (best-effort): run vision analysis + update row.
 *
 * If Phase 2 fails the response still returns the plan row with
 * analysisError populated so the frontend can show the chart and
 * inform the user that analysis can be retried.
 *
 * multipart fields:
 *   - chart     (file, required)
 *   - symbol    (string, required)
 *   - side      (LONG | SHORT, optional)
 *   - userBias  (long | short | unclear, optional)
 *   - note      (string, optional, free text ≤ 500 chars)
 */
router.post("/trade-plan", upload.single("chart"), async (req, res) => {
  try {
    // ── Validate inputs ───────────────────────────────────────────────────────
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "chart file required" });
      return;
    }
    if (!ALLOWED_TYPES.has(file.mimetype)) {
      res.status(400).json({ error: `unsupported image type: ${file.mimetype}` });
      return;
    }
    const symbolRaw = req.body?.symbol;
    if (!symbolRaw || typeof symbolRaw !== "string") {
      res.status(400).json({ error: "symbol required" });
      return;
    }
    const symbol = symbolRaw.toUpperCase();

    const sideRaw = typeof req.body?.side === "string" ? req.body.side.toUpperCase() : null;
    const side = sideRaw === "LONG" || sideRaw === "SHORT" ? sideRaw : null;

    const userBiasRaw = typeof req.body?.userBias === "string"
      ? req.body.userBias.toLowerCase()
      : null;
    const userBias = ["long", "short", "unclear"].includes(userBiasRaw ?? "")
      ? (userBiasRaw as string)
      : null;

    const note = typeof req.body?.note === "string"
      ? req.body.note.slice(0, 500)
      : null;

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 1 — Durable storage (must succeed before returning 500)
    //
    // The image goes to GCS and the plan row is created BEFORE analysis
    // runs. This guarantees the plan object always exists after a successful
    // HTTP response — analysis failures only affect Phase 2.
    // ────────────────────────────────────────────────────────────────────────

    // 1a. Upload image to GCS private bucket
    const objectId = randomUUID();
    const fullPath = `${privateObjectPath()}/uploads/${objectId}`;
    const { bucketName, objectName } = parseBucketAndKey(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const gcsFile = bucket.file(objectName);
    await gcsFile.save(file.buffer, {
      contentType: file.mimetype,
      resumable: false,
      metadata: { contentType: file.mimetype },
    });
    const uploadKey = `/objects/uploads/${objectId}`;

    // 1b. Capture live price at upload time.
    //     Used by:
    //       (a) the AI prompt — converts zone notes to actual dollar levels
    //       (b) auto-entry watcher — measures retrace progress for "wait" plans
    //           (formula: signedMove% / returnToZonePct% = retrace fraction)
    const priceAtUpload = priceStream.getLatest(symbol) ?? null;

    // 1c. Create the plan row immediately — before analysis.
    //     All analysis fields are null at this point. The row is unconsumed
    //     and visible to the auto-entry watcher and safeguard manager.
    const [row] = await db.insert(tradePlansTable).values({
      symbol,
      side,
      userBias,
      uploadKey,
      uploadContentType: file.mimetype,
      uploadBytes: file.size,
      priceAtUpload: priceAtUpload != null ? String(priceAtUpload) : null,
      // Analysis fields: all null until Phase 2 updates them
      channelZone: null,
      channelTilt: null,
      trendPosture: null,
      detectedBias: null,
      agreementScore: null,
      continuationProbPct: null,
      pivotProximityNote: null,
      recommendedPatience: null,
      recommendedTightening: null,
      setupQuality: null,
      riskNote: null,
      summary: null,
      returnToZonePct: null,
      returnToZoneNote: null,
      entryZoneNote: null,
      invalidationZoneNote: null,
      confidenceLevel: null,
      likelyAction: null,
      rawAnalysis: null,
    }).returning();

    // ────────────────────────────────────────────────────────────────────────
    // PHASE 2 — Vision analysis (best-effort; failure returns partial plan)
    //
    // Analysis runs exactly once. The result is stored in rawAnalysis (JSONB)
    // so all subsequent reads (auto-entry, safeguard arm, UI) share the same
    // persisted object — no repeated AI calls, no re-computation.
    // ────────────────────────────────────────────────────────────────────────

    let analysisError: string | null = null;

    try {
      const analysis = await analyzeChartScreenshot({
        imageBase64: file.buffer.toString("base64"),
        contentType: file.mimetype,
        symbol,
        currentPrice: priceAtUpload,
        side,
        userBias,
        userNote: note,
      });

      // Update the row with the full analysis result
      const [updated] = await db
        .update(tradePlansTable)
        .set({
          channelZone: analysis.channelZone,
          channelTilt: analysis.channelTilt,
          trendPosture: analysis.trendPosture,
          detectedBias: analysis.detectedBias,
          agreementScore: analysis.agreementScore,
          continuationProbPct: analysis.continuationProbPct,
          pivotProximityNote: analysis.pivotProximityNote,
          recommendedPatience: analysis.recommendedPatience,
          recommendedTightening: analysis.recommendedTightening,
          setupQuality: analysis.setupQuality,
          riskNote: analysis.riskNote,
          summary: analysis.summary,
          returnToZonePct: analysis.returnToZonePct != null
            ? String(analysis.returnToZonePct)
            : null,
          returnToZoneNote: analysis.returnToZoneNote,
          entryZoneNote: analysis.entryZoneNote,
          invalidationZoneNote: analysis.invalidationZoneNote,
          confidenceLevel: analysis.confidenceLevel,
          likelyAction: analysis.likelyAction,
          rawAnalysis: analysis,
        })
        .where(eq(tradePlansTable.id, row.id))
        .returning();

      // Return the fully-analysed plan
      res.json(updated);
      return;

    } catch (err) {
      // Phase 2 failed — log it, but do NOT fail the request.
      // The image is safely in GCS and the plan row exists.
      analysisError = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, planId: row.id, symbol, uploadKey },
        "Trade plan analysis failed — plan row preserved, image stored durably",
      );
    }

    // Return the partial plan with a descriptive error so the UI can
    // show the chart, inform the user, and offer a retry.
    res.json({
      ...row,
      analysisError,
      summary: "Analysis failed — your chart has been saved. Delete and re-upload to retry.",
      riskNote: `Vision analysis failed: ${analysisError ?? "unknown error"}`,
    });

  } catch (err) {
    req.log.error({ err }, "Failed to create trade plan");
    res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
  }
});

/**
 * GET /api/trade-plan?symbol=BTCUSDT&limit=20
 * Lists plans (most recent first), optionally filtered by symbol.
 */
router.get("/trade-plan", async (req, res) => {
  try {
    const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
    const limit = Math.min(parseInt(String(req.query.limit || "20")), 100);
    const rows = await db
      .select()
      .from(tradePlansTable)
      .where(symbol ? eq(tradePlansTable.symbol, symbol) : undefined)
      .orderBy(desc(tradePlansTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to list trade plans");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/trade-plan/:symbol/latest
 *
 * Returns the most recent UNCONSUMED plan for the symbol.
 * This is the same object the auto-entry watcher reads on every 60-second
 * cycle and the safeguard manager claims on arm — a single shared state.
 * Returns 204 No Content if none exists.
 */
router.get("/trade-plan/:symbol/latest", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const [row] = await db
      .select()
      .from(tradePlansTable)
      .where(and(eq(tradePlansTable.symbol, symbol), isNull(tradePlansTable.consumedAt)))
      .orderBy(desc(tradePlansTable.createdAt))
      .limit(1);
    if (!row) {
      res.status(204).end();
      return;
    }
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch latest trade plan");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * GET /api/trade-plan/:id/image
 *
 * Streams the stored chart screenshot from App Storage (GCS).
 * Image always available because GCS upload is Phase 1 (guaranteed).
 */
router.get("/trade-plan/:id/image", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

    const [row] = await db
      .select()
      .from(tradePlansTable)
      .where(eq(tradePlansTable.id, id))
      .limit(1);
    if (!row) { res.status(404).json({ error: "not found" }); return; }

    const file = await objectStorageService.getObjectEntityFile(row.uploadKey);
    const response = await objectStorageService.downloadObject(file, 60 * 60);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) {
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "image not found in storage" });
      return;
    }
    req.log.error({ err }, "Failed to serve trade plan image");
    res.status(500).json({ error: String(err) });
  }
});

/**
 * DELETE /api/trade-plan/:id
 *
 * Removes the row and best-effort deletes the GCS image.
 * Deletion is the explicit reset path: user scraps a stale or failed plan
 * and re-uploads. Does NOT affect plans already consumed by a safeguard.
 */
router.delete("/trade-plan/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }

    const [row] = await db
      .select()
      .from(tradePlansTable)
      .where(eq(tradePlansTable.id, id))
      .limit(1);
    if (!row) { res.status(404).json({ error: "not found" }); return; }

    // Best-effort GCS delete — never fail the request if the image is gone
    try {
      const file = await objectStorageService.getObjectEntityFile(row.uploadKey);
      await file.delete({ ignoreNotFound: true });
    } catch (err) {
      req.log.warn({ err, id }, "trade plan GCS image delete skipped (not critical)");
    }

    await db.delete(tradePlansTable).where(eq(tradePlansTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete trade plan");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
