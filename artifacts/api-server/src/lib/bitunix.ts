import crypto from "crypto";

const API_KEY = process.env.BITUNIX_API_KEY;
const API_SECRET = process.env.BITUNIX_API_SECRET;
const BASE_URL = "https://fapi.bitunix.com";

export interface BitunixResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

/**
 * Bitunix Futures signature algorithm:
 *   digest = SHA256(nonce + timestamp + apiKey + queryParams + body)
 *   sign   = SHA256(digest + apiSecret)
 *
 * queryParams: For GET requests, sort params alphabetically by key, then
 * concatenate as `key1value1key2value2` (no separators, no '=' or '&').
 * For POST: empty string.
 *
 * body: For POST, the raw JSON body string. For GET: empty string.
 */
function buildSignature(queryParams: string, body: string, timestamp: string, nonce: string): string {
  if (!API_KEY || !API_SECRET) {
    throw new Error("BITUNIX_API_KEY and BITUNIX_API_SECRET must be set");
  }
  const digestInput = nonce + timestamp + API_KEY + queryParams + body;
  const digest = crypto.createHash("sha256").update(digestInput).digest("hex");
  return crypto.createHash("sha256").update(digest + API_SECRET).digest("hex");
}

function buildHeaders(queryParams: string, body: string) {
  if (!API_KEY) throw new Error("BITUNIX_API_KEY must be set");
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const sign = buildSignature(queryParams, body, timestamp, nonce);
  return {
    "api-key": API_KEY,
    sign,
    timestamp,
    nonce,
    "Content-Type": "application/json",
  };
}

function sortedQueryString(params: Record<string, string>): { url: string; signString: string } {
  const sortedKeys = Object.keys(params).sort();
  const url = sortedKeys.map((k) => `${k}=${encodeURIComponent(params[k])}`).join("&");
  const signString = sortedKeys.map((k) => k + params[k]).join("");
  return { url, signString };
}

export async function bitunixGet<T = unknown>(
  path: string,
  params: Record<string, string> = {}
): Promise<BitunixResponse<T>> {
  const { url: qs, signString } = sortedQueryString(params);
  const headers = buildHeaders(signString, "");
  const url = `${BASE_URL}${path}${qs ? "?" + qs : ""}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bitunix GET ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<BitunixResponse<T>>;
}

export async function bitunixPost<T = unknown>(
  path: string,
  body: Record<string, unknown>
): Promise<BitunixResponse<T>> {
  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders("", bodyStr);
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { method: "POST", headers, body: bodyStr });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bitunix POST ${path} failed: ${res.status} ${text}`);
  }
  return res.json() as Promise<BitunixResponse<T>>;
}

/**
 * Convenience wrapper that throws on Bitunix-level errors (code != 0)
 * with the upstream message.
 */
export function unwrap<T>(response: BitunixResponse<T>): T {
  if (response.code !== 0) {
    throw new Error(`Bitunix error ${response.code}: ${response.msg}`);
  }
  return response.data;
}

export type PositionMode = "ONE_WAY" | "HEDGE" | "UNKNOWN";

export interface AccountInfo {
  available: string;
  balance: string;
  frozen: string;
  unrealizedPNL: string;
  bonus: string;
  positionMode: string;
}

export interface LeverageMarginMode {
  leverage: number;
  marginMode: string;
}

export interface MarketOrderResult {
  orderId?: string;
  [key: string]: unknown;
}

export interface RawPosition {
  positionId?: string;
  symbol?: string;
  side?: string;
  qty?: string;
  marginMode?: string;
  positionMode?: string;
  leverage?: number | string;
  realizedPNL?: string;
  margin?: string;
  unrealizedPNL?: string;
  liqPrice?: string;
  avgOpenPrice?: string;
  entryPrice?: string;
  [key: string]: unknown;
}

export function toPositionDirection(value: unknown): "LONG" | "SHORT" | null {
  const side = String(value ?? "").trim().toUpperCase();
  if (side === "LONG" || side === "BUY") return "LONG";
  if (side === "SHORT" || side === "SELL") return "SHORT";
  return null;
}

export interface KlineBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

function firstRecord(data: unknown): Record<string, unknown> {
  if (Array.isArray(data) && data[0] && typeof data[0] === "object") {
    return data[0] as Record<string, unknown>;
  }
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    for (const key of ["list", "accountList", "positions", "data"]) {
      if (Array.isArray(record[key]) && record[key][0] && typeof record[key][0] === "object") {
        return record[key][0] as Record<string, unknown>;
      }
    }
    return record;
  }
  return {};
}

function stringValue(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return "0";
}

let positionModeCache: { mode: PositionMode; expiresAt: number } | undefined;

export async function getPositionMode(): Promise<PositionMode> {
  if (positionModeCache && positionModeCache.expiresAt > Date.now()) {
    return positionModeCache.mode;
  }
  try {
    const response = await bitunixGet("/api/v1/futures/account", { marginCoin: "USDT" });
    const raw = stringValue(firstRecord(response.data), "positionMode").toUpperCase();
    const mode: PositionMode = raw === "ONE_WAY" || raw === "HEDGE" ? raw : "UNKNOWN";
    positionModeCache = { mode, expiresAt: Date.now() + 5 * 60_000 };
    return mode;
  } catch {
    return "UNKNOWN";
  }
}

export function invalidatePositionModeCache(): void {
  positionModeCache = undefined;
}

export async function getAccountInfo(): Promise<AccountInfo> {
  const response = await bitunixGet("/api/v1/futures/account", { marginCoin: "USDT" });
  const record = firstRecord(response.data);
  return {
    available: stringValue(record, "available", "availableBalance", "availableBal"),
    balance: stringValue(record, "balance", "totalEquity", "equity", "totalBalance"),
    frozen: stringValue(record, "frozen", "frozenBalance", "frozenBal", "orderMargin"),
    unrealizedPNL: stringValue(record, "unrealizedPNL", "unrealizedPnl", "unrealisedPNL"),
    bonus: stringValue(record, "bonus", "voucherBalance"),
    positionMode: stringValue(record, "positionMode"),
  };
}

export async function getLeverageMarginMode(symbol: string): Promise<LeverageMarginMode> {
  const response = await bitunixGet("/api/v1/futures/account/get_leverage_margin_mode", { symbol });
  const record = firstRecord(response.data);
  const parsed = Number(stringValue(record, "leverage", "longLeverage", "buyLeverage"));
  return {
    leverage: Number.isFinite(parsed) ? parsed : 0,
    marginMode: stringValue(record, "marginMode", "positionType", "marginType"),
  };
}

export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  unwrap(await bitunixPost("/api/v1/futures/account/change_leverage", {
    symbol,
    leverage,
    marginCoin: "USDT",
  }));
}

export async function adjustPositionMargin(params: {
  symbol: string;
  side: string;
  amount: string;
  type: "ADD" | "REDUCE";
}): Promise<void> {
  unwrap(await bitunixPost("/api/v1/futures/account/adjust_position_margin", {
    symbol: params.symbol,
    side: params.side.toUpperCase(),
    amount: params.type === "REDUCE" ? `-${params.amount}` : params.amount,
    marginCoin: "USDT",
  }));
}

export async function placeMarketOrder(params: {
  symbol: string;
  side: "BUY" | "SELL";
  qty: string;
  positionMode: PositionMode;
}): Promise<MarketOrderResult> {
  const body: Record<string, unknown> = {
    symbol: params.symbol,
    side: params.side,
    orderType: "MARKET",
    qty: params.qty,
  };
  if (params.positionMode !== "ONE_WAY") body.tradeSide = "OPEN";
  const data = unwrap(await bitunixPost<{ orderId?: string }>(
    "/api/v1/futures/trade/place_order",
    body,
  ));
  return data ?? {};
}

export async function getOpenPositions(params?: {
  symbol?: string;
  positionId?: string;
}): Promise<RawPosition[]> {
  const query: Record<string, string> = {};
  if (params?.symbol) query.symbol = params.symbol;
  if (params?.positionId) query.positionId = params.positionId;
  const data = unwrap(await bitunixGet<unknown>(
    "/api/v1/futures/position/get_pending_positions",
    query,
  ));
  if (Array.isArray(data)) return data as RawPosition[];
  if (data === null || data === undefined) return [];
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  for (const key of ["list", "positions", "positionList", "pendingPositions", "items", "data", "resultList"]) {
    if (Array.isArray(record[key])) return record[key] as RawPosition[];
  }
  if (Object.keys(record).length === 0) return [];
  throw new Error(
    `Unexpected Bitunix open-position response shape: ${Object.keys(record).join(", ")}`,
  );
}

export async function closeAllPositions(symbol?: string): Promise<unknown> {
  return unwrap(await bitunixPost("/api/v1/futures/trade/close_all_position", symbol ? { symbol } : {}));
}

export async function flashClosePosition(positionId: string): Promise<unknown> {
  return unwrap(await bitunixPost("/api/v1/futures/trade/flash_close_position", { positionId }));
}

export async function getTickerPrice(symbol: string): Promise<string | null> {
  const response = await fetch(
    `${BASE_URL}/api/v1/futures/market/tickers?symbol=${encodeURIComponent(symbol)}`,
    { signal: AbortSignal.timeout(4_000) },
  );
  const json = await response.json() as { code?: number; data?: unknown };
  if (json.code !== 0) return null;
  const record = firstRecord(json.data);
  const price = record.lastPrice ?? record.lastPr ?? record.last ?? record.close ?? record.price ?? record.markPrice;
  return price === undefined || price === null ? null : String(price);
}

export async function getTickerPrices(symbols: string[]): Promise<Record<string, string>> {
  const prices: Record<string, string> = {};
  await Promise.all(symbols.map(async (symbol) => {
    const price = await getTickerPrice(symbol);
    if (price) prices[symbol] = price;
  }));
  return prices;
}

export async function getKlines(symbol: string, interval: string, limit = 20): Promise<KlineBar[]> {
  const url = `${BASE_URL}/api/v1/futures/market/kline?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(6_000) });
  const json = await response.json() as { code?: number; data?: unknown };
  if (json.code !== 0 || !Array.isArray(json.data)) return [];
  return (json.data as unknown[]).map((item): KlineBar => {
    if (Array.isArray(item)) {
      return {
        ts: Number(item[0]),
        open: Number(item[1]),
        high: Number(item[2]),
        low: Number(item[3]),
        close: Number(item[4]),
        vol: Number(item[5] ?? 0),
      };
    }
    const record = item as Record<string, unknown>;
    return {
      ts: Number(record.ts ?? record.time ?? record.timestamp ?? record.openTime ?? 0),
      open: Number(record.open ?? record.o ?? 0),
      high: Number(record.high ?? record.h ?? 0),
      low: Number(record.low ?? record.l ?? 0),
      close: Number(record.close ?? record.c ?? 0),
      vol: Number(record.vol ?? record.volume ?? record.v ?? 0),
    };
  }).filter((bar) => bar.ts > 0 && bar.high >= bar.low);
}
