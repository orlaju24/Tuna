/**
 * Health check endpoint — verifies DB and exchange connectivity.
 *
 * GET /api/healthz
 *
 * Returns 200 when all systems are reachable, 503 when any critical
 * dependency is down.  The response body always includes a per-system
 * status so the caller can distinguish partial failures.
 *
 * Designed to degrade gracefully: one failing check does not crash the
 * server — it is reported in the response.  This supports the PDF's
 * requirement that the app "should degrade gracefully rather than collapse".
 */

import { Router, type IRouter } from "express";
import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { bitunixGet } from "../lib/bitunix";

const router: IRouter = Router();

router.get("/healthz", async (_req, res) => {
  const results: Record<string, { ok: boolean; latencyMs?: number; error?: string }> = {};

  // ── Database ──────────────────────────────────────────────────────────────
  const dbStart = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    results.database = { ok: true, latencyMs: Date.now() - dbStart };
  } catch (err) {
    results.database = { ok: false, latencyMs: Date.now() - dbStart, error: String(err) };
  }

  // ── Bitunix exchange ──────────────────────────────────────────────────────
  const exStart = Date.now();
  try {
    await bitunixGet("/api/v1/futures/account", { marginCoin: "USDT" });
    results.exchange = { ok: true, latencyMs: Date.now() - exStart };
  } catch (err) {
    results.exchange = { ok: false, latencyMs: Date.now() - exStart, error: String(err) };
  }

  const allOk = Object.values(results).every((r) => r.ok);
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks: results,
  });
});

export default router;
