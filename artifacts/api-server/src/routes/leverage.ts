import { Router } from "express";
import { bitunixGet, bitunixPost } from "../lib/bitunix";
import { cacheGet, cacheInvalidate } from "../lib/apiCache";

const router = Router();

// 20 s TTL: leverage rarely changes between user actions. Frontend polls at
// 30–60 s, so cached value is always fresh. Invalidated immediately on POST.
const LEVERAGE_TTL_MS = 20_000;

function leverageKey(symbol: string) {
  return `leverage:${symbol}`;
}

router.get("/leverage", async (req, res) => {
  const symbol = String(req.query.symbol || "");
  if (!symbol) {
    res.status(400).json({ code: -1, msg: "symbol is required", data: null });
    return;
  }
  try {
    const response = await cacheGet(
      leverageKey(symbol),
      LEVERAGE_TTL_MS,
      () =>
        bitunixGet("/api/v1/futures/account/get_leverage_margin_mode", {
          symbol,
          marginCoin: "USDT",
        }),
    );
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch leverage");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

router.post("/leverage", async (req, res) => {
  const { symbol, leverage, marginMode } = req.body;
  if (!symbol || !leverage) {
    res.status(400).json({ code: -1, msg: "symbol and leverage are required", data: null });
    return;
  }
  try {
    const result = await bitunixPost("/api/v1/futures/account/change_leverage", {
      symbol,
      marginCoin: "USDT",
      leverage: Number(leverage),
      ...(marginMode ? { marginMode } : {}),
    });
    // Invalidate so the next GET reflects the updated leverage immediately.
    cacheInvalidate(leverageKey(symbol));
    const verified = await bitunixGet("/api/v1/futures/account/get_leverage_margin_mode", {
      symbol,
      marginCoin: "USDT",
    });
    res.json({ code: 0, msg: "ok", data: { result, verified: verified.data } });
  } catch (err) {
    req.log.error({ err }, "Failed to change leverage");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
