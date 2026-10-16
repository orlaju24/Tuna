import { Router } from "express";
import multer from "multer";
import { randomUUID } from "crypto";
import { db } from "../lib/db";
import { hindsightExamplesTable } from "@workspace/db/schema";
import { openai } from "../lib/openaiClient";
import { objectStorageClient } from "../lib/objectStorage";
import { desc, eq, and, type SQL } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

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

// ── AI extraction ──────────────────────────────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a Bitunix futures trading screenshot to extract structured trade data.

Look carefully at the image and extract the following as a JSON object. Use null for fields you cannot determine with reasonable confidence.

{
  "direction": "LONG" | "SHORT" | null,
  "leverage": number | null,
  "entryPrice": number | null,
  "markPrice": number | null,
  "unrealizedRoiPct": number | null,
  "timeOfDayLabel": string | null,
  "sessionBucket": "asian" | "london" | "ny" | "pre-market" | null,
  "btcSpotPrice": number | null,
  "wholeNumberNearest": number | null,
  "wholeNumberRelation": "above" | "below" | "at" | null,
  "wholeNumberDistPct": number | null,
  "profitStatus": "win" | "loss" | "open" | null,
  "outcomeClass": "strong_win" | "win" | "scratch" | "loss" | "strong_loss" | null,
  "marketRegime": "trending_up" | "trending_down" | "ranging" | "volatile" | null,
  "closeType": "flash_close" | "tp" | "safeguard" | "manual" | "open" | "unknown",
  "confidenceScore": number,
  "extractionNotes": string
}

Session bucket: asian=18:00-02:00 UTC, london=02:00-10:00 UTC, ny=12:00-20:00 UTC.
BTC whole numbers are multiples of $1000 (e.g. $68000, $69000, $72000).
- "above" = current price > whole number (e.g. 68071 is above $68k).
- "below" = current price < whole number.
ROI: strong_win >= 25%, win 10-25%, scratch near 0%, loss -10 to -25%, strong_loss < -25%.
If screenshot shows Short position with positive PnL, profitStatus = "win".
Return ONLY the JSON object, no markdown.`;

async function extractFromImage(imageBuffer: Buffer, mimeType: string): Promise<Record<string, unknown>> {
  const base64 = imageBuffer.toString("base64");
  const response = await openai.chat.completions.create({
    model: "gpt-5.4",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: EXTRACTION_PROMPT },
          {
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}`, detail: "high" },
          },
        ],
      },
    ],
    max_tokens: 600,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    logger.warn({ text }, "Failed to parse AI extraction JSON");
    return { extractionNotes: text, confidenceScore: 0 };
  }
}

function sessionBucketFromTime(timeLabel: string | null): string | null {
  if (!timeLabel) return null;
  const match = timeLabel.match(/(\d{1,2}):(\d{2})\s*UTC([+-]\d+)?/i);
  if (!match) return null;
  const hour = parseInt(match[1]);
  const offset = match[3] ? parseInt(match[3]) : 0;
  const utcHour = ((hour - offset) % 24 + 24) % 24;
  if (utcHour >= 18 || utcHour < 2) return "asian";
  if (utcHour >= 2 && utcHour < 10) return "london";
  if (utcHour >= 12 && utcHour < 20) return "ny";
  return "pre-market";
}

// ── POST /api/hindsight/upload ─────────────────────────────────────────────
router.post("/hindsight/upload", upload.single("image"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "image file required" });
    return;
  }
  if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
    res.status(400).json({ error: `unsupported image type: ${file.mimetype}` });
    return;
  }

  const symbol = (req.body.symbol ?? "BTCUSDT").toUpperCase();
  const userNotes: string | null = req.body.notes ?? null;
  const tags: string | null = req.body.tags ?? null;

  // Phase 1: Store image (guaranteed)
  let imageKey: string | null = null;
  try {
    const objectId = randomUUID();
    const ext = file.mimetype.includes("png") ? "png" : "jpg";
    const fullPath = `${privateObjectPath()}/hindsight/${objectId}.${ext}`;
    const { bucketName, objectName } = parseBucketAndKey(fullPath);
    const bucket = objectStorageClient.bucket(bucketName);
    await bucket.file(objectName).save(file.buffer, {
      metadata: { contentType: file.mimetype },
    });
    imageKey = fullPath;
  } catch (err) {
    logger.warn({ err }, "Hindsight image storage failed — continuing without key");
  }

  // Phase 2: AI extraction (best-effort)
  let extracted: Record<string, unknown> = {};
  try {
    extracted = await extractFromImage(file.buffer, file.mimetype);
  } catch (err) {
    logger.warn({ err }, "Hindsight AI extraction failed");
    extracted = { confidenceScore: 0, extractionNotes: "AI extraction failed" };
  }

  const sessionBucket =
    (extracted.sessionBucket as string | null) ??
    sessionBucketFromTime(extracted.timeOfDayLabel as string | null);

  try {
    const [row] = await db.insert(hindsightExamplesTable).values({
      symbol,
      source: "upload",
      direction:           (extracted.direction as string) ?? null,
      leverage:            extracted.leverage != null ? Number(extracted.leverage) : null,
      entryPrice:          extracted.entryPrice != null ? String(extracted.entryPrice) : null,
      exitPrice:           null,
      roiPct:              extracted.unrealizedRoiPct != null ? String(extracted.unrealizedRoiPct) : null,
      btcSpotPrice:        extracted.btcSpotPrice != null ? String(extracted.btcSpotPrice) : null,
      wholeNumberNearest:  extracted.wholeNumberNearest != null ? String(extracted.wholeNumberNearest) : null,
      wholeNumberRelation: (extracted.wholeNumberRelation as string) ?? null,
      wholeNumberDistPct:  extracted.wholeNumberDistPct != null ? String(extracted.wholeNumberDistPct) : null,
      timeOfDayLabel:      (extracted.timeOfDayLabel as string) ?? null,
      sessionBucket:       sessionBucket ?? null,
      profitStatus:        (extracted.profitStatus as string) ?? null,
      outcomeClass:        (extracted.outcomeClass as string) ?? null,
      marketRegime:        (extracted.marketRegime as string) ?? null,
      closeType:           (extracted.closeType as string) ?? "unknown",
      triggerType:         "unknown",
      confidenceScore:     extracted.confidenceScore != null ? Number(extracted.confidenceScore) : null,
      extractionNotes:     (extracted.extractionNotes as string) ?? null,
      rawExtraction:       extracted,
      imageKey,
      userNotes,
      tags,
    }).returning();

    res.json({ ok: true, id: row.id, extracted, imageKey });
  } catch (err) {
    req.log.error({ err }, "Failed to insert hindsight example");
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/hindsight ─────────────────────────────────────────────────────
router.get("/hindsight", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "50")), 200);
  const symbol    = req.query.symbol      ? String(req.query.symbol).toUpperCase()      : null;
  const direction = req.query.direction   ? String(req.query.direction).toUpperCase()   : null;
  const outcomeClass   = req.query.outcomeClass   ? String(req.query.outcomeClass)   : null;
  const sessionBucket  = req.query.sessionBucket  ? String(req.query.sessionBucket)  : null;

  try {
    const conditions: SQL[] = [];
    if (symbol)       conditions.push(eq(hindsightExamplesTable.symbol, symbol));
    if (direction)    conditions.push(eq(hindsightExamplesTable.direction, direction));
    if (outcomeClass) conditions.push(eq(hindsightExamplesTable.outcomeClass, outcomeClass));
    if (sessionBucket)conditions.push(eq(hindsightExamplesTable.sessionBucket, sessionBucket));

    const rows = await db
      .select()
      .from(hindsightExamplesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(hindsightExamplesTable.createdAt))
      .limit(limit);

    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch hindsight examples");
    res.status(500).json({ error: String(err) });
  }
});

// ── GET /api/hindsight/summary ─────────────────────────────────────────────
router.get("/hindsight/summary", async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(hindsightExamplesTable)
      .orderBy(desc(hindsightExamplesTable.createdAt))
      .limit(500);

    const concluded = rows.filter(r => r.profitStatus !== "open" && r.profitStatus != null);
    const wins   = rows.filter(r => r.profitStatus === "win");
    const losses = rows.filter(r => r.profitStatus === "loss");
    const shorts = rows.filter(r => r.direction === "SHORT");
    const longs  = rows.filter(r => r.direction === "LONG");

    const bySession = rows.reduce<Record<string, number>>((acc, r) => {
      const k = r.sessionBucket ?? "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

    const byOutcome = rows.reduce<Record<string, number>>((acc, r) => {
      const k = r.outcomeClass ?? "unknown";
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});

    const shortWins = shorts.filter(r => r.profitStatus === "win");
    const longWins  = longs.filter(r => r.profitStatus === "win");

    res.json({
      total: rows.length,
      wins: wins.length,
      losses: losses.length,
      winRate: concluded.length > 0 ? wins.length / concluded.length : null,
      shorts: shorts.length,
      longs: longs.length,
      shortWinRate: shorts.length > 0 ? shortWins.length / shorts.length : null,
      longWinRate:  longs.length  > 0 ? longWins.length  / longs.length  : null,
      bySession,
      byOutcome,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to compute hindsight summary");
    res.status(500).json({ error: String(err) });
  }
});

// ── DELETE /api/hindsight/:id ──────────────────────────────────────────────
router.delete("/hindsight/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) { res.status(400).json({ error: "invalid id" }); return; }
  try {
    await db.delete(hindsightExamplesTable).where(eq(hindsightExamplesTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete hindsight example");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
