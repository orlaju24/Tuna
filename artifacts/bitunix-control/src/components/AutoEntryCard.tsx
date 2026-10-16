import { useState } from "react";
import { Bot, ChevronDown, ChevronUp, Check, X, Clock, Shield, AlertTriangle, Plus, Trash2, Snowflake, LogOut, Play } from "lucide-react";
import { cn } from "../lib/utils";
import {
  useAutoEntryConfig,
  useAutoEntryStatus,
  useToggleAutoEntry,
  useUpdateAutoEntryConfig,
  useFreezeSession,
  useUnfreezeSession,
  useWalkAway,
  useResume,
  type TimeWindow,
  type EvalResult,
} from "../hooks/useAutoEntry";

// ── Time window presets from the Oracle Method ────────────────────────────────

const WINDOW_PRESETS: { type: "blocked" | "allowed"; window: TimeWindow }[] = [
  {
    type: "blocked",
    window: { label: "Witching Hour (danger)", startHour: 1, startMin: 0, endHour: 4, endMin: 0 },
  },
  {
    type: "allowed",
    window: { label: "AM Pump", startHour: 7, startMin: 0, endHour: 8, endMin: 0 },
  },
  {
    type: "allowed",
    window: { label: "Stock Market Open", startHour: 9, startMin: 30, endHour: 10, endMin: 30 },
  },
  {
    type: "allowed",
    window: { label: "Midday Pump", startHour: 11, startMin: 0, endHour: 13, endMin: 0 },
  },
  {
    type: "allowed",
    window: { label: "Bus Pump / Close", startHour: 16, startMin: 0, endHour: 16, endMin: 30 },
  },
  {
    type: "allowed",
    window: { label: "End of Day", startHour: 20, startMin: 0, endHour: 20, endMin: 30 },
  },
];

function fmtWindow(w: TimeWindow): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(w.startHour)}:${pad(w.startMin)}–${pad(w.endHour)}:${pad(w.endMin)} ET`;
}

// ── Check row ─────────────────────────────────────────────────────────────────

function CheckRow({
  ok,
  label,
  detail,
}: {
  ok: boolean | null;
  label: string;
  detail?: string;
}) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <div className="mt-0.5 flex-shrink-0">
        {ok === null ? (
          <div className="w-3.5 h-3.5 rounded-full border border-zinc-600" />
        ) : ok ? (
          <Check size={14} className="text-emerald-400" />
        ) : (
          <X size={14} className="text-red-400" />
        )}
      </div>
      <div className="min-w-0">
        <span className={cn("text-xs", ok ? "text-zinc-300" : ok === false ? "text-red-300" : "text-zinc-500")}>
          {label}
        </span>
        {detail && (
          <span className="ml-1 text-[10px] text-zinc-500">{detail}</span>
        )}
      </div>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

export function AutoEntryCard() {
  const { data: config } = useAutoEntryConfig();
  const { data: status } = useAutoEntryStatus();
  const toggle = useToggleAutoEntry();
  const update = useUpdateAutoEntryConfig();
  const freeze = useFreezeSession();
  const unfreeze = useUnfreezeSession();
  const walkAway = useWalkAway();
  const resume = useResume();

  const [showConfig, setShowConfig] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const enabled = config?.enabled ?? false;
  const frozen = config?.sessionFrozen ?? false;
  const walkAwayActive = config?.walkAwayMode ?? false;
  const last: EvalResult | null = status?.lastResult ?? null;

  // Local editable config state
  const [draft, setDraft] = useState<{
    symbol: string;
    side: string;
    maxMargin: string;
    leverage: string;
    minLiqGap: string;
    minEdge: string;
    t1: string;
    trail: string;
  } | null>(null);

  function openConfig() {
    if (!config) return;
    setDraft({
      symbol: config.symbol,
      side: config.side,
      maxMargin: config.maxMarginUsdt,
      leverage: String(config.leverage),
      minLiqGap: config.minLiqGapUsdt,
      minEdge: String(config.minEdgeScore),
      t1: config.safeguardThreshold1Pct,
      trail: config.safeguardTrailPct,
    });
    setShowConfig(true);
  }

  function saveConfig() {
    if (!draft) return;
    update.mutate({
      symbol: draft.symbol,
      side: draft.side,
      maxMarginUsdt: draft.maxMargin,
      leverage: Number(draft.leverage),
      minLiqGapUsdt: draft.minLiqGap,
      minEdgeScore: Number(draft.minEdge),
      safeguardThreshold1Pct: draft.t1,
      safeguardTrailPct: draft.trail,
    });
    setShowConfig(false);
    setDraft(null);
  }

  function addWindow(type: "blocked" | "allowed", w: TimeWindow) {
    if (!config) return;
    const key = type === "blocked" ? "blockedWindowsJson" : "allowedWindowsJson";
    const existing = (type === "blocked" ? config.blockedWindowsJson : config.allowedWindowsJson) ?? [];
    const alreadyThere = existing.some(
      (e) => e.label === w.label,
    );
    if (alreadyThere) return;
    update.mutate({ [key]: [...existing, w] });
  }

  function removeWindow(type: "blocked" | "allowed", idx: number) {
    if (!config) return;
    const key = type === "blocked" ? "blockedWindowsJson" : "allowedWindowsJson";
    const existing = (type === "blocked" ? config.blockedWindowsJson : config.allowedWindowsJson) ?? [];
    update.mutate({ [key]: existing.filter((_, i) => i !== idx) });
  }

  function toggleMiddles() {
    if (!config) return;
    update.mutate({ avoidMiddles: !config.avoidMiddles });
  }

  function toggleAutoArm() {
    if (!config) return;
    update.mutate({ autoArmSafeguard: !config.autoArmSafeguard });
  }

  // ── Status indicator ────────────────────────────────────────────────────────
  const statusLabel = !enabled
    ? { text: "OFF", color: "text-zinc-500", bg: "bg-zinc-800" }
    : frozen
    ? { text: "FROZEN", color: "text-red-300", bg: "bg-red-900/30" }
    : walkAwayActive
    ? { text: "WALK AWAY", color: "text-amber-300", bg: "bg-amber-900/30" }
    : last?.entryOpened
    ? { text: "ENTERED", color: "text-emerald-300", bg: "bg-emerald-900/30" }
    : last?.allowed
    ? { text: "SCANNING", color: "text-blue-300", bg: "bg-blue-900/20" }
    : !last
    ? { text: "WATCHING", color: "text-zinc-400", bg: "bg-zinc-800" }
    : { text: "BLOCKED", color: "text-amber-300", bg: "bg-amber-900/20" };

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot size={15} className={enabled ? "text-blue-400" : "text-zinc-600"} />
          <span className="text-xs font-bold uppercase tracking-wide text-zinc-300">
            Auto Entry
          </span>
          <span className={cn("text-[10px] font-bold uppercase px-1.5 py-0.5 rounded", statusLabel.bg, statusLabel.color)}>
            {statusLabel.text}
          </span>
        </div>

        {/* Enable/disable toggle */}
        <button
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!enabled)}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200",
            enabled ? "bg-blue-600" : "bg-zinc-700",
            toggle.isPending && "opacity-50",
          )}
          title={enabled ? "Disable auto-entry" : "Enable auto-entry"}
        >
          <span
            className={cn(
              "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200",
              enabled ? "translate-x-6" : "translate-x-1",
            )}
          />
        </button>
      </div>

      {/* Warning when enabled */}
      {enabled && !frozen && !walkAwayActive && (
        <div className="flex items-start gap-1.5 rounded-lg bg-amber-900/20 border border-amber-700/30 px-2.5 py-1.5">
          <AlertTriangle size={11} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <p className="text-[10px] text-amber-300">
            System will open a {config?.side === "SIGNAL" ? "directional" : config?.side ?? "–"} position on{" "}
            {config?.symbol} when all guardrails pass. Flat-only — no stacking.
          </p>
        </div>
      )}

      {/* Frozen banner */}
      {frozen && (
        <div className="flex items-center gap-2 rounded-lg bg-red-900/30 border border-red-700/40 px-2.5 py-2">
          <Snowflake size={12} className="text-red-300 flex-shrink-0" />
          <p className="text-[10px] text-red-200 flex-1">
            Session frozen — all auto-entry blocked until you unfreeze.
          </p>
          <button
            onClick={() => unfreeze.mutate()}
            disabled={unfreeze.isPending}
            className="text-[10px] px-2 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white font-medium shrink-0"
          >
            Unfreeze
          </button>
        </div>
      )}

      {/* Walk Away banner */}
      {!frozen && walkAwayActive && (
        <div className="flex items-center gap-2 rounded-lg bg-amber-900/25 border border-amber-700/40 px-2.5 py-2">
          <LogOut size={12} className="text-amber-300 flex-shrink-0" />
          <p className="text-[10px] text-amber-200 flex-1">
            Walk Away — standing down until you confirm a fresh setup.
          </p>
          <button
            onClick={() => resume.mutate()}
            disabled={resume.isPending}
            className="text-[10px] px-2 py-0.5 rounded bg-amber-700 hover:bg-amber-600 text-white font-medium shrink-0"
          >
            Resume
          </button>
        </div>
      )}

      {/* Governance action buttons — visible when enabled and not already in a governance state */}
      {enabled && !frozen && !walkAwayActive && (
        <div className="flex gap-2">
          <button
            onClick={() => freeze.mutate()}
            disabled={freeze.isPending}
            className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded border border-red-800/60 text-red-400 hover:bg-red-900/30 transition-colors"
            title="Hard kill-switch — blocks all auto-entry, survives restart"
          >
            <Snowflake size={10} /> Freeze
          </button>
          <button
            onClick={() => walkAway.mutate()}
            disabled={walkAway.isPending}
            className="flex items-center gap-1 text-[10px] px-2.5 py-1 rounded border border-amber-800/60 text-amber-400 hover:bg-amber-900/20 transition-colors"
            title="Stand down after a close — oracle waits for fresh plan before re-entering"
          >
            <LogOut size={10} /> Walk Away
          </button>
        </div>
      )}

      {/* Last evaluation checklist */}
      {enabled && (
        <div className="space-y-0.5">
          <p className="text-[10px] uppercase tracking-wide text-zinc-600 mb-1">
            Last scan{last ? ` · ${new Date(last.evaluatedAt).toLocaleTimeString()}` : " · pending"}
          </p>

          <CheckRow
            ok={last ? last.positionFlat : null}
            label="Position flat"
            detail={last && !last.positionFlat ? "trade already open" : undefined}
          />
          <CheckRow
            ok={last ? last.timeWindowOk : null}
            label="Time window"
            detail={last?.blockReasons.find((r) => r.startsWith("Time") || r.startsWith("Outside"))}
          />
          <CheckRow
            ok={last ? last.wholeNumberProximityOk : null}
            label="Whole-number zone"
            detail={last?.currentPrice ? `$${last.currentPrice.toFixed(0)}` : undefined}
          />
          <CheckRow
            ok={last ? last.avoidMiddlesOk : null}
            label="Not in middles"
          />
          <CheckRow
            ok={last ? last.edgeOk : null}
            label="Oracle score"
            detail={
              last?.edgeScore != null
                ? `${last.edgeScore}/100 · ${last.edgeGrade ?? ""} (min ${config?.minEdgeScore ?? 65})`
                : undefined
            }
          />
          <CheckRow
            ok={last ? last.liqGapOk : null}
            label="Liq gap"
            detail={
              last?.liqGapEstimate != null
                ? `$${Math.round(last.liqGapEstimate).toLocaleString()} gap (min $${
                    config ? parseFloat(config.minLiqGapUsdt).toLocaleString() : "3,000"
                  })`
                : undefined
            }
          />
          <CheckRow
            ok={last ? last.detectedSide !== null && last.detectedSide !== "NONE" : null}
            label="Direction"
            detail={last?.detectedSide ?? undefined}
          />
          <CheckRow
            ok={last
              ? last.planGateOk === null
                ? true          // no plan = gate open, treat as pass
                : last.planGateOk
              : null}
            label="Plan gate"
            detail={
              !last
                ? undefined
                : last.planGateOk === null
                ? "no plan · gate open"
                : last.planLikelyAction
                ? `${last.planLikelyAction}${last.planConfidenceLevel != null ? ` · ${last.planConfidenceLevel}%` : ""}${last.planReturnToZoneNote ? ` · ${last.planReturnToZoneNote}` : ""}`
                : undefined
            }
          />

          {/* Block reasons */}
          {last && !last.allowed && last.blockReasons.length > 0 && (
            <div className="mt-1.5 rounded-lg bg-red-950/30 border border-red-800/30 px-2 py-1.5 space-y-0.5">
              {last.blockReasons.map((r, i) => (
                <p key={i} className="text-[10px] text-red-300">
                  · {r}
                </p>
              ))}
            </div>
          )}

          {/* Entry confirmation */}
          {last?.entryOpened && (
            <div className="mt-1.5 rounded-lg bg-emerald-950/30 border border-emerald-700/30 px-2 py-1.5">
              <p className="text-[10px] text-emerald-300 font-medium">
                Entered {last.entrySide} {last.entryQty} {last.entrySymbol} @{" "}
                {last.entryPrice?.toFixed(2)}
                {last.safeguardArmed ? " · Safeguard armed" : ""}
              </p>
            </div>
          )}
        </div>
      )}

      {/* Config toggle */}
      <button
        onClick={() => {
          if (!showConfig) openConfig();
          else { setShowConfig(false); setDraft(null); }
        }}
        className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
      >
        {showConfig ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        {showConfig ? "Hide settings" : "Settings"}
      </button>

      {/* Config panel */}
      {showConfig && draft && (
        <div className="space-y-3 border-t border-zinc-800 pt-3">
          {/* Symbol + Side */}
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Symbol</span>
              <input
                value={draft.symbol}
                onChange={(e) => setDraft({ ...draft, symbol: e.target.value.toUpperCase() })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Direction</span>
              <select
                value={draft.side}
                onChange={(e) => setDraft({ ...draft, side: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              >
                <option value="SIGNAL">Auto (HTF)</option>
                <option value="LONG">Long</option>
                <option value="SHORT">Short</option>
              </select>
            </label>
          </div>

          {/* Margin + Leverage */}
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Max Margin ($)</span>
              <input
                type="number"
                value={draft.maxMargin}
                onChange={(e) => setDraft({ ...draft, maxMargin: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Leverage (x)</span>
              <input
                type="number"
                value={draft.leverage}
                onChange={(e) => setDraft({ ...draft, leverage: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
          </div>

          {/* Liq gap + Edge score */}
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Min Liq Gap ($)</span>
              <input
                type="number"
                value={draft.minLiqGap}
                onChange={(e) => setDraft({ ...draft, minLiqGap: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Min Oracle Score</span>
              <input
                type="number"
                min={0}
                max={100}
                value={draft.minEdge}
                onChange={(e) => setDraft({ ...draft, minEdge: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
          </div>

          {/* Safeguard settings */}
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Guard Threshold (%)</span>
              <input
                type="number"
                value={draft.t1}
                onChange={(e) => setDraft({ ...draft, t1: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[10px] text-zinc-500 uppercase tracking-wide">Guard Trail (%)</span>
              <input
                type="number"
                value={draft.trail}
                onChange={(e) => setDraft({ ...draft, trail: e.target.value })}
                className="w-full rounded bg-zinc-800 border border-zinc-700 px-2 py-1 text-xs text-zinc-200"
              />
            </label>
          </div>

          <button
            onClick={saveConfig}
            disabled={update.isPending}
            className="w-full rounded bg-blue-700 hover:bg-blue-600 py-1.5 text-xs font-medium text-white"
          >
            Save Parameters
          </button>

          {/* Toggles */}
          <div className="space-y-2 border-t border-zinc-800 pt-2">
            <ToggleRow
              icon={<Shield size={12} />}
              label="Auto-arm safeguard after entry"
              on={config?.autoArmSafeguard ?? true}
              onToggle={toggleAutoArm}
            />
            <ToggleRow
              icon={<AlertTriangle size={12} />}
              label="Avoid middles zone (30–70% between whole numbers)"
              on={config?.avoidMiddles ?? true}
              onToggle={toggleMiddles}
            />
          </div>

          {/* Time windows */}
          <div className="border-t border-zinc-800 pt-2 space-y-2">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500 flex items-center gap-1">
              <Clock size={10} /> Time Windows · America/New_York
            </p>

            {/* Active blocked windows */}
            <WindowList
              label="Blocked"
              color="red"
              windows={config?.blockedWindowsJson ?? []}
              onRemove={(i) => removeWindow("blocked", i)}
            />

            {/* Active allowed windows */}
            <WindowList
              label="Allowed"
              note="(if empty, any time is ok)"
              color="emerald"
              windows={config?.allowedWindowsJson ?? []}
              onRemove={(i) => removeWindow("allowed", i)}
            />

            {/* Preset buttons */}
            <p className="text-[10px] text-zinc-600 mt-1">Add preset:</p>
            <div className="flex flex-wrap gap-1.5">
              {WINDOW_PRESETS.map((p, i) => {
                const existing = (p.type === "blocked"
                  ? config?.blockedWindowsJson
                  : config?.allowedWindowsJson) ?? [];
                const active = existing.some((e) => e.label === p.window.label);
                return (
                  <button
                    key={i}
                    onClick={() => addWindow(p.type, p.window)}
                    disabled={active || update.isPending}
                    className={cn(
                      "text-[10px] rounded px-2 py-0.5 border",
                      p.type === "blocked"
                        ? active
                          ? "border-red-700/50 text-red-500 opacity-40"
                          : "border-red-700/50 text-red-400 hover:bg-red-900/30"
                        : active
                        ? "border-emerald-700/50 text-emerald-500 opacity-40"
                        : "border-emerald-700/50 text-emerald-400 hover:bg-emerald-900/20",
                    )}
                  >
                    {active ? "✓" : "+"} {p.window.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Recent log toggle */}
      {(status?.recentLog?.length ?? 0) > 0 && (
        <>
          <button
            onClick={() => setShowLog((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
          >
            {showLog ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            Recent evaluations ({status?.recentLog?.length})
          </button>

          {showLog && (
            <div className="space-y-1">
              {(status?.recentLog ?? []).map((row) => (
                <div
                  key={row.id}
                  className={cn(
                    "rounded px-2 py-1 text-[10px] flex items-center gap-2",
                    row.entryOpened
                      ? "bg-emerald-950/30 text-emerald-300"
                      : row.allowed
                      ? "bg-blue-950/20 text-blue-300"
                      : "bg-zinc-800/60 text-zinc-400",
                  )}
                >
                  <span className="text-zinc-600 flex-shrink-0">
                    {new Date(row.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {row.entryOpened ? (
                    <span className="font-medium">
                      Entered {row.entrySide} {row.entrySymbol} @ {parseFloat(row.entryPrice ?? "0").toFixed(0)}
                    </span>
                  ) : (
                    <span>
                      {[
                        row.positionFlat ? null : "not flat",
                        !row.timeWindowOk ? "time" : null,
                        !row.avoidMiddlesOk ? "middles" : null,
                        !row.edgeOk ? `oracle ${row.edgeScore ?? "?"}` : null,
                        !row.liqGapOk ? "liq" : null,
                      ]
                        .filter(Boolean)
                        .join(", ") || "all clear"}
                    </span>
                  )}
                  {row.edgeScore != null && (
                    <span className="ml-auto text-zinc-600">{row.edgeScore}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ToggleRow({
  icon,
  label,
  on,
  onToggle,
}: {
  icon: React.ReactNode;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-[10px] text-zinc-400">
        {icon} {label}
      </div>
      <button
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
          on ? "bg-blue-600" : "bg-zinc-700",
        )}
      >
        <span
          className={cn(
            "inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform",
            on ? "translate-x-5" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

function WindowList({
  label,
  note,
  color,
  windows,
  onRemove,
}: {
  label: string;
  note?: string;
  color: "red" | "emerald";
  windows: TimeWindow[];
  onRemove: (i: number) => void;
}) {
  if (windows.length === 0) {
    return (
      <p className="text-[10px] text-zinc-600">
        {label}: none {note && <span className="text-zinc-700">{note}</span>}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <p className={cn("text-[10px] uppercase tracking-wide", color === "red" ? "text-red-500" : "text-emerald-500")}>
        {label}
      </p>
      {windows.map((w, i) => (
        <div key={i} className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-400">
            {w.label} · {fmtWindow(w)}
          </span>
          <button onClick={() => onRemove(i)} className="text-zinc-600 hover:text-red-400 p-0.5">
            <Trash2 size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}
