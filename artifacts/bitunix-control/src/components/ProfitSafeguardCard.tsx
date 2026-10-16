/**
 * Profit Safeguard Card — three clear states per PDF spec:
 *   DORMANT  — no armed safeguard (or no open position)
 *   ARMED    — watching for the first protection threshold
 *   PROTECTED— ROI hit threshold; safeguard price is trailing the trade
 *
 * The internal safeguardPrice shown here is app-side only. Bitunix never
 * receives it until the retrace fires the actual close call.
 */
import { useState } from "react";
import { ShieldCheck, ShieldAlert, ShieldOff, Trash2, Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { useSafeguards, useCreateSafeguard, useDisarmSafeguard, useDeleteSafeguard, type SafeguardRow, type StructureContext, type SafeguardPlanSnapshot } from "@/hooks/useSafeguard";
import { normalizePositionDirection, type Position } from "@/hooks/usePositions";
import { usePrice } from "@/hooks/usePrice";
import { cn } from "@/lib/utils";

function patienceColor(level: string): string {
  switch (level) {
    case "exceptional": return "text-violet-400";
    case "strong":      return "text-emerald-400";
    case "good":        return "text-blue-400";
    case "standard":    return "text-zinc-400";
    case "tight":       return "text-red-400";
    default:            return "text-zinc-500";
  }
}

// ── Market structure chip helpers ────────────────────────────────────
function dirArrow(d: -1 | 0 | 1): string {
  return d > 0 ? "↑" : d < 0 ? "↓" : "→";
}

function StructureChips({ s }: { s: StructureContext }) {
  type Chip = { label: string; cls: string; title?: string };
  const chips: Chip[] = [];

  // HTF alignment
  if (s.htfAligned) {
    const up = s.htfDirection > 0;
    chips.push({
      label: `ALIGNED ${up ? "↑" : "↓"}`,
      cls: up ? "bg-emerald-500/15 text-emerald-300" : "bg-red-500/15 text-red-300",
      title: "1h and 6h agree on direction",
    });
  } else {
    chips.push({
      label: `MIXED ${dirArrow(s.oneHourDirection)}/${dirArrow(s.sixHourDirection)}`,
      cls: "bg-zinc-700/60 text-zinc-400",
      title: "1h and 6h disagree",
    });
  }

  // LTF lead / confirm
  if (s.fifteenMinConfirms) {
    chips.push({
      label: "15M CONFIRMS",
      cls: "bg-emerald-500/15 text-emerald-300",
      title: "Both 3m and 15m match HTF",
    });
  } else if (s.threeMinLeads) {
    chips.push({
      label: "3M LEADS",
      cls: "bg-blue-500/15 text-blue-300",
      title: "3m matches HTF; 15m hasn't confirmed yet",
    });
  }

  // 4-bar 6h streak
  if (s.fourBarRule) {
    chips.push({
      label: `4-BAR ${Math.abs(s.fourBarStreak)}${s.fourBarStreak > 0 ? "↑" : "↓"} ✓`,
      cls: "bg-violet-500/15 text-violet-300",
      title: "4+ consecutive same-direction 6h bars",
    });
  } else if (Math.abs(s.fourBarStreak) >= 2) {
    chips.push({
      label: `${Math.abs(s.fourBarStreak)}-BAR ${s.fourBarStreak > 0 ? "↑" : "↓"}`,
      cls: "bg-zinc-700/60 text-zinc-400",
    });
  }

  // Velocity
  if (s.velocityState === "fast") {
    chips.push({
      label: `FAST ${s.threeMinBodyPct.toFixed(2)}%`,
      cls: "bg-amber-500/15 text-amber-300",
      title: "3m body > 0.15% — strong momentum",
    });
  } else if (s.velocityState === "slow") {
    chips.push({
      label: "SLOW",
      cls: "bg-zinc-700/60 text-zinc-500",
      title: "3m body < 0.05% — weak momentum",
    });
  }

  // Pivot state
  if (s.pivotState !== "clear") {
    const pivotCls: Record<string, string> = {
      approach: "bg-blue-500/15 text-blue-300",
      stall:    "bg-red-500/15 text-red-300",
      bounce:   "bg-red-500/15 text-red-300",
      break:    "bg-emerald-500/15 text-emerald-300",
    };
    chips.push({
      label: `${s.pivotState.toUpperCase()} @ ${s.nearestPivot.toLocaleString()}`,
      cls: pivotCls[s.pivotState] ?? "bg-zinc-700/60 text-zinc-400",
      title: `Within ${s.pivotProximityPct.toFixed(2)}% of whole-number pivot`,
    });
  }

  // Counter-move / resumption (one-shot)
  if (s.resumption) {
    chips.push({
      label: "RESUMPTION ✓",
      cls: "bg-emerald-500/15 text-emerald-300",
      title: "Counter-move just resolved back into HTF",
    });
  } else if (s.counterMove) {
    chips.push({
      label: "COUNTER-MOVE",
      cls: "bg-yellow-500/15 text-yellow-300",
      title: "3m flipped against the aligned HTF",
    });
  }

  if (chips.length === 0) {
    chips.push({ label: "NEUTRAL", cls: "bg-zinc-700/60 text-zinc-500" });
  }

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c, i) => (
        <span
          key={i}
          title={c.title}
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide",
            c.cls
          )}
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}

const STATE_COLORS: Record<string, string> = {
  armed:      "text-blue-400",
  protecting: "text-emerald-400",
  triggered:  "text-yellow-400",
  completed:  "text-emerald-500",
  failed:     "text-red-400",
  cancelled:  "text-zinc-600",
};

// Arm-at ROI % choices — 17 through 50 in meaningful steps
const T1_PRESETS = [17, 18, 19, 20, 22, 25, 30, 35, 40, 50];

// Five trailing modes — each maps to a distinct internal trail-width strategy
const TRAILING_MODES = [
  {
    value: "tight",
    label: "Tight",
    desc: "Locks gains fast · 2 pp constant",
    cls: "text-red-300",
  },
  {
    value: "standard",
    label: "Standard",
    desc: "Balanced trail · 3 pp + profit quality",
    cls: "text-zinc-300",
  },
  {
    value: "wide",
    label: "Wide",
    desc: "Breathes on clean trends · 5 pp + plan",
    cls: "text-blue-300",
  },
  {
    value: "structure",
    label: "Structure",
    desc: "Market-rhythm driven · no oracle delta",
    cls: "text-violet-300",
  },
  {
    value: "adaptive",
    label: "Adaptive",
    desc: "Oracle-guided · full 4-layer engine",
    cls: "text-emerald-300",
  },
] as const;

// ── Plan badge ─────────────────────────────────────────────────────────
const PLAN_PATIENCE_CLS: Record<string, string> = {
  "very-patient": "text-violet-400",
  "patient":      "text-emerald-400",
  "standard":     "text-zinc-400",
  "tight":        "text-red-400",
};
const PLAN_ZONE_CLS: Record<string, string> = {
  lower: "bg-emerald-500/15 text-emerald-300",
  middle:"bg-zinc-700/60 text-zinc-300",
  upper: "bg-red-500/15 text-red-300",
};

function PlanBadge({ plan, delta }: { plan: SafeguardPlanSnapshot; delta: number }) {
  const [open, setOpen] = useState(false);
  const score = plan.agreementScore ?? 0;
  const scoreCls =
    score >= 50 ? "text-emerald-400"
    : score >= 15 ? "text-blue-400"
    : score >= -15 ? "text-zinc-400"
    : score >= -50 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/40">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 text-[10px] text-zinc-600 hover:text-zinc-400 uppercase tracking-wider"
      >
        <span className="flex items-center gap-1.5 flex-wrap">
          Plan
          {plan.channelZone && (
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded font-semibold normal-case tracking-normal",
              PLAN_ZONE_CLS[plan.channelZone] ?? "bg-zinc-700/60 text-zinc-400",
            )}>
              {plan.channelZone}
            </span>
          )}
          <span className={cn("font-mono normal-case tracking-normal font-semibold", scoreCls)}>
            {score >= 0 ? "+" : ""}{score}
          </span>
          {plan.recommendedPatience && (
            <span className={cn(
              "font-mono normal-case tracking-normal font-semibold",
              PLAN_PATIENCE_CLS[plan.recommendedPatience] ?? "text-zinc-400",
            )}>
              · {plan.recommendedPatience}
            </span>
          )}
          {delta !== 0 && (
            <span className={cn(
              "font-mono normal-case tracking-normal",
              delta > 0 ? "text-emerald-400" : "text-yellow-400",
            )}>
              · trail {delta > 0 ? "+" : ""}{delta.toFixed(2)} pp
            </span>
          )}
        </span>
        <span>{open ? "▴" : "▾"}</span>
      </button>
      {open && plan.summary && (
        <div className="mt-1.5 bg-zinc-800/40 border border-zinc-800 rounded px-2 py-1.5">
          <p className="text-[11px] text-zinc-300 leading-relaxed">{plan.summary}</p>
          {plan.continuationProbPct != null && (
            <p className="text-[10px] text-zinc-500 font-mono mt-1">
              continuation {plan.continuationProbPct}% · plan #{plan.id}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Oracle sub-level target helpers ──────────────────────────────────────────

function wholeNumberStep(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 10000) return 1000;
  if (abs >= 1000)  return 100;
  if (abs >= 100)   return 10;
  if (abs >= 10)    return 1;
  if (abs >= 1)     return 0.1;
  return 0.01;
}

/**
 * Oracle Method targets after a whole-number break.
 *   SHORT from ~$109,050: .888 = $108,888  deeper = $108,000
 *   LONG  from ~$107,950: .888 = $108,888  deeper = $109,000
 */
function oracleTargets(side: string, entryPrice: number) {
  const step = wholeNumberStep(entryPrice);
  const brk  = Math.round(entryPrice / step) * step;
  return side === "SHORT"
    ? { target888: brk - step + step * 0.888, deeper: brk - step, brk }
    : { target888: brk + step * 0.888,         deeper: brk + step,  brk };
}

/**
 * Live target-progress panel shown inside each active safeguard row.
 * Computes everything from entryPrice + side + live price — no extra API call.
 */
function OracleTargetsPanel({ sg }: { sg: SafeguardRow }) {
  const livePrice = usePrice(sg.symbol);
  const entry = parseFloat(sg.entryPrice);
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const isShort = sg.side === "SHORT";
  const { target888, deeper, brk } = oracleTargets(sg.side, entry);

  const t888Captured   = livePrice != null && (isShort ? livePrice <= target888 : livePrice >= target888);
  const deeperCaptured = livePrice != null && (isShort ? livePrice <= deeper    : livePrice >= deeper);

  // Progress 0→1 from entry toward .888 (caps at 1 once captured)
  const totalRange = isShort ? entry - target888 : target888 - entry;
  const travelled  = livePrice != null
    ? (isShort ? entry - livePrice : livePrice - entry)
    : 0;
  const progress = totalRange > 0
    ? Math.min(1, Math.max(0, travelled / totalRange))
    : 0;

  // Distance remaining to .888 in raw price units
  const distTo888 = livePrice != null
    ? (isShort ? livePrice - target888 : target888 - livePrice)
    : null;

  return (
    <div className="mt-2 pt-2 border-t border-zinc-800/40">
      <div className="text-[10px] text-zinc-600 uppercase tracking-wider mb-1.5">
        Oracle Targets
      </div>

      {/* Entry → break level */}
      <div className="flex items-center justify-between text-[10px] text-zinc-600 mb-0.5">
        <span>Entry</span>
        <span className="font-mono">{fmtPrice(entry)}</span>
      </div>

      {/* .888 sub-target */}
      <div className="flex items-center justify-between text-[11px] mb-0.5">
        <span className={t888Captured ? "text-emerald-400 font-semibold" : "text-amber-300/80"}>
          .888 zone{t888Captured ? " ✓" : ""}
        </span>
        <span className={cn("font-mono", t888Captured ? "text-emerald-300" : "text-amber-300")}>
          {fmtPrice(target888)}
          {!t888Captured && distTo888 != null && distTo888 > 0 && (
            <span className="text-zinc-600 font-normal ml-1 text-[10px]">
              ({isShort ? "−" : "+"}{distTo888.toFixed(0)} away)
            </span>
          )}
        </span>
      </div>

      {/* Progress bar — only shown before .888 is captured */}
      {!t888Captured && (
        <div className="mb-1">
          <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-400/50 transition-all duration-700 rounded-full"
              style={{ width: `${(progress * 100).toFixed(1)}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-zinc-700 mt-0.5">
            <span>entry {fmtPrice(entry)}</span>
            <span>.888 {fmtPrice(target888)}</span>
          </div>
        </div>
      )}

      {/* Deeper whole-number target */}
      <div className="flex items-center justify-between text-[11px]">
        <span className={deeperCaptured ? "text-emerald-400 font-semibold" : "text-zinc-500"}>
          {isShort ? "↓" : "↑"} {deeper.toLocaleString()} whole{deeperCaptured ? " ✓" : ""}
        </span>
        <span className={cn("font-mono", deeperCaptured ? "text-emerald-300" : "text-zinc-500")}>
          {fmtPrice(deeper)}
        </span>
      </div>

      {/* "Catch the extra" notice */}
      {t888Captured && !deeperCaptured && (
        <div className="mt-1 text-[10px] text-emerald-500/70 italic">
          .888 caught — trail tightened to protect the extra. Watching {isShort ? "↓" : "↑"} {deeper.toLocaleString()}.
        </div>
      )}
      {deeperCaptured && (
        <div className="mt-1 text-[10px] text-violet-400/70 italic">
          Full range captured: {brk.toLocaleString()} → .888 → {deeper.toLocaleString()}. Trail locked tight.
        </div>
      )}
    </div>
  );
}

function fmtRoi(pct: number | null | undefined): string {
  if (pct == null) return "—";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function fmtPrice(p: string | number | null | undefined): string {
  if (p == null) return "—";
  const n = typeof p === "string" ? parseFloat(p) : p;
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

export function ProfitSafeguardCard({
  symbol,
  position,
  openPositions = position ? [position] : [],
}: {
  symbol: string;
  position: Position | null;
  openPositions?: Position[];
}) {
  const { data: safeguards = [], isLoading } = useSafeguards(symbol);
  const create = useCreateSafeguard();
  const disarm = useDisarmSafeguard();
  const del = useDeleteSafeguard();

  const [formOpen, setFormOpen] = useState(false);
  const [t1, setT1] = useState("17");
  const [trailingMode, setTrailingMode] = useState("adaptive");

  const direction = normalizePositionDirection(position?.side);
  const matchingSafeguards = safeguards.filter((s) => {
    if (!position) return true;
    if (s.positionId) return s.positionId === String(position.positionId);
    const entry = Number(position.avgOpenPrice ?? position.entryPrice);
    const candidateDirection = normalizePositionDirection(position.side);
    if (
      !candidateDirection ||
      s.symbol !== position.symbol ||
      s.side !== candidateDirection ||
      !Number.isFinite(entry) ||
      Math.abs(Number(s.entryPrice) - entry) > Math.max(1e-8, Math.abs(entry) * 1e-8)
    ) {
      return false;
    }
    const samePositionCandidates = openPositions.filter((candidate) => {
      const candidateEntry = Number(candidate.avgOpenPrice ?? candidate.entryPrice);
      return (
        candidate.symbol === position.symbol &&
        normalizePositionDirection(candidate.side) === candidateDirection &&
        Number.isFinite(candidateEntry) &&
        Math.abs(candidateEntry - entry) <= Math.max(1e-8, Math.abs(entry) * 1e-8)
      );
    });
    return samePositionCandidates.length === 1;
  });
  const active = matchingSafeguards.filter((s) =>
    ["armed", "protecting", "triggered", "closing"].includes(s.state)
  );
  const history = matchingSafeguards.filter((s) =>
    ["triggered", "completed", "failed", "cancelled"].includes(s.state)
  );

  const entryPrice = Number(position?.avgOpenPrice ?? position?.entryPrice);
  const quantity = Number(position?.qty);
  const leverage = Number(position?.leverage);
  const canArm = !!(
    position?.positionId &&
    direction &&
    Number.isFinite(entryPrice) &&
    entryPrice > 0 &&
    Number.isFinite(quantity) &&
    quantity > 0 &&
    Number.isFinite(leverage) &&
    leverage > 0
  );
  const hasActive = active.length > 0;

  const handleArm = () => {
    if (!position || !canArm || !direction) return;
    create.mutate(
      {
        symbol,
        side: direction,
        entryPrice: position.avgOpenPrice ?? position.entryPrice ?? "0",
        qty: position.qty,
        leverage: Math.round(leverage),
        positionId: String(position.positionId),
        threshold1Pct: parseFloat(t1) || 17,
        threshold2Pct: (parseFloat(t1) || 17) + 6,
        trailStepPct: 3,
        closeMethod: "flash_close",
        trailingMode,
      },
      { onSuccess: () => setFormOpen(false) }
    );
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-zinc-400" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
            Protect Profit{position ? ` · ${symbol} ${direction ?? position.side}` : ""}
          </span>
        </div>
        {!hasActive && (
          <button
            disabled={!canArm}
            onClick={() => setFormOpen((v) => !v)}
            className={cn(
              "text-xs",
              canArm ? "text-blue-400 hover:text-blue-300" : "text-zinc-600 cursor-not-allowed"
            )}
            title={!canArm ? "A valid open position with an exchange position id is required" : undefined}
          >
            {formOpen ? "Cancel" : "+ Arm"}
          </button>
        )}
      </div>

      {/* DORMANT state */}
      {!hasActive && !formOpen && (
        <div className={cn(
          "rounded-lg px-3 py-2.5 flex items-center gap-2 text-xs",
          canArm ? "bg-zinc-800/60 text-zinc-500" : "bg-zinc-800/40 text-zinc-600"
        )}>
          <ShieldOff size={12} />
          <span>
            {canArm
              ? "No safeguard armed for this position. Tap \"+ Arm\" to set up stepped protection."
              : position
                ? "DORMANT — valid position details and a Bitunix position ID are required."
                : "DORMANT — no open position to protect."}
          </span>
        </div>
      )}

      {/* Create form — preset toggles */}
      {formOpen && !hasActive && (
        <div className="bg-zinc-800 rounded-lg p-3 space-y-3 mb-3">
          {/* Position context */}
          <div className="text-xs text-zinc-400 font-semibold">
            {symbol} {direction ?? position?.side}
            {" @ "}{fmtPrice(position?.avgOpenPrice ?? position?.entryPrice)}
          </div>

          {/* Arm-at ROI presets — 17% through 50% */}
          <div>
            <div className="text-[10px] text-zinc-500 mb-1.5">Arm at ROI</div>
            <div className="flex flex-wrap gap-1">
              {T1_PRESETS.map((v) => (
                <button
                  key={v}
                  onClick={() => setT1(String(v))}
                  className={cn(
                    "py-1.5 px-2 rounded text-xs font-semibold transition-colors min-w-[2.6rem]",
                    t1 === String(v)
                      ? "bg-blue-600 text-white"
                      : "bg-zinc-700 text-zinc-400 hover:bg-zinc-600"
                  )}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>

          {/* Trailing mode selector */}
          <div>
            <div className="text-[10px] text-zinc-500 mb-1.5">Trail mode</div>
            <div className="space-y-1">
              {TRAILING_MODES.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setTrailingMode(m.value)}
                  className={cn(
                    "w-full flex items-center justify-between px-2.5 py-1.5 rounded text-xs transition-colors",
                    trailingMode === m.value
                      ? "bg-zinc-700 border border-zinc-500"
                      : "bg-zinc-800 border border-transparent hover:border-zinc-700"
                  )}
                >
                  <span className={cn("font-semibold", m.cls)}>{m.label}</span>
                  <span className="text-zinc-500 text-[10px]">{m.desc}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded bg-zinc-900/70 px-2.5 py-2 text-[10px] text-zinc-400">
            Closes this position only; other positions in {symbol} stay open.
          </div>

          {/* Summary line */}
          <div className="text-[10px] text-zinc-500 font-mono text-center">
            arms at {t1}% ROI ·{" "}
            <span className={TRAILING_MODES.find((m) => m.value === trailingMode)?.cls}>
              {trailingMode}
            </span>{" "}
            trail
          </div>

          <div className="text-[10px] text-zinc-600 italic">
            Bitunix only sees the close at execution — intent stays private.
          </div>

          <button
            disabled={create.isPending}
            onClick={handleArm}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center justify-center gap-2"
          >
            {create.isPending && <Loader2 size={12} className="animate-spin" />}
            Arm Safeguard
          </button>
          {create.isError && (
            <p className="text-[10px] text-red-300">
              {(create.error as Error).message || "Could not arm safeguard"}
            </p>
          )}
        </div>
      )}

      {/* ACTIVE safeguards */}
      {isLoading && <div className="text-xs text-zinc-600">Loading…</div>}

      <div className="space-y-2">
        {active.map((sg) => {
          const liveRoi = sg.liveRoiPct;
          const isProtecting = sg.state === "protecting";
          const isExiting = ["triggered", "closing"].includes(sg.state);
          const t1Val = parseFloat(sg.threshold1Pct);

          return (
            <div
              key={sg.id}
              className={cn(
                "rounded-lg border px-3 py-2.5",
                isProtecting
                  ? "bg-emerald-900/20 border-emerald-700/40"
                  : "bg-blue-900/10 border-blue-800/30"
              )}
            >
              {/* State badge + controls */}
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-1.5">
                  {isProtecting ? (
                    <ShieldCheck size={13} className="text-emerald-400" />
                  ) : (
                    <ShieldAlert size={13} className="text-blue-400" />
                  )}
                  <span className={cn("text-xs font-bold uppercase", STATE_COLORS[sg.state] || "text-zinc-400")}>
                    {isExiting ? "EXITING" : isProtecting ? "PROTECTED" : "ARMED"}
                  </span>
                  {sg.trailingMode && sg.trailingMode !== "adaptive" && (
                    <span className={cn(
                      "text-[9px] font-semibold uppercase tracking-wide px-1 py-0.5 rounded",
                      "bg-zinc-700",
                      TRAILING_MODES.find((m) => m.value === sg.trailingMode)?.cls ?? "text-zinc-400"
                    )}>
                      {sg.trailingMode}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                    {!isExiting && (
                      <button
                        disabled={disarm.isPending}
                        onClick={() => disarm.mutate(sg.id)}
                        className="text-zinc-500 hover:text-yellow-400 text-[10px]"
                        title="Disarm"
                      >
                        disarm
                      </button>
                    )}
                  <button
                    disabled={del.isPending}
                    onClick={() => del.mutate(sg.id)}
                    className="text-zinc-600 hover:text-red-400"
                    title="Delete"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>

              {/* Live ROI */}
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-zinc-500">Live ROI</span>
                <span className={cn(
                  "font-mono font-semibold",
                  liveRoi == null ? "text-zinc-500"
                    : liveRoi >= t1Val ? "text-emerald-400"
                    : liveRoi > 0 ? "text-blue-400"
                    : "text-red-400"
                )}>
                  {fmtRoi(liveRoi)}
                  {liveRoi != null && liveRoi < t1Val && (
                    <span className="text-zinc-600 font-normal"> · watching for {t1Val}%</span>
                  )}
                </span>
              </div>

              {/* Safeguard close price (protecting only) */}
              {isProtecting && sg.safeguardPrice && (
                <div className="flex items-center justify-between text-[11px] mb-1">
                  <span className="text-zinc-500">Safeguard close</span>
                  <span className="font-mono text-emerald-300">
                    {fmtPrice(sg.safeguardPrice)} USDT
                  </span>
                </div>
              )}

              {/* High-water ROI */}
              {isProtecting && sg.highWaterRoiPct && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">High-water ROI</span>
                  <span className="font-mono text-zinc-400">
                    {fmtRoi(parseFloat(sg.highWaterRoiPct))}
                  </span>
                </div>
              )}

              {/* Ladder progress */}
              {isProtecting && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-zinc-500">Ladder</span>
                  <span className="font-mono text-zinc-400">
                    {sg.ratchetCount === 0
                      ? `step 0 · next lock-in @ ${sg.nextMilestoneRoiPct != null ? `+${sg.nextMilestoneRoiPct.toFixed(0)}%` : "—"}`
                      : `step ${sg.ratchetCount}/4 · next @ ${sg.nextMilestoneRoiPct != null ? `+${sg.nextMilestoneRoiPct.toFixed(0)}%` : "✓ max"}`}
                  </span>
                </div>
              )}

              {/* Oracle sub-level targets — progress from entry toward .888 and next whole */}
              <OracleTargetsPanel sg={sg} />

              {/* Patience level — adaptive trail based on signal alignment */}
              {isProtecting && sg.patienceLevel && (
                <div className="flex items-center justify-between text-[11px] mt-0.5">
                  <span className="text-zinc-500">Patience</span>
                  <span className={cn("font-mono font-semibold uppercase tracking-wider text-[10px]", patienceColor(sg.patienceLevel))}>
                    {sg.patienceLevel}
                    {sg.signalScore != null && (
                      <span className="ml-1 font-normal normal-case tracking-normal text-zinc-600">
                        ({sg.signalScore > 0 ? "+" : ""}{sg.signalScore})
                      </span>
                    )}
                    {sg.structure && sg.structure.patienceBoost !== 0 && (
                      <span className={cn(
                        "ml-1 font-normal normal-case tracking-normal",
                        sg.structure.patienceBoost > 0 ? "text-emerald-400" : "text-yellow-400"
                      )}>
                        {sg.structure.patienceBoost > 0 ? "+" : ""}{sg.structure.patienceBoost} boost · trail {sg.structure.trailWidth.toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>
              )}

              {/* Market structure chip row — only when protecting and structure is loaded */}
              {isProtecting && sg.structure && (
                <div className="mt-2 pt-2 border-t border-zinc-800/40">
                  <div className="text-[10px] text-zinc-600 mb-1.5 uppercase tracking-wider">
                    Market Structure
                  </div>
                  <StructureChips s={sg.structure} />
                </div>
              )}

              {/* Pre-trade plan badge — present whenever a plan was claimed at arm */}
              {sg.plan && <PlanBadge plan={sg.plan} delta={sg.planTrailDelta ?? 0} />}

              <div className="mt-2 pt-2 border-t border-zinc-800/40 text-[10px] text-zinc-500">
                Close scope: this position only
              </div>

              {/* Compact config */}
              <div className="mt-1.5 text-[10px] text-zinc-600 font-mono">
                {sg.side} · arm@{sg.threshold1Pct}% · trail {sg.trailStepPct}%
              </div>
            </div>
          );
        })}
      </div>

      {/* Compact history */}
      {history.length > 0 && (
        <HistorySection history={history} onDelete={(id) => del.mutate(id)} />
      )}
    </div>
  );
}

function HistorySection({
  history,
  onDelete,
}: {
  history: SafeguardRow[];
  onDelete: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border-t border-zinc-800 pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400"
      >
        {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        History ({history.length})
      </button>
      {open && (
        <div className="mt-2 space-y-1.5">
          {history.map((sg) => (
            <div key={sg.id} className="flex items-center justify-between text-[10px] text-zinc-600 bg-zinc-800/40 rounded px-2 py-1">
              <span className={cn("font-semibold uppercase", STATE_COLORS[sg.state])}>
                {sg.state}
              </span>
              <span className="font-mono">
                {sg.side} · hw {sg.highWaterRoiPct ? `${parseFloat(sg.highWaterRoiPct).toFixed(1)}%` : "—"}
              </span>
              {sg.triggeredAt && (
                <span>{new Date(sg.triggeredAt).toLocaleTimeString()}</span>
              )}
              <button
                onClick={() => onDelete(sg.id)}
                className="text-zinc-700 hover:text-red-400 ml-1"
              >
                <Trash2 size={10} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
