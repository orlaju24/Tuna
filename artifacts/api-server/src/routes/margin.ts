import { Router } from "express";
import { bitunixPost, bitunixGet } from "../lib/bitunix";

const router = Router();

router.post("/margin/adjust", async (req, res) => {
  const { symbol, positionId, amount, type } = req.body;
  if (!symbol || !positionId || !amount || !type) {
    res.status(400).json({ code: -1, msg: "symbol, positionId, amount, type are required", data: null });
    return;
  }
  try {
    const result = await bitunixPost("/api/v1/futures/account/adjust_position_margin", {
      symbol,
      marginCoin: "USDT",
      positionId,
      amount: String(amount),
      type, // "ADD" or "REDUCE"
    });
    const verified = await bitunixGet("/api/v1/futures/position/get_pending_positions", { symbol });
    res.json({ code: 0, msg: "ok", data: { result, verified: verified.data } });
  } catch (err) {
    req.log.error({ err }, "Failed to adjust margin");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
