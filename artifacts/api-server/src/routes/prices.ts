import { Router } from "express";
import { handleSSE, priceStream } from "../lib/priceStream";

const router = Router();

const MAX_SYMBOLS_QUERY_LENGTH = 512;

router.get("/prices/stream", (req, res) => {
  const symbols = String(req.query.symbols || "");
  if (!symbols) {
    res.status(400).json({ code: -1, msg: "symbols query param required", data: null });
    return;
  }
  if (symbols.length > MAX_SYMBOLS_QUERY_LENGTH) {
    res.status(400).json({ code: -1, msg: "symbols query param too long", data: null });
    return;
  }
  handleSSE(symbols, res);
});

// Diagnostics: live status of the shared price stream (WS state, last message, cached prices)
router.get("/prices/status", (_req, res) => {
  res.json({ code: 0, msg: "ok", data: priceStream.status() });
});

export default router;
