import { Router } from "express";
import { bitunixGet } from "../lib/bitunix";
import { cacheGet } from "../lib/apiCache";

const router = Router();

// 6 s TTL: frontend polls at 8–30 s depending on app state.
// All open tabs share one cached value — one Bitunix call per 6 s max,
// regardless of how many browser tabs are polling.
const ACCOUNT_TTL_MS = 6_000;

interface AccountData {
  marginCoin: string;
  available: string;
  frozen: string;
  margin: string;
  transfer: string;
  positionMode: string;
  crossUnrealizedPNL: string;
  isolationUnrealizedPNL: string;
  bonus: string;
}

router.get("/account", async (req, res) => {
  try {
    const response = await cacheGet(
      "account:USDT",
      ACCOUNT_TTL_MS,
      () => bitunixGet<AccountData>("/api/v1/futures/account", { marginCoin: "USDT" }),
    );
    res.json(response);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch account");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
