/**
 * GET /api/edge-score/:symbol
 *
 * Returns a 0-100 setup quality score for the given symbol, assembled from:
 *   - The cached market-structure context (signalScore.ts)
 *   - Live account wallet data (margin exposure)
 *
 * Cached 30 s — faster than any frontend poll and shared across all tabs.
 */

import { Router } from "express";
import { bitunixGet } from "../lib/bitunix";
import { cacheGet } from "../lib/apiCache";
import { getStructureContext } from "../lib/signalScore";
import { computeEdgeScore } from "../lib/edgeScore";

const router = Router();
const EDGE_TTL_MS = 30_000;

interface AccountData {
  available: string;
  margin: string;
}

router.get("/edge-score/:symbol", async (req, res) => {
  const symbol = (req.params["symbol"] ?? "").toUpperCase();
  if (!symbol) {
    res.status(400).json({ code: -1, msg: "symbol path param required", data: null });
    return;
  }

  try {
    const data = await cacheGet(
      `edge-score:${symbol}`,
      EDGE_TTL_MS,
      async () => {
        // Share the account cache with /api/account — no separate Bitunix call
        // when the account was fetched in the last 6 s by any other route.
        const [ctx, accountResp] = await Promise.all([
          Promise.resolve(getStructureContext(symbol)),
          cacheGet("account:USDT", 6_000, () =>
            bitunixGet<AccountData>("/api/v1/futures/account", { marginCoin: "USDT" })
          ),
        ]);

        const acct = accountResp.data;
        const available     = acct ? (parseFloat(acct.available) || 0) : 0;
        const positionMargin = acct ? (parseFloat(acct.margin)    || 0) : 0;

        const edge = computeEdgeScore(ctx, { available, positionMargin });

        return {
          symbol,
          ...edge,
          structure: ctx,
        };
      },
    );

    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute edge score");
    res.status(502).json({ code: -1, msg: String(err), data: null });
  }
});

export default router;
