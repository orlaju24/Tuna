/**
 * Pre-Trade Plan Card — upload-driven expert feedback before entry.
 *
 * Workflow:
 *   1. User picks a chart screenshot (or pastes from clipboard).
 *   2. Optional: declare side/bias/note.
 *   3. "Analyze" sends image + metadata to the server, which uploads to App
 *      Storage and runs a vision model. Returns a structured plan.
 *   4. Plan is shown with channel-zone chip, agreement gauge, continuation
 *      bar, and a 2-3 sentence summary.
 *   5. The newest unconsumed plan for the symbol is automatically claimed
 *      by the next safeguard armed for that same symbol — surfacing in the
 *      Profit Safeguard card and folded into the live trail-width formula.
 */
import { useRef, useState, useMemo, useEffect } from "react";
import { Upload, Loader2, Image as ImageIcon, Trash2, Sparkles, X } from "lucide-react";
import {
  useLatestTradePlan,
  useUploadTradePlan,
  useDeleteTradePlan,
  type TradePlanRow,
} from "@/hooks/useTradePlan";
import { type Position } from "@/hooks/usePositions";
import { usePrice } from "@/hooks/usePrice";
import { cn } from "@/lib/utils";

const ZONE_CLS: Record<string, string> = {
  lower:   "bg-emerald-500/15 text-emerald-300",
  middle:  "bg-zinc-700/60 text-zinc-300",
  upper:   "bg-red-500/15 text-red-300",
  unknown: "bg-zinc-800 text-zinc-500",
};

const QUALITY_CLS: Record<string, string> = {
  strong: "text-violet-400",
  clean:  "text-emerald-400",
  mixed:  "text-zinc-400",
  weak:   "text-red-400",
};

const PATIENCE_CLS: Record<string, string> = {
  "very-patient": "text-violet-400",
  "patient":      "text-emerald-400",
  "standard":     "text-zinc-400",
  "tight":        "text-red-400",
};

const ACTION_CONFIG: Record<string, { label: string; cls: string; bg: string }> = {
  "enter":       { label: "ENTER",              cls: "text-emerald-300", bg: "bg-emerald-500/15 border-emerald-700/40" },
  "wait":        { label: "WAIT",               cls: "text-amber-300",   bg: "bg-amber-500/15 border-amber-700/40" },
  "stand-down":  { label: "STAND DOWN",         cls: "text-red-300",     bg: "bg-red-500/15 border-red-700/40" },
  "probe":       { label: "PROBE — Toss a Dwarf", cls: "text-cyan-300",  bg: "bg-cyan-500/10 border-cyan-700/40" },
};

function fmtAgreement(score: number | null): string {
  if (score == null) return "—";
  return score >= 0 ? `+${score}` : String(score);
}

function agreementColor(score: number | null): string {
  if (score == null) return "text-zinc-500";
  if (score >= 50) return "text-emerald-400";
  if (score >= 15) return "text-blue-400";
  if (score >= -15) return "text-zinc-400";
  if (score >= -50) return "text-yellow-400";
  return "text-red-400";
}

function planTrailDelta(plan: TradePlanRow): number {
  let d = ((plan.agreementScore ?? 0) / 100) * 2;
  if (plan.channelZone === "upper") d -= 0.5;
  else if (plan.channelZone === "lower") d += 0.25;
  if (plan.recommendedPatience === "tight") d -= 0.5;
  else if (plan.recommendedPatience === "very-patient") d += 0.5;
  return Math.max(-2.0, Math.min(2.5, d));
}

function PlanDisplay({ plan, onDelete }: { plan: TradePlanRow; onDelete: () => void }) {
  const score = plan.agreementScore ?? 0;
  const cont = plan.continuationProbPct ?? 0;
  const conf = plan.confidenceLevel ?? null;
  const delta = planTrailDelta(plan);
  const consumed = plan.consumedAt != null;
  const action = plan.likelyAction ?? null;
  const actionCfg = action ? ACTION_CONFIG[action] : null;
  const livePrice = usePrice(plan.symbol);

  // Live retrace progress: how far price has moved toward the expected zone.
  // Only meaningful when plan says "wait" and we have the anchor price.
  // Returns 0..∞ fraction (>= 0.80 means 80% of expected retrace done = zone reached).
  const retraceProgress: number | null = (() => {
    if (action !== "wait") return null;
    if (!plan.priceAtUpload || !plan.returnToZonePct || !livePrice) return null;
    const uploadPrice = parseFloat(plan.priceAtUpload);
    const retracePct  = parseFloat(plan.returnToZonePct);
    const bias        = plan.detectedBias;
    if (!uploadPrice || !retracePct || (bias !== "long" && bias !== "short")) return null;
    const movePct    = ((livePrice - uploadPrice) / uploadPrice) * 100;
    const signedMove = bias === "long" ? -movePct : movePct;
    return Math.max(0, signedMove / retracePct);
  })();

  // Position the agreement-gauge needle from -100..+100 into 0..100% of width
  const needlePct = ((score + 100) / 200) * 100;

  return (
    <div className="space-y-3">
      {/* Top row: zone chip + quality + delete */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          {plan.channelZone && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide",
                ZONE_CLS[plan.channelZone] ?? ZONE_CLS.unknown,
              )}
            >
              {plan.channelZone} zone
            </span>
          )}
          {plan.detectedBias && plan.detectedBias !== "unclear" && (
            <span className={cn(
              "text-[10px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wide",
              plan.detectedBias === "long" ? "bg-emerald-500/15 text-emerald-300"
                : plan.detectedBias === "short" ? "bg-red-500/15 text-red-300"
                : "bg-zinc-700/60 text-zinc-400",
            )}>
              {plan.detectedBias}
            </span>
          )}
          {plan.setupQuality && (
            <span className={cn(
              "text-[10px] uppercase font-bold tracking-wide",
              QUALITY_CLS[plan.setupQuality] ?? "text-zinc-500",
            )}>
              {plan.setupQuality}
            </span>
          )}
          {consumed && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-300 font-semibold uppercase tracking-wide">
              In use
            </span>
          )}
        </div>
        <button
          onClick={onDelete}
          className="text-zinc-600 hover:text-red-400"
          title="Delete this plan"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* ── Action signal banner — the image-to-self-trade decision ── */}
      {actionCfg && (
        <div className={cn(
          "rounded-lg border px-3 py-2 flex items-center justify-between gap-3",
          actionCfg.bg,
        )}>
          <div>
            <span className={cn("text-xs font-bold uppercase tracking-widest", actionCfg.cls)}>
              {actionCfg.label}
            </span>
            {action === "wait" && plan.returnToZoneNote && (
              <p className="text-[11px] text-amber-200/70 mt-0.5 leading-snug">
                {plan.returnToZoneNote}
              </p>
            )}
            {action === "stand-down" && plan.riskNote && (
              <p className="text-[11px] text-red-200/70 mt-0.5 leading-snug">
                {plan.riskNote}
              </p>
            )}
            {action === "probe" && (
              <p className="text-[11px] text-cyan-200/70 mt-0.5 leading-snug">
                Level not yet confirmed — use ~20% normal size to test it. Expect stop-outs; a failed probe proves the level.{plan.entryZoneNote ? ` ${plan.entryZoneNote}` : ""}
              </p>
            )}
          </div>
          {conf != null && (
            <div className="text-right flex-shrink-0">
              <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Confidence</div>
              <div className={cn(
                "font-mono font-bold text-sm",
                conf >= 70 ? "text-emerald-400"
                  : conf >= 50 ? "text-blue-400"
                  : conf >= 35 ? "text-zinc-400"
                  : "text-red-400",
              )}>
                {conf}<span className="text-zinc-600 text-[10px] font-normal">/100</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Agreement gauge: -100..+100 with needle */}
      <div>
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="text-zinc-500">Agreement</span>
          <span className={cn("font-mono font-bold", agreementColor(score))}>
            {fmtAgreement(score)}
          </span>
        </div>
        <div className="relative h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div className="absolute inset-y-0 left-0 right-1/2 bg-red-500/30" />
          <div className="absolute inset-y-0 left-1/2 right-0 bg-emerald-500/30" />
          <div className="absolute top-0 bottom-0 w-px bg-zinc-600 left-1/2" />
          <div
            className={cn(
              "absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full",
              score >= 0 ? "bg-emerald-400" : "bg-red-400",
            )}
            style={{ left: `calc(${needlePct}% - 4px)` }}
          />
        </div>
      </div>

      {/* Continuation probability bar */}
      <div>
        <div className="flex items-center justify-between text-[11px] mb-1">
          <span className="text-zinc-500">Continuation</span>
          <span className="font-mono text-zinc-300">{cont}%</span>
        </div>
        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full transition-all",
              cont >= 60 ? "bg-emerald-400" : cont >= 40 ? "bg-blue-400" : "bg-zinc-500",
            )}
            style={{ width: `${cont}%` }}
          />
        </div>
      </div>

      {/* Return-to-zone depth + live retrace progress meter */}
      {action === "wait" && plan.returnToZonePct != null && (
        <div className="bg-amber-900/10 border border-amber-800/20 rounded px-2.5 py-2 space-y-1.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-amber-400/80">Expected retrace</span>
            <span className="font-mono text-amber-300 font-semibold">
              ~{parseFloat(plan.returnToZonePct).toFixed(1)}%
            </span>
          </div>
          {retraceProgress !== null && (
            <>
              <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={cn(
                    "h-full transition-all duration-700",
                    retraceProgress >= 0.8 ? "bg-emerald-400"
                      : retraceProgress >= 0.4 ? "bg-amber-400"
                      : "bg-zinc-600",
                  )}
                  style={{ width: `${Math.min(100, retraceProgress * 100).toFixed(0)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-zinc-500 uppercase tracking-wide">Zone progress</span>
                <span className={cn(
                  "font-mono font-semibold",
                  retraceProgress >= 0.8 ? "text-emerald-400" : "text-amber-400/80",
                )}>
                  {Math.min(100, (retraceProgress * 100)).toFixed(0)}%
                  {retraceProgress >= 0.8 && " · zone reached"}
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {/* Patience + trail-delta */}
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div className="bg-zinc-800/60 rounded px-2 py-1.5">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wide">Patience</div>
          <div className={cn(
            "font-mono font-bold uppercase",
            PATIENCE_CLS[plan.recommendedPatience ?? ""] ?? "text-zinc-400",
          )}>
            {plan.recommendedPatience ?? "—"}
          </div>
        </div>
        <div className="bg-zinc-800/60 rounded px-2 py-1.5">
          <div className="text-zinc-500 text-[10px] uppercase tracking-wide">Trail bias</div>
          <div className={cn(
            "font-mono font-bold",
            delta > 0 ? "text-emerald-400" : delta < 0 ? "text-yellow-400" : "text-zinc-400",
          )}>
            {delta === 0 ? "neutral" : `${delta > 0 ? "+" : ""}${delta.toFixed(2)} pp`}
          </div>
        </div>
      </div>

      {/* Entry zone + invalidation zone */}
      {(plan.entryZoneNote || plan.invalidationZoneNote) && (
        <div className="space-y-1">
          {plan.entryZoneNote && (
            <div className="flex items-start gap-2 text-[11px]">
              <span className="text-zinc-600 flex-shrink-0 w-16 uppercase tracking-wide text-[10px] pt-0.5">Entry</span>
              <span className="text-zinc-300 leading-snug">{plan.entryZoneNote}</span>
            </div>
          )}
          {plan.invalidationZoneNote && (
            <div className="flex items-start gap-2 text-[11px]">
              <span className="text-zinc-600 flex-shrink-0 w-16 uppercase tracking-wide text-[10px] pt-0.5">Invalidate</span>
              <span className="text-red-300/80 leading-snug">{plan.invalidationZoneNote}</span>
            </div>
          )}
        </div>
      )}

      {/* Plain-language summary */}
      {plan.summary && (
        <div className="bg-zinc-800/40 border border-zinc-800 rounded px-2.5 py-2">
          <p className="text-[12px] text-zinc-300 leading-relaxed">{plan.summary}</p>
          {plan.pivotProximityNote && (
            <p className="text-[11px] text-zinc-500 italic leading-relaxed mt-1">
              Pivot: {plan.pivotProximityNote}
            </p>
          )}
          {plan.riskNote && action !== "stand-down" && (
            <p className="text-[11px] text-yellow-300/80 italic leading-relaxed mt-1">
              Risk: {plan.riskNote}
            </p>
          )}
        </div>
      )}

      {/* Thumbnail of the uploaded chart */}
      <div className="border border-zinc-800 rounded overflow-hidden bg-zinc-950">
        <img
          src={`/api/trade-plan/${plan.id}/image`}
          alt="uploaded chart"
          className="w-full max-h-48 object-contain"
        />
      </div>

      <div className="text-[10px] text-zinc-600 font-mono text-right">
        plan #{plan.id} · {new Date(plan.createdAt).toLocaleString([], {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        })}
      </div>
    </div>
  );
}

export function PreTradePlanCard({
  symbol,
  position,
}: {
  symbol: string;
  position: Position | null;
}) {
  const { data: latest } = useLatestTradePlan(symbol);
  const upload = useUploadTradePlan();
  const del = useDeleteTradePlan();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [userBias, setUserBias] = useState<"long" | "short" | "unclear" | "">("");
  const [note, setNote] = useState("");

  // Derive intended side from any open position so the model has the right context
  const side = useMemo<"LONG" | "SHORT" | undefined>(() => {
    if (!position) return undefined;
    return position.side === "BUY" ? "LONG" : "SHORT";
  }, [position]);

  useEffect(() => {
    if (!picked) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(picked);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [picked]);

  const handlePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setPicked(f);
  };

  const clearPicked = () => {
    setPicked(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleAnalyze = () => {
    if (!picked) return;
    upload.mutate(
      {
        file: picked,
        symbol,
        side,
        userBias: userBias || undefined,
        note: note || undefined,
      },
      {
        onSuccess: () => {
          clearPicked();
          setNote("");
        },
      },
    );
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-violet-400" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
            Entry Plan
          </span>
        </div>
        <span className="text-[10px] text-zinc-600">
          {latest?.consumedAt ? "claimed by safeguard" : latest ? "ready to claim" : "no plan yet"}
        </span>
      </div>

      {/* Latest plan (if any) */}
      {latest && (
        <PlanDisplay
          plan={latest}
          onDelete={() => del.mutate(latest.id)}
        />
      )}

      {/* Upload form — collapsed below the existing plan */}
      <div className={cn(
        "mt-3 pt-3 border-t border-zinc-800",
        !latest && "mt-0 pt-0 border-t-0",
      )}>
        {!picked && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full py-3 rounded-lg border border-dashed border-zinc-700 hover:border-zinc-500 text-zinc-500 hover:text-zinc-300 text-xs flex items-center justify-center gap-2 transition-colors"
          >
            <Upload size={14} />
            {latest ? "Upload a fresh chart" : "Upload chart screenshot"}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handlePick}
          className="hidden"
        />

        {picked && (
          <div className="space-y-3">
            <div className="relative bg-zinc-950 border border-zinc-800 rounded overflow-hidden">
              {previewUrl ? (
                <img src={previewUrl} alt="preview" className="w-full max-h-48 object-contain" />
              ) : (
                <div className="h-32 flex items-center justify-center text-zinc-600">
                  <ImageIcon size={24} />
                </div>
              )}
              <button
                onClick={clearPicked}
                className="absolute top-1 right-1 bg-black/60 hover:bg-black/80 rounded-full p-1 text-zinc-300"
                title="Remove"
              >
                <X size={12} />
              </button>
            </div>

            {/* Bias selector */}
            <div>
              <div className="text-[10px] text-zinc-500 mb-1.5 uppercase tracking-wide">
                Your bias {side ? `· position is ${side}` : "(no open position)"}
              </div>
              <div className="flex gap-1.5">
                {(["long", "short", "unclear"] as const).map((b) => (
                  <button
                    key={b}
                    onClick={() => setUserBias(userBias === b ? "" : b)}
                    className={cn(
                      "flex-1 py-1.5 rounded text-[11px] font-semibold transition-colors capitalize",
                      userBias === b
                        ? b === "long" ? "bg-emerald-600 text-white"
                          : b === "short" ? "bg-red-600 text-white"
                          : "bg-zinc-600 text-white"
                        : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700",
                    )}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              placeholder="Optional context (e.g. 'channel from yesterday')"
              rows={2}
              className="w-full text-[12px] bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 resize-none"
            />

            {upload.isError && (
              <div className="text-[11px] text-red-400 bg-red-950/40 border border-red-900/50 rounded px-2 py-1.5">
                {(upload.error as Error)?.message || "Upload failed"}
              </div>
            )}

            <button
              disabled={upload.isPending}
              onClick={handleAnalyze}
              className="w-full py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center justify-center gap-2"
            >
              {upload.isPending ? (
                <><Loader2 size={12} className="animate-spin" />Analyzing chart…</>
              ) : (
                <><Sparkles size={12} />Analyze</>
              )}
            </button>
          </div>
        )}

        <p className="text-[10px] text-zinc-600 italic mt-2">
          The next safeguard armed for {symbol} will adopt this plan and let it bend its trail.
        </p>
      </div>
    </div>
  );
}
