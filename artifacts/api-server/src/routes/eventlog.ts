import { Router } from "express";
import { db } from "../lib/db";
import { eventLogTable } from "@workspace/db/schema";
import { desc } from "drizzle-orm";

const router = Router();

router.get("/events", async (req, res) => {
  const limit = Math.min(parseInt(String(req.query.limit || "50")), 200);
  try {
    const rows = await db
      .select()
      .from(eventLogTable)
      .orderBy(desc(eventLogTable.createdAt))
      .limit(limit);
    res.json(rows);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch events");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
