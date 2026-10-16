/**
 * Oracle Score Card
 *
 * Displays the Oracle Entry Score (0-100) with its five patience-centric
 * components and the current oracle state (READY / WAIT MODE / LATE SETUP /
 * NO SIGNAL). The state banner is the primary display — it answers the one
 * question that matters: should the oracle act now, wait, or stand aside?
 */

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useEdgeScore } from "@/hooks/useEdgeScore";
import type { EdgeScoreData, OracleState } from "@/hooks/useSafeguard";

// ── Grade palette ─────────────────────────────────────────────────────────────

const GRADE_CFG = {
  exceptional: { label: "EXCEPTIONAL", ring: "border-violet-500/60", text: "text-violet-400", bar: "bg-violet-500" },
  good:        { label: "GOOD",        ring: "border-emerald-500/60",text: "text-emerald-400",bar: "bg-emerald-500" },
  moderate:    { label: "MODERATE",    ring: "border-zinc-500/60",   text: "text-zinc-300",   bar: "bg-zinc-400" },
  weak:        { label: "WEAK",        ring: "border-yellow-500/60", text: "text-yellow-400", bar: "bg-yellow-500" },
  poor:        { label: "POOR",        ring: "border-red-500/60",    text: "text-red-400",    bar: "bg-red-500" },
} as const;

// ── Oracle state config ───────────────────────────────────────────────────────

const ORACLE_STATE_CFG: Record<OracleState, {
  label: string;
  icon: string;
  bg: string;
  border: string;
  text: string;
  sub: string;
}> = {
  ready: {
    label:  "READY",
    icon:   "◆",
    bg:     "bg-emerald-500/12",
    border: "border-emerald-600/40",
    text:   "text-emerald-300",
    sub:    "Structure confirmed · price at zone · oracle can act",
  },
  wait_mode: {
    label:  "WAIT MODE",
    icon:   "◇",
    bg:     "bg-amber-500/10",
    border: "border-amber-700/35",
    text:   "text-amber-300",
    sub:    "Interesting setup · waiting for price to reach the zone",
  },
  late_setup: {
    label:  "LATE SETUP",
    icon:   "▲",
    bg:     "bg-red-500/10",
    border: "border-red-700/35",
    text:   "text-red-300",
    sub:    "Move already in progress · don't chase · wait for a reset",
  },
  no_signal: {
    label:  "NO SIGNAL",
    icon:   "○",
    bg:     "bg-zinc-800/60",
    border: "border-zinc-700/50",
    text:   "text-zinc-500",
    sub:    "No HTF consensus · oracle is standing aside",
  },
};

const PLAY_LABEL: Record<string, { text: string; cls: string }> = {
  over_key:              { text: "OVER KEY",    cls: "bg-emerald-500/15 text-emerald-300" },
  under_key:             { text: "UNDER KEY",   cls: "bg-red-500/15 text-red-300" },
  over_under_transition: { text: "OVER→UNDER",  cls: "bg-red-500/15 text-red-300" },
  under_over_transition: { text: "UNDER→OVER",  cls: "bg-emerald-500/15 text-emerald-300" },
  clean_rejection:       { text: "REJECTION",   cls: "bg-amber-500/15 text-amber-300" },
  clean_retest:          { text: "RETEST HOLD", cls: "bg-blue-500/15 text-blue-300" },
};

// ── Component bar ─────────────────────────────────────────────────────────────

function ScoreBar({
  heading,
  detail,
  score,
  max,
  barColor,
}: {
  heading: string;
  detail: string;
  score: number;
  max: number;
  barColor: string;
}) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-zinc-500 uppercase tracking-wide truncate pr-1">
          {heading}{" "}
          <span className="text-zinc-700 normal-case tracking-normal">· {detail}</span>
        </span>
        <span className="font-mono text-zinc-400 shrink-0">
          {score}/{max}
        </span>
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

// ── Loaded view ───────────────────────────────────────────────────────────────

function OracleScoreBody({ data }: { data: EdgeScoreData }) {
  const cfg = GRADE_CFG[data.grade];
  const oracleCfg = ORACLE_STATE_CFG[data.oracleState ?? "no_signal"];
  const playChip = PLAY_LABEL[data.components.keyLevelBehavior.playType];

  const rows: Array<{ heading: string; detail: string; score: number; max: number }> = [
    {
      heading: "Structure",
      detail: data.components.structureAlignment.label,
      score: data.components.structureAlignment.score,
      max: data.components.structureAlignment.max,
    },
    {
      heading: "Patience",
      detail: data.components.patienceQuality.label,
      score: data.components.patienceQuality.score,
      max: data.components.patienceQuality.max,
    },
    {
      heading: "Key level",
      detail: data.components.keyLevelBehavior.label,
      score: data.components.keyLevelBehavior.score,
      max: data.components.keyLevelBehavior.max,
    },
    {
      heading: "Wallet",
      detail: data.components.walletReadiness.label,
      score: data.components.walletReadiness.score,
      max: data.components.walletReadiness.max,
    },
    {
      heading: "Timing",
      detail: data.components.timeSuitability.label,
      score: data.components.timeSuitability.score,
      max: data.components.timeSuitability.max,
    },
  ];

  return (
    <div className="space-y-3">

      {/* ── Oracle state banner — the primary display ── */}
      <div className={cn(
        "rounded-lg border px-3 py-2.5 flex items-start gap-3",
        oracleCfg.bg,
        oracleCfg.border,
      )}>
        <span className={cn("text-lg leading-none mt-0.5 shrink-0", oracleCfg.text)}>
          {oracleCfg.icon}
        </span>
        <div className="min-w-0">
          <div className={cn("text-xs font-bold uppercase tracking-widest leading-none mb-1", oracleCfg.text)}>
            {oracleCfg.label}
          </div>
          {/* Dynamic narration — WHY the oracle is in this state */}
          <div className="text-[11px] text-zinc-400 leading-snug">
            {data.oracleNarration ?? oracleCfg.sub}
          </div>
        </div>
      </div>

      {/* Score ring + grade */}
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex items-center justify-center w-14 h-14 rounded-full border-2 shrink-0",
            cfg.ring,
          )}
        >
          <div className="text-center">
            <div className={cn("text-xl font-bold font-mono leading-none", cfg.text)}>
              {data.edgeScore}
            </div>
            <div className="text-[8px] text-zinc-700 mt-0.5">/ 100</div>
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-1">
            <span className={cn("text-xs font-bold", cfg.text)}>{cfg.label}</span>
            {playChip && (
              <span
                className={cn(
                  "text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide",
                  playChip.cls,
                )}
              >
                {playChip.text}
              </span>
            )}
          </div>
          <p className="text-[11px] text-zinc-500 leading-relaxed">{data.reason}</p>
        </div>
      </div>

      {/* Per-component bars */}
      <div className="space-y-1.5">
        {rows.map((r) => (
          <ScoreBar
            key={r.heading}
            heading={r.heading}
            detail={r.detail}
            score={r.score}
            max={r.max}
            barColor={cfg.bar}
          />
        ))}
      </div>

      {/* Safeguard impact note */}
      <div
        className={cn(
          "text-[11px] px-2.5 py-1.5 rounded-lg border leading-snug",
          data.safeguardDelta > 0
            ? "bg-emerald-500/8 border-emerald-500/20 text-emerald-400"
            : data.safeguardDelta < 0
              ? "bg-red-500/8 border-red-500/20 text-red-400"
              : "bg-zinc-800/60 border-zinc-700 text-zinc-400",
        )}
      >
        <span className="font-mono font-semibold mr-1.5">
          {data.safeguardDelta > 0
            ? `+${data.safeguardDelta}`
            : data.safeguardDelta !== 0
              ? `${data.safeguardDelta}`
              : "±0"}
        </span>
        {data.safeguardNote}
      </div>

      {/* Pattern Memory */}
      <PatternMemoryRow structure={data.structure ?? null} />
    </div>
  );
}

// ── Pattern Memory Row ────────────────────────────────────────────────────────

const QUALITY_COLORS: Record<string, string> = {
  "high-conviction": "text-violet-400",
  "clean":           "text-emerald-400",
  "transitional":    "text-zinc-400",
  "late":            "text-amber-400",
  "messy":           "text-orange-400",
  "forced":          "text-red-400",
};

const OUTCOME_COLORS: Record<string, string> = {
  win:       "text-emerald-400",
  loss:      "text-red-400",
  breakeven: "text-zinc-400",
  unknown:   "text-zinc-500",
};

function confidenceColor(c: number): string {
  if (c >= 70) return "text-emerald-400";
  if (c >= 50) return "text-amber-400";
  return "text-red-400";
}

function PatternMemoryRow({ structure }: { structure: import("@/hooks/useSafeguard").StructureContext | null }) {
  if (!structure) return null;
  const {
    fingerprintConfidence: conf,
    fingerprintSampleCount: total,
    postWinHumility,
    postWinMinutesLeft,
    patternTopMatches: matches,
  } = structure;

  const topMatch = matches?.[0] ?? null;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-2.5 py-2 space-y-1.5">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wide">
          Pattern Memory
        </span>
        <div className="flex items-center gap-1.5">
          {postWinHumility && (
            <span className="text-[10px] font-bold bg-amber-500/15 border border-amber-500/30 text-amber-300 px-1.5 py-0.5 rounded">
              CAUTION {postWinMinutesLeft}m
            </span>
          )}
          {conf === null ? (
            <span className="text-[10px] text-zinc-600 font-mono">
              {total}/5 trades
            </span>
          ) : (
            <span className={cn("text-[11px] font-bold font-mono", confidenceColor(conf))}>
              {conf}
              <span className="text-zinc-600 font-normal">/100</span>
            </span>
          )}
        </div>
      </div>

      {/* State line */}
      {conf === null ? (
        <p className="text-[10px] text-zinc-600 leading-snug">
          Building pattern memory — oracle will compare future setups to this history once {5 - total} more trade{5 - total === 1 ? "" : "s"} are recorded.
        </p>
      ) : topMatch ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn("text-[10px] font-semibold capitalize", QUALITY_COLORS[topMatch.qualityLabel] ?? "text-zinc-400")}>
            {topMatch.qualityLabel}
          </span>
          {topMatch.isMentorExample && (
            <span className="text-[9px] bg-violet-500/15 border border-violet-500/30 text-violet-400 px-1 py-px rounded">mentor</span>
          )}
          <span className="text-zinc-600 text-[10px]">·</span>
          <span className={cn("text-[10px] font-semibold", OUTCOME_COLORS[topMatch.outcome] ?? "text-zinc-400")}>
            {topMatch.outcome}
          </span>
          {topMatch.roiPct != null && (
            <>
              <span className="text-zinc-600 text-[10px]">·</span>
              <span className="text-[10px] text-zinc-300 font-mono">
                {topMatch.roiPct > 0 ? "+" : ""}{topMatch.roiPct.toFixed(1)}%
              </span>
            </>
          )}
          <span className="text-zinc-600 text-[10px]">·</span>
          <span className="text-[10px] text-zinc-500">
            {topMatch.similarity}% match
          </span>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-600 leading-snug">
          No close matches in history — setup is unlike prior patterns.
        </p>
      )}

      {/* Secondary matches */}
      {conf !== null && matches && matches.length > 1 && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {matches.slice(1).map((m, i) => (
            <span key={i} className="text-[9px] text-zinc-600">
              <span className={cn("capitalize", QUALITY_COLORS[m.qualityLabel] ?? "text-zinc-500")}>
                {m.qualityLabel}
              </span>
              {" "}
              <span className={OUTCOME_COLORS[m.outcome] ?? "text-zinc-500"}>
                {m.outcome}
              </span>
              {" · "}
              {m.similarity}%
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function OracleScoreCard({ symbol }: { symbol: string }) {
  const { data, isLoading, isError } = useEdgeScore(symbol);
  const [collapsed, setCollapsed] = useState(false);

  const oracleState = data?.oracleState ?? null;
  const oracleCfg = oracleState ? ORACLE_STATE_CFG[oracleState] : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-800/40 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-200">Oracle Score</span>
          {data && !isLoading && (
            <>
              <span
                className={cn(
                  "text-[11px] font-bold font-mono px-1.5 py-0.5 rounded bg-zinc-800",
                  GRADE_CFG[data.grade].text,
                )}
              >
                {data.edgeScore}
              </span>
              {oracleCfg && (
                <span className={cn(
                  "text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded",
                  oracleCfg.bg,
                  oracleCfg.text,
                  "border",
                  oracleCfg.border,
                )}>
                  {oracleCfg.icon} {oracleCfg.label}
                </span>
              )}
            </>
          )}
          {isLoading && (
            <span className="text-[10px] text-zinc-600 animate-pulse">reading…</span>
          )}
        </div>
        <span className="text-zinc-600 text-xs">{collapsed ? "▾" : "▴"}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4 border-t border-zinc-800 pt-3">
          {isLoading && !data && (
            <div className="text-zinc-600 text-xs text-center py-4 animate-pulse">
              oracle is reading the market…
            </div>
          )}
          {isError && !data && (
            <div className="text-red-500/70 text-xs text-center py-3">
              unable to compute oracle score
            </div>
          )}
          {data && <OracleScoreBody data={data} />}
        </div>
      )}
    </div>
  );
}

// Back-compat export so any other import of EdgeScoreCard still works
export { OracleScoreCard as EdgeScoreCard };
