import { Router } from "express";
import { db } from "../lib/db";
import { autoEntryConfigTable, eventLogTable } from "@workspace/db/schema";
import { autoEntryWatcher, getRecentAutoEntryLog } from "../lib/autoEntryWatcher";

const router = Router();

// GET /api/auto-entry/config
router.get("/auto-entry/config", async (req, res) => {
  try {
    const [config] = await db.select().from(autoEntryConfigTable).limit(1);
    if (!config) {
      res.status(404).json({ error: "No config found — server not fully initialised" });
      return;
    }
    res.json(config);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch auto-entry config");
    res.status(500).json({ error: String(err) });
  }
});

// PUT /api/auto-entry/config — update any subset of config fields
router.put("/auto-entry/config", async (req, res) => {
  const {
    symbol,
    side,
    maxMarginUsdt,
    leverage,
    minLiqGapUsdt,
    minEdgeScore,
    avoidMiddles,
    allowedWindowsJson,
    blockedWindowsJson,
    autoArmSafeguard,
    safeguardThreshold1Pct,
    safeguardTrailPct,
    sessionFrozen,
    walkAwayMode,
  } = req.body;

  // Validate side if provided
  if (side && !["LONG", "SHORT", "SIGNAL"].includes(side.toUpperCase())) {
    res.status(400).json({ error: "side must be LONG, SHORT, or SIGNAL" });
    return;
  }

  try {
    const [existing] = await db.select().from(autoEntryConfigTable).limit(1);
    if (!existing) {
      res.status(404).json({ error: "Config not initialised" });
      return;
    }

    const updates: Partial<typeof autoEntryConfigTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (symbol              !== undefined) updates.symbol              = symbol.toUpperCase();
    if (side                !== undefined) updates.side                = side.toUpperCase();
    if (maxMarginUsdt       !== undefined) updates.maxMarginUsdt       = String(maxMarginUsdt);
    if (leverage            !== undefined) updates.leverage            = Number(leverage);
    if (minLiqGapUsdt       !== undefined) updates.minLiqGapUsdt       = String(minLiqGapUsdt);
    if (minEdgeScore        !== undefined) updates.minEdgeScore        = Number(minEdgeScore);
    if (avoidMiddles        !== undefined) updates.avoidMiddles        = Boolean(avoidMiddles);
    if (allowedWindowsJson  !== undefined) updates.allowedWindowsJson  = allowedWindowsJson;
    if (blockedWindowsJson  !== undefined) updates.blockedWindowsJson  = blockedWindowsJson;
    if (autoArmSafeguard    !== undefined) updates.autoArmSafeguard    = Boolean(autoArmSafeguard);
    if (safeguardThreshold1Pct !== undefined) updates.safeguardThreshold1Pct = String(safeguardThreshold1Pct);
    if (safeguardTrailPct   !== undefined) updates.safeguardTrailPct   = String(safeguardTrailPct);
    if (sessionFrozen       !== undefined) updates.sessionFrozen       = Boolean(sessionFrozen);
    if (walkAwayMode        !== undefined) updates.walkAwayMode        = Boolean(walkAwayMode);

    const [updated] = await db
      .update(autoEntryConfigTable)
      .set(updates)
      .returning();

    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update auto-entry config");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auto-entry/enable
router.post("/auto-entry/enable", async (req, res) => {
  try {
    const [updated] = await db
      .update(autoEntryConfigTable)
      .set({ enabled: true, updatedAt: new Date() })
      .returning();
    res.json({ enabled: true, config: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to enable auto-entry");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auto-entry/disable
router.post("/auto-entry/disable", async (req, res) => {
  try {
    const [updated] = await db
      .update(autoEntryConfigTable)
      .set({ enabled: false, updatedAt: new Date() })
      .returning();
    res.json({ enabled: false, config: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to disable auto-entry");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auto-entry/freeze — engage session kill-switch
router.post("/auto-entry/freeze", async (req, res) => {
  try {
    const [updated] = await db
      .update(autoEntryConfigTable)
      .set({ sessionFrozen: true, updatedAt: new Date() })
      .returning();
    await db.insert(eventLogTable).values({
      symbol: updated.symbol,
      eventType: "freeze_activated",
      eventMessage: `[FROZEN] Session freeze engaged manually. All auto-entry blocked until unfrozen.`,
      source: "auto_entry",
    });
    res.json({ sessionFrozen: true, config: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to freeze session");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auto-entry/unfreeze — lift session kill-switch
router.post("/auto-entry/unfreeze", async (req, res) => {
  try {
    const [updated] = await db
      .update(autoEntryConfigTable)
      .set({ sessionFrozen: false, updatedAt: new Date() })
      .returning();
    await db.insert(eventLogTable).values({
      symbol: updated.symbol,
      eventType: "freeze_lifted",
      eventMessage: `[UNFROZEN] Session freeze lifted. Oracle will resume evaluating conditions on next cycle.`,
      source: "auto_entry",
    });
    res.json({ sessionFrozen: false, config: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to unfreeze session");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auto-entry/walk-away — engage walk-away (manual stand-down)
router.post("/auto-entry/walk-away", async (req, res) => {
  try {
    const [updated] = await db
      .update(autoEntryConfigTable)
      .set({ walkAwayMode: true, updatedAt: new Date() })
      .returning();
    await db.insert(eventLogTable).values({
      symbol: updated.symbol,
      eventType: "walk_away_engaged",
      eventMessage: `[WALK AWAY] Standing down — oracle will not re-enter until you tap Resume. Wait for a fresh plan and structure reconfirmation.`,
      source: "auto_entry",
    });
    res.json({ walkAwayMode: true, config: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to engage walk-away");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/auto-entry/resume — lift walk-away mode
router.post("/auto-entry/resume", async (req, res) => {
  try {
    const [updated] = await db
      .update(autoEntryConfigTable)
      .set({ walkAwayMode: false, updatedAt: new Date() })
      .returning();
    await db.insert(eventLogTable).values({
      symbol: updated.symbol,
      eventType: "walk_away_lifted",
      eventMessage: `[RESUMED] Walk Away lifted. Oracle is scanning again — confirm the setup before auto-entry fires.`,
      source: "auto_entry",
    });
    res.json({ walkAwayMode: false, config: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to lift walk-away");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/auto-entry/status — current eval state + last result
router.get("/auto-entry/status", async (req, res) => {
  try {
    const [config] = await db.select().from(autoEntryConfigTable).limit(1);
    const lastResult = autoEntryWatcher.getLastResult();
    const recentLog = await getRecentAutoEntryLog(5);
    res.json({
      enabled: config?.enabled ?? false,
      lastResult,
      recentLog,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch auto-entry status");
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/auto-entry/log — full recent evaluation log
router.get("/auto-entry/log", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit ?? "50")), 200);
  try {
    const rows = await getRecentAutoEntryLog(limit);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch auto-entry log");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
