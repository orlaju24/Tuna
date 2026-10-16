import { Router } from "express";
import {
  canExecuteKill,
  canFire,
  positionLockKey,
  releaseKill,
  release,
} from "../lib/cooldown.js";
import {
  closeAllPositions,
  flashClosePosition,
  getOpenPositions,
  getPositionMode,
  setLeverage,
  adjustPositionMargin,
  placeMarketOrder,
  getAccountInfo,
  getLeverageMarginMode,
  getTickerPrice,
  getTickerPrices,
  getKlines,
} from "../lib/bitunix.js";
import { logEvent, readLogs } from "../lib/actionLog.js";

const router = Router();

const COOLDOWN_SECONDS = parseInt(process.env["KILL_COOLDOWN"] ?? "3", 10);
const APP_PASSWORD = process.env["APP_PASSWORD"];
const TRIGGER_TOKEN = process.env["INTERNAL_TRIGGER_TOKEN"];
const TRIGGER_MAX_AGE_MS = 10_000;

const DEFAULT_SYMBOL = process.env["DEFAULT_SYMBOL"] ?? "BTCUSDT";
const VALID_LEVERAGES = [71, 77, 81, 85] as const;
type ValidLeverage = (typeof VALID_LEVERAGES)[number];
const DEFAULT_LEVERAGE: ValidLeverage = 81;

const TRADE_LOCK_KEY = "trade_entry";
const TRADE_LOCK_SECONDS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Handler = Parameters<typeof router.post>[1];
type Req = Parameters<Handler>[0];
type Res = Parameters<Handler>[1];

function requireAppKey(req: Req, res: Res): boolean {
  const key = req.headers["x-key"];
  if (!APP_PASSWORD || key !== APP_PASSWORD) {
    res.status(403).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function resolveSymbol(raw: unknown): string {
  const s = String(raw ?? "").trim().toUpperCase();
  return s || DEFAULT_SYMBOL;
}

async function pollUntilFlat(
  symbol: string,
  maxPolls = 8,
  intervalMs = 700,
): Promise<{ status: "CLOSED" | "STILL_OPEN"; remaining: number }> {
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const positions = await getOpenPositions({ symbol });
      if (positions.length === 0) return { status: "CLOSED", remaining: 0 };
    } catch {
      // transient — continue
    }
  }
  const final = await getOpenPositions({ symbol });
  return {
    status: final.length === 0 ? "CLOSED" : "STILL_OPEN",
    remaining: final.length,
  };
}

async function pollUntilPositionGone(
  positionId: string,
  symbol: string,
  maxPolls = 6,
  intervalMs = 600,
): Promise<"CLOSED" | "STILL_OPEN"> {
  for (let i = 0; i < maxPolls; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const positions = await getOpenPositions({ symbol });
      if (!positions.some((p) => p.positionId === positionId)) return "CLOSED";
    } catch {
      // transient — continue
    }
  }
  return "STILL_OPEN";
}

// ---------------------------------------------------------------------------
// Kill-switch execution
// ---------------------------------------------------------------------------

async function executeKill(
  source: "manual_ui" | "trigger",
  symbol: string,
  res: Res,
  meta?: { triggerPrice?: number; triggerSymbol?: string },
): Promise<void> {
  const start = Date.now();

  logEvent({
    ts: Date.now(),
    action: "kill",
    source,
    status: "requested",
    symbol,
    exchangeEndpoint: "/api/v1/futures/trade/close_all_position",
    verification: "pending",
    ...meta,
  });

  try {
    await Promise.race([
      closeAllPositions(symbol),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Exchange timeout")), 5000),
      ),
    ]);

    let { status, remaining } = await pollUntilFlat(symbol, 8, 700);

    if (status === "STILL_OPEN") {
      logEvent({
        ts: Date.now(),
        action: "kill_retry",
        source,
        status: "retrying",
        symbol,
        exchangeEndpoint: "/api/v1/futures/trade/close_all_position",
        remaining,
        verification: "still_open_after_first_close",
      });
      await closeAllPositions(symbol);
      const second = await pollUntilFlat(symbol, 5, 700);
      status = second.status;
      remaining = second.remaining;
    }

    const durationMs = Date.now() - start;
    logEvent({
      ts: Date.now(),
      action: "kill",
      source,
      status: status === "CLOSED" ? "success" : "still_open",
      symbol,
      exchangeEndpoint: "/api/v1/futures/trade/close_all_position",
      remaining,
      durationMs,
      verification: status === "CLOSED" ? "confirmed_flat" : "positions_remain",
      ...meta,
    });

    res.json({ ok: true, status, remaining, durationMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;
    logEvent({
      ts: Date.now(),
      action: "kill",
      source,
      status: "error",
      symbol,
      exchangeEndpoint: "/api/v1/futures/trade/close_all_position",
      error: message,
      durationMs,
      verification: "unknown",
      ...meta,
    });
    releaseKill();
    res.status(500).json({ error: message });
  }
}

// ---------------------------------------------------------------------------
// Trade entry
// ---------------------------------------------------------------------------

async function executeTrade(
  direction: "long" | "short",
  symbol: string,
  amount: string,
  leverage: ValidLeverage,
  source: "manual_ui",
  res: Res,
): Promise<void> {
  const start = Date.now();
  const side = direction === "long" ? "BUY" : "SELL";

  logEvent({
    ts: Date.now(),
    action: direction === "long" ? "open_long" : "open_short",
    source,
    status: "requested",
    symbol,
    amount,
    leverageTarget: leverage,
    exchangeEndpoint: "/api/v1/futures/trade/place_order",
  });

  try {
    const positions = await getOpenPositions({ symbol });
    if (positions.length > 0) {
      release(TRADE_LOCK_KEY);
      logEvent({
        ts: Date.now(),
        action: direction === "long" ? "open_long" : "open_short",
        source,
        status: "blocked",
        symbol,
        amount,
        leverageTarget: leverage,
        exchangeEndpoint: "/api/v1/futures/trade/place_order",
        error: `Existing ${symbol} position detected`,
      });
      res.status(409).json({ error: `Existing ${symbol} position detected. Close it first.` });
      return;
    }

    const positionMode = await getPositionMode();

    try {
      await setLeverage(symbol, leverage);
      logEvent({
        ts: Date.now(),
        action: "set_leverage",
        source,
        status: "success",
        symbol,
        leverageTarget: leverage,
        positionMode,
        exchangeEndpoint: "/api/v1/futures/account/change_leverage",
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      release(TRADE_LOCK_KEY);
      logEvent({
        ts: Date.now(),
        action: "set_leverage",
        source,
        status: "error",
        symbol,
        leverageTarget: leverage,
        exchangeEndpoint: "/api/v1/futures/account/change_leverage",
        error: message,
      });
      res.status(500).json({ error: `Leverage set failed: ${message}` });
      return;
    }

    const result = await placeMarketOrder({ symbol, side, qty: amount, positionMode });
    const durationMs = Date.now() - start;

    logEvent({
      ts: Date.now(),
      action: direction === "long" ? "open_long" : "open_short",
      source,
      status: "submitted",
      symbol,
      amount,
      leverageTarget: leverage,
      positionMode,
      exchangeEndpoint: "/api/v1/futures/trade/place_order",
      durationMs,
    });

    res.json({
      ok: true,
      orderId: result.orderId,
      symbol,
      side: direction === "long" ? "LONG" : "SHORT",
      leverage,
      durationMs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;
    release(TRADE_LOCK_KEY);
    logEvent({
      ts: Date.now(),
      action: direction === "long" ? "open_long" : "open_short",
      source,
      status: "error",
      symbol,
      amount,
      leverageTarget: leverage,
      exchangeEndpoint: "/api/v1/futures/trade/place_order",
      error: message,
      durationMs,
    });
    res.status(500).json({ error: message });
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /account — USDT balance + equity from Bitunix
router.get("/account", async (req, res) => {
  if (!requireAppKey(req, res)) return;
  try {
    const info = await getAccountInfo();
    res.json({
      available: info.available,
      balance: info.balance,
      frozen: info.frozen,
      unrealizedPNL: info.unrealizedPNL,
      bonus: info.bonus,
      positionMode: info.positionMode,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /ticker?symbol=BTCUSDT — live price from Bitunix public ticker endpoint
router.get("/ticker", async (req, res) => {
  if (!requireAppKey(req, res)) return;
  const symbol = String(req.query["symbol"] ?? "").toUpperCase();
  if (!symbol) {
    res.status(400).json({ error: "symbol query param required" });
    return;
  }
  try {
    const price = await getTickerPrice(symbol);
    res.json({ symbol, price });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /prices?symbols=BTCUSDT,ETHUSDT — batch prices for the favorites strip
router.get("/prices", async (req, res) => {
  if (!requireAppKey(req, res)) return;
  const raw = String(req.query["symbols"] ?? "");
  const symbols = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (!symbols.length) {
    res.status(400).json({ error: "symbols query param required" });
    return;
  }
  try {
    const prices = await getTickerPrices(symbols);
    res.json(prices);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /klines?symbol=BTCUSDT&interval=3min&limit=20 — candlestick bars
router.get("/klines", async (req, res) => {
  if (!requireAppKey(req, res)) return;
  const symbol = resolveSymbol(req.query["symbol"]);
  const interval = String(req.query["interval"] ?? "3min");
  const limit = Math.min(100, Math.max(5, parseInt(String(req.query["limit"] ?? "20"), 10)));
  try {
    const bars = await getKlines(symbol, interval, limit);
    res.json(bars);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// GET /symbol/:symbol/info — leverage + margin mode from Bitunix for a given symbol
router.get("/symbol/:symbol/info", async (req, res) => {
  if (!requireAppKey(req, res)) return;
  const symbol = req.params.symbol.toUpperCase();
  try {
    const [levMargin, positions] = await Promise.all([
      getLeverageMarginMode(symbol),
      getOpenPositions({ symbol }),
    ]);

    const position = positions[0] ?? null;
    res.json({
      symbol,
      leverage: levMargin.leverage,
      marginMode: levMargin.marginMode,
      hasPosition: positions.length > 0,
      position: position
        ? {
            positionId: position.positionId ?? "",
            side: position.side ?? "",
            qty: position.qty ?? "",
            entryPrice: position.avgOpenPrice ?? "",
            liqPrice: position.liqPrice ?? "",
            unrealizedPNL: position.unrealizedPNL ?? "",
            margin: position.margin ?? "",
            leverage: String(position.leverage ?? levMargin.leverage),
            marginMode: position.marginMode ?? levMargin.marginMode,
          }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /leverage
router.post("/leverage", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const { leverage, symbol: rawSymbol } = req.body as { leverage?: number; symbol?: string };
  const symbol = resolveSymbol(rawSymbol);

  if (!leverage || !(VALID_LEVERAGES as readonly number[]).includes(leverage)) {
    res.status(400).json({
      error: `Invalid leverage. Must be one of: ${VALID_LEVERAGES.join(", ")}`,
    });
    return;
  }

  const lev = leverage as ValidLeverage;
  const start = Date.now();

  try {
    await setLeverage(symbol, lev);
    const durationMs = Date.now() - start;
    logEvent({
      ts: Date.now(),
      action: "set_leverage",
      source: "manual_ui",
      status: "success",
      symbol,
      leverageTarget: lev,
      exchangeEndpoint: "/api/v1/futures/account/change_leverage",
      durationMs,
    });
    res.json({ ok: true, leverage: lev, symbol, durationMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;
    logEvent({
      ts: Date.now(),
      action: "set_leverage",
      source: "manual_ui",
      status: "error",
      symbol,
      leverageTarget: lev,
      exchangeEndpoint: "/api/v1/futures/account/change_leverage",
      error: message,
      durationMs,
    });
    res.status(500).json({ error: message });
  }
});

// POST /trade/long
router.post("/trade/long", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const { amount, leverage, symbol: rawSymbol } = req.body as {
    amount?: string;
    leverage?: number;
    symbol?: string;
  };
  const symbol = resolveSymbol(rawSymbol);
  const qty = String(amount ?? "").trim();
  const lev: ValidLeverage = (VALID_LEVERAGES as readonly number[]).includes(leverage ?? 0)
    ? (leverage as ValidLeverage)
    : DEFAULT_LEVERAGE;

  if (!qty || isNaN(parseFloat(qty)) || parseFloat(qty) <= 0) {
    res.status(400).json({ error: "Invalid amount. Provide a positive numeric quantity." });
    return;
  }

  if (!canFire(TRADE_LOCK_KEY, TRADE_LOCK_SECONDS)) {
    res.status(409).json({ error: "Trade lock active. Wait before retrying." });
    return;
  }

  await executeTrade("long", symbol, qty, lev, "manual_ui", res);
});

// POST /trade/short
router.post("/trade/short", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const { amount, leverage, symbol: rawSymbol } = req.body as {
    amount?: string;
    leverage?: number;
    symbol?: string;
  };
  const symbol = resolveSymbol(rawSymbol);
  const qty = String(amount ?? "").trim();
  const lev: ValidLeverage = (VALID_LEVERAGES as readonly number[]).includes(leverage ?? 0)
    ? (leverage as ValidLeverage)
    : DEFAULT_LEVERAGE;

  if (!qty || isNaN(parseFloat(qty)) || parseFloat(qty) <= 0) {
    res.status(400).json({ error: "Invalid amount. Provide a positive numeric quantity." });
    return;
  }

  if (!canFire(TRADE_LOCK_KEY, TRADE_LOCK_SECONDS)) {
    res.status(409).json({ error: "Trade lock active. Wait before retrying." });
    return;
  }

  await executeTrade("short", symbol, qty, lev, "manual_ui", res);
});

// POST /kill — close all positions for a symbol
router.post("/kill", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const { symbol: rawSymbol } = req.body as { symbol?: string };
  const symbol = resolveSymbol(rawSymbol);

  if (!canExecuteKill(COOLDOWN_SECONDS)) {
    res.status(409).json({ error: "Kill lock active. Wait for cooldown." });
    return;
  }

  await executeKill("manual_ui", symbol, res);
});

// GET /positions — open positions, optional ?symbol= filter
router.get("/positions", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const symbol = req.query["symbol"] ? String(req.query["symbol"]).toUpperCase() : undefined;

  try {
    const [raw, positionMode] = await Promise.all([
      getOpenPositions(symbol ? { symbol } : undefined),
      getPositionMode(),
    ]);

    const positions = raw.map((p) => ({
      positionId: p.positionId ?? "",
      symbol: p.symbol ?? "",
      side: p.side ?? "",
      qty: p.qty ?? "",
      size: p.qty ?? "",
      marginMode: p.marginMode ?? "",
      positionMode: p.positionMode ?? "",
      leverage: p.leverage !== undefined ? String(p.leverage) : "",
      entryPrice: p.avgOpenPrice ?? "",
      liqPrice: p.liqPrice ?? "",
      unrealisedPnl: p.unrealizedPNL ?? "",
      margin: p.margin ?? "",
      realizedPNL: p.realizedPNL ?? "",
    }));

    res.json({ positions, count: positions.length, positionMode });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// POST /positions/:positionId/close
router.post("/positions/:positionId/close", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const { positionId } = req.params;
  const { symbol: rawSymbol } = req.body as { symbol?: string };
  const symbol = resolveSymbol(rawSymbol);
  const lockKey = positionLockKey(positionId);

  if (!canFire(lockKey, 1)) {
    res.status(409).json({ error: "Position lock active. Wait before retrying." });
    return;
  }

  const start = Date.now();

  logEvent({
    ts: Date.now(),
    action: "flash_close",
    source: "manual_ui",
    status: "requested",
    symbol,
    exchangeEndpoint: "/api/v1/futures/trade/flash_close_position",
    positionId,
    verification: "pending",
  });

  try {
    await Promise.race([
      flashClosePosition(positionId),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Exchange timeout")), 5000),
      ),
    ]);

    const status = await pollUntilPositionGone(positionId, symbol, 6, 600);
    const durationMs = Date.now() - start;

    logEvent({
      ts: Date.now(),
      action: "flash_close",
      source: "manual_ui",
      status: status === "CLOSED" ? "success" : "still_open",
      symbol,
      exchangeEndpoint: "/api/v1/futures/trade/flash_close_position",
      positionId,
      durationMs,
      verification: status === "CLOSED" ? "confirmed_gone" : "still_in_pending_list",
    });

    res.json({ ok: true, status, positionId, durationMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;

    logEvent({
      ts: Date.now(),
      action: "flash_close",
      source: "manual_ui",
      status: "error",
      symbol,
      exchangeEndpoint: "/api/v1/futures/trade/flash_close_position",
      positionId,
      error: message,
      durationMs,
      verification: "unknown",
    });

    release(lockKey);
    res.status(500).json({ error: message });
  }
});

// POST /positions/:positionId/margin
router.post("/positions/:positionId/margin", async (req, res) => {
  if (!requireAppKey(req, res)) return;

  const { positionId } = req.params;
  const { amount, type, side, symbol: rawSymbol } = req.body as {
    amount?: string;
    type?: "ADD" | "REDUCE";
    side?: string;
    symbol?: string;
  };
  const symbol = resolveSymbol(rawSymbol);

  const amt = String(amount ?? "").trim();
  if (!amt || isNaN(parseFloat(amt)) || parseFloat(amt) <= 0) {
    res.status(400).json({ error: "Invalid amount. Provide a positive USDT amount." });
    return;
  }
  if (type !== "ADD" && type !== "REDUCE") {
    res.status(400).json({ error: "type must be ADD or REDUCE" });
    return;
  }
  if (!side) {
    res.status(400).json({ error: "side is required (LONG or SHORT)" });
    return;
  }

  const lockKey = positionLockKey(`margin_${positionId}`);
  if (!canFire(lockKey, 2)) {
    res.status(409).json({ error: "Margin lock active. Wait before retrying." });
    return;
  }

  const start = Date.now();

  try {
    await adjustPositionMargin({ symbol, side, amount: amt, type });
    const durationMs = Date.now() - start;

    logEvent({
      ts: Date.now(),
      action: "adjust_margin",
      source: "manual_ui",
      status: "success",
      symbol,
      positionId,
      exchangeEndpoint: "/api/v1/futures/account/adjust_position_margin",
      durationMs,
    });

    res.json({ ok: true, positionId, type, amount: amt, durationMs });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - start;

    logEvent({
      ts: Date.now(),
      action: "adjust_margin",
      source: "manual_ui",
      status: "error",
      symbol,
      positionId,
      exchangeEndpoint: "/api/v1/futures/account/adjust_position_margin",
      error: message,
      durationMs,
    });

    release(lockKey);
    res.status(500).json({ error: message });
  }
});

// GET /logs
router.get("/logs", (req, res) => {
  if (!requireAppKey(req, res)) return;
  const logs = readLogs(50);
  res.json({ logs });
});

// POST /trigger/close — external trigger
router.post("/trigger/close", async (req, res) => {
  const { token, symbol: rawSymbol, price: triggerPrice, triggeredAt } = req.body as {
    token?: string;
    symbol?: string;
    price?: number;
    triggeredAt?: number;
  };

  if (!TRIGGER_TOKEN || token !== TRIGGER_TOKEN) {
    res.status(403).json({ error: "Unauthorized trigger token" });
    return;
  }

  if (!triggeredAt || Date.now() - triggeredAt > TRIGGER_MAX_AGE_MS) {
    res.status(400).json({ error: "Stale trigger — timestamp too old" });
    return;
  }

  if (!canExecuteKill(COOLDOWN_SECONDS)) {
    res.status(409).json({ error: "Kill lock active" });
    return;
  }

  const symbol = resolveSymbol(rawSymbol);
  await executeKill("trigger", symbol, res, { triggerPrice, triggerSymbol: rawSymbol });
});

export default router;
