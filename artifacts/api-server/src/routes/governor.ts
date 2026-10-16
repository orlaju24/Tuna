import { Router } from "express";
import { getGovernorState, invalidateGovernorCache } from "../lib/behaviorGovernor";

const router = Router();

// GET /api/governor — returns current behavioral score + adjustments
router.get("/governor", async (req, res) => {
  try {
    const state = await getGovernorState();
    res.json(state);
  } catch (err) {
    req.log.error({ err }, "Governor state computation failed");
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/governor/reset — force cache flush (manual override after review)
router.post("/governor/reset", async (req, res) => {
  try {
    invalidateGovernorCache();
    const state = await getGovernorState();
    req.log.info({ score: state.score, grade: state.grade }, "Governor cache reset by user");
    res.json({ ok: true, state });
  } catch (err) {
    req.log.error({ err }, "Governor reset failed");
    res.status(500).json({ error: String(err) });
  }
});

export default router;
