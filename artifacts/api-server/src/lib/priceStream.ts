import type { Response } from "express";
import WebSocket from "ws";
import { logger } from "./logger";

type PriceListener = (symbol: string, price: number) => void;

interface TickerItem {
  symbol: string;
  markPrice?: string;
  lastPrice?: string;
  last?: string;
}

const WS_URL = "wss://fapi.bitunix.com/public/";
const REST_URL = "https://fapi.bitunix.com/api/v1/futures/market/tickers";
const HEARTBEAT_INTERVAL_MS = 20_000;
const STALE_THRESHOLD_MS = 15_000; // if no msg in this window, force reconnect
const REST_FALLBACK_INTERVAL_MS = 5_000;

/**
 * Bitunix server-side price stream.
 *
 * Primary feed: a single shared WebSocket connection to Bitunix's public
 * futures ticker channel. The watcher and SSE consumers all subscribe to
 * this singleton — when the WS pushes a price, the watcher reacts in
 * real time and the SSE listeners forward the price to browsers.
 *
 * Safety net: a slow REST poll (every 5s) only runs while the WS is
 * disconnected or stale (>8s without a message). When WS is healthy,
 * the REST poll skips its own work, so we don't double-bill the API.
 *
 * On WS disconnect: exponential backoff reconnect with re-subscription
 * of every active symbol.
 */
class BitunixPriceStream {
  private listeners = new Set<PriceListener>();
  private subscribers = new Map<string, number>(); // symbol -> ref count
  private latestPrices = new Map<string, number>();
  private subscribedOnWS = new Set<string>();
  private ws: WebSocket | null = null;
  private wsConnecting = false;
  private wsLastMsgAt = 0;
  private wsGeneration = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private stalenessTimer: ReturnType<typeof setInterval> | null = null;
  private restFallbackTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 1000;

  addListener(cb: PriceListener) {
    this.listeners.add(cb);
    this.latestPrices.forEach((price, sym) => cb(sym, price));
  }

  removeListener(cb: PriceListener) {
    this.listeners.delete(cb);
  }

  subscribe(symbol: string) {
    const upper = symbol.toUpperCase();
    this.subscribers.set(upper, (this.subscribers.get(upper) || 0) + 1);
    this.ensureWS();
    this.sendSubscribe(upper);
    this.ensureRestFallback();
    // Immediate REST kick for snappy first paint
    this.restPollOnce().catch(() => {});
  }

  unsubscribe(symbol: string) {
    const upper = symbol.toUpperCase();
    const c = this.subscribers.get(upper) || 0;
    if (c <= 1) {
      this.subscribers.delete(upper);
      this.sendUnsubscribe(upper);
    } else {
      this.subscribers.set(upper, c - 1);
    }
    if (this.subscribers.size === 0) {
      this.stopRestFallback();
      this.closeWS();
    }
  }

  getLatest(symbol: string): number | undefined {
    return this.latestPrices.get(symbol.toUpperCase());
  }

  status() {
    const states = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    const rs = this.ws?.readyState;
    return {
      wsState: rs !== undefined ? states[rs] : "NONE",
      wsLastMsgAt: this.wsLastMsgAt || null,
      msSinceLastMsg: this.wsLastMsgAt ? Date.now() - this.wsLastMsgAt : null,
      subscribedSymbols: Array.from(this.subscribers.keys()),
      cachedPrices: Object.fromEntries(this.latestPrices),
      listenerCount: this.listeners.size,
    };
  }

  private ensureWS() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.wsConnecting) return;
    if (this.subscribers.size === 0) return;
    this.wsConnecting = true;
    const generation = ++this.wsGeneration;
    logger.info({ url: WS_URL, generation }, "Connecting Bitunix WS");

    let socket: WebSocket;
    try {
      socket = new WebSocket(WS_URL);
    } catch (err) {
      logger.error({ err: String(err) }, "WS construct failed");
      this.wsConnecting = false;
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    // All handlers below early-return unless `socket` is still the active one.
    // This prevents a stale connection's events (delayed `close`, late `message`)
    // from mutating timers, subscription tracking, or reconnect state that now
    // belongs to a newer socket.
    const isActive = () => this.ws === socket;

    socket.on("open", () => {
      if (!isActive()) {
        try { socket.close(); } catch {}
        return;
      }
      this.wsConnecting = false;
      this.wsLastMsgAt = Date.now();
      this.reconnectDelayMs = 1000;
      logger.info({ generation }, "Bitunix WS connected");
      // (Re)subscribe everything currently active. Safe to clear because
      // subscribedOnWS is per-connection state.
      this.subscribedOnWS.clear();
      for (const s of this.subscribers.keys()) this.sendSubscribe(s);
      this.startHeartbeat();
      this.startStalenessWatch();
    });

    socket.on("message", (raw) => {
      if (!isActive()) return;
      this.wsLastMsgAt = Date.now();
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleWSMessage(msg);
    });

    socket.on("close", () => {
      if (!isActive()) {
        // Stale socket closed — do not touch live connection state.
        logger.debug({ generation }, "Stale Bitunix WS close ignored");
        return;
      }
      logger.warn({ generation }, "Bitunix WS closed");
      this.wsConnecting = false;
      this.stopHeartbeat();
      this.stopStalenessWatch();
      this.subscribedOnWS.clear();
      this.ws = null;
      if (this.subscribers.size > 0) this.scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (!isActive()) return;
      logger.error({ err: String(err), generation }, "Bitunix WS error");
      // 'close' will fire after 'error' and trigger the reconnect path
    });
  }

  private handleWSMessage(msg: unknown) {
    if (!msg || typeof msg !== "object") return;
    const m = msg as Record<string, unknown>;

    // Bitunix control frames use an explicit `op` field. Reply to server
    // pings, drop server pongs. Anything else with a stray `ping` key is
    // treated as data, not control traffic.
    if (m.op === "ping") {
      try {
        this.ws?.send(JSON.stringify({ op: "pong", pong: m.ping ?? Date.now() }));
      } catch {}
      return;
    }
    if (m.op === "pong") return;

    // Single ticker push: {ch:"ticker", symbol:"BTCUSDT", data:{...}}
    if (m.ch === "ticker" && typeof m.symbol === "string" && m.data) {
      this.applyTicker(m.symbol, m.data);
      return;
    }

    // Batch ticker push variant: {ch:"tickers", data:[...]}
    if ((m.ch === "tickers" || m.ch === "ticker") && Array.isArray(m.data)) {
      for (const item of m.data) {
        if (item && typeof item === "object" && typeof (item as Record<string, unknown>).symbol === "string") {
          const it = item as Record<string, unknown>;
          this.applyTicker(it.symbol as string, it);
        }
      }
      return;
    }

    // Subscribe/unsubscribe acks and unknown frames — log at debug for now
    if (m.op === "subscribe" || m.op === "unsubscribe") return;
    logger.debug({ msg: m }, "Unhandled Bitunix WS frame");
  }

  private applyTicker(symbolRaw: string, data: unknown) {
    if (!data || typeof data !== "object") return;
    const sym = symbolRaw.toUpperCase();
    const d = data as Record<string, unknown>;
    // Try a handful of common field names for "current price"
    const candidates = [d.la, d.lastPrice, d.last, d.markPrice, d.mp, d.c, d.price];
    let price = NaN;
    for (const v of candidates) {
      if (v === undefined || v === null) continue;
      const n = parseFloat(String(v));
      if (Number.isFinite(n) && n > 0) {
        price = n;
        break;
      }
    }
    if (!Number.isFinite(price)) return;
    this.latestPrices.set(sym, price);
    this.listeners.forEach((cb) => cb(sym, price));
  }

  private closeWS() {
    this.stopHeartbeat();
    this.stopStalenessWatch();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    // Critical: clear the connecting flag so a subsequent subscribe()
    // can open a fresh WS. Without this, rapid disarm→arm cycles would
    // leave wsConnecting=true forever (the in-flight socket's open
    // event no longer matches isActive() and never resets the flag).
    this.wsConnecting = false;
    this.subscribedOnWS.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.subscribers.size > 0) this.ensureWS();
    }, delay);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  private sendSubscribe(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscribedOnWS.has(symbol)) return;
    try {
      this.ws.send(JSON.stringify({ op: "subscribe", args: [{ symbol, ch: "ticker" }] }));
      this.subscribedOnWS.add(symbol);
    } catch (err) {
      logger.error({ err: String(err), symbol }, "WS subscribe send failed");
    }
  }

  private sendUnsubscribe(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.subscribedOnWS.has(symbol)) return;
    try {
      this.ws.send(JSON.stringify({ op: "unsubscribe", args: [{ symbol, ch: "ticker" }] }));
      this.subscribedOnWS.delete(symbol);
    } catch {}
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ op: "ping", ping: Date.now() }));
        } catch {}
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startStalenessWatch() {
    this.stopStalenessWatch();
    this.stalenessTimer = setInterval(() => {
      if (this.wsLastMsgAt && Date.now() - this.wsLastMsgAt > STALE_THRESHOLD_MS) {
        logger.warn("Bitunix WS stale — forcing reconnect");
        try {
          this.ws?.terminate();
        } catch {}
      }
    }, 5000);
  }

  private stopStalenessWatch() {
    if (this.stalenessTimer) {
      clearInterval(this.stalenessTimer);
      this.stalenessTimer = null;
    }
  }

  private ensureRestFallback() {
    if (this.restFallbackTimer) return;
    this.restFallbackTimer = setInterval(() => {
      // If WS is healthy AND received a message in the last 8s, skip — WS is the source of truth
      if (
        this.ws?.readyState === WebSocket.OPEN &&
        this.wsLastMsgAt &&
        Date.now() - this.wsLastMsgAt < 8_000
      ) {
        return;
      }
      this.restPollOnce().catch(() => {});
    }, REST_FALLBACK_INTERVAL_MS);
  }

  private stopRestFallback() {
    if (this.restFallbackTimer) {
      clearInterval(this.restFallbackTimer);
      this.restFallbackTimer = null;
    }
  }

  private async restPollOnce() {
    if (this.subscribers.size === 0) return;
    const symbols = Array.from(this.subscribers.keys()).join(",");
    const url = `${REST_URL}?symbols=${encodeURIComponent(symbols)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const json = (await res.json()) as { code: number; data: TickerItem[] };
      if (json.code !== 0 || !Array.isArray(json.data)) return;
      for (const t of json.data) {
        const price = parseFloat(t.markPrice ?? t.lastPrice ?? t.last ?? "0");
        if (price > 0) {
          this.latestPrices.set(t.symbol, price);
          this.listeners.forEach((cb) => cb(t.symbol, price));
        }
      }
    } catch (_) {}
  }
}

export const priceStream = new BitunixPriceStream();

const MAX_SSE_SYMBOLS = 20;
const MAX_SSE_CONNECTIONS = 10;

let activeSseConnections = 0;

export function handleSSE(symbolsParam: string, res: Response): boolean {
  const symbols = Array.from(
    new Set(
      symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ).slice(0, MAX_SSE_SYMBOLS);

  if (symbols.length === 0) {
    res.status(400).json({ code: -1, msg: "no valid symbols after normalization", data: null });
    return false;
  }

  if (activeSseConnections >= MAX_SSE_CONNECTIONS) {
    res.status(429).json({ code: -1, msg: "too many concurrent price stream connections", data: null });
    return false;
  }

  activeSseConnections += 1;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const wantedSet = new Set(symbols);
  symbols.forEach((s) => priceStream.subscribe(s));

  symbols.forEach((s) => {
    const p = priceStream.getLatest(s);
    if (p !== undefined) {
      res.write(`data: ${JSON.stringify({ symbol: s, price: p })}\n\n`);
    }
  });

  const listener = (symbol: string, price: number) => {
    if (wantedSet.has(symbol)) {
      res.write(`data: ${JSON.stringify({ symbol, price })}\n\n`);
    }
  };
  priceStream.addListener(listener);

  const hb = setInterval(() => {
    res.write(`: hb ${Date.now()}\n\n`);
  }, 25000);

  res.on("close", () => {
    activeSseConnections -= 1;
    priceStream.removeListener(listener);
    clearInterval(hb);
    symbols.forEach((s) => priceStream.unsubscribe(s));
  });

  return true;
}
