/**
 * Resumption Card
 *
 * Displays the current wave phase and entry timing guidance derived from the
 * HA 3m candle sequence. The core insight: catch the resumption BEFORE the
 * large candle becomes obvious to everyone else.
 *
 * Wave cycle: pressure_building → first_wave → pullback → resumption_forming
 *             → resumption_confirmed → extended → [reset]
 *
 * Context-aware 'extended' behaviour:
 *   FLAT     → "DO NOT ENTER" — chasing an exhausted wave
 *   IN TRADE → Extension health panel — extension is the PROFIT WAVE; hold
 *              until the extension DIES, then tighten protection.
 *
 * HA direction signals shown:
 *   waveAlignedWithHa6h  — 6h HA confirms the wave direction (pill in banner)
 *   pullbackControlled   — 3m counter but 1h HA still holds (note in pullback)
 *   waveExhaustionFlag   — extended + 1h exhaustion (double warning)
 */

import { cn } from "@/lib/utils";
import { useEdgeScore } from "@/hooks/useEdgeScore";
import { useSafeguards } from "@/hooks/useSafeguard";

type WavePhase =
  | "pressure_building"
  | "first_wave"
  | "pullback"
  | "resumption_forming"
  | "resumption_confirmed"
  | "extended"
  | "mixed";

type ExtensionPhase = "alive" | "peaking" | "dying" | "dead";

// ── Phase config ──────────────────────────────────────────────────────────────

const PHASE_CFG: Record<WavePhase, {
  label:    string;
  icon:     string;
  color:    string;
  bg:       string;
  border:   string;
  badge:    string;
  guidance: string;
  entryQuality: "ideal" | "good" | "wait" | "avoid" | "neutral";
}> = {
  pressure_building: {
    label:    "PRESSURE BUILDING",
    icon:     "◈",
    color:    "text-amber-300",
    bg:       "bg-amber-500/8",
    border:   "border-amber-700/30",
    badge:    "bg-amber-500/20 text-amber-300",
    guidance: "First 1–3 HA bars forming in HTF direction. Watch for body growth and wick compression — the setup is announcing itself.",
    entryQuality: "wait",
  },
  first_wave: {
    label:    "FIRST WAVE",
    icon:     "▶",
    color:    "text-amber-300",
    bg:       "bg-amber-500/8",
    border:   "border-amber-700/30",
    badge:    "bg-amber-500/20 text-amber-300",
    guidance: "Initial directional push underway. The oracle waits for a controlled pullback — the best entry is in the resumption, not here.",
    entryQuality: "wait",
  },
  pullback: {
    label:    "PULLBACK",
    icon:     "◀",
    color:    "text-blue-300",
    bg:       "bg-blue-500/8",
    border:   "border-blue-700/30",
    badge:    "bg-blue-500/20 text-blue-300",
    guidance: "Counter-move absorbing the prior wave. If it stays controlled and structure holds, the resumption is the setup. Stay patient.",
    entryQuality: "wait",
  },
  resumption_forming: {
    label:    "RESUMPTION FORMING",
    icon:     "◆",
    color:    "text-emerald-300",
    bg:       "bg-emerald-500/10",
    border:   "border-emerald-600/40",
    badge:    "bg-emerald-500/20 text-emerald-300",
    guidance: "First 1–2 HA bars back in HTF direction after the pullback. This is the window — catch it before the move becomes obvious.",
    entryQuality: "ideal",
  },
  resumption_confirmed: {
    label:    "RESUMPTION CONFIRMED",
    icon:     "◆◆",
    color:    "text-emerald-300",
    bg:       "bg-emerald-500/10",
    border:   "border-emerald-600/40",
    badge:    "bg-emerald-500/20 text-emerald-300",
    guidance: "3–4 HA bars have resumed HTF direction. Still the oracle's preferred entry zone — the setup is proven but not yet extended.",
    entryQuality: "good",
  },
  extended: {
    label:    "WAVE EXTENDED",
    icon:     "⚑",
    color:    "text-red-300",
    bg:       "bg-red-500/8",
    border:   "border-red-700/30",
    badge:    "bg-red-500/20 text-red-300",
    guidance: "5+ HA bars without a reset. The obvious candle has expanded — entering here means chasing. Oracle waits for a pullback and fresh resumption.",
    entryQuality: "avoid",
  },
  mixed: {
    label:    "NO CLEAR WAVE",
    icon:     "◯",
    color:    "text-zinc-500",
    bg:       "bg-zinc-800/40",
    border:   "border-zinc-700/40",
    badge:    "bg-zinc-700/40 text-zinc-500",
    guidance: "HTF has no consensus direction. Oracle cannot classify the wave cycle without a clear trend.",
    entryQuality: "neutral",
  },
};

// ── Extension phase config (in-trade only) ────────────────────────────────────

const EXT_CFG: Record<ExtensionPhase, {
  label:     string;
  icon:      string;
  subLabel:  string;
  color:     string;
  bg:        string;
  border:    string;
  trailNote: string;
  headerCls: string;
}> = {
  alive: {
    label:     "EXTENSION ALIVE",
    icon:      "▲▲",
    subLabel:  "Extension wave expanding — bodies growing, wicks compressed. Oracle holds the position.",
    color:     "text-emerald-300",
    bg:        "bg-emerald-500/8",
    border:    "border-emerald-600/30",
    trailNote: "Trail +1.5 pp — extension breathing room granted",
    headerCls: "text-emerald-400",
  },
  peaking: {
    label:     "EXTENSION PEAKING",
    icon:      "▲",
    subLabel:  "Extension running — early fatigue signals. Watch for body softening or first opposing wick.",
    color:     "text-amber-300",
    bg:        "bg-amber-500/8",
    border:    "border-amber-600/30",
    trailNote: "Trail +0.25 pp — slight room, stay alert",
    headerCls: "text-amber-400",
  },
  dying: {
    label:     "DYING EXTENSION",
    icon:      "▼",
    subLabel:  "Bodies shrinking, wicks growing — extension losing force. Safeguard tightening protection.",
    color:     "text-orange-300",
    bg:        "bg-orange-500/8",
    border:    "border-orange-600/30",
    trailNote: "Trail −1.0 pp — safeguard closing in on the peak",
    headerCls: "text-orange-400",
  },
  dead: {
    label:     "EXTENSION DEAD",
    icon:      "▼▼",
    subLabel:  "Extension has collapsed. Safeguard in aggressive mode — next retrace fires the close.",
    color:     "text-red-300",
    bg:        "bg-red-500/8",
    border:    "border-red-700/30",
    trailNote: "Trail −2.0 pp — aggressive exit preparation",
    headerCls: "text-red-400",
  },
};

const ENTRY_QUALITY_LABEL: Record<string, { text: string; cls: string }> = {
  ideal:   { text: "IDEAL ENTRY ZONE",  cls: "text-emerald-400" },
  good:    { text: "GOOD ENTRY ZONE",   cls: "text-emerald-400" },
  wait:    { text: "WAIT FOR RESET",    cls: "text-amber-400" },
  avoid:   { text: "DO NOT ENTER",      cls: "text-red-400" },
  neutral: { text: "NO SIGNAL",         cls: "text-zinc-500" },
};

// ── Phase step indicator constants ────────────────────────────────────────────

const PHASE_ORDER: Record<WavePhase, number> = {
  mixed:                -1,
  pressure_building:     0,
  first_wave:            1,
  pullback:              2,
  resumption_forming:    3,
  resumption_confirmed:  4,
  extended:              5,
};

const PHASE_DOTS: Record<WavePhase, string> = {
  mixed:                "?",
  pressure_building:    "⬡",
  first_wave:           "▶",
  pullback:             "◀",
  resumption_forming:   "◆",
  resumption_confirmed: "◆◆",
  extended:             "⚑",
};

const STEP_PHASES: WavePhase[] = [
  "pressure_building",
  "first_wave",
  "pullback",
  "resumption_forming",
  "resumption_confirmed",
  "extended",
];

// ── Subcomponents ─────────────────────────────────────────────────────────────

function StrengthBar({
  label,
  value,
  max = 1,
  color,
}: {
  label: string;
  value: number;
  max?: number;
  color: string;
}) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wide">{label}</span>
        <span className="text-[10px] text-zinc-400 font-mono">{(value * 100).toFixed(0)}%</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ExtensionScoreBar({ score, phase }: { score: number; phase: ExtensionPhase }) {
  const barColor =
    phase === "alive"   ? "bg-emerald-500" :
    phase === "peaking" ? "bg-amber-400"   :
    phase === "dying"   ? "bg-orange-500"  :
                          "bg-red-600";
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-wide">Extension health</span>
        <span className={cn(
          "text-xs font-bold font-mono",
          phase === "alive"   ? "text-emerald-400" :
          phase === "peaking" ? "text-amber-400"   :
          phase === "dying"   ? "text-orange-400"  :
                                "text-red-400",
        )}>
          {score}/100
        </span>
      </div>
      <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-700", barColor)}
          style={{ width: `${score}%` }}
        />
      </div>
      <div className="flex justify-between text-[9px] text-zinc-700 font-mono">
        <span>dead</span>
        <span>dying</span>
        <span>peaking</span>
        <span>alive</span>
      </div>
    </div>
  );
}

/**
 * Small pill showing whether the wave direction is aligned with the 6h HA bias.
 * aligned   = wave is going in the same direction as the 6h HA master bias  → stronger signal
 * misaligned = wave is going AGAINST the 6h HA bias                          → suspect, reduce confidence
 * unknown   = 6h HA has no clean bias (ha6hBias === 0)                       → show nothing
 */
function HaAlignmentPill({
  aligned,
  hasBias,
}: {
  aligned: boolean;
  hasBias: boolean;
}) {
  if (!hasBias) return null;
  return aligned ? (
    <span className="inline-flex items-center gap-0.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-600/30">
      6h HA ✓
    </span>
  ) : (
    <span className="inline-flex items-center gap-0.5 text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-600/30">
      6h HA ✗
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ResumptionCard({ symbol }: { symbol: string }) {
  const { data, isLoading, error } = useEdgeScore(symbol);
  const { data: safeguards } = useSafeguards(symbol);

  const structure = data?.structure;
  const phase = (structure?.wavePhase ?? "mixed") as WavePhase;
  const cfg = PHASE_CFG[phase] ?? PHASE_CFG.mixed;

  const wave1Avg   = structure?.wave1BodyAvg   ?? 0;
  const wave2Avg   = structure?.wave2BodyAvg   ?? 0;
  const ratio      = structure?.wave2VsWave1Ratio ?? 0;
  const wave1Len   = structure?.wave1Length    ?? 0;
  const wave2Len   = structure?.wave2Length    ?? 0;
  const pullLen    = structure?.pullbackLength ?? 0;

  // HA direction quality flags (new)
  const waveAlignedWithHa6h = structure?.waveAlignedWithHa6h ?? false;
  const pullbackControlled  = structure?.pullbackControlled  ?? false;
  const waveExhaustionFlag  = structure?.waveExhaustionFlag  ?? false;
  // ha6hBias === 0 means no clean 6h HA opinion yet — don't show alignment pill
  const ha6hHasOpinion = (structure as { ha6hBias?: number } | undefined)?.ha6hBias !== 0;

  const hasWave1 = wave1Len > 0 && wave1Avg > 0;
  const hasWave2 = wave2Len > 0 && wave2Avg > 0;
  const hasComparison = hasWave1 && hasWave2 && ratio > 0;

  const ratioLabel =
    ratio >= 1.3 ? "Wave 2 clearly stronger ▲▲" :
    ratio >= 1.1 ? "Wave 2 stronger ▲" :
    ratio >= 0.9 ? "Similar strength ≈" :
    ratio > 0    ? "Wave 2 weaker ▼" :
    null;

  const ratioColor =
    ratio >= 1.1 ? "text-emerald-400" :
    ratio >= 0.9 ? "text-zinc-400" :
    ratio > 0    ? "text-amber-400" :
    "text-zinc-600";

  const entryQ = ENTRY_QUALITY_LABEL[cfg.entryQuality];

  // Detect active trade — an armed safeguard is the cleanest signal
  const armedSafeguard = safeguards?.find(s => s.state === "armed" || s.state === "protecting");
  const inTrade = !!armedSafeguard;

  // Extension health — only meaningful when phase === 'extended'
  const extScore = structure?.extensionScore;
  const extPhase = (structure?.extensionPhase ?? "peaking") as ExtensionPhase;
  const extCfg   = EXT_CFG[extPhase];

  // In-trade + extended = profit wave mode (not "do not enter")
  const showExtensionPanel = phase === "extended" && inTrade && extScore !== undefined;

  if (isLoading) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 animate-pulse">
        <div className="h-4 bg-zinc-800 rounded w-1/3 mb-3" />
        <div className="h-10 bg-zinc-800 rounded mb-2" />
        <div className="h-3 bg-zinc-800 rounded w-2/3" />
      </div>
    );
  }

  if (error || !data) return null;

  // ── In-trade extension panel ─────────────────────────────────────────────
  if (showExtensionPanel) {
    return (
      <div className={cn("rounded-xl border p-4 space-y-3 transition-colors", extCfg.bg, extCfg.border)}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">
            Wave Cycle
          </span>
          <span className={cn("text-[10px] font-bold font-mono", extCfg.headerCls)}>
            EXTENSION — HOLD
          </span>
        </div>

        {/* Extension phase banner */}
        <div className={cn(
          "rounded-lg px-3 py-2.5 flex items-center gap-2.5 border",
          extCfg.bg, extCfg.border,
        )}>
          <span className={cn("text-lg leading-none font-bold", extCfg.color)}>{extCfg.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn("text-sm font-bold tracking-tight", extCfg.color)}>{extCfg.label}</span>
              {/* Exhaustion flag — shown even in-trade as a tightening alert */}
              {waveExhaustionFlag && (
                <span className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-600/30">
                  1h EXHAUSTED
                </span>
              )}
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5 leading-snug">{extCfg.subLabel}</div>
          </div>
        </div>

        {/* Extension score bar */}
        <ExtensionScoreBar score={extScore!} phase={extPhase} />

        {/* Trail adjustment note */}
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500">
          <span>⇔</span>
          <span>{extCfg.trailNote}</span>
        </div>

        {/* Wave structure still shown below for context */}
        {(hasWave1 || pullLen > 0 || hasWave2) && (
          <div className="space-y-2 pt-1 border-t border-zinc-800/50">
            <div className="flex items-center gap-1 text-[10px] font-mono">
              {STEP_PHASES.map((p) => {
                const isActive = p === phase;
                const isPast   = PHASE_ORDER[phase] > PHASE_ORDER[p] && PHASE_ORDER[phase] !== -1;
                return (
                  <div key={p} className="flex items-center gap-1">
                    <span className={cn(
                      "text-[9px]",
                      isActive ? extCfg.color + " font-bold" :
                      isPast   ? "text-zinc-600" : "text-zinc-700",
                    )}>
                      {PHASE_DOTS[p]}
                    </span>
                    {p !== "extended" && (
                      <span className="text-zinc-800">›</span>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {hasWave1 && (
                <div className="text-center">
                  <div className="text-[10px] text-zinc-600 font-mono uppercase mb-1">Wave 1</div>
                  <div className="text-sm font-bold text-zinc-400 font-mono">{wave1Len}</div>
                  <div className="text-[9px] text-zinc-600">HA bars</div>
                </div>
              )}
              {pullLen > 0 && (
                <div className="text-center">
                  <div className="text-[10px] text-zinc-600 font-mono uppercase mb-1">Pullback</div>
                  <div className="text-sm font-bold text-blue-400 font-mono">{pullLen}</div>
                  <div className="text-[9px] text-zinc-600">HA bars</div>
                </div>
              )}
              {hasWave2 && (
                <div className="text-center">
                  <div className="text-[10px] text-zinc-600 font-mono uppercase mb-1">Extension</div>
                  <div className={cn("text-sm font-bold font-mono", extCfg.color)}>{wave2Len}</div>
                  <div className="text-[9px] text-zinc-600">HA bars</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Standard wave cycle view ──────────────────────────────────────────────
  return (
    <div className={cn("rounded-xl border p-4 space-y-3 transition-colors", cfg.bg, cfg.border)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest">
          Wave Cycle
        </span>
        <span className={cn("text-[10px] font-bold font-mono", entryQ.cls)}>
          {entryQ.text}
        </span>
      </div>

      {/* Phase banner */}
      <div className={cn(
        "rounded-lg px-3 py-2.5 flex items-center gap-2.5 border",
        cfg.bg, cfg.border,
      )}>
        <span className={cn("text-lg leading-none", cfg.color)}>{cfg.icon}</span>
        <div className="flex-1 min-w-0">
          {/* Label row with HA alignment pill */}
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className={cn("text-sm font-bold tracking-tight", cfg.color)}>{cfg.label}</span>
            <HaAlignmentPill aligned={waveAlignedWithHa6h} hasBias={ha6hHasOpinion} />
          </div>
          <div className="text-[11px] text-zinc-500 leading-snug">{cfg.guidance}</div>

          {/* Pullback-specific: controlled flag */}
          {phase === "pullback" && pullbackControlled && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-blue-300">
              <span>◈</span>
              <span>1h HA still holding trade direction — controlled counter.</span>
            </div>
          )}
          {phase === "pullback" && !pullbackControlled && ha6hHasOpinion && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-zinc-500">
              <span>◈</span>
              <span>1h HA not confirming — watch depth of counter before entering.</span>
            </div>
          )}

          {/* Extended + exhaustion: double warning */}
          {phase === "extended" && waveExhaustionFlag && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-red-400 font-semibold">
              <span>⚠</span>
              <span>1h HA also exhausted — double overextension signal. High reversal risk.</span>
            </div>
          )}

          {/* Resumption misaligned with 6h HA: caution note */}
          {(phase === "resumption_forming" || phase === "resumption_confirmed") &&
            !waveAlignedWithHa6h && ha6hHasOpinion && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-amber-400">
              <span>⚠</span>
              <span>Wave against 6h HA bias — oracle score reduced. Confirm 6h flip before sizing.</span>
            </div>
          )}
        </div>
      </div>

      {/* Wave structure */}
      {(hasWave1 || pullLen > 0 || hasWave2) && (
        <div className="space-y-2">
          {/* Phase step dots */}
          <div className="flex items-center gap-1 text-[10px] font-mono">
            {STEP_PHASES.map((p) => {
              const isActive = p === phase;
              const isPast   = PHASE_ORDER[phase] > PHASE_ORDER[p] && PHASE_ORDER[phase] !== -1 && phase !== "mixed";
              const isFuture = PHASE_ORDER[phase] < PHASE_ORDER[p];
              return (
                <div key={p} className="flex items-center gap-1">
                  <span className={cn(
                    "text-[9px]",
                    isActive ? cfg.color + " font-bold" :
                    isPast   ? "text-zinc-600" :
                    isFuture ? "text-zinc-700" :
                               "text-zinc-600",
                  )}>
                    {PHASE_DOTS[p]}
                  </span>
                  {p !== "extended" && (
                    <span className="text-zinc-800">›</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Wave bar lengths */}
          <div className="grid grid-cols-3 gap-2">
            {hasWave1 && (
              <div className="text-center">
                <div className="text-[10px] text-zinc-600 font-mono uppercase mb-1">Wave 1</div>
                <div className="text-sm font-bold text-zinc-400 font-mono">{wave1Len}</div>
                <div className="text-[9px] text-zinc-600">HA bars</div>
              </div>
            )}
            {pullLen > 0 && (
              <div className="text-center">
                <div className="text-[10px] text-zinc-600 font-mono uppercase mb-1">Pullback</div>
                <div className={cn(
                  "text-sm font-bold font-mono",
                  pullbackControlled ? "text-blue-300" : "text-blue-400",
                )}>{pullLen}</div>
                <div className={cn(
                  "text-[9px]",
                  pullbackControlled ? "text-blue-500/60" : "text-zinc-600",
                )}>
                  {pullbackControlled ? "controlled" : "HA bars"}
                </div>
              </div>
            )}
            {hasWave2 && (
              <div className="text-center">
                <div className="text-[10px] text-zinc-600 font-mono uppercase mb-1">Wave 2</div>
                <div className={cn("text-sm font-bold font-mono",
                  ratio >= 1.1 ? "text-emerald-400" :
                  ratio >= 0.9 ? "text-zinc-400" : "text-amber-400"
                )}>{wave2Len}</div>
                <div className="text-[9px] text-zinc-600">HA bars</div>
              </div>
            )}
          </div>

          {/* Body strength comparison */}
          {hasWave1 && (
            <div className="space-y-1.5 pt-1 border-t border-zinc-800/60">
              <StrengthBar
                label="Wave 1 strength"
                value={wave1Avg}
                color="bg-zinc-500"
              />
              {hasWave2 && (
                <StrengthBar
                  label="Wave 2 strength"
                  value={wave2Avg}
                  color={ratio >= 1.1 ? "bg-emerald-500" : ratio >= 0.9 ? "bg-zinc-400" : "bg-amber-500"}
                />
              )}
              {hasComparison && (
                <div className="flex justify-between items-center pt-0.5">
                  <span className="text-[10px] text-zinc-600 font-mono">Resumption force</span>
                  <span className={cn("text-[10px] font-bold font-mono", ratioColor)}>
                    {ratioLabel ?? `${(ratio * 100).toFixed(0)}%`}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* No wave data yet */}
      {!hasWave1 && phase !== "mixed" && (
        <div className="text-center py-2">
          <p className="text-[11px] text-zinc-600">
            Watching first HA bars form…
          </p>
        </div>
      )}
    </div>
  );
}
