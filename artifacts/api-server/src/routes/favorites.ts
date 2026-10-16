import { Router } from "express";
import { db } from "../lib/db";
import { favoritesTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router = Router();

router.get("/favorites", async (req, res) => {
  try {
    const rows = await db.select().from(favoritesTable).orderBy(favoritesTable.sortOrder);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch favorites");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/favorites", async (req, res) => {
  const { symbol, sortOrder } = req.body;
  if (!symbol) {
    res.status(400).json({ error: "symbol is required" });
    return;
  }
  try {
    const [row] = await db
      .insert(favoritesTable)
      .values({ symbol: symbol.toUpperCase(), sortOrder: sortOrder ?? 0 })
      .returning();
    res.json(row);
  } catch (err) {
    req.log.error({ err }, "Failed to add favorite");
    res.status(500).json({ error: String(err) });
  }
});

router.delete("/favorites/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  try {
    await db.delete(favoritesTable).where(eq(favoritesTable.id, id));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete favorite");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
