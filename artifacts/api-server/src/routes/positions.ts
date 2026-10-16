import { Router } from "express";
import { getOpenPositions } from "../lib/bitunix";
import { cacheGet } from "../lib/apiCache";

const router = Router();

// 3 s TTL: frontend polls at 4–15 s depending on app state.
// Multiple tabs (or rapid re-renders) share one in-flight result.
const POSITIONS_TTL_MS = 3_000;

router.get("/positions", async (req, res) => {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  try {
    const positions = await cacheGet(
      `positions:${symbol || "all"}`,
      POSITIONS_TTL_MS,
      () => getOpenPositions(symbol ? { symbol } : undefined),
    );
    res.json({ code: 0, msg: "success", data: positions });
  } catch (err) {
    req.log.error({ err }, "Failed to fetch positions");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
