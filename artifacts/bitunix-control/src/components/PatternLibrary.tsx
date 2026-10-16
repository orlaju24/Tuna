import { useState, useRef } from "react";
import { useHindsightExamples, useHindsightSummary, useDeleteHindsight, type HindsightExample } from "@/hooks/useHindsight";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Formatting helpers ────────────────────────────────────────────────────

function fmtPct(v: string | number | null | undefined, decimals = 1): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(decimals)}%`;
}

function fmtPrice(v: string | number | null | undefined): string {
  if (v == null) return "—";
  const n = typeof v === "string" ? parseFloat(v) : v;
  return isNaN(n) ? "—" : `$${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
}

// ── Visual mappings ───────────────────────────────────────────────────────

const OUTCOME_CFG: Record<string, { label: string; cls: string }> = {
  strong_win: { label: "Strong Win",  cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  win:        { label: "Win",         cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  scratch:    { label: "Scratch",     cls: "bg-zinc-700/60   text-zinc-400    border-zinc-600/40"     },
  loss:       { label: "Loss",        cls: "bg-red-500/10    text-red-400     border-red-500/20"      },
  strong_loss:{ label: "Strong Loss", cls: "bg-red-500/20    text-red-300     border-red-500/30"      },
};

const SESSION_LABEL: Record<string, string> = {
  asian:       "Asian",
  london:      "London",
  ny:          "NY",
  "pre-market":"Pre-mkt",
  unknown:     "Unknown",
};

const DIRECTION_CLS: Record<string, string> = {
  SHORT: "bg-red-500/20 text-red-400",
  LONG:  "bg-emerald-500/20 text-emerald-400",
};

// ── Example card ─────────────────────────────────────────────────────────

function ExampleCard({ ex }: { ex: HindsightExample }) {
  const [expanded, setExpanded] = useState(false);
  const { mutate: deleteEx } = useDeleteHindsight();
  const outcome = ex.outcomeClass ? OUTCOME_CFG[ex.outcomeClass] : null;

  return (
    <div className="border border-zinc-800 rounded-xl bg-zinc-900/60 overflow-hidden">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full text-left p-4 hover:bg-zinc-800/30 transition-colors"
      >
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2 flex-wrap">
            {ex.direction && (
              <span className={cn("text-xs px-2 py-0.5 rounded font-semibold", DIRECTION_CLS[ex.direction] ?? "bg-zinc-700 text-zinc-300")}>
                {ex.direction}
              </span>
            )}
            {ex.leverage && (
              <span className="text-sm text-zinc-400 font-mono">{ex.leverage}x</span>
            )}
            {outcome && (
              <span className={cn("text-xs px-2 py-0.5 rounded border font-semibold", outcome.cls)}>
                {outcome.label}
              </span>
            )}
            {ex.sessionBucket && (
              <span className="text-xs text-zinc-500 bg-zinc-800 px-1.5 py-0.5 rounded">
                {SESSION_LABEL[ex.sessionBucket] ?? ex.sessionBucket}
              </span>
            )}
            {ex.confidenceScore != null && (
              <span className={cn(
                "text-xs font-mono",
                ex.confidenceScore >= 80 ? "text-emerald-400" : ex.confidenceScore >= 50 ? "text-zinc-400" : "text-yellow-400"
              )}>
                {ex.confidenceScore}% conf
              </span>
            )}
          </div>
          <span className="text-zinc-600 text-sm shrink-0">{expanded ? "▴" : "▾"}</span>
        </div>

        {/* Key data row */}
        <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
          <div>
            <div className="text-zinc-500 text-xs mb-0.5">Entry</div>
            <div className="text-zinc-300 font-mono">{fmtPrice(ex.entryPrice)}</div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs mb-0.5">ROI</div>
            <div className={cn("font-mono font-semibold",
              ex.roiPct && parseFloat(ex.roiPct) >= 0 ? "text-emerald-400" : "text-red-400"
            )}>
              {fmtPct(ex.roiPct)}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 text-xs mb-0.5">Level</div>
            <div className="text-zinc-300 font-mono">
              {ex.wholeNumberNearest
                ? `${fmtPrice(ex.wholeNumberNearest)} ${ex.wholeNumberRelation ?? ""}`
                : "—"}
            </div>
          </div>
        </div>

        {ex.timeOfDayLabel && (
          <div className="mt-2 text-xs text-zinc-600 font-mono">{ex.timeOfDayLabel}</div>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-800 pt-3 space-y-1.5">
          {ex.marketRegime && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Regime</span>
              <span className="text-zinc-300 font-mono">{ex.marketRegime.replace(/_/g, " ")}</span>
            </div>
          )}
          {ex.closeType && ex.closeType !== "unknown" && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Close type</span>
              <span className="text-zinc-300 font-mono">{ex.closeType.replace(/_/g, " ")}</span>
            </div>
          )}
          {ex.wholeNumberDistPct && (
            <div className="flex justify-between text-xs">
              <span className="text-zinc-500">Distance to level</span>
              <span className="text-zinc-300 font-mono">{parseFloat(ex.wholeNumberDistPct).toFixed(2)}%</span>
            </div>
          )}
          {ex.extractionNotes && (
            <div className="mt-2 pt-2 border-t border-zinc-800/60">
              <div className="text-xs text-zinc-500 mb-1">AI notes</div>
              <p className="text-xs text-zinc-400 italic leading-relaxed">{ex.extractionNotes}</p>
            </div>
          )}
          {ex.userNotes && (
            <div className="mt-1">
              <div className="text-xs text-zinc-500 mb-1">Your notes</div>
              <p className="text-xs text-zinc-400 leading-relaxed">{ex.userNotes}</p>
            </div>
          )}
          <div className="pt-2 flex justify-between items-center">
            <span className="text-xs text-zinc-600">
              {new Date(ex.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); deleteEx(ex.id); }}
              className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Upload form ───────────────────────────────────────────────────────────

function UploadForm({ symbol }: { symbol?: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  const handleSubmit = async () => {
    if (!file) return;
    setUploading(true);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      fd.append("symbol", symbol ?? "BTCUSDT");
      if (notes) fd.append("notes", notes);

      const resp = await fetch(`${import.meta.env.BASE_URL}api/hindsight/upload`, {
        method: "POST",
        body: fd,
      });
      const data = await resp.json() as { ok?: boolean; error?: string };
      if (data.ok) {
        setResult({ ok: true, message: "Example saved and extracted." });
        setFile(null);
        setNotes("");
        if (inputRef.current) inputRef.current.value = "";
        qc.invalidateQueries({ queryKey: ["hindsight"] });
        qc.invalidateQueries({ queryKey: ["hindsight-summary"] });
      } else {
        setResult({ ok: false, message: data.error ?? "Upload failed" });
      }
    } catch (err) {
      setResult({ ok: false, message: String(err) });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="border border-zinc-700/50 rounded-xl p-4 bg-zinc-900/40 space-y-3">
      <div className="text-xs text-zinc-400 font-semibold uppercase tracking-wider">
        Add Hindsight Example
      </div>
      <div>
        <label className="text-xs text-zinc-500 mb-1 block">Screenshot (Bitunix trade view)</label>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={e => setFile(e.target.files?.[0] ?? null)}
          className="text-xs text-zinc-400 w-full file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:bg-zinc-700 file:text-zinc-300 hover:file:bg-zinc-600 cursor-pointer"
        />
      </div>
      {file && (
        <div>
          <label className="text-xs text-zinc-500 mb-1 block">Notes (optional)</label>
          <input
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="e.g. clean break below $68k, fast entry"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-zinc-500"
          />
        </div>
      )}
      {file && (
        <button
          onClick={handleSubmit}
          disabled={uploading}
          className={cn(
            "w-full py-2.5 rounded-lg text-sm font-semibold transition-colors",
            uploading
              ? "bg-zinc-700 text-zinc-400 cursor-not-allowed"
              : "bg-violet-600 hover:bg-violet-500 text-white"
          )}
        >
          {uploading ? "Analysing…" : "Upload & Extract"}
        </button>
      )}
      {result && (
        <div className={cn(
          "text-xs px-3 py-2 rounded",
          result.ok ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
        )}>
          {result.message}
        </div>
      )}
    </div>
  );
}

// ── Summary chips ─────────────────────────────────────────────────────────

function SummaryRow({ label, value, cls }: { label: string; value: React.ReactNode; cls?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-zinc-500 text-xs">{label}</span>
      <span className={cn("text-sm font-mono font-semibold", cls ?? "text-zinc-300")}>{value}</span>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────

type PFilter = "all" | "win" | "loss" | "short" | "long";
const P_FILTERS: { key: PFilter; label: string }[] = [
  { key: "all",   label: "All"   },
  { key: "short", label: "Short" },
  { key: "long",  label: "Long"  },
  { key: "win",   label: "Wins"  },
  { key: "loss",  label: "Losses"},
];

export function PatternLibrary({ symbol }: { symbol?: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState<PFilter>("all");
  const [showUpload, setShowUpload] = useState(false);

  const { data: examples = [], isLoading } = useHindsightExamples({ symbol });
  const { data: summary } = useHindsightSummary();

  const filtered = examples.filter(ex => {
    if (filter === "win")   return ex.profitStatus === "win";
    if (filter === "loss")  return ex.profitStatus === "loss";
    if (filter === "short") return ex.direction === "SHORT";
    if (filter === "long")  return ex.direction === "LONG";
    return true;
  });

  const winRate = summary?.winRate != null
    ? `${(summary.winRate * 100).toFixed(0)}%`
    : null;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <button
          onClick={() => setCollapsed(v => !v)}
          className="flex items-center gap-2"
        >
          <span className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
            Pattern Library
          </span>
          {summary && summary.total > 0 && (
            <span className="text-xs bg-violet-500/20 text-violet-300 px-2 py-0.5 rounded-full font-mono">
              {summary.total}
            </span>
          )}
          <span className="text-zinc-600 text-sm ml-1">{collapsed ? "▸" : "▾"}</span>
        </button>
        {!collapsed && (
          <button
            onClick={() => setShowUpload(v => !v)}
            className="text-xs px-2.5 py-1 rounded-full bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors font-medium"
          >
            {showUpload ? "cancel" : "+ add example"}
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          {/* Summary strip */}
          {summary && summary.total > 0 && (
            <div className="grid grid-cols-3 gap-3 mt-3 mb-4 p-3 bg-zinc-800/40 rounded-xl">
              <SummaryRow
                label="Win rate"
                value={winRate ?? "—"}
                cls={summary.winRate != null && summary.winRate >= 0.5 ? "text-emerald-400" : "text-red-400"}
              />
              <SummaryRow
                label="Shorts W%"
                value={summary.shortWinRate != null ? `${(summary.shortWinRate * 100).toFixed(0)}%` : "—"}
              />
              <SummaryRow
                label="Longs W%"
                value={summary.longWinRate != null ? `${(summary.longWinRate * 100).toFixed(0)}%` : "—"}
              />
            </div>
          )}

          {/* Session breakdown */}
          {summary && Object.keys(summary.bySession).length > 0 && (
            <div className="flex gap-2 flex-wrap mb-3">
              {Object.entries(summary.bySession).map(([k, v]) => (
                <span key={k} className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded font-mono">
                  {SESSION_LABEL[k] ?? k}: {v}
                </span>
              ))}
            </div>
          )}

          {/* Upload form */}
          {showUpload && (
            <div className="mb-4">
              <UploadForm symbol={symbol} />
            </div>
          )}

          {/* Filters */}
          {examples.length > 0 && (
            <div className="flex gap-1.5 mb-3">
              {P_FILTERS.map(f => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "text-xs px-3 py-1.5 rounded-full font-medium transition-colors",
                    filter === f.key
                      ? "bg-zinc-700 text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          )}

          {isLoading && (
            <div className="text-sm text-zinc-500 py-4">Loading pattern library…</div>
          )}

          {!isLoading && examples.length === 0 && !showUpload && (
            <div className="text-center py-8 space-y-2">
              <div className="text-zinc-500 text-sm">No historical examples yet.</div>
              <div className="text-zinc-600 text-xs leading-relaxed max-w-xs mx-auto">
                Upload screenshots of past winning or losing trades. The system extracts entry, exit,
                session, whole-number context and outcome to build a mentor-style pattern memory.
              </div>
              <button
                onClick={() => setShowUpload(true)}
                className="mt-2 text-xs px-4 py-2 rounded-full bg-violet-600/20 text-violet-300 border border-violet-500/30 hover:bg-violet-600/30 transition-colors"
              >
                Upload first example
              </button>
            </div>
          )}

          <div className="space-y-3">
            {filtered.map(ex => (
              <ExampleCard key={ex.id} ex={ex} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
