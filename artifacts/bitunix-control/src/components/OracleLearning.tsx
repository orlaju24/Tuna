/**
 * Oracle Learning Panel
 *
 * Surfaces what the oracle has learned from closed trades — win rates by
 * session / velocity / oracle-score bucket, fingerprint quality distribution,
 * and actionable recommendations for calibrating auto-entry settings.
 *
 * This is the "machine learning" layer: pure statistical analysis fed back
 * to the operator so they can decide whether to tighten thresholds,
 * restrict time windows, or understand which setup signatures perform best.
 */

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useLearningDigest, type LearningDigest } from "@/hooks/useJournal";

// ── Helpers ───────────────────────────────────────────────────────────────────

function winRateColor(wr: number): string {
  if (wr >= 70) return "text-emerald-400";
  if (wr >= 50) return "text-zinc-300";
  if (wr >= 35) return "text-yellow-400";
  return "text-red-400";
}

function confidenceColor(c: string): string {
  if (c === "high")   return "text-emerald-400";
  if (c === "medium") return "text-amber-400";
  return "text-zinc-500";
}

const SESSION_LABELS: Record<string, string> = {
  overlap: "London/NY Overlap",
  ny:      "New York",
  london:  "London",
  asian:   "Asian",
};

const VELOCITY_LABELS: Record<string, string> = {
  slow:   "Slow (patient)",
  normal: "Normal",
  fast:   "Fast (momentum)",
};

const ORACLE_BUCKET_LABELS: Record<string, string> = {
  exceptional: "Exceptional (80+)",
  good:        "Good (65-79)",
  moderate:    "Moderate (45-64)",
  poor:        "Poor (<45)",
};

const QUALITY_COLORS: Record<string, string> = {
  "high-conviction": "bg-violet-500/20 text-violet-300",
  "clean":           "bg-emerald-500/20 text-emerald-300",
  "transitional":    "bg-zinc-700 text-zinc-400",
  "late":            "bg-amber-500/20 text-amber-300",
  "messy":           "bg-orange-500/20 text-orange-300",
  "forced":          "bg-red-500/20 text-red-300",
};

const RECOMMENDATION_ICONS: Record<string, string> = {
  oracle_threshold:      "◈",
  time_window:           "⏱",
  velocity:              "〜",
  htf_alignment:         "↑↑",
  quality_warning:       "⚠",
  trigger_floor:         "⬆",
  trigger_floor_warning: "⚠",
  general:               "◦",
};

const WAVE_PHASE_LABELS: Record<string, string> = {
  pressure_building:    "Pressure building",
  first_wave:           "First wave",
  pullback:             "Pullback",
  resumption_forming:   "Resumption forming",
  resumption_confirmed: "Resumption confirmed",
  extended:             "Extended",
  mixed:                "Mixed / unclear",
};

// ── Sub-components ────────────────────────────────────────────────────────────

function StatTable({
  title,
  stats,
  labelMap,
  minSamples = 2,
}: {
  title: string;
  stats: LearningDigest["sessionStats"];
  labelMap: Record<string, string>;
  minSamples?: number;
}) {
  const rows = Object.entries(stats)
    .filter(([, v]) => v.total >= minSamples)
    .sort((a, b) => b[1].winRate - a[1].winRate);

  if (rows.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">{title}</div>
      {rows.map(([key, v]) => (
        <div key={key} className="flex items-center gap-2">
          {/* Win-rate bar */}
          <div className="flex-1 min-w-0">
            <div className="flex justify-between items-baseline mb-0.5">
              <span className="text-xs text-zinc-400 truncate">{labelMap[key] ?? key}</span>
              <div className="flex items-center gap-1.5 shrink-0 ml-2">
                <span className={cn("text-xs font-bold font-mono", winRateColor(v.winRate))}>
                  {v.winRate}%
                </span>
                <span className="text-[10px] text-zinc-600 font-mono">
                  {v.wins}/{v.total}
                </span>
                <span className={cn(
                  "text-[10px] font-mono",
                  v.avgRoi >= 0 ? "text-emerald-400/70" : "text-red-400/70",
                )}>
                  {v.avgRoi >= 0 ? "+" : ""}{v.avgRoi.toFixed(1)}%
                </span>
              </div>
            </div>
            <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={cn("h-full rounded-full", v.winRate >= 60 ? "bg-emerald-500" : v.winRate >= 40 ? "bg-yellow-500" : "bg-red-500")}
                style={{ width: `${v.winRate}%` }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function QualityDistribution({ dist, total }: { dist: Record<string, number>; total: number }) {
  if (total === 0) return null;
  const order = ["high-conviction", "clean", "transitional", "late", "messy", "forced"];
  const rows = order
    .filter((k) => (dist[k] ?? 0) > 0)
    .map((k) => ({ key: k, count: dist[k] ?? 0, pct: Math.round(((dist[k] ?? 0) / total) * 100) }));

  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
        Fingerprint Quality ({total} trades)
      </div>
      <div className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <span key={r.key} className={cn("text-xs px-2 py-0.5 rounded-full font-medium capitalize", QUALITY_COLORS[r.key] ?? "bg-zinc-700 text-zinc-400")}>
            {r.key} {r.pct}%
          </span>
        ))}
      </div>
      {/* Forced-trade warning */}
      {(dist["forced"] ?? 0) / total > 0.3 && (
        <p className="text-[11px] text-red-400/80 leading-snug">
          Over 30% of trades were entered below oracle threshold — the system is flagging this as a discipline pattern.
        </p>
      )}
    </div>
  );
}

function Recommendations({ recs }: { recs: LearningDigest["recommendations"] }) {
  if (recs.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">Recommendations</div>
      {recs.map((r, i) => (
        <div
          key={i}
          className={cn(
            "rounded-lg border px-3 py-2 text-xs leading-snug space-y-1",
            r.actionable
              ? "border-amber-700/30 bg-amber-500/6"
              : "border-zinc-700/50 bg-zinc-800/40",
          )}
        >
          <div className="flex items-start gap-2">
            <span className="text-zinc-500 shrink-0 font-mono text-[10px] mt-0.5">
              {RECOMMENDATION_ICONS[r.type] ?? "◦"}
            </span>
            <p className="text-zinc-300">{r.insight}</p>
          </div>
          <div className="flex items-center gap-2 pl-4">
            <span className={cn("text-[10px] font-semibold uppercase", confidenceColor(r.confidence))}>
              {r.confidence} confidence
            </span>
            {r.actionable && (
              <span className="text-[10px] bg-amber-500/15 text-amber-300 px-1.5 py-px rounded">
                actionable
              </span>
            )}
            {r.suggestedValue != null && (
              <span className="text-[10px] text-zinc-500 font-mono">
                → {r.suggestedValue}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function OracleLearning({ symbol }: { symbol?: string }) {
  const { data, isLoading } = useLearningDigest(symbol);
  const [collapsed, setCollapsed] = useState(false);

  const hasData = data && !data.insufficientData && data.sampleSize >= 3;
  const totalFp  = data ? Object.values(data.qualityDistribution).reduce((s, v) => s + v, 0) : 0;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between mb-1"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
            Oracle Learning
          </span>
          {data && !data.insufficientData && (
            <span className="text-xs bg-zinc-700 text-zinc-300 px-2 py-0.5 rounded-full font-mono">
              {data.sampleSize} trades
            </span>
          )}
          {data?.allWinRate != null && (
            <span className={cn(
              "text-[10px] font-bold px-1.5 py-0.5 rounded font-mono",
              data.allWinRate >= 60 ? "bg-emerald-500/15 text-emerald-300"
                : data.allWinRate >= 40 ? "bg-zinc-700 text-zinc-300"
                : "bg-red-500/15 text-red-300",
            )}>
              {data.allWinRate}% win
            </span>
          )}
        </div>
        <span className="text-zinc-600 text-sm">{collapsed ? "▸" : "▾"}</span>
      </button>

      {!collapsed && (
        <div className="mt-3 space-y-4">
          {isLoading && (
            <div className="text-xs text-zinc-600 text-center py-4 animate-pulse">
              analysing trade history…
            </div>
          )}

          {!isLoading && data?.insufficientData && (
            <p className="text-xs text-zinc-600 text-center py-4">
              Oracle Learning needs at least 5 completed trades to derive patterns.
              {data.sampleSize > 0 && ` (${data.sampleSize} recorded so far)`}
            </p>
          )}

          {hasData && (
            <>
              {/* Recommendations come first — most actionable */}
              <Recommendations recs={data.recommendations} />

              {/* Winning oracle range */}
              {data.winningOracleRange && (
                <div className="rounded-lg border border-emerald-700/25 bg-emerald-500/6 px-3 py-2">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">
                    Winning oracle range
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold font-mono text-emerald-400">
                      {data.winningOracleRange.min}
                    </span>
                    <span className="text-zinc-600 text-sm">to</span>
                    <span className="text-lg font-bold font-mono text-emerald-400">
                      {data.winningOracleRange.max}
                    </span>
                    <span className="text-xs text-zinc-500">/100</span>
                    {data.suggestedMinEdge != null && (
                      <span className="text-xs text-amber-400 ml-1">
                        · floor {data.suggestedMinEdge} suggested
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Session stats */}
              <StatTable
                title="Session win rate"
                stats={data.sessionStats}
                labelMap={SESSION_LABELS}
              />

              {/* Velocity stats */}
              <StatTable
                title="Entry velocity"
                stats={data.velocityStats}
                labelMap={VELOCITY_LABELS}
              />

              {/* Oracle bucket stats */}
              <StatTable
                title="Oracle score at entry"
                stats={data.oracleBucketStats}
                labelMap={ORACLE_BUCKET_LABELS}
              />

              {/* HTF alignment stats */}
              <StatTable
                title="HTF alignment"
                stats={data.htfStats}
                labelMap={{ "aligned-up": "Aligned up", "aligned-down": "Aligned down", "mixed": "Mixed", "1h-up": "1H up only", "1h-down": "1H down only" }}
              />

              {/* Trigger floor memory — only shown once at least 2 floors have closed */}
              {data.triggerFloorStats && data.triggerFloorStats.total >= 2 && (
                <div className="space-y-2">
                  <div className="text-[10px] font-semibold text-zinc-500 uppercase tracking-wider">
                    Trigger Floor Memory ({data.triggerFloorStats.total} floors)
                  </div>
                  <div className="rounded-lg border border-violet-700/30 bg-violet-500/6 px-3 py-2">
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <span className={cn("text-lg font-bold font-mono", winRateColor(data.triggerFloorStats.winRate))}>
                        {data.triggerFloorStats.winRate}%
                      </span>
                      <span className="text-xs text-zinc-500">win when floor active</span>
                      <span className={cn(
                        "text-xs font-mono ml-auto",
                        data.triggerFloorStats.avgRoi >= 0 ? "text-emerald-400" : "text-red-400",
                      )}>
                        avg {data.triggerFloorStats.avgRoi >= 0 ? "+" : ""}{data.triggerFloorStats.avgRoi.toFixed(1)}% ROI
                      </span>
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-1 leading-snug">
                      How often ladder protection after a trigger cross led to a profitable exit.
                    </p>
                  </div>
                  {Object.keys(data.byFloorWavePhase).length >= 1 && (
                    <StatTable
                      title="Wave at floor activation"
                      stats={data.byFloorWavePhase}
                      labelMap={WAVE_PHASE_LABELS}
                      minSamples={1}
                    />
                  )}
                </div>
              )}

              {/* Quality distribution from fingerprints */}
              {totalFp > 0 && (
                <QualityDistribution dist={data.qualityDistribution} total={totalFp} />
              )}

              <p className="text-[10px] text-zinc-600 leading-snug pt-1">
                Based on {data.sampleSize} completed trade{data.sampleSize !== 1 ? "s" : ""}.
                Patterns with fewer than 2 trades are excluded. The oracle uses this data
                to adjust fingerprint quality weights and narration — manual calibration
                of auto-entry thresholds is always the operator's decision.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
