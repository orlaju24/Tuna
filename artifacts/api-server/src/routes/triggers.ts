import { Router } from "express";
import { db } from "../lib/db";
import { triggersTable, eventLogTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { watcherManager } from "../lib/watcher";

const router = Router();

router.get("/triggers", async (req, res) => {
  try {
    const rows = await db.select().from(triggersTable).orderBy(triggersTable.createdAt);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch triggers");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/triggers", async (req, res) => {
  const { symbol, triggerPrice, direction, closeMethod } = req.body;
  if (!symbol || !triggerPrice || !direction || !closeMethod) {
    res.status(400).json({ error: "symbol, triggerPrice, direction, closeMethod required" });
    return;
  }
  try {
    const [row] = await db
      .insert(triggersTable)
      .values({
        symbol: symbol.toUpperCase(),
        triggerPrice: String(triggerPrice),
        direction,
        closeMethod,
        armed: false,
        watcherStatus: "draft",
      })
      .returning();
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to create trigger");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/triggers/:id/arm", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    const [row] = await db
      .update(triggersTable)
      .set({ armed: true, watcherStatus: "armed", updatedAt: new Date() })
      .where(eq(triggersTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "trigger not found" });
      return;
    }
    watcherManager.arm(row);
    await db.insert(eventLogTable).values({
      symbol: row.symbol,
      eventType: "trigger_armed",
      eventMessage: `Trigger ${id} armed for ${row.symbol} @ ${row.triggerPrice} (${row.direction})`,
      source: "trigger",
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to arm trigger");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/triggers/:id/disarm", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    const [row] = await db
      .update(triggersTable)
      .set({ armed: false, watcherStatus: "cancelled", updatedAt: new Date() })
      .where(eq(triggersTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "trigger not found" });
      return;
    }
    watcherManager.disarm(id);
    await db.insert(eventLogTable).values({
      symbol: row.symbol,
      eventType: "trigger_disarmed",
      eventMessage: `Trigger ${id} disarmed`,
      source: "trigger",
    });
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to disarm trigger");
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/triggers/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    watcherManager.disarm(id);
    await db.delete(triggersTable).where(eq(triggersTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete trigger");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
