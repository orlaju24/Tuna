import React, { useState, useEffect, useCallback, useRef } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  useGetAccount,
  useGetSymbolInfo,
  useGetLogs,
  useKillAll,
  useClosePosition,
  useTradeLong,
  useTradeShort,
  useSetLeverage,
  useAdjustMargin,
  getGetSymbolInfoQueryKey,
  getGetAccountQueryKey,
  getGetLogsQueryKey,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock, Loader2, X, Terminal, AlertTriangle, ChevronDown, ChevronUp, RefreshCw, Pencil, Plus, Check } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { toast } from "sonner";

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_FAVORITES: string[] = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "SOLUSDT",
  "TRADOORUSDT",
  "MYXUSDT",
  "ORDIUSDT",
];
const FAVS_KEY = "ks_favorites_v1";

const VALID_LEVERAGES = [71, 77, 81, 85] as const;
type ValidLeverage = (typeof VALID_LEVERAGES)[number];

const BITUNIX_WS = "wss://fapi.bitunix.com/public";

function shortSymbol(s: string) {
  return s.replace("USDT", "");
}

function fmtPrice(p: string | null | undefined) {
  if (!p) return "—";
  const n = parseFloat(p);
  if (isNaN(n)) return p;
  // Format large numbers with commas, 2-4 decimals depending on magnitude
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return n.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

function fmtUsdt(v: string | null | undefined) {
  if (!v) return "0.00";
  const n = parseFloat(v);
  if (isNaN(n)) return v;
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n.toFixed(2);
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

// ─── Batch REST prices for the favorites strip ───────────────────────────────

function useFavoritePrices(
  symbols: string[],
  token: string,
  intervalMs = 5000,
): Record<string, string> {
  const [prices, setPrices] = useState<Record<string, string>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const fetchAll = async () => {
      if (!token || !mountedRef.current) return;
      try {
        const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
        const res = await fetch(
          `${BASE}/api/prices?symbols=${symbols.join(",")}`,
          { headers: { "x-key": token } },
        );
        if (!res.ok) return;
        const data = await res.json() as Record<string, string>;
        if (mountedRef.current) setPrices((prev) => ({ ...prev, ...data }));
      } catch { /* ignore */ }
    };

    void fetchAll();
    const id = setInterval(fetchAll, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [symbols.join(","), token, intervalMs]);

  return prices;
}

// ─── Editable favorites (localStorage-persisted) ─────────────────────────────

function useFavorites() {
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(FAVS_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch { /* ignore */ }
    return DEFAULT_FAVORITES;
  });

  const persist = (next: string[]) => {
    setFavorites(next);
    try { localStorage.setItem(FAVS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const addFavorite = (raw: string): boolean => {
    const sym = raw.trim().toUpperCase().replace(/\s/g, "");
    if (!sym || favorites.includes(sym)) return false;
    // Auto-append USDT if user typed a bare asset like "SOL"
    const full = sym.endsWith("USDT") ? sym : sym + "USDT";
    if (favorites.includes(full)) return false;
    persist([...favorites, full]);
    return true;
  };

  const removeFavorite = (sym: string) => persist(favorites.filter((f) => f !== sym));

  return { favorites, addFavorite, removeFavorite };
}

// ─── Live Price via Bitunix WebSocket (with REST fallback) ───────────────────

/** Extract price from any known Bitunix WS field name */
function extractWsPrice(d: unknown): string | null {
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  // Bitunix prod fields (confirmed): lastPrice, markPrice, last — try in order of preference
  const raw = o["lastPrice"] ?? o["lastPr"] ?? o["last"] ?? o["markPrice"] ?? o["markPr"] ?? o["price"] ?? o["indexPr"] ?? o["close"];
  return raw != null ? String(raw) : null;
}

function useMarketPrice(symbol: string, token: string, restFallbackMs = 3500): { price: string | null; connected: boolean } {
  const [price, setPrice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restFallbackRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastWsPriceRef = useRef<number>(0);
  const mountedRef = useRef(true);

  // REST fallback — fires if WS hasn't delivered a price after `restFallbackMs`
  const fetchRestPrice = useCallback(async () => {
    if (!token || !mountedRef.current) return;
    try {
      const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const res = await fetch(`${BASE}/api/ticker?symbol=${symbol}`, { headers: { "x-key": token } });
      if (!res.ok) return;
      const data = await res.json() as { price?: string | null };
      if (data.price && mountedRef.current) setPrice(data.price);
    } catch { /* ignore */ }
  }, [symbol, token]);

  useEffect(() => {
    mountedRef.current = true;
    setPrice(null);
    setConnected(false);
    lastWsPriceRef.current = 0;

    // Schedule REST fallback in case WS is slow
    restFallbackRef.current = setTimeout(fetchRestPrice, restFallbackMs);
    // Also poll REST every 4s in case WS drops
    const restPollId = setInterval(() => {
      if (Date.now() - lastWsPriceRef.current > 5000) void fetchRestPrice();
    }, 4000);

    const connect = () => {
      if (!mountedRef.current) return;

      const ws = new WebSocket(BITUNIX_WS);
      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        setConnected(true);
        // Subscribe to ticker (lastPr) AND MarketPrice (markPr) channels
        ws.send(JSON.stringify({
          op: "subscribe",
          args: [{ instType: "FUTURES", channel: "ticker", instId: symbol }],
        }));
        ws.send(JSON.stringify({
          op: "subscribe",
          args: [{ instType: "FUTURES", channel: "MarketPrice", instId: symbol }],
        }));
      };

      ws.onmessage = (e) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(e.data as string) as Record<string, unknown>;
          let p: string | null = null;
          if (Array.isArray(msg["data"]) && (msg["data"] as unknown[]).length > 0) {
            p = extractWsPrice((msg["data"] as unknown[])[0]);
          } else {
            p = extractWsPrice(msg["data"]) ?? extractWsPrice(msg);
          }
          if (p) {
            lastWsPriceRef.current = Date.now();
            setPrice(p);
          }
        } catch { /* ignore parse errors */ }
      };

      ws.onerror = () => { setConnected(false); };

      ws.onclose = () => {
        setConnected(false);
        if (mountedRef.current) reconnectRef.current = setTimeout(connect, 3500);
      };
    };

    connect();

    return () => {
      mountedRef.current = false;
      clearTimeout(reconnectRef.current);
      clearTimeout(restFallbackRef.current);
      clearInterval(restPollId);
      wsRef.current?.close();
    };
  }, [symbol, token]);

  return { price, connected };
}

// ─── K-line / Heikin Ashi ─────────────────────────────────────────────────────

interface KlineBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
}

const KLINE_INTERVALS = ["3min", "15min", "1h", "2h", "6h"] as const;
type KlineInterval = (typeof KLINE_INTERVALS)[number];

function computeHeikinAshi(bars: KlineBar[]): KlineBar[] {
  const ha: KlineBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const haClose = (b.open + b.high + b.low + b.close) / 4;
    const haOpen =
      i === 0
        ? (b.open + b.close) / 2
        : (ha[i - 1].open + ha[i - 1].close) / 2;
    ha.push({
      ts: b.ts,
      open: haOpen,
      high: Math.max(b.high, haOpen, haClose),
      low: Math.min(b.low, haOpen, haClose),
      close: haClose,
      vol: b.vol,
    });
  }
  return ha;
}

/** Parse a raw kline item from WS or REST into KlineBar (array or object format) */
function parseKlineItem(raw: unknown): KlineBar | null {
  if (Array.isArray(raw) && raw.length >= 5) {
    return {
      ts:    Number(raw[0]),
      open:  Number(raw[1]),
      high:  Number(raw[2]),
      low:   Number(raw[3]),
      close: Number(raw[4]),
      vol:   Number(raw[5] ?? 0),
    };
  }
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    const ts = Number(r["ts"] ?? r["time"] ?? r["t"] ?? 0);
    if (!ts) return null;
    return {
      ts,
      open:  Number(r["open"]  ?? r["o"] ?? 0),
      high:  Number(r["high"]  ?? r["h"] ?? 0),
      low:   Number(r["low"]   ?? r["l"] ?? 0),
      close: Number(r["close"] ?? r["c"] ?? r["last"] ?? 0),
      vol:   Number(r["vol"]   ?? r["v"] ?? 0),
    };
  }
  return null;
}

function useKlines(symbol: string, interval: KlineInterval, token: string, limit = 20): KlineBar[] {
  const [bars, setBars] = useState<KlineBar[]>([]);
  const mountedRef = useRef(true);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    setBars([]);
    wsRef.current?.close();
    wsRef.current = null;

    if (!token) return;

    // ── REST: initial load + 8s backup poll ─────────────────────────────
    const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    const loadRest = async () => {
      if (!mountedRef.current) return;
      try {
        const res = await fetch(
          `${BASE}/api/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
          { headers: { "x-key": token } },
        );
        if (!res.ok || !mountedRef.current) return;
        const data = await res.json() as KlineBar[];
        if (Array.isArray(data) && data.length > 0 && mountedRef.current) setBars(data);
      } catch { /* ignore */ }
    };

    void loadRest();
    const restId = setInterval(loadRest, 8000);

    // ── WebSocket: live forming-candle updates ───────────────────────────
    const ws = new WebSocket(BITUNIX_WS);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      // Subscribe to Bitunix kline channel for live candle push
      ws.send(JSON.stringify({
        op: "subscribe",
        args: [{ instType: "FUTURES", channel: "kline", instId: symbol, interval }],
      }));
    };

    ws.onmessage = (e) => {
      if (!mountedRef.current) return;
      try {
        const msg = JSON.parse(e.data as string) as Record<string, unknown>;
        const arr = msg["data"];
        if (!Array.isArray(arr) || arr.length === 0) return;
        const bar = parseKlineItem(arr[0]);
        if (!bar || bar.ts === 0 || bar.close === 0) return;

        setBars((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (bar.ts === last.ts) {
            // Update forming candle in place
            const next = [...prev];
            next[next.length - 1] = bar;
            return next;
          }
          if (bar.ts > last.ts) {
            // New candle — append and trim to limit
            return [...prev, bar].slice(-limit);
          }
          return prev;
        });
      } catch { /* ignore */ }
    };

    ws.onerror = () => { /* REST poll is the fallback */ };
    ws.onclose = () => { /* REST poll is the fallback */ };

    return () => {
      mountedRef.current = false;
      clearInterval(restId);
      ws.close();
      wsRef.current = null;
    };
  }, [symbol, interval, token, limit]);

  return bars;
}

function use1hCountdown(): string {
  const [text, setText] = useState("");
  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const next = Math.ceil(now / 3_600_000) * 3_600_000;
      const rem = next - now;
      const m = Math.floor(rem / 60_000);
      const s = Math.floor((rem % 60_000) / 1000);
      setText(`${m}m ${String(s).padStart(2, "0")}s`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return text;
}

function fmtHHMM(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function CandleChart({ bars, displayCount = 10 }: { bars: KlineBar[]; displayCount?: number }) {
  if (bars.length < 3) {
    return (
      <div className="h-28 flex items-center justify-center text-[#333] text-[10px] tracking-widest">
        LOADING CANDLES…
      </div>
    );
  }

  const ha = computeHeikinAshi(bars);
  const visible = ha.slice(-displayCount);
  const n = visible.length;

  const LABEL_H = 13;
  const W = 300;
  const CHART_H = 100;
  const H = CHART_H + LABEL_H;
  const padY = 6;
  const slotW = W / n;
  const candleW = Math.max(4, Math.floor(slotW) - 6);

  const allPrices = visible.flatMap((b) => [b.high, b.low]);
  const priceMin = Math.min(...allPrices);
  const priceMax = Math.max(...allPrices);
  const priceRange = priceMax - priceMin || 1;

  const toY = (p: number) =>
    padY + (1 - (p - priceMin) / priceRange) * (CHART_H - 2 * padY);

  // Label first, midpoint, and last candle only
  const labelSet = new Set([0, Math.floor(n / 2), n - 1]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: H + 4 }}
      preserveAspectRatio="none"
    >
      {visible.map((bar, i) => {
        const isActive = i === n - 1;
        const isUp = bar.close >= bar.open;
        const color = isActive ? "#eab308" : isUp ? "#4ade80" : "#ef4444";
        const fill  = isActive ? "#ca8a04" : isUp ? "#16a34a" : "#dc2626";

        const slotX = i * slotW;
        const x = slotX + (slotW - candleW) / 2;
        const bodyTop = toY(Math.max(bar.open, bar.close));
        const bodyBot = toY(Math.min(bar.open, bar.close));
        const bodyH   = Math.max(bodyBot - bodyTop, 1.5);
        const wickX   = slotX + slotW / 2;
        const labelX  = slotX + slotW / 2;

        return (
          <g key={bar.ts}>
            <line x1={wickX} y1={toY(bar.high)} x2={wickX} y2={toY(bar.low)} stroke={color} strokeWidth={1} />
            <rect x={x} y={bodyTop} width={candleW} height={bodyH} fill={fill} />
            {labelSet.has(i) && (
              <text
                x={labelX} y={H - 1}
                textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
                fontSize={7} fill={isActive ? "#eab308" : "#444"} fontFamily="monospace"
              >
                {isActive ? "NOW" : fmtHHMM(bar.ts)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ─── Password Screen ──────────────────────────────────────────────────────────

function PasswordScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) { setError("ACCESS KEY REQUIRED"); return; }
    localStorage.setItem("killswitch_password", password.trim());
    onAuthenticated();
  };

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-[#0a0a0a] text-[#e5e5e5] p-4 font-mono">
      <Card className="w-full max-w-sm border-[#333] bg-[#111]">
        <CardHeader className="space-y-2 border-b border-[#333] pb-6">
          <div className="flex items-center justify-center mb-2">
            <Lock className="h-12 w-12 text-[#888]" strokeWidth={1.5} />
          </div>
          <CardTitle className="text-center text-xl tracking-widest text-[#e5e5e5] uppercase">
            System Locked
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-xs tracking-wider text-[#888] uppercase">Access Key</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(""); }}
                className="font-mono text-lg tracking-widest text-center border-[#333] bg-black/50 h-14 text-white"
                autoFocus
                autoComplete="off"
              />
              {error && <p className="text-red-500 text-xs text-center">{error}</p>}
            </div>
            <Button type="submit" className="w-full h-14 tracking-widest uppercase text-base bg-[#333] text-white hover:bg-[#444] border border-[#444]">
              Initialize
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Margin Modal ─────────────────────────────────────────────────────────────

interface MarginModalState {
  positionId: string;
  symbol: string;
  side: string;
  currentMargin: string;
}

function MarginModal({
  state,
  token,
  onClose,
  onSuccess,
}: {
  state: MarginModalState;
  token: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [tab, setTab] = useState<"ADD" | "REDUCE">("ADD");
  const [amount, setAmount] = useState("");

  const adjustMargin = useAdjustMargin({
    request: { headers: { "x-key": token } },
    mutation: {
      onSuccess: () => {
        toast.success(`Margin ${tab === "ADD" ? "increased" : "reduced"} — verified.`);
        setAmount("");
        onSuccess();
        onClose();
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        toast.error(`Margin error: ${msg}`);
      },
    },
  });

  const handleConfirm = () => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) { toast.error("Enter a valid positive USDT amount."); return; }
    adjustMargin.mutate({
      positionId: state.positionId,
      data: { amount: String(val), type: tab, side: state.side, symbol: state.symbol },
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="border-[#333] bg-[#111] sm:max-w-sm font-mono text-[#e5e5e5]">
        <DialogHeader>
          <DialogTitle className="tracking-widest uppercase text-sm">Adjust Margin</DialogTitle>
          <DialogDescription className="text-[#666] font-mono text-xs">
            {state.symbol} · {state.side.toUpperCase()} · Current: {state.currentMargin || "—"} USDT
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2 mt-2">
          {(["ADD", "REDUCE"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2 text-xs font-bold tracking-widest rounded border transition-colors ${
                tab === t
                  ? t === "ADD"
                    ? "bg-[#16a34a]/20 border-[#16a34a] text-[#4ade80]"
                    : "bg-[#dc2626]/20 border-[#dc2626] text-[#f87171]"
                  : "bg-transparent border-[#333] text-[#555]"
              }`}
            >
              {t === "ADD" ? "INCREASE" : "REDUCE"}
            </button>
          ))}
        </div>
        <div className="space-y-1 mt-3">
          <label className="text-[10px] tracking-widest text-[#666] uppercase">Amount (USDT)</label>
          <div className="relative">
            <Input
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-14 text-xl font-mono tracking-widest border-[#333] bg-black/50 text-white pr-16 focus-visible:ring-1 focus-visible:ring-[#666] focus-visible:ring-offset-0 placeholder:text-[#333]"
              autoFocus
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] text-xs font-bold">USDT</span>
          </div>
        </div>
        <DialogFooter className="mt-4 flex gap-2">
          <Button
            variant="outline"
            onClick={onClose}
            disabled={adjustMargin.isPending}
            className="flex-1 font-mono tracking-widest border-[#333] hover:bg-[#222] text-white hover:text-white"
          >
            CANCEL
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={adjustMargin.isPending || !amount.trim()}
            className={`flex-1 font-mono tracking-widest font-bold ${
              tab === "ADD"
                ? "bg-[#16a34a] hover:bg-[#15803d] text-white"
                : "bg-[#dc2626] hover:bg-[#b91c1c] text-white"
            }`}
          >
            {adjustMargin.isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "CONFIRM"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function MainApp() {
  const client = useQueryClient();
  const token = localStorage.getItem("killswitch_password") || "";

  // ── Symbol & price state
  const [selectedSymbol, setSelectedSymbol] = useState("BTCUSDT");
  const { price, connected: wsConnected } = useMarketPrice(selectedSymbol, token);
  const { favorites, addFavorite, removeFavorite } = useFavorites();
  const favPrices = useFavoritePrices(favorites, token);

  // ── UI state
  const [favsEditMode, setFavsEditMode] = useState(false);
  const [addingInput, setAddingInput] = useState("");
  const [amount, setAmount] = useState("");
  const [selectedLeverage, setSelectedLeverage] = useState<ValidLeverage>(81);
  const [isSettingLev, setIsSettingLev] = useState(false);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [isTrading, setIsTrading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [verifyWarning, setVerifyWarning] = useState<string | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [favsOpen, setFavsOpen] = useState(true);
  const [chartInterval, setChartInterval] = useState<KlineInterval>("3min");
  const [marginModal, setMarginModal] = useState<MarginModalState | null>(null);

  // ── Chart data — display count per timeframe; fetch extra for HA warmup
  const chartDisplayCount =
    chartInterval === "3min"  ? 15 :
    chartInterval === "15min" ? 8  :
    chartInterval === "1h"    ? 6  :
    chartInterval === "2h"    ? 4  : 4;
  const klineBars = useKlines(selectedSymbol, chartInterval, token, chartDisplayCount + 20);
  const countdown1h = use1hCountdown();

  // ── Data queries
  const {
    data: symbolData,
    isLoading: symbolLoading,
    refetch: refetchSymbol,
  } = useGetSymbolInfo(selectedSymbol, {
    request: { headers: { "x-key": token } },
    query: {
      queryKey: getGetSymbolInfoQueryKey(selectedSymbol),
      refetchInterval: 5000,
    },
  });

  const { data: accountData, refetch: refetchAccount } = useGetAccount({
    request: { headers: { "x-key": token } },
    query: {
      queryKey: getGetAccountQueryKey(),
      refetchInterval: 15000,
    },
  });

  const { data: logsData } = useGetLogs({
    request: { headers: { "x-key": token } },
    query: {
      queryKey: getGetLogsQueryKey(),
      refetchInterval: 30000,
    },
  });

  // ── Sync selected leverage with what Bitunix reports when symbol changes
  useEffect(() => {
    if (!symbolData?.leverage) return;
    const lev = Number(symbolData.leverage);
    if (!lev) return;
    // Snap to nearest valid option
    const closest = (VALID_LEVERAGES as readonly number[]).reduce((a, b) =>
      Math.abs(b - lev) < Math.abs(a - lev) ? b : a,
    ) as ValidLeverage;
    setSelectedLeverage(closest);
  }, [symbolData?.leverage, selectedSymbol]);

  // ── Error auto-clear
  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(() => setLastError(null), 10000);
    return () => clearTimeout(t);
  }, [lastError]);

  useEffect(() => {
    if (!verifyWarning) return;
    const t = setTimeout(() => setVerifyWarning(null), 30000);
    return () => clearTimeout(t);
  }, [verifyWarning]);

  const handleLogout = useCallback(() => {
    localStorage.removeItem("killswitch_password");
    window.location.reload();
  }, []);

  const handleSwitchSymbol = (sym: string) => {
    setSelectedSymbol(sym);
    setLastError(null);
    setVerifyWarning(null);
    // Immediate refetch for the new symbol
    setTimeout(() => client.invalidateQueries({ queryKey: getGetSymbolInfoQueryKey(sym) }), 0);
  };

  const invalidateAll = useCallback(() => {
    client.invalidateQueries({ queryKey: getGetSymbolInfoQueryKey(selectedSymbol) });
    client.invalidateQueries({ queryKey: getGetAccountQueryKey() });
    client.invalidateQueries({ queryKey: getGetLogsQueryKey() });
  }, [client, selectedSymbol]);

  // ── Leverage setter
  const setLevHook = useSetLeverage({
    request: { headers: { "x-key": token } },
    mutation: {
      onSuccess: (data) => {
        toast.success(`${data.symbol} leverage → ${data.leverage}x`);
        client.invalidateQueries({ queryKey: getGetSymbolInfoQueryKey(selectedSymbol) });
      },
      onError: (err: unknown) => {
        setLastError(`Leverage error: ${err instanceof Error ? err.message : String(err)}`);
      },
      onSettled: () => setIsSettingLev(false),
    },
  });

  const handleSetLeverage = (lev: ValidLeverage) => {
    setSelectedLeverage(lev);
    setIsSettingLev(true);
    setLevHook.mutate({ data: { leverage: lev, symbol: selectedSymbol } });
  };

  // ── Kill all
  const killAll = useKillAll({
    request: { headers: { "x-key": token } },
    mutation: {
      onSuccess: (data) => {
        setIsConfirmOpen(false);
        setLastError(null);
        if (data.status === "STILL_OPEN") {
          setVerifyWarning(`STILL OPEN — ${data.remaining ?? "?"} position(s) remain. Verify on exchange.`);
        } else {
          setVerifyWarning(null);
          toast.success(`${selectedSymbol} — confirmed flat.`);
        }
        invalidateAll();
      },
      onError: (err: unknown) => {
        setIsConfirmOpen(false);
        setLastError(`Close All Error: ${err instanceof Error ? err.message : String(err)}`);
        invalidateAll();
      },
    },
  });

  // ── Close single position
  const closePosition = useClosePosition({
    request: { headers: { "x-key": token } },
    mutation: {
      onMutate: (vars) => { setClosingIds((prev) => new Set(prev).add(vars.positionId)); },
      onSuccess: (data, vars) => {
        setClosingIds((prev) => { const n = new Set(prev); n.delete(vars.positionId); return n; });
        if (data.status === "STILL_OPEN") {
          setVerifyWarning(`Position still open on Bitunix — verify manually.`);
        } else {
          setVerifyWarning(null);
          toast.success("Position closed — confirmed.");
        }
        invalidateAll();
      },
      onError: (err: unknown, vars) => {
        setClosingIds((prev) => { const n = new Set(prev); n.delete(vars.positionId); return n; });
        setLastError(`Close Error: ${err instanceof Error ? err.message : String(err)}`);
      },
    },
  });

  // ── Open Long
  const tradeLong = useTradeLong({
    request: { headers: { "x-key": token } },
    mutation: {
      onMutate: () => { setIsTrading(true); setLastError(null); },
      onSuccess: () => {
        toast.success(`${selectedSymbol} long opened at ${selectedLeverage}x`);
        invalidateAll();
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg.includes("409") || msg.includes("Existing") ? "CLOSE CURRENT POSITION FIRST" : `Trade Error: ${msg}`);
      },
      onSettled: () => setIsTrading(false),
    },
  });

  // ── Open Short
  const tradeShort = useTradeShort({
    request: { headers: { "x-key": token } },
    mutation: {
      onMutate: () => { setIsTrading(true); setLastError(null); },
      onSuccess: () => {
        toast.success(`${selectedSymbol} short opened at ${selectedLeverage}x`);
        invalidateAll();
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        setLastError(msg.includes("409") || msg.includes("Existing") ? "CLOSE CURRENT POSITION FIRST" : `Trade Error: ${msg}`);
      },
      onSettled: () => setIsTrading(false),
    },
  });

  const handleTrade = (side: "long" | "short") => {
    const val = parseFloat(amount);
    if (isNaN(val) || val <= 0) { setLastError("Enter a valid BTC quantity"); return; }
    const body = { amount, leverage: selectedLeverage, symbol: selectedSymbol };
    if (side === "long") tradeLong.mutate({ data: body });
    else tradeShort.mutate({ data: body });
  };

  // ── Derived state
  const pos = symbolData?.position ?? null;
  const hasPosition = !!pos;
  const isExecuting = killAll.isPending || isTrading || closingIds.size > 0;
  const isTradeDisabled = isTrading || hasPosition || !amount.trim();
  const isLong = pos?.side?.toUpperCase() === "LONG";
  const pnl = parseFloat(pos?.unrealizedPNL ?? "0");
  const isPnlPos = pnl >= 0;
  const isClosing = pos ? closingIds.has(pos.positionId ?? "") : false;

  // ── Derived helpers
  const baseAsset = selectedSymbol.replace(/USDT$/, "");
  const posLev = pos?.leverage ?? (symbolData?.leverage && Number(symbolData.leverage) > 0 ? String(symbolData.leverage) : null);
  const posMarginMode = pos?.marginMode ?? (symbolData?.marginMode && symbolData.marginMode !== "UNKNOWN" ? symbolData.marginMode : null);
  const priceColor = "text-white";

  return (
    <div className="min-h-[100dvh] bg-[#0a0a0a] text-[#e5e5e5] flex flex-col font-mono">

      {/* ── Sticky Header ───────────────────────── */}
      <header className="flex-none sticky top-0 z-20 bg-[#0a0a0a] border-b border-[#222]">
        {/* Top row: title + WS indicator + logout */}
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-[#888]" />
            <span className="font-bold tracking-widest text-sm text-white">Bitunix Futures</span>
          </div>
          <div className="flex items-center gap-3">
            <div className={`w-2 h-2 rounded-full ${wsConnected ? "bg-[#4ade80]" : "bg-[#dc2626] animate-pulse"}`} title={wsConnected ? "WS connected" : "WS reconnecting"} />
            <button
              onClick={() => { refetchSymbol(); refetchAccount(); }}
              className="p-1 text-[#555] hover:text-[#aaa] transition-colors"
              title="Refresh data"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={handleLogout}
              className="text-[10px] text-[#555] hover:text-[#aaa] tracking-widest"
            >
              EXIT
            </button>
          </div>
        </div>

        {/* Favorites strip — collapsible */}
        <div className="border-t border-[#1a1a1a]">
          {/* Toggle bar */}
          <div className="flex items-center justify-between px-4 py-1.5">
            <button
              onClick={() => { setFavsOpen((v) => !v); setFavsEditMode(false); }}
              className="flex items-center gap-2 text-[#555] hover:text-[#888] transition-colors flex-1"
            >
              {!favsOpen && (
                <span className="text-[11px] font-bold text-white tracking-wider px-2 py-0.5 border border-[#444] rounded bg-[#1a1a1a]">
                  {shortSymbol(selectedSymbol)}
                  {favPrices[selectedSymbol] && (
                    <span className="ml-1 text-[#888] font-normal">{fmtPrice(favPrices[selectedSymbol])}</span>
                  )}
                </span>
              )}
              <span className="text-[9px] tracking-widest uppercase text-[#555]">PAIRS</span>
              {favsOpen ? <ChevronUp className="w-3 h-3 ml-1" /> : <ChevronDown className="w-3 h-3 ml-1" />}
            </button>
            {favsOpen && (
              <button
                onClick={() => { setFavsEditMode((v) => !v); setAddingInput(""); }}
                className={`p-1.5 rounded transition-colors ${favsEditMode ? "text-[#eab308]" : "text-[#555] hover:text-[#888]"}`}
                title={favsEditMode ? "Done editing" : "Edit favorites"}
              >
                {favsEditMode ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
              </button>
            )}
          </div>
          {/* Expanded strip */}
          {favsOpen && (
            <div className="overflow-x-auto scrollbar-none pb-2 px-4">
              <div className="flex gap-2 w-max">
                {favorites.map((sym) => {
                  const isActive = sym === selectedSymbol;
                  const fp = favPrices[sym];
                  return (
                    <div key={sym} className="relative shrink-0">
                      <button
                        onClick={() => !favsEditMode && handleSwitchSymbol(sym)}
                        className={`flex flex-col items-start px-3 py-1.5 rounded border transition-colors min-w-[68px] ${
                          isActive && !favsEditMode
                            ? "bg-white text-black border-white"
                            : favsEditMode
                            ? "bg-transparent border-[#444] opacity-70"
                            : "bg-transparent border-[#333] hover:border-[#666]"
                        }`}
                      >
                        <span className={`text-[11px] font-bold tracking-wider leading-tight ${isActive && !favsEditMode ? "text-black" : "text-[#ccc]"}`}>
                          {shortSymbol(sym)}
                        </span>
                        <span className={`text-[10px] tabular-nums leading-tight mt-0.5 ${isActive && !favsEditMode ? "text-black/70" : "text-[#666]"}`}>
                          {fp ? fmtPrice(fp) : <span className="opacity-40">···</span>}
                        </span>
                      </button>
                      {favsEditMode && (
                        <button
                          onClick={() => {
                            removeFavorite(sym);
                            if (sym === selectedSymbol && favorites.length > 1) {
                              const next = favorites.find((f) => f !== sym);
                              if (next) handleSwitchSymbol(next);
                            }
                          }}
                          className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[#dc2626] flex items-center justify-center shadow"
                          title={`Remove ${sym}`}
                        >
                          <X className="w-2.5 h-2.5 text-white" />
                        </button>
                      )}
                    </div>
                  );
                })}

                {/* Add new pair chip */}
                {favsEditMode && (
                  addingInput !== null && (
                    <div className="flex items-center gap-1 shrink-0">
                      <input
                        autoFocus
                        value={addingInput}
                        onChange={(e) => setAddingInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            const ok = addFavorite(addingInput);
                            if (ok) setAddingInput("");
                            else toast.error("Already in list or invalid");
                          }
                          if (e.key === "Escape") setAddingInput("");
                        }}
                        placeholder="SOL"
                        className="w-16 px-2 py-1 text-[11px] rounded border border-[#555] bg-[#111] text-white font-mono uppercase placeholder:text-[#444] focus:outline-none focus:border-[#eab308]"
                        maxLength={12}
                      />
                      <button
                        onClick={() => {
                          const ok = addFavorite(addingInput);
                          if (ok) setAddingInput("");
                          else toast.error("Already in list or invalid");
                        }}
                        className="w-7 h-7 rounded border border-[#555] bg-[#1a1a1a] flex items-center justify-center text-[#4ade80] hover:border-[#4ade80] transition-colors"
                        title="Add"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col p-3 gap-3 max-w-xl mx-auto w-full pb-10">

        {/* ── POSITION + CHART CARD ─────────────── */}
        <div className="border border-[#2a2a2a] rounded bg-[#0f0f0f] p-4">

          {/* Header row: pair + badges */}
          <div className="flex items-center justify-between mb-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-base font-bold tracking-wider text-white">{selectedSymbol}</span>
              {hasPosition ? (
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold tracking-widest ${isLong ? "bg-[#16a34a]/20 text-[#4ade80] border border-[#16a34a]/50" : "bg-[#dc2626]/20 text-[#f87171] border border-[#dc2626]/50"}`}>
                  {(pos!.side ?? "").toUpperCase()}
                </span>
              ) : (
                <span className="text-[10px] px-1.5 py-0.5 rounded font-bold tracking-widest text-[#444] border border-[#2a2a2a]">FLAT</span>
              )}
              {posLev && <span className="text-[10px] px-1.5 py-0.5 rounded text-[#888] border border-[#222]">{posLev}×</span>}
              {posMarginMode && <span className="text-[9px] px-1.5 py-0.5 rounded text-[#555] border border-[#1f1f1f]">{posMarginMode}</span>}
            </div>
            {symbolLoading && !price && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#333]" />}
          </div>

          {/* OPEN: PnL hero + position grid */}
          {hasPosition && pos ? (
            <>
              <div className="mt-3 mb-1">
                <div className="text-[9px] text-[#444] tracking-widest mb-0.5">UNREALIZED PNL</div>
                <div className={`text-4xl font-bold tabular-nums tracking-tight leading-none ${isPnlPos ? "text-[#4ade80]" : "text-[#f87171]"}`}>
                  {isPnlPos ? "+" : ""}{fmtUsdt(pos.unrealizedPNL)}
                  <span className="text-base font-normal ml-1.5 text-[#555]">USDT</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm border-t border-[#1a1a1a] pt-3 mt-3">
                {pos.entryPrice && (
                  <div>
                    <div className="text-[#444] text-[9px] tracking-widest mb-0.5">ENTRY</div>
                    <div className="text-[#bbb] font-bold tabular-nums">{fmtPrice(pos.entryPrice)}</div>
                    <div className="text-[9px] text-[#333]">USDT</div>
                  </div>
                )}
                <div className="text-right">
                  <div className="text-[#444] text-[9px] tracking-widest mb-0.5">MARK PRICE</div>
                  <div className={`font-bold tabular-nums ${priceColor}`}>{price ? fmtPrice(price) : "···"}</div>
                  <div className="text-[9px] text-[#333]">USDT</div>
                </div>
                {pos.margin && (
                  <div>
                    <div className="text-[#444] text-[9px] tracking-widest mb-0.5">MARGIN USED</div>
                    <div className="text-[#bbb] tabular-nums">{fmtUsdt(pos.margin)}</div>
                    <div className="text-[9px] text-[#333]">USDT</div>
                  </div>
                )}
                <div className="text-right">
                  <div className="text-[#444] text-[9px] tracking-widest mb-0.5">LEVERAGE</div>
                  <div className="text-[#bbb]">{posLev ? `${posLev}×` : "—"}</div>
                </div>
                {pos.qty && (
                  <div>
                    <div className="text-[#444] text-[9px] tracking-widest mb-0.5">SIZE</div>
                    <div className="text-[#bbb] tabular-nums">{pos.qty}</div>
                    <div className="text-[9px] text-[#333]">{baseAsset}</div>
                  </div>
                )}
                {pos.liqPrice && (
                  <div className="text-right">
                    <div className="text-[#444] text-[9px] tracking-widest mb-0.5">LIQ PRICE</div>
                    <div className="text-amber-400 font-bold tabular-nums">{fmtPrice(pos.liqPrice)}</div>
                    <div className="text-[9px] text-amber-800">USDT</div>
                  </div>
                )}
              </div>
            </>
          ) : (
            /* FLAT: clearly labeled mark price + account summary */
            <>
              <div className="mt-2">
                <div className="text-[9px] text-[#444] tracking-widest mb-0.5">MARK PRICE</div>
                <div className="text-3xl font-bold tracking-tight tabular-nums leading-none text-white">
                  {price ? fmtPrice(price) : <span className="text-[#2a2a2a]">···</span>}
                  <span className="text-sm text-[#444] ml-2 font-normal">USDT</span>
                </div>
              </div>
              {accountData && (
                <div className="flex gap-5 mt-3 pt-3 border-t border-[#1a1a1a]">
                  <div>
                    <div className="text-[9px] text-[#444] tracking-widest">AVAILABLE</div>
                    <div className="text-[#4ade80] font-bold tabular-nums">{fmtUsdt(accountData.available)} <span className="text-[9px] text-[#555] font-normal">USDT</span></div>
                  </div>
                  <div>
                    <div className="text-[9px] text-[#444] tracking-widest">EQUITY</div>
                    <div className="text-white font-bold tabular-nums">{fmtUsdt(accountData.balance)} <span className="text-[9px] text-[#555] font-normal">USDT</span></div>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Embedded Chart ─────────────────── */}
          <div className="mt-3 pt-3 border-t border-[#161616]">
            {/* Interval tabs + 1h countdown */}
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex gap-1">
                {KLINE_INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    onClick={() => setChartInterval(iv)}
                    className={`px-2 py-0.5 text-[10px] font-bold tracking-widest rounded transition-colors ${
                      chartInterval === iv
                        ? "bg-white text-black"
                        : "text-[#444] hover:text-[#888] border border-[#222] hover:border-[#333]"
                    }`}
                  >
                    {iv}
                  </button>
                ))}
              </div>
              <div className="text-[9px] tabular-nums">
                <span className="text-[#333]">1h closes </span>
                <span className="text-[#4ade80] font-bold">{countdown1h}</span>
              </div>
            </div>
            {/* HA legend */}
            <div className="flex items-center gap-3 mb-1">
              <span className="text-[8px] text-[#2a2a2a] tracking-widest font-bold">HA</span>
              <span className="flex items-center gap-1 text-[8px] text-[#3a7a3a]"><span className="inline-block w-2 h-1.5 bg-[#16a34a] rounded-sm" />up</span>
              <span className="flex items-center gap-1 text-[8px] text-[#7a3a3a]"><span className="inline-block w-2 h-1.5 bg-[#dc2626] rounded-sm" />dn</span>
              <span className="flex items-center gap-1 text-[8px] text-[#7a6a00]"><span className="inline-block w-2 h-1.5 bg-yellow-600 rounded-sm" />forming</span>
            </div>
            <CandleChart bars={klineBars} displayCount={chartDisplayCount} />
          </div>

          {/* Close + Margin — only when position open */}
          {hasPosition && pos && (
            <div className="flex gap-2 mt-3 pt-3 border-t border-[#1a1a1a]">
              <button
                disabled={isClosing || isExecuting}
                onClick={() => closePosition.mutate({ positionId: pos.positionId ?? "", data: { symbol: selectedSymbol } })}
                className="flex-1 h-10 text-sm font-bold tracking-widest border border-[#444] rounded hover:bg-[#222] disabled:opacity-50 transition-colors"
              >
                {isClosing ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "CLOSE POSITION"}
              </button>
              <button
                disabled={isExecuting}
                onClick={() => setMarginModal({ positionId: pos.positionId ?? "", symbol: selectedSymbol, side: pos.side ?? "LONG", currentMargin: pos.margin ?? "" })}
                className="h-10 px-4 text-xs font-bold tracking-widest border border-[#2a2a2a] rounded hover:bg-[#111] disabled:opacity-40 transition-colors text-[#888]"
              >
                MARGIN
              </button>
            </div>
          )}
        </div>

        {/* ── Warnings / Errors ─────────────────── */}
        {verifyWarning && (
          <div className="bg-amber-500/10 border border-amber-500/50 text-amber-400 p-3 rounded text-xs font-bold flex justify-between items-start gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>VERIFY: {verifyWarning}</span>
            </div>
            <button onClick={() => setVerifyWarning(null)} className="p-1 hover:bg-amber-500/20 rounded shrink-0"><X className="w-4 h-4" /></button>
          </div>
        )}
        {lastError && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-500 p-3 rounded text-sm font-bold flex justify-between items-center">
            <span>ERR: {lastError}</span>
            <button onClick={() => setLastError(null)} className="p-1 hover:bg-red-500/20 rounded"><X className="w-4 h-4" /></button>
          </div>
        )}

        {/* ── LEVERAGE ──────────────────────────── */}
        <div className="space-y-1.5">
          <label className="text-[9px] font-bold tracking-widest text-[#555]">LEVERAGE</label>
          <div className="grid grid-cols-4 gap-2">
            {VALID_LEVERAGES.map((lev) => {
              const isSelected = selectedLeverage === lev;
              return (
                <button
                  key={lev}
                  disabled={isSettingLev || isExecuting}
                  onClick={() => handleSetLeverage(lev)}
                  className={`h-10 text-sm font-bold tracking-wider rounded border transition-colors ${
                    isSelected ? "bg-white text-black border-white" : "bg-transparent text-[#666] border-[#222] hover:border-[#444] hover:text-[#bbb]"
                  } disabled:opacity-40`}
                >
                  {isSettingLev && isSelected ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : `${lev}×`}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── QTY INPUT ─────────────────────────── */}
        <div className="space-y-1.5">
          <label className="text-[9px] font-bold tracking-widest text-[#555]">QTY ({baseAsset})</label>
          <div className="relative">
            <Input
              type="text"
              inputMode="decimal"
              placeholder="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-14 text-2xl font-mono tracking-widest border-[#222] bg-[#0f0f0f] text-white pr-16 focus-visible:ring-1 focus-visible:ring-[#444] focus-visible:ring-offset-0 placeholder:text-[#2a2a2a]"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#444] text-xs font-bold">{baseAsset}</span>
          </div>
        </div>

        {/* ── LONG / SHORT ──────────────────────── */}
        <div className="space-y-2">
          <div className="flex gap-3">
            <button
              disabled={isTradeDisabled}
              onClick={() => handleTrade("long")}
              className={`flex-1 h-14 font-bold tracking-widest text-sm uppercase rounded transition-all active:scale-[0.98] ${
                isTradeDisabled ? "bg-[#111] text-[#333] border border-[#1a1a1a] cursor-not-allowed" : "bg-[#16a34a] text-white border border-[#15803d] hover:bg-[#15803d]"
              }`}
            >
              {tradeLong.isPending ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : `LONG ${selectedLeverage}×`}
            </button>
            <button
              disabled={isTradeDisabled}
              onClick={() => handleTrade("short")}
              className={`flex-1 h-14 font-bold tracking-widest text-sm uppercase rounded transition-all active:scale-[0.98] ${
                isTradeDisabled ? "bg-[#111] text-[#333] border border-[#1a1a1a] cursor-not-allowed" : "bg-[#dc2626] text-white border border-[#b91c1c] hover:bg-[#b91c1c]"
              }`}
            >
              {tradeShort.isPending ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : `SHORT ${selectedLeverage}×`}
            </button>
          </div>
          {hasPosition && (
            <p className="text-center text-[10px] font-bold text-amber-600 tracking-widest">CLOSE CURRENT POSITION FIRST</p>
          )}
        </div>

        {/* ── CLOSE ALL ─────────────────────────── */}
        <div>
          <button
            onClick={() => setIsConfirmOpen(true)}
            disabled={isExecuting}
            className="w-full h-14 bg-[#dc2626] hover:bg-[#b91c1c] text-white font-bold tracking-widest text-base rounded uppercase transition-all active:scale-[0.98] border border-[#7f1d1d] shadow-[0_0_12px_rgba(220,38,38,0.15)] disabled:opacity-50"
          >
            {killAll.isPending ? "CLOSING ALL…" : `CLOSE ALL ${selectedSymbol}`}
          </button>
        </div>

        {/* ── ACCOUNT (collapsible) ─────────────── */}
        <div className="border border-[#1a1a1a] rounded bg-[#090909] overflow-hidden">
          <button
            onClick={() => setAccountOpen((v) => !v)}
            className="w-full px-4 py-3 flex justify-between items-center hover:bg-[#0f0f0f] transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="text-[9px] font-bold tracking-widest text-[#555]">ACCOUNT</span>
              {accountData && <span className="text-sm font-bold text-white tabular-nums">{fmtUsdt(accountData.balance)} USDT</span>}
            </div>
            {accountOpen ? <ChevronUp className="w-4 h-4 text-[#333]" /> : <ChevronDown className="w-4 h-4 text-[#333]" />}
          </button>
          {accountOpen && accountData && (
            <div className="px-4 pb-4 grid grid-cols-2 gap-3 border-t border-[#141414] pt-3 text-sm">
              <div>
                <div className="text-[#444] text-[9px] tracking-widest">AVAILABLE</div>
                <div className="font-bold text-[#4ade80] tabular-nums">{fmtUsdt(accountData.available)}</div>
              </div>
              <div className="text-right">
                <div className="text-[#444] text-[9px] tracking-widest">EQUITY</div>
                <div className="font-bold text-white tabular-nums">{fmtUsdt(accountData.balance)}</div>
              </div>
              <div>
                <div className="text-[#444] text-[9px] tracking-widest">FROZEN</div>
                <div className="text-[#666] tabular-nums">{fmtUsdt(accountData.frozen)}</div>
              </div>
              <div className="text-right">
                <div className="text-[#444] text-[9px] tracking-widest">UNREALIZED PNL</div>
                <div className={`tabular-nums ${parseFloat(accountData.unrealizedPNL ?? "0") >= 0 ? "text-[#4ade80]" : "text-[#f87171]"}`}>
                  {parseFloat(accountData.unrealizedPNL ?? "0") >= 0 ? "+" : ""}{fmtUsdt(accountData.unrealizedPNL)}
                </div>
              </div>
              <div className="col-span-2 text-[8px] text-[#333] tracking-widest">{accountData.positionMode}</div>
            </div>
          )}
        </div>

        {/* ── AUDIT LOG (collapsible) ────────────── */}
        <div className="border border-[#1a1a1a] rounded bg-[#090909] overflow-hidden">
          <button
            onClick={() => setLogsOpen((v) => !v)}
            className="w-full p-3 flex justify-between items-center hover:bg-[#0f0f0f] transition-colors"
          >
            <span className="text-[9px] font-bold tracking-widest text-[#444]">AUDIT LOG</span>
            {logsOpen ? <ChevronUp className="w-4 h-4 text-[#333]" /> : <ChevronDown className="w-4 h-4 text-[#333]" />}
          </button>
          {logsOpen && (
            <div className="p-3 space-y-2 max-h-48 overflow-y-auto text-[11px] font-mono leading-tight border-t border-[#141414]">
              {!logsData?.logs?.length ? (
                <div className="text-[#333] text-center py-2">NO RECORDS</div>
              ) : (
                logsData.logs.slice(0, 8).map((log, i) => (
                  <div key={i} className="flex flex-col border-b border-[#141414] pb-2 last:border-0 last:pb-0">
                    <div className="flex gap-2 items-baseline">
                      <span className="text-[#333] shrink-0">{format(new Date(log.ts), "HH:mm:ss")}</span>
                      <span className="text-[#777] font-bold">{log.action}</span>
                      <span className="text-[#555]">{log.symbol}</span>
                      <span className={`ml-auto ${log.error ? "text-red-600" : "text-[#3a7a3a]"}`}>[{log.status}]</span>
                    </div>
                    {log.error && <div className="text-red-700 pl-14 truncate">ERR: {log.error}</div>}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

      </main>

      {/* ── Confirm Close All Dialog ─────────────── */}
      <Dialog open={isConfirmOpen} onOpenChange={setIsConfirmOpen}>
        <DialogContent className="border-[#333] bg-[#111] sm:max-w-sm font-mono text-[#e5e5e5]">
          <DialogHeader>
            <DialogTitle className="text-red-500 tracking-widest uppercase">Confirm</DialogTitle>
            <DialogDescription className="text-[#888] font-mono">
              Close <strong className="text-white">all</strong> open <strong className="text-white">{selectedSymbol}</strong> positions immediately?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4 flex gap-3">
            <Button
              variant="outline"
              onClick={() => setIsConfirmOpen(false)}
              disabled={killAll.isPending}
              className="flex-1 font-mono tracking-widest border-[#333] hover:bg-[#222] text-white hover:text-white"
            >
              CANCEL
            </Button>
            <Button
              variant="destructive"
              onClick={() => killAll.mutate({ data: { symbol: selectedSymbol } })}
              disabled={killAll.isPending}
              className="flex-1 font-mono tracking-widest font-bold bg-red-600 hover:bg-red-700 text-white"
            >
              {killAll.isPending ? "EXECUTING..." : "CONFIRM"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Margin Modal ─────────────────────────── */}
      {marginModal && (
        <MarginModal
          state={marginModal}
          token={token}
          onClose={() => setMarginModal(null)}
          onSuccess={invalidateAll}
        />
      )}
    </div>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

function AppContent() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    document.documentElement.classList.add("dark");
    const token = localStorage.getItem("killswitch_password");
    setIsAuthenticated(!!token);
  }, []);

  if (isAuthenticated === null) return null;
  if (!isAuthenticated) return <PasswordScreen onAuthenticated={() => setIsAuthenticated(true)} />;
  return <MainApp />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
      <Toaster theme="dark" position="top-center" />
    </QueryClientProvider>
  );
}
