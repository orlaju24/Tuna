import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Lightbulb,
  ArrowUp,
  ArrowDown,
  Minus,
  Hash,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Coffee,
  Settings,
  RefreshCw,
  Moon,
} from "lucide-react";
import { useSignal, type Direction, type TimeframeRead } from "@/hooks/useSignal";
import { useEdgeScore } from "@/hooks/useEdgeScore";
import { useTriggers } from "@/hooks/useTriggers";
import { useSafeguards, useCreateSafeguard, useDisarmSafeguard } from "@/hooks/useSafeguard";
import { useScheduleStatus } from "@/hooks/useScheduleStatus";
import { fmtDuration } from "@/lib/schedule";
import { ScheduleSettingsModal } from "./ScheduleSettingsModal";
import { normalizePositionDirection, type Position } from "@/hooks/usePositions";
import { cn } from "@/lib/utils";

const WALK_AWAY_KEY = "bitunix.walkAway";
const HOURLY_REFETCH_MS = 60 * 60 * 1000;

const TF_LABELS: Record<string, string> = {
  "3m": "Short pulse (3m)",
  "15m": "Mid pulse (15m)",
  "1h": "Main trend (1h)",
  "6h": "Higher bias (6h)",
};

function fmtLevel(level: number, step: number): string {
  const decimals = step >= 1 ? 0 : Math.max(0, -Math.floor(Math.log10(step)));
  return level.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function dirIcon(d: Direction) {
  if (d === "up") return <ArrowUp size={12} />;
  if (d === "down") return <ArrowDown size={12} />;
  return <Minus size={12} />;
}

function dirTone(d: Direction): string {
  if (d === "up") return "text-emerald-400 bg-emerald-900/30";
  if (d === "down") return "text-red-400 bg-red-900/30";
  return "text-zinc-400 bg-zinc-800";
}

function dirLabel(d: Direction): string {
  if (d === "up") return "UP";
  if (d === "down") return "DOWN";
  return "MIXED";
}

function TimeframeRow({ tf, read }: { tf: string; read: TimeframeRead }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="text-zinc-500">{read.ok ? dirIcon(read.direction) : <Minus size={12} />}</span>
        <span>{TF_LABELS[tf] || tf}</span>
      </div>
      <div className="flex items-center gap-2">
        {read.ok ? (
          <span className="text-[10px] text-zinc-600 font-mono">
            {read.lastCandlePct >= 0 ? "+" : ""}
            {read.lastCandlePct.toFixed(2)}%
          </span>
        ) : null}
        <span
          className={cn(
            "text-xs font-semibold px-2 py-0.5 rounded-full",
            read.ok ? dirTone(read.direction) : "text-zinc-600 bg-zinc-800/60"
          )}
        >
          {read.ok ? dirLabel(read.direction) : "NO DATA"}
        </span>
      </div>
    </div>
  );
}

function VerdictBanner({
  label,
  confidence,
  score,
}: {
  label: string;
  confidence: "low" | "medium" | "high";
  score: number;
}) {
  const isBull = score >= 3;
  const isBear = score <= -3;
  const tone = isBull
    ? "bg-emerald-900/40 border-emerald-700/40 text-emerald-300"
    : isBear
      ? "bg-red-900/40 border-red-700/40 text-red-300"
      : "bg-zinc-800 border-zinc-700/40 text-zinc-300";

  const conf = confidence.toUpperCase();
  const confTone =
    confidence === "high"
      ? "text-white"
      : confidence === "medium"
        ? "text-zinc-200"
        : "text-zinc-500";

  return (
    <div className={cn("rounded-lg border px-3 py-2 mb-2", tone)}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className={cn("text-[10px] font-mono uppercase", confTone)}>
          conf · {conf}
        </span>
      </div>
      <div className="text-[10px] opacity-70 mt-0.5 font-mono">score {score >= 0 ? "+" : ""}{score} / ±8</div>
    </div>
  );
}

// ── Heikin Ashi trend row ─────────────────────────────────────────────────────

function HeikinAshiRow({ haStreak3m, haStreak15m, haBodyStrength3m, haNoDissent3m }: {
  haStreak3m: number;
  haStreak15m: number;
  haBodyStrength3m: number;
  haNoDissent3m: boolean;
}) {
  const dir3m  = haStreak3m  > 0 ? "up"   : haStreak3m  < 0 ? "down" : "mixed";
  const dir15m = haStreak15m > 0 ? "up"   : haStreak15m < 0 ? "down" : "mixed";
  const abs3m  = Math.abs(haStreak3m);
  const abs15m = Math.abs(haStreak15m);

  // Body strength indicator — only shown when ≥ 0.65 (meaningful)
  const bodyPct = Math.round(haBodyStrength3m * 100);

  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className="text-zinc-500">{dirIcon(dir3m)}</span>
        <span>Heikin Ashi (3m)</span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap justify-end">
        {/* 15m HA tag */}
        {abs15m >= 1 && (
          <span className={cn(
            "text-[10px] font-mono px-1.5 py-0.5 rounded",
            dir15m === "up"   ? "text-emerald-500/70 bg-emerald-900/20" :
            dir15m === "down" ? "text-red-500/70 bg-red-900/20" :
            "text-zinc-600 bg-zinc-800/40"
          )}>
            15m×{abs15m}
          </span>
        )}
        {/* Body strength — only shown if notable */}
        {haBodyStrength3m >= 0.65 && abs3m >= 1 && (
          <span className={cn(
            "text-[10px] font-mono",
            haBodyStrength3m >= 0.85 ? "text-yellow-400" : "text-zinc-500"
          )}>
            {bodyPct}%
          </span>
        )}
        {/* No-dissent badge — the cleanest signal */}
        {haNoDissent3m && abs3m >= 2 && (
          <span className="text-[10px] text-violet-400 font-semibold">clean</span>
        )}
        {/* Main 3m HA streak badge */}
        <span className={cn(
          "text-xs font-semibold px-2 py-0.5 rounded-full",
          abs3m === 0   ? "text-zinc-600 bg-zinc-800"
          : dir3m === "up"
            ? abs3m >= 4  ? "text-emerald-300 bg-emerald-900/50"
              : abs3m >= 2  ? "text-emerald-400 bg-emerald-900/40"
              : "text-emerald-500/70 bg-emerald-900/20"
            : abs3m >= 4  ? "text-red-300 bg-red-900/50"
              : abs3m >= 2  ? "text-red-400 bg-red-900/40"
              : "text-red-500/70 bg-red-900/20"
        )}>
          {abs3m === 0 ? "NEUTRAL" : `${dir3m === "up" ? "↑" : "↓"} ${abs3m}`}
        </span>
      </div>
    </div>
  );
}

export function SignalAwareness({
  symbol,
  position,
}: {
  symbol: string;
  position: Position | null;
}) {
  const qc = useQueryClient();
  const { status, windows, setWindows, setScheduleEnabled } = useScheduleStatus();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const {
    data: envelope,
    isLoading,
    isError,
    isFetching,
    dataUpdatedAt,
  } = useSignal(symbol, {
    enabled: status.inWindow,
    refetchIntervalMs: HOURLY_REFETCH_MS,
  });

  // HA data comes from the Oracle score's structure context (already cached 30s,
  // no extra API call — React Query deduplicates the same queryKey).
  const { data: edgeData } = useEdgeScore(symbol);
  const haStreak3m       = edgeData?.structure?.haStreak3m       ?? 0;
  const haStreak15m      = edgeData?.structure?.haStreak15m      ?? 0;
  const haBodyStrength3m = edgeData?.structure?.haBodyStrength3m ?? 0;
  const haNoDissent3m    = edgeData?.structure?.haNoDissent3m    ?? false;

  const { data: triggers = [] } = useTriggers();
  const { data: safeguards = [] } = useSafeguards(symbol);
  const createSafeguard = useCreateSafeguard();
  const disarmSafeguard = useDisarmSafeguard();

  // Walk-away persisted to localStorage
  const [walkAway, setWalkAway] = useState<boolean>(() => {
    try { return localStorage.getItem(WALK_AWAY_KEY) === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(WALK_AWAY_KEY, walkAway ? "1" : "0"); } catch { /**/ }
  }, [walkAway]);

  // Active safeguard for this symbol
  const activeSafeguard = safeguards.find((s) =>
    position?.positionId != null &&
    s.positionId === String(position.positionId) &&
    ["armed", "protecting"].includes(s.state)
  );
  const safeguardState = activeSafeguard?.state ?? null; // "armed" | "protecting" | null

  // Combined protection state
  const triggerArmed = triggers.some((t) => t.symbol === symbol && t.armed);

  // Protection row label + colour
  const protectionLabel =
    safeguardState === "protecting" ? "GUARDED"
    : safeguardState === "armed"   ? "ARMED"
    : triggerArmed                 ? "SET"
    : "NONE";

  const protectionColor =
    safeguardState === "protecting" ? "text-emerald-400 bg-emerald-900/30"
    : safeguardState === "armed"   ? "text-blue-400 bg-blue-900/30"
    : triggerArmed                 ? "text-blue-400 bg-blue-900/30"
    : "text-yellow-400 bg-yellow-900/30";

  const ProtectionIcon =
    safeguardState === "protecting" ? ShieldCheck
    : safeguardState === "armed"   ? ShieldAlert
    : triggerArmed                 ? ShieldCheck
    : ShieldOff;

  // Walk-away toggle — auto-arms / disarms the safeguard
  const toggleWalkAway = () => {
    const next = !walkAway;
    setWalkAway(next);

    const direction = normalizePositionDirection(position?.side);
    if (next && position?.positionId && direction && !activeSafeguard) {
      // Auto-arm with sensible defaults (17 % arm, 3 % trail, flash close)
      createSafeguard.mutate({
        symbol,
        side: direction,
        entryPrice: position.avgOpenPrice ?? position.entryPrice ?? "0",
        qty: position.qty,
        leverage: parseInt(String(position.leverage)),
        positionId: String(position.positionId),
        threshold1Pct: 17,
        threshold2Pct: 23,
        trailStepPct: 3,
        closeMethod: "flash_close",
      });
    } else if (!next && activeSafeguard) {
      // Disarm when walk-away is turned off
      disarmSafeguard.mutate(activeSafeguard.id);
    }
  };

  // Walk-away button label
  const walkAwayLabel =
    walkAway && safeguardState === "protecting" ? "ON · GUARDED"
    : walkAway && safeguardState === "armed"    ? "ON · ARMED"
    : walkAway                                  ? "ON"
    : "OFF";

  const walkAwayColor = walkAway
    ? "bg-emerald-900/40 text-emerald-400 hover:bg-emerald-900/60"
    : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700";

  // Walk-away status hint
  const walkAwayHint =
    walkAway && safeguardState === "protecting"
      ? "Safeguard is trailing profit — will close on retrace."
      : walkAway && safeguardState === "armed"
        ? "Safeguard watching for 17% ROI before trailing."
        : walkAway && !position
          ? "Walk-away on — open a position to activate safeguard."
          : walkAway && triggerArmed
            ? "Trigger set. Walk away — it will close on cross."
            : walkAway
              ? "Walk-away on. Arm a trigger or safeguard first."
              : null;

  const hintColor =
    safeguardState === "protecting" ? "text-emerald-400/80"
    : safeguardState === "armed"   ? "text-blue-400/80"
    : "text-yellow-400/80";

  const wakeNow = () => {
    qc.invalidateQueries({ queryKey: ["signal", symbol] });
    qc.refetchQueries({ queryKey: ["signal", symbol] });
  };

  const lastUpdatedLabel = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Lightbulb size={14} className="text-zinc-400" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
            Signal Awareness
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 hidden sm:inline">guide layer · not advice</span>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-zinc-500 hover:text-zinc-300 p-0.5"
            title="Awareness schedule"
          >
            <Settings size={13} />
          </button>
        </div>
      </div>

      {/* Schedule status strip */}
      <div
        className={cn(
          "rounded-lg px-2.5 py-1.5 mb-2 flex items-center justify-between text-[11px]",
          status.inWindow
            ? "bg-emerald-900/20 text-emerald-400"
            : "bg-zinc-800/60 text-zinc-500"
        )}
      >
        <div className="flex items-center gap-1.5">
          {status.inWindow ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>
                LIVE
                {status.currentWindow?.label ? ` · ${status.currentWindow.label}` : ""}
                {status.minutesUntilWindowEnd !== null
                  ? ` · ${fmtDuration(status.minutesUntilWindowEnd)} left`
                  : ""}
              </span>
            </>
          ) : (
            <>
              <Moon size={11} />
              <span>
                QUIET
                {status.nextWindow
                  ? ` · next ${status.nextWindow.start} ET${status.nextWindow.label ? ` (${status.nextWindow.label})` : ""}`
                  : status.scheduleEnabled
                    ? " · no windows configured"
                    : ""}
              </span>
            </>
          )}
        </div>
        {!status.inWindow && status.scheduleEnabled && (
          <button
            onClick={wakeNow}
            disabled={isFetching}
            className="flex items-center gap-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40"
            title="Force one fresh read now"
          >
            <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} />
            <span>Wake now</span>
          </button>
        )}
      </div>

      {/* Outside-window placeholder */}
      {!status.inWindow && !envelope && (
        <div className="text-[11px] text-zinc-500 italic py-1 mb-1">
          Awareness paused to preserve credits. Tap "Wake now" for an on-demand read.
        </div>
      )}

      {isLoading && status.inWindow && (
        <div className="text-xs text-zinc-500 py-2">Reading market…</div>
      )}
      {isError && status.inWindow && (
        <div className="text-xs text-red-400 py-2">Could not read signal data from Bitunix</div>
      )}

      {envelope?.code === 0 && envelope.data && (
        <>
          <VerdictBanner
            label={envelope.data.verdict.label}
            confidence={envelope.data.verdict.confidence}
            score={envelope.data.verdict.score}
          />
          {!status.inWindow && lastUpdatedLabel && (
            <div className="text-[10px] text-zinc-600 italic mb-1">
              Last read at {lastUpdatedLabel} — gauge is paused.
            </div>
          )}
          <div className="divide-y divide-zinc-800/60">
            <TimeframeRow tf="3m"  read={envelope.data.timeframes["3m"]}  />
            <TimeframeRow tf="15m" read={envelope.data.timeframes["15m"]} />
            <TimeframeRow tf="1h"  read={envelope.data.timeframes["1h"]}  />
            <TimeframeRow tf="6h"  read={envelope.data.timeframes["6h"]}  />
            <HeikinAshiRow
              haStreak3m={haStreak3m}
              haStreak15m={haStreak15m}
              haBodyStrength3m={haBodyStrength3m}
              haNoDissent3m={haNoDissent3m}
            />
            <div className="flex items-center justify-between py-1.5">
              <div className="flex items-center gap-2 text-xs text-zinc-400">
                <Hash size={12} className="text-zinc-500" />
                <span>Whole number</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-600 font-mono">
                  {fmtLevel(envelope.data.wholeNumber.level, envelope.data.wholeNumber.step)} ({envelope.data.wholeNumber.distancePct.toFixed(2)}%)
                </span>
                <span
                  className={cn(
                    "text-xs font-semibold px-2 py-0.5 rounded-full",
                    envelope.data.wholeNumber.nearby
                      ? "text-yellow-400 bg-yellow-900/30"
                      : "text-zinc-400 bg-zinc-800"
                  )}
                >
                  {envelope.data.wholeNumber.nearby ? "NEARBY" : "CLEAR"}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Protection row — reflects both trigger and safeguard state */}
      <div className="mt-2 pt-2 border-t border-zinc-800/60 flex items-center justify-between py-1.5">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <span className="text-zinc-500">
            <ProtectionIcon size={12} />
          </span>
          <span>Protection</span>
        </div>
        <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", protectionColor)}>
          {protectionLabel}
        </span>
      </div>

      {/* Walk-away toggle — auto-arms/disarms safeguard */}
      <div className="mt-1 pt-2 border-t border-zinc-800/60 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Coffee size={12} className="text-zinc-500" />
          <span>Walk-away mode</span>
        </div>
        <button
          onClick={toggleWalkAway}
          className={cn(
            "text-xs font-semibold px-2 py-0.5 rounded-full transition-colors",
            walkAwayColor
          )}
        >
          {walkAwayLabel}
        </button>
      </div>

      {/* Walk-away status hint */}
      {walkAway && walkAwayHint && (
        <div className={cn("mt-2 text-[11px] italic", hintColor)}>
          {walkAwayHint}
        </div>
      )}

      <ScheduleSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        windows={windows}
        scheduleEnabled={status.scheduleEnabled}
        onSave={setWindows}
        onToggleSchedule={setScheduleEnabled}
      />
    </div>
  );
}
