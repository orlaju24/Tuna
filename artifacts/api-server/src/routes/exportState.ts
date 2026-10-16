/**
 * State Export / Import
 *
 * GET  /api/export/state
 *   Returns a portable JSON snapshot of all strategy configuration and live
 *   state.  Safe to call at any time — read-only.  No secrets are included
 *   (API keys are env vars, never stored in DB).
 *
 *   Includes:
 *     • auto_entry_config  — all guardrail settings
 *     • triggers           — armed + pending triggers (re-arm after import)
 *     • safeguards         — currently armed safeguards (re-arm after import)
 *     • trade_plans        — last 10 uploaded chart plans
 *     • metadata           — export timestamp + schema version hint
 *
 * POST /api/import/state
 *   Restores configuration from an export payload.
 *   Safety rules:
 *     • auto_entry_config is upserted (merged, never clobbered)
 *     • triggers are inserted as DRAFT (armed=false) — operator must re-arm
 *     • safeguards are inserted as CANCELLED — for reference only; a new
 *       safeguard must be armed against the live position
 *     • trade_plans are skipped (charts reference external storage)
 *
 * This endpoint is the primary tool for migrating between hosts per the
 * portability requirement in the system PDF.
 */

import { Router } from "express";
import { db } from "../lib/db";
import {
  autoEntryConfigTable,
  triggersTable,
  safeguardsTable,
  tradePlansTable,
} from "@workspace/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";

const router = Router();

// ── Export ────────────────────────────────────────────────────────────────────

router.get("/export/state", async (req, res) => {
  try {
    const [autoEntryConfig, triggers, safeguards, tradePlans] = await Promise.all([
      db.select().from(autoEntryConfigTable).limit(1),
      db
        .select()
        .from(triggersTable)
        .where(inArray(triggersTable.watcherStatus, ["draft", "watching", "triggered"]))
        .orderBy(desc(triggersTable.createdAt))
        .limit(50),
      db
        .select()
        .from(safeguardsTable)
        .where(inArray(safeguardsTable.state, ["armed", "protecting"]))
        .orderBy(desc(safeguardsTable.createdAt))
        .limit(20),
      db
        .select()
        .from(tradePlansTable)
        .orderBy(desc(tradePlansTable.createdAt))
        .limit(10),
    ]);

    res.json({
      exportedAt:    new Date().toISOString(),
      schemaVersion: "1",
      autoEntryConfig: autoEntryConfig[0] ?? null,
      triggers,
      safeguards,
      tradePlans,
    });
  } catch (err) {
    req.log.error({ err }, "State export failed");
    res.status(500).json({ error: "Export failed", detail: String(err) });
  }
});

// ── Import ────────────────────────────────────────────────────────────────────

router.post("/import/state", async (req, res) => {
  const payload = req.body as {
    autoEntryConfig?: Record<string, unknown>;
    triggers?:        Record<string, unknown>[];
    safeguards?:      Record<string, unknown>[];
  };

  const report: { autoEntryConfig: string; triggers: string; safeguards: string } = {
    autoEntryConfig: "skipped",
    triggers:        "skipped",
    safeguards:      "skipped",
  };

  try {
    // ── Auto-entry config (upsert) ──────────────────────────────────────────
    if (payload.autoEntryConfig && typeof payload.autoEntryConfig === "object") {
      const cfg = payload.autoEntryConfig;
      const [existing] = await db.select().from(autoEntryConfigTable).limit(1);
      const safeFields: Partial<typeof autoEntryConfigTable.$inferInsert> = {
        symbol:             typeof cfg.symbol === "string"           ? cfg.symbol : undefined,
        side:               typeof cfg.side === "string"             ? cfg.side : undefined,
        maxMarginUsdt:      cfg.maxMarginUsdt != null                ? String(cfg.maxMarginUsdt) : undefined,
        leverage:           typeof cfg.leverage === "number"         ? cfg.leverage : undefined,
        minLiqGapUsdt:      cfg.minLiqGapUsdt != null               ? String(cfg.minLiqGapUsdt) : undefined,
        minEdgeScore:       typeof cfg.minEdgeScore === "number"     ? cfg.minEdgeScore : undefined,
        avoidMiddles:       typeof cfg.avoidMiddles === "boolean"    ? cfg.avoidMiddles : undefined,
        allowedWindowsJson: cfg.allowedWindowsJson ?? undefined,
        blockedWindowsJson: cfg.blockedWindowsJson ?? undefined,
        autoArmSafeguard:   typeof cfg.autoArmSafeguard === "boolean" ? cfg.autoArmSafeguard : undefined,
        safeguardThreshold1Pct: cfg.safeguardThreshold1Pct != null  ? String(cfg.safeguardThreshold1Pct) : undefined,
        safeguardTrailPct:  cfg.safeguardTrailPct != null           ? String(cfg.safeguardTrailPct) : undefined,
        // Governance states are intentionally reset on import for safety
        sessionFrozen:   false,
        walkAwayMode:    false,
        // enabled is intentionally reset to false — operator must re-enable
        enabled: false,
      };
      // Remove undefined keys
      const cleanFields = Object.fromEntries(
        Object.entries(safeFields).filter(([, v]) => v !== undefined),
      ) as Partial<typeof autoEntryConfigTable.$inferInsert>;

      if (existing) {
        await db.update(autoEntryConfigTable)
          .set({ ...cleanFields, updatedAt: new Date() })
          .where(eq(autoEntryConfigTable.id, existing.id));
        report.autoEntryConfig = "updated";
      } else {
        await db.insert(autoEntryConfigTable).values(cleanFields as typeof autoEntryConfigTable.$inferInsert);
        report.autoEntryConfig = "inserted";
      }
    }

    // ── Triggers (insert as draft — operator must re-arm) ──────────────────
    if (Array.isArray(payload.triggers) && payload.triggers.length > 0) {
      let inserted = 0;
      for (const t of payload.triggers) {
        if (typeof t.symbol !== "string" || t.triggerPrice == null) continue;
        await db.insert(triggersTable).values({
          symbol:       t.symbol,
          triggerPrice: String(t.triggerPrice),
          direction:    typeof t.direction === "string" ? t.direction : "cross_above",
          closeMethod:  typeof t.closeMethod === "string" ? t.closeMethod : "flash_close",
          armed:        false,        // safety: never auto-arm on import
          watcherStatus: "draft",
        });
        inserted++;
      }
      report.triggers = `${inserted} inserted as draft`;
    }

    // ── Safeguards (insert as cancelled — reference only) ──────────────────
    if (Array.isArray(payload.safeguards) && payload.safeguards.length > 0) {
      let inserted = 0;
      for (const s of payload.safeguards) {
        if (typeof s.symbol !== "string" || s.entryPrice == null) continue;
        await db.insert(safeguardsTable).values({
          symbol:          s.symbol,
          side:            typeof s.side === "string" ? s.side : "LONG",
          entryPrice:      String(s.entryPrice),
          qty:             s.qty != null ? String(s.qty) : "0",
          leverage:        typeof s.leverage === "number" ? s.leverage : 1,
          threshold1Pct:   s.threshold1Pct != null ? String(s.threshold1Pct) : "17",
          threshold2Pct:   s.threshold2Pct != null ? String(s.threshold2Pct) : "23",
          trailStepPct:    s.trailStepPct  != null ? String(s.trailStepPct)  : "3",
          closeMethod:     typeof s.closeMethod === "string" ? s.closeMethod : "flash_close",
          state:           "cancelled",  // safety: not live
        });
        inserted++;
      }
      report.safeguards = `${inserted} inserted as cancelled (historical reference)`;
    }

    logger.info({ report }, "State import completed");
    res.json({
      ok: true,
      report,
      notice: "auto_entry re-armed=false and sessionFrozen=false on import. Review triggers before arming. Safeguards inserted as cancelled — arm a new one against the live position.",
    });
  } catch (err) {
    req.log.error({ err }, "State import failed");
    res.status(500).json({ error: "Import failed", detail: String(err) });
  }
});

export default router;
