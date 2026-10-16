import { useState } from "react";
import { ShieldAlert, ChevronDown, ChevronUp, RefreshCw, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { useGovernor, useGovernorReset, type GovernorGrade, type GovernorComponent } from "@/hooks/useGovernor";
import { cn } from "@/lib/utils";

// ── Grade styling ─────────────────────────────────────────────────────────────
function gradeConfig(grade: GovernorGrade) {
  switch (grade) {
    case "clean":   return { color: "text-emerald-400", bg: "bg-emerald-400/10 border-emerald-400/20", badge: "bg-emerald-400/15 text-emerald-400", label: "CLEAN",   Icon: CheckCircle2 };
    case "monitor": return { color: "text-blue-400",    bg: "bg-blue-400/10 border-blue-400/20",       badge: "bg-blue-400/15 text-blue-400",    label: "MONITOR", Icon: Info };
    case "caution": return { color: "text-amber-400",   bg: "bg-amber-400/10 border-amber-400/20",     badge: "bg-amber-400/15 text-amber-400",   label: "CAUTION", Icon: AlertTriangle };
    case "warning": return { color: "text-orange-400",  bg: "bg-orange-400/10 border-orange-400/20",   badge: "bg-orange-400/15 text-orange-400", label: "WARNING", Icon: AlertTriangle };
    case "freeze":  return { color: "text-red-400",     bg: "bg-red-400/10 border-red-400/20",         badge: "bg-red-400/15 text-red-400",       label: "FREEZE",  Icon: XCircle };
  }
}

// ── Score arc gauge ───────────────────────────────────────────────────────────
function ScoreGauge({ score, grade }: { score: number; grade: GovernorGrade }) {
  const { color } = gradeConfig(grade);
  const r = 28;
  const circ = 2 * Math.PI * r;
  // Arc covers 220° of the circle (from 160° to -60° going CW)
  const arcFraction = 220 / 360;
  const arcLen = circ * arcFraction;
  const filled  = arcLen * (score / 100);
  const dashOffset = arcLen - filled;
  const strokeColor =
    grade === "clean"   ? "#34d399" :
    grade === "monitor" ? "#60a5fa" :
    grade === "caution" ? "#fbbf24" :
    grade === "warning" ? "#fb923c" :
    "#f87171";

  return (
    <div className="relative flex items-center justify-center" style={{ width: 80, height: 80 }}>
      <svg width="80" height="80" viewBox="0 0 80 80" style={{ transform: "rotate(124deg)" }}>
        {/* track */}
        <circle
          cx="40" cy="40" r={r}
          fill="none"
          stroke="#27272a"
          strokeWidth="6"
          strokeDasharray={`${arcLen} ${circ}`}
          strokeLinecap="round"
        />
        {/* fill */}
        <circle
          cx="40" cy="40" r={r}
          fill="none"
          stroke={strokeColor}
          strokeWidth="6"
          strokeDasharray={`${filled} ${circ - filled}`}
          strokeDashoffset={0}
          strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.4s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={cn("text-xl font-bold leading-none", color)}>{score}</span>
        <span className="text-[9px] text-zinc-500 mt-0.5">/ 100</span>
      </div>
    </div>
  );
}

// ── Single component row ───────────────────────────────────────────────────────
function ComponentRow({ comp }: { comp: GovernorComponent }) {
  const pct = comp.max > 0 ? (comp.score / comp.max) * 100 : 0;
  const barColor =
    pct >= 80 ? "bg-emerald-500" :
    pct >= 50 ? "bg-amber-500"   :
    "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-baseline">
        <span className="text-[11px] text-zinc-400">{comp.label}</span>
        <span className="text-[10px] font-mono text-zinc-500">{comp.score}/{comp.max}</span>
      </div>
      <div className="h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────
export function BehaviorGovernor() {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading } = useGovernor();
  const reset = useGovernorReset();

  if (isLoading || !data) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <ShieldAlert size={14} className="text-zinc-500" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Behavior Score</span>
        </div>
        <div className="text-xs text-zinc-600 text-center py-4">Computing…</div>
      </div>
    );
  }

  const { color, bg, badge, label, Icon } = gradeConfig(data.grade);
  const hasAdjustment = data.adjustments.oracleFloorDelta > 0 || data.adjustments.autoBlocked;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between mb-3"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2">
          <ShieldAlert size={14} className={color} />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Behavior Score</span>
          <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-bold", badge)}>
            {label}
          </span>
          {data.tradesAnalyzed > 0 && (
            <span className="text-[10px] text-zinc-600">{data.tradesAnalyzed} trades</span>
          )}
        </div>
        {expanded ? <ChevronUp size={14} className="text-zinc-600" /> : <ChevronDown size={14} className="text-zinc-600" />}
      </button>

      {/* Grade banner */}
      <div className={cn("border rounded-lg p-3 mb-3", bg)}>
        <div className="flex items-start gap-3">
          {/* Score gauge */}
          <ScoreGauge score={data.score} grade={data.grade} />

          {/* Right side */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Icon size={13} className={color} />
              <span className={cn("text-sm font-bold", color)}>{label}</span>
            </div>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              {data.adjustments.label}
            </p>
            {hasAdjustment && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {data.adjustments.oracleFloorDelta > 0 && (
                  <span className="text-[10px] bg-amber-400/10 text-amber-400 border border-amber-400/20 px-2 py-0.5 rounded-full">
                    Oracle floor +{data.adjustments.oracleFloorDelta} pts
                  </span>
                )}
                {data.adjustments.autoBlocked && (
                  <span className="text-[10px] bg-red-400/10 text-red-400 border border-red-400/20 px-2 py-0.5 rounded-full">
                    Auto-entry blocked
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Penalties — always visible when present */}
      {data.penalties.length > 0 && (
        <div className="space-y-2 mb-3">
          {data.penalties.map((p, i) => (
            <div key={i} className="flex gap-2 items-start bg-zinc-800/50 rounded-lg px-3 py-2">
              <AlertTriangle size={11} className="text-amber-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-[11px] font-medium text-amber-300">{p.label} <span className="text-zinc-500 font-normal">−{p.points} pts</span></div>
                <div className="text-[10px] text-zinc-500 leading-relaxed">{p.detail}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Expanded detail: component breakdown */}
      {expanded && (
        <div className="space-y-3 mb-3">
          <div className="h-px bg-zinc-800" />
          <p className="text-[10px] text-zinc-600 uppercase tracking-wide font-medium">Score breakdown</p>
          <ComponentRow comp={data.components.sessionDiscipline} />
          <ComponentRow comp={data.components.entryQuality} />
          <ComponentRow comp={data.components.postWinDiscipline} />
          <ComponentRow comp={data.components.lossRecovery} />
          <ComponentRow comp={data.components.nearMissRate} />
          <div className="text-[10px] text-zinc-600 text-right">
            Updated {new Date(data.computedAt).toLocaleTimeString()}
          </div>
        </div>
      )}

      {/* Reset button (only useful when penalised) */}
      {(data.grade !== "clean" || expanded) && (
        <button
          className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs transition-colors disabled:opacity-50"
          onClick={() => reset.mutate()}
          disabled={reset.isPending}
        >
          <RefreshCw size={12} className={reset.isPending ? "animate-spin" : ""} />
          {reset.isPending ? "Refreshing…" : "Refresh score"}
        </button>
      )}
    </div>
  );
}
