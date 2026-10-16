import { useState, useMemo } from "react";
import { useJournal, useTradeDebrief, useEnrichTrade, type JournalEntry, type DebriefCandle } from "@/hooks/useJournal";
import { cn } from "@/lib/utils";

// ── Sort types ────────────────────────────────────────────────────────────────

type SortKey = "newest" | "best" | "economical" | "easy";
type FilterKey = "all" | "safeguard" | "trigger" | "manual";

const SORT_OPTIONS: { key: SortKey; label: string; title: string }[] = [
  { key: "newest",     label: "Newest",     title: "Most recent first" },
  { key: "best",       label: "Best",       title: "Highest exit ROI first" },
  { key: "economical", label: "Economical", title: "Best ROI per unit of risk (ROI ÷ MAE)" },
  { key: "easy",       label: "Easy",       title: "Smallest adverse excursion first" },
];

const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: "all",       label: "All" },
  { key: "safeguard", label: "Safeguard" },
  { key: "trigger",   label: "Trigger" },
  { key: "manual",    label: "Manual" },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtRoi(pct: string | number | null | undefined): string {
  if (pct == null || pct === "") return "—";
  const n = typeof pct === "string" ? parseFloat(pct) : pct;
  if (isNaN(n)) return "—";
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtPrice(p: string | null | undefined): string {
  if (!p) return "—";
  const n = parseFloat(p);
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function roiNum(pct: string | null | undefined): number {
  return pct ? parseFloat(pct) : 0;
}

function maeNum(pct: string | null | undefined): number {
  return pct ? Math.abs(parseFloat(pct)) : 0;
}

function sortEntries(entries: JournalEntry[], sort: SortKey): JournalEntry[] {
  const copy = [...entries];
  switch (sort) {
    case "best":
      return copy.sort((a, b) => roiNum(b.exitRoiPct) - roiNum(a.exitRoiPct));
    case "economical": {
      const efficiency = (e: JournalEntry) => {
        const mae = maeNum(e.maePct);
        return mae > 0 ? roiNum(e.exitRoiPct) / mae : roiNum(e.exitRoiPct);
      };
      return copy.sort((a, b) => efficiency(b) - efficiency(a));
    }
    case "easy":
      return copy.sort((a, b) => maeNum(a.maePct) - maeNum(b.maePct));
    default:
      return copy.sort((a, b) =>
        new Date(b.exitAt ?? b.createdAt).getTime() - new Date(a.exitAt ?? a.createdAt).getTime()
      );
  }
}

/** Get the ISO week key "YYYY-Www" for grouping. Returns Mon–Sun bucket. */
function weekKey(entry: JournalEntry): string {
  const d = new Date(entry.exitAt ?? entry.createdAt);
  // Normalise to Monday
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  // ISO week label
  return monday.toISOString().slice(0, 10); // "2026-05-04"
}

function weekLabel(isoMonday: string): string {
  const monday = new Date(isoMonday + "T00:00:00");
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  return `${monday.toLocaleDateString(undefined, opts)} – ${sunday.toLocaleDateString(undefined, opts)}`;
}

// ── Style maps ────────────────────────────────────────────────────────────────

const GIVEBACK_COLOR: Record<string, string> = {
  low:      "text-emerald-400",
  moderate: "text-yellow-400",
  high:     "text-red-400",
};

const EXIT_REASON_LABEL: Record<string, string> = {
  original_trigger:     "Trigger",
  safeguard_protection: "Safeguard — 1st lock",
  safeguard_ratchet:    "Safeguard — ratchet",
  manual_flash:         "Manual flash close",
  manual_close_all:     "Manual close all",
};

const SIDE_COLOR: Record<string, string> = {
  SHORT: "bg-red-500/20 text-red-400",
  SELL:  "bg-red-500/20 text-red-400",
  LONG:  "bg-emerald-500/20 text-emerald-400",
  BUY:   "bg-emerald-500/20 text-emerald-400",
};

const PATIENCE_COLOR: Record<string, string> = {
  exceptional: "text-violet-400",
  strong:      "text-emerald-400",
  good:        "text-blue-400",
  standard:    "text-zinc-400",
  tight:       "text-red-400",
};

const HTF_LABEL: Record<string, { text: string; cls: string }> = {
  "aligned-up":   { text: "ALIGNED ↑", cls: "bg-emerald-500/15 text-emerald-300" },
  "aligned-down": { text: "ALIGNED ↓", cls: "bg-red-500/15 text-red-300" },
  "1h-up":        { text: "1H ↑",      cls: "bg-zinc-700/60 text-zinc-400" },
  "1h-down":      { text: "1H ↓",      cls: "bg-zinc-700/60 text-zinc-400" },
  "mixed":        { text: "MIXED",     cls: "bg-zinc-700/60 text-zinc-500" },
};

const PIVOT_CLS: Record<string, string> = {
  approach: "bg-blue-500/15 text-blue-300",
  stall:    "bg-red-500/15 text-red-300",
  bounce:   "bg-red-500/15 text-red-300",
  break:    "bg-emerald-500/15 text-emerald-300",
  clear:    "bg-zinc-700/60 text-zinc-500",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

// ── Mini candlestick chart ─────────────────────────────────────────────────────

function CandleChart({ candles, entryPrice, exitPrice }: {
  candles: DebriefCandle[];
  entryPrice: string | null;
  exitPrice:  string | null;
}) {
  if (candles.length === 0) return null;
  // Bitunix returns newest-first — reverse for chronological display
  const chron = [...candles].reverse();
  const highs  = chron.map((c) => parseFloat(c.high));
  const lows   = chron.map((c) => parseFloat(c.low));
  const rangeHigh = Math.max(...highs);
  const rangeLow  = Math.min(...lows);
  const span = rangeHigh - rangeLow || 1;

  const W = 300;
  const H = 56;
  const pad = 2;
  const innerH = H - pad * 2;
  const cw = Math.max(2, Math.floor((W - pad * 2) / chron.length) - 1);

  const toY = (price: number) => pad + innerH - ((price - rangeLow) / span) * innerH;

  const entryY = entryPrice ? toY(parseFloat(entryPrice)) : null;
  const exitY  = exitPrice  ? toY(parseFloat(exitPrice))  : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: 56 }}
      preserveAspectRatio="none"
    >
      {/* Entry / exit reference lines */}
      {entryY != null && (
        <line x1={0} y1={entryY} x2={W} y2={entryY}
          stroke="#10b981" strokeWidth={0.6} strokeDasharray="3 2" opacity={0.6} />
      )}
      {exitY != null && (
        <line x1={0} y1={exitY} x2={W} y2={exitY}
          stroke="#f59e0b" strokeWidth={0.6} strokeDasharray="3 2" opacity={0.6} />
      )}

      {/* Candles */}
      {chron.map((c, i) => {
        const x     = pad + i * (cw + 1);
        const open  = parseFloat(c.open);
        const close = parseFloat(c.close);
        const high  = parseFloat(c.high);
        const low   = parseFloat(c.low);
        const bull  = close >= open;
        const color = bull ? "#10b981" : "#ef4444";
        const bodyTop    = toY(Math.max(open, close));
        const bodyBottom = toY(Math.min(open, close));
        const bodyH      = Math.max(1, bodyBottom - bodyTop);
        const wickX      = x + cw / 2;
        return (
          <g key={i}>
            <line x1={wickX} y1={toY(high)} x2={wickX} y2={toY(low)}
              stroke={color} strokeWidth={0.8} opacity={0.7} />
            <rect x={x} y={bodyTop} width={cw} height={bodyH}
              fill={bull ? color : "transparent"}
              stroke={color} strokeWidth={bull ? 0 : 0.8}
              opacity={0.85} />
          </g>
        );
      })}
    </svg>
  );
}

// ── Exchange debrief panel ─────────────────────────────────────────────────────

function DebriefPanel({ entry }: { entry: JournalEntry }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useTradeDebrief(entry.id, open);
  const enrich = useEnrichTrade();

  const hasExchangeData = entry.enrichedAt != null;
  const isInferred = entry.dataConfidence === "inferred";
  const missingEntry = entry.entryPrice == null;

  const fmtMoney = (v: number | null) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(4)}`;

  const fmtRoiN = (v: number | null) =>
    v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

  return (
    <div className="mt-3 pt-3 border-t border-zinc-800/60">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wider">Exchange debrief</span>
          {hasExchangeData && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-semibold">
              ENRICHED
            </span>
          )}
          {(isInferred || missingEntry) && !hasExchangeData && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-semibold">
              MISSING DATA
            </span>
          )}
        </div>
        <span className="text-zinc-600 text-xs">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {/* Fetch & save button — prominent for inferred records */}
          {(isInferred || missingEntry) && (
            <button
              onClick={() => enrich.mutate(entry.id)}
              disabled={enrich.isPending}
              className={cn(
                "w-full py-2 rounded-lg text-xs font-semibold transition-colors",
                enrich.isPending
                  ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                  : "bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30",
              )}
            >
              {enrich.isPending
                ? "Fetching from exchange…"
                : hasExchangeData
                ? "Re-fetch & update record"
                : "Fetch exchange data & save to record"}
            </button>
          )}

          {enrich.isError && (
            <p className="text-xs text-red-400 font-mono">
              {enrich.error?.message ?? "Enrichment failed"}
            </p>
          )}
          {enrich.isSuccess && (
            <p className="text-xs text-emerald-400">
              Record updated — entry/exit prices and P&L saved.
            </p>
          )}

          {/* Already-saved enrichment data */}
          {hasExchangeData && (
            <div className="space-y-0.5">
              <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">
                Saved exchange data
                <span className="ml-2 text-zinc-700 normal-case">
                  (fetched {new Date(entry.enrichedAt!).toLocaleDateString()})
                </span>
              </div>
              {entry.realizedPnl != null && (
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Realized P&L</span>
                  <span className={cn(
                    "font-mono font-semibold",
                    parseFloat(entry.realizedPnl) >= 0 ? "text-emerald-400" : "text-red-400",
                  )}>
                    {parseFloat(entry.realizedPnl) >= 0 ? "+" : ""}
                    {parseFloat(entry.realizedPnl).toFixed(4)} USDT
                  </span>
                </div>
              )}
              {entry.exitFee != null && (
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Exchange fee</span>
                  <span className="font-mono text-zinc-400">
                    −{parseFloat(entry.exitFee).toFixed(4)} USDT
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Live debrief data */}
          {isLoading && (
            <p className="text-xs text-zinc-500 animate-pulse">Loading exchange data…</p>
          )}
          {isError && (
            <p className="text-xs text-red-400 font-mono">{String(error)}</p>
          )}

          {data && (
            <div className="space-y-3">
              {/* Exchange-confirmed prices & metrics */}
              {data.exchange ? (
                <div className="space-y-0.5">
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">
                    Exchange-confirmed fills
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">Entry price</span>
                    <span className="font-mono text-zinc-200">
                      {parseFloat(data.exchange.entryPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">Exit price</span>
                    <span className="font-mono text-zinc-200">
                      {parseFloat(data.exchange.exitPrice).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">Qty</span>
                    <span className="font-mono text-zinc-400">{data.exchange.qty}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">Realized P&L</span>
                    <span className={cn(
                      "font-mono font-semibold",
                      parseFloat(data.exchange.realizedPnl) >= 0 ? "text-emerald-400" : "text-red-400",
                    )}>
                      {fmtMoney(parseFloat(data.exchange.realizedPnl))} USDT
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-500">Exchange fee</span>
                    <span className="font-mono text-zinc-400">
                      −{Math.abs(parseFloat(data.exchange.fee ?? "0")).toFixed(4)} USDT
                    </span>
                  </div>
                  {data.computed.netPnl != null && data.computed.totalFee != null && (
                    <div className="flex justify-between text-xs border-t border-zinc-800/60 pt-1.5 mt-1">
                      <span className="text-zinc-400">Net after fees</span>
                      <span className={cn(
                        "font-mono font-bold",
                        data.computed.netPnl >= 0 ? "text-emerald-400" : "text-red-400",
                      )}>
                        {fmtMoney(data.computed.netPnl)} USDT
                      </span>
                    </div>
                  )}
                  {data.computed.exchangeRoiPct != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Exchange ROI%</span>
                      <span className={cn(
                        "font-mono font-bold",
                        data.computed.exchangeRoiPct >= 0 ? "text-emerald-400" : "text-red-400",
                      )}>
                        {fmtRoiN(data.computed.exchangeRoiPct)}
                      </span>
                    </div>
                  )}
                  {data.computed.holdDurationMs != null && (
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-400">Exchange hold time</span>
                      <span className="font-mono text-zinc-400">
                        {Math.floor(data.computed.holdDurationMs / 60000)}m {Math.round((data.computed.holdDurationMs % 60000) / 1000)}s
                      </span>
                    </div>
                  )}
                  {/* Open / close timestamps from exchange */}
                  <div className="flex justify-between text-xs pt-0.5">
                    <span className="text-zinc-600">Opened</span>
                    <span className="font-mono text-zinc-500">
                      {new Date(data.exchange.openTime).toLocaleString([], {
                        month: "short", day: "numeric",
                        hour: "2-digit", minute: "2-digit", second: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-600">Closed</span>
                    <span className="font-mono text-zinc-500">
                      {new Date(data.exchange.closeTime).toLocaleString([], {
                        month: "short", day: "numeric",
                        hour: "2-digit", minute: "2-digit", second: "2-digit",
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-zinc-600">Position ID</span>
                    <span className="font-mono text-zinc-600 text-[10px] break-all text-right max-w-[160px]">
                      {data.exchange.positionId}
                    </span>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-500 italic">
                  No matching position found in exchange history for this trade window.
                </p>
              )}

              {/* 3m candle replay chart */}
              {data.candles.length > 0 && (
                <div>
                  <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">
                    3m candle replay · hold window
                    <span className="ml-2 text-zinc-700 normal-case">
                      {data.candles.length} bars
                    </span>
                  </div>
                  <div className="rounded-lg bg-zinc-950 px-2 py-1.5">
                    <CandleChart
                      candles={data.candles}
                      entryPrice={data.exchange?.entryPrice ?? entry.entryPrice}
                      exitPrice={data.exchange?.exitPrice  ?? entry.exitPrice}
                    />
                    <div className="flex items-center gap-3 mt-1 text-[9px] font-mono">
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-3 h-px bg-emerald-500 opacity-60" style={{ borderTop: "1px dashed" }} />
                        <span className="text-emerald-600">entry</span>
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="inline-block w-3 h-px bg-amber-500 opacity-60" />
                        <span className="text-amber-600">exit</span>
                      </span>
                      <span className="text-zinc-700 ml-auto">green = bullish · red = bearish</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Shared Row helper ─────────────────────────────────────────────────────────

function Row({ label, value, valueClass }: { label: string; value: React.ReactNode; valueClass?: string }) {
  return (
    <div className="flex justify-between items-start gap-2 py-1 min-w-0">
      <span className="text-zinc-500 text-xs shrink-0">{label}</span>
      <span className={cn("font-mono text-xs text-right min-w-0 break-words", valueClass ?? "text-zinc-300")}>
        {value}
      </span>
    </div>
  );
}

function StructureFlags({ entry }: { entry: JournalEntry }) {
  const chips: { text: string; cls: string }[] = [];
  if (entry.htfAlignment && HTF_LABEL[entry.htfAlignment]) chips.push(HTF_LABEL[entry.htfAlignment]);
  if (entry.fifteenMinConfirm)      chips.push({ text: "15M CONFIRMS", cls: "bg-emerald-500/15 text-emerald-300" });
  else if (entry.threeMinLead)      chips.push({ text: "3M LEADS",     cls: "bg-blue-500/15 text-blue-300" });
  if (entry.fourBarStreak != null && Math.abs(entry.fourBarStreak) >= 4)
    chips.push({ text: `4-BAR ${Math.abs(entry.fourBarStreak)}${entry.fourBarStreak > 0 ? "↑" : "↓"} ✓`, cls: "bg-violet-500/15 text-violet-300" });
  else if (entry.fourBarStreak != null && Math.abs(entry.fourBarStreak) >= 2)
    chips.push({ text: `${Math.abs(entry.fourBarStreak)}-BAR ${entry.fourBarStreak > 0 ? "↑" : "↓"}`, cls: "bg-zinc-700/60 text-zinc-400" });
  if (entry.velocityState === "fast") chips.push({ text: "FAST", cls: "bg-amber-500/15 text-amber-300" });
  else if (entry.velocityState === "slow") chips.push({ text: "SLOW", cls: "bg-zinc-700/60 text-zinc-500" });
  if (entry.pivotState && entry.pivotState !== "clear")
    chips.push({ text: entry.pivotState.toUpperCase(), cls: PIVOT_CLS[entry.pivotState] ?? "bg-zinc-700/60 text-zinc-400" });
  if (entry.resumption)  chips.push({ text: "RESUMPTION ✓", cls: "bg-emerald-500/15 text-emerald-300" });
  else if (entry.counterMove) chips.push({ text: "COUNTER-MOVE", cls: "bg-yellow-500/15 text-yellow-300" });

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c, i) => (
          <span key={i} className={cn("text-xs px-2 py-0.5 rounded font-semibold uppercase tracking-wide", c.cls)}>
            {c.text}
          </span>
        ))}
      </div>
      {((entry.patienceBoost != null && entry.patienceBoost !== 0) || entry.trailWidth) ? (
        <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono">
          {entry.patienceBoost != null && entry.patienceBoost !== 0 && (
            <span className={entry.patienceBoost > 0 ? "text-emerald-400" : "text-yellow-400"}>
              {entry.patienceBoost > 0 ? "+" : ""}{entry.patienceBoost} boost
            </span>
          )}
          {entry.trailWidth && <span>· trail {parseFloat(entry.trailWidth).toFixed(1)}%</span>}
        </div>
      ) : null}
    </div>
  );
}

function JournalCard({ entry }: { entry: JournalEntry }) {
  const [open, setOpen] = useState(false);
  const side    = entry.side.toUpperCase();
  const roi     = roiNum(entry.exitRoiPct);
  const roiColor = roi >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/60">
      {/* Clickable header */}
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left p-4 hover:bg-zinc-800/40 transition-colors rounded-xl"
      >
        {/* Top row: symbol + side + date */}
        <div className="flex items-center justify-between gap-2 mb-3 min-w-0">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <span className="font-mono text-base font-bold text-zinc-100">{entry.symbol}</span>
            <span className={cn("text-xs px-2 py-0.5 rounded font-semibold", SIDE_COLOR[side] || "bg-zinc-700 text-zinc-300")}>
              {side}
            </span>
            <span className="text-zinc-400 text-sm font-mono">{entry.leverage}x</span>
            {entry.nearMiss && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/10 text-yellow-400 font-semibold">near-miss</span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-zinc-500 font-mono">
              {entry.exitAt
                ? new Date(entry.exitAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                : "—"}
            </span>
            <span className="text-zinc-600 text-sm">{open ? "▴" : "▾"}</span>
          </div>
        </div>

        {/* Key metrics */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
          <div>
            <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Hold</div>
            <div className="text-zinc-300 font-mono">{fmtDuration(entry.holdDurationMs)}</div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Peak ROI</div>
            <div className="text-zinc-300 font-mono">{fmtRoi(entry.peakRoiPct)}</div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Exit ROI</div>
            <div className={cn("font-mono font-semibold", roiColor)}>{fmtRoi(entry.exitRoiPct)}</div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">MFE</div>
            <div className="text-zinc-300 font-mono">{fmtRoi(entry.mfePct)}</div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">MAE</div>
            <div className="text-zinc-300 font-mono">{fmtRoi(entry.maePct)}</div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Giveback</div>
            <div className={cn("font-mono font-semibold", GIVEBACK_COLOR[entry.givebackRating || ""] ?? "text-zinc-400")}>
              {entry.givebackPct ? `${parseFloat(entry.givebackPct).toFixed(1)}%` : "—"}
            </div>
          </div>
        </div>

        {/* Exit method + patience badge */}
        <div className="mt-2.5 flex items-center gap-2 flex-wrap">
          {entry.safeguardUsed ? (
            <>
              <span className="text-sm text-violet-400 font-semibold">
                {entry.ratchetCount > 0
                  ? `${entry.ratchetCount} ratchet${entry.ratchetCount !== 1 ? "s" : ""} climbed`
                  : "No ratchet advance"}
              </span>
              {entry.protectedRoiPct && (
                <span className="text-xs text-zinc-500">· locked {fmtRoi(entry.protectedRoiPct)}</span>
              )}
            </>
          ) : (
            <span className="text-xs text-zinc-500">
              {EXIT_REASON_LABEL[entry.exitReason] ?? entry.exitReason}
            </span>
          )}
          {entry.patienceLevel && (
            <span className={cn(
              "text-xs px-2 py-0.5 rounded font-semibold bg-zinc-800 ml-auto",
              PATIENCE_COLOR[entry.patienceLevel] ?? "text-zinc-400",
            )}>
              {entry.patienceLevel.toUpperCase()}
            </span>
          )}
        </div>
      </button>

      {/* Expanded detail — not overflow-hidden so long text renders fully */}
      {open && (
        <div className="px-4 pb-4 border-t border-zinc-800 pt-3 space-y-0.5">
          <Row label="Entry price"   value={fmtPrice(entry.entryPrice)} />
          <Row label="Exit price"    value={fmtPrice(entry.exitPrice)} />
          <Row label="Protected ROI" value={fmtRoi(entry.protectedRoiPct)} valueClass="text-emerald-400" />
          <Row label="Ratchets"      value={entry.ratchetCount ?? 0} />
          {entry.executionLatencyMs != null && (
            <Row label="Exec latency" value={`${entry.executionLatencyMs} ms`} />
          )}

          {/* Setup fingerprint — full-width block to avoid cropping */}
          {entry.setupFingerprint && (
            <div className="py-1.5">
              <div className="text-zinc-500 text-xs mb-1">Setup fingerprint</div>
              <p className="text-zinc-400 text-xs font-mono break-all leading-relaxed bg-zinc-800/50 rounded px-2 py-1.5">
                {entry.setupFingerprint}
              </p>
            </div>
          )}

          {/* Market-structure snapshot */}
          {entry.htfAlignment && (
            <div className="mt-3 pt-3 border-t border-zinc-800/60">
              <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">Structure at exit</div>
              <StructureFlags entry={entry} />
            </div>
          )}

          {/* Pre-trade plan snapshot */}
          {entry.uploadUsed && entry.tradePlanId != null && (
            <div className="mt-3 pt-3 border-t border-zinc-800/60">
              <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider flex items-center gap-1.5">
                <span>Pre-trade plan</span>
                {entry.outcomeVsPlan && (
                  <span className={cn(
                    "text-xs px-1.5 py-0.5 rounded font-semibold normal-case tracking-normal",
                    entry.outcomeVsPlan === "confirmed" ? "bg-emerald-500/15 text-emerald-300"
                      : entry.outcomeVsPlan === "partial" ? "bg-blue-500/15 text-blue-300"
                      : "bg-red-500/15 text-red-300",
                  )}>
                    {entry.outcomeVsPlan}
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-2 text-sm">
                <div>
                  <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Zone</div>
                  <div className="text-zinc-300 font-mono">{entry.channelZoneAtPlan ?? "—"}</div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Agreement</div>
                  <div className={cn(
                    "font-mono",
                    (entry.agreementScoreAtPlan ?? 0) >= 50  ? "text-emerald-400"
                    : (entry.agreementScoreAtPlan ?? 0) >= 15 ? "text-blue-400"
                    : (entry.agreementScoreAtPlan ?? 0) <= -50 ? "text-red-400"
                    : (entry.agreementScoreAtPlan ?? 0) <= -15 ? "text-yellow-400"
                    : "text-zinc-400",
                  )}>
                    {entry.agreementScoreAtPlan != null
                      ? (entry.agreementScoreAtPlan >= 0 ? "+" : "") + entry.agreementScoreAtPlan
                      : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-zinc-500 text-xs uppercase tracking-wide mb-0.5">Continuation</div>
                  <div className="text-zinc-300 font-mono">
                    {entry.continuationProbAtPlan != null ? `${entry.continuationProbAtPlan}%` : "—"}
                  </div>
                </div>
              </div>
              {entry.recommendedPatienceAtPlan && (
                <div className="text-xs text-zinc-500 font-mono mt-1.5">
                  patience {entry.recommendedPatienceAtPlan}
                  {entry.userBiasAtPlan && ` · user bias ${entry.userBiasAtPlan}`}
                </div>
              )}
              {entry.tradePlanId && (
                <a
                  href={`/api/trade-plan/${entry.tradePlanId}/image`}
                  target="_blank" rel="noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 underline mt-1.5 inline-block"
                >
                  view chart
                </a>
              )}
            </div>
          )}

          {/* Oracle score at arm */}
          {entry.edgeScore != null && (
            <div className="mt-3 pt-3 border-t border-zinc-800/60">
              <div className="text-xs text-zinc-500 mb-2 uppercase tracking-wider">Oracle score at arm</div>
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className={cn(
                  "text-2xl font-bold font-mono",
                  entry.edgeScore >= 80 ? "text-violet-400"
                  : entry.edgeScore >= 65 ? "text-emerald-400"
                  : entry.edgeScore >= 45 ? "text-zinc-300"
                  : entry.edgeScore >= 25 ? "text-yellow-400"
                  : "text-red-400",
                )}>
                  {entry.edgeScore}
                  <span className="text-zinc-600 text-sm font-normal ml-1">/100</span>
                </span>
                {entry.wholeNumberPlayType && entry.wholeNumberPlayType !== "none" && (
                  <span className="text-xs px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">
                    {entry.wholeNumberPlayType.replace(/_/g, " ")}
                  </span>
                )}
                {entry.walletSizeScore != null && (
                  <span className="text-xs text-zinc-600 font-mono">wallet {entry.walletSizeScore}/20</span>
                )}
              </div>
            </div>
          )}

          {/* Verdict */}
          {entry.verdict && (
            <div className="mt-3 pt-3 border-t border-zinc-800/60">
              <div className="text-xs text-zinc-500 mb-1.5">Verdict</div>
              <p className="text-sm text-zinc-400 italic leading-relaxed">{entry.verdict}</p>
            </div>
          )}

          {/* Exchange debrief — always available */}
          <DebriefPanel entry={entry} />
        </div>
      )}
    </div>
  );
}

// ── Week header ───────────────────────────────────────────────────────────────

function WeekHeader({ isoMonday, entries }: { isoMonday: string; entries: JournalEntry[] }) {
  const wins    = entries.filter((e) => roiNum(e.exitRoiPct) > 0).length;
  const losses  = entries.filter((e) => roiNum(e.exitRoiPct) < 0).length;
  const avgRoi  = entries.length > 0
    ? entries.reduce((s, e) => s + roiNum(e.exitRoiPct), 0) / entries.length
    : 0;
  const winRate = entries.length > 0 ? Math.round((wins / entries.length) * 100) : 0;

  return (
    <div className="flex items-center justify-between gap-2 px-1 pt-2 pb-1">
      <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
        {weekLabel(isoMonday)}
      </span>
      <div className="flex items-center gap-2 text-[10px] font-mono">
        <span className="text-emerald-400">{wins}W</span>
        <span className="text-zinc-600">/</span>
        <span className="text-red-400">{losses}L</span>
        <span className="text-zinc-600">·</span>
        <span className={winRate >= 50 ? "text-emerald-400" : "text-red-400"}>{winRate}%</span>
        <span className="text-zinc-600">·</span>
        <span className={cn("font-semibold", avgRoi >= 0 ? "text-emerald-400" : "text-red-400")}>
          {avgRoi >= 0 ? "+" : ""}{avgRoi.toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

// ── Main export ────────────────────────────────────────────────────────────────

export function TradeJournal({ symbol }: { symbol?: string } = {}) {
  const { data: entries = [], isLoading } = useJournal({ limit: 100, symbol });
  const [filter,    setFilter]    = useState<FilterKey>("all");
  const [sort,      setSort]      = useState<SortKey>("newest");
  const [collapsed, setCollapsed] = useState(false);

  const filtered = useMemo(() =>
    entries.filter((e) => {
      if (filter === "safeguard") return e.safeguardUsed;
      if (filter === "trigger")   return e.sourceType === "trigger";
      if (filter === "manual")    return e.sourceType === "manual";
      return true;
    }),
    [entries, filter],
  );

  const sorted = useMemo(() => sortEntries(filtered, sort), [filtered, sort]);

  // Group by week
  const weekGroups = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const e of sorted) {
      const k = weekKey(e);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(e);
    }
    return map;
  }, [sorted]);

  const count = entries.length;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between mb-1"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
            Trade Memory
          </span>
          {count > 0 && (
            <span className="text-xs bg-zinc-700 text-zinc-300 px-2 py-0.5 rounded-full font-mono">
              {count}
            </span>
          )}
        </div>
        <span className="text-zinc-600 text-sm">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <>
          {count > 0 && (
            <div className="space-y-2 mt-2 mb-4">
              {/* Filter row */}
              <div className="flex gap-1.5 flex-wrap">
                {FILTER_OPTIONS.map((f) => (
                  <button
                    key={f.key}
                    onClick={(e) => { e.stopPropagation(); setFilter(f.key); }}
                    className={cn(
                      "text-xs px-3 py-1.5 rounded-full font-medium transition-colors",
                      filter === f.key ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300",
                    )}
                  >
                    {f.label}
                  </button>
                ))}
              </div>

              {/* Sort row */}
              <div className="flex gap-1.5 flex-wrap items-center">
                <span className="text-[10px] text-zinc-600 uppercase tracking-wider">Sort</span>
                {SORT_OPTIONS.map((s) => (
                  <button
                    key={s.key}
                    onClick={(e) => { e.stopPropagation(); setSort(s.key); }}
                    title={s.title}
                    className={cn(
                      "text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors",
                      sort === s.key
                        ? "bg-violet-600/30 text-violet-300 border border-violet-500/40"
                        : "text-zinc-600 hover:text-zinc-400 border border-transparent",
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {isLoading && <div className="text-sm text-zinc-500 py-3">Loading…</div>}

          {!isLoading && sorted.length === 0 && (
            <div className="text-sm text-zinc-600 text-center py-8">No completed trades yet</div>
          )}

          {/* Weekly groups */}
          <div className="space-y-1">
            {[...weekGroups.entries()].map(([isoMonday, group]) => (
              <div key={isoMonday} className="space-y-2">
                <WeekHeader isoMonday={isoMonday} entries={group} />
                {group.map((e) => <JournalCard key={e.id} entry={e} />)}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
