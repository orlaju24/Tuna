import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { type Position } from "@/hooks/usePositions";
import { usePrice } from "@/hooks/usePrice";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarginModal } from "./MarginModal";

// Pick a sensible base-asset precision for the order size based on the
// asset's price magnitude. BTC ($78k) → 4 dp; ETH ($2k) → 3 dp;
// SOL/BNB ($10–$1k) → 2 dp; DOGE/SHIB (< $1) → 0 dp. Bitunix will still
// reject if it's below the contract step, but this keeps the auto-conversion
// readable across the spread of assets we care about.
function sizeDecimals(price: number): number {
  if (price >= 10000) return 4;
  if (price >= 1000) return 3;
  if (price >= 10) return 2;
  if (price >= 1) return 1;
  return 0;
}

// Round to the nearest step (not floor) so a $5 order doesn't silently
// vanish to 0. Half-step rounding error is well below any user concern,
// and keeps small notional amounts actually placeable.
function roundToDp(n: number, dp: number): number {
  const factor = Math.pow(10, dp);
  return Math.round(n * factor) / factor;
}

type ActionStatus = {
  type: "idle" | "pending" | "verifying" | "success" | "still_open" | "no_position" | "error";
  message: string;
};

// ── Double-press confirmation hook ────────────────────────────────────────────
// Returns helpers for a two-tap confirmation pattern.
//   - First tap:  arm() → starts a 3-second countdown, returns false
//   - Second tap: arm() → fires immediately, returns true
//   - Expires:    resets automatically after TIMEOUT_MS
//   - cancel():   disarms without firing (call when the other button is pressed)

const CONFIRM_TIMEOUT_MS = 3000;
const TICK_MS = 50;
const TOTAL_TICKS = CONFIRM_TIMEOUT_MS / TICK_MS;

function useDoublePress(onConfirm: () => void) {
  const [armed, setArmed] = useState(false);
  const [progress, setProgress] = useState(0); // 0 = full bar, 1 = empty
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickCount = useRef(0);

  const disarm = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    tickCount.current = 0;
    setArmed(false);
    setProgress(0);
  }, []);

  // Clean up on unmount
  useEffect(() => () => { if (tickRef.current) clearInterval(tickRef.current); }, []);

  const press = useCallback(() => {
    if (armed) {
      disarm();
      onConfirm();
      return;
    }
    // Arm: start countdown
    setArmed(true);
    setProgress(0);
    tickCount.current = 0;
    tickRef.current = setInterval(() => {
      tickCount.current += 1;
      const p = tickCount.current / TOTAL_TICKS;
      setProgress(p);
      if (tickCount.current >= TOTAL_TICKS) {
        disarm();
      }
    }, TICK_MS);
  }, [armed, disarm, onConfirm]);

  return { armed, progress, press, cancel: disarm };
}

// ── Confirm button wrapper ─────────────────────────────────────────────────────
// Renders the button in normal state OR armed confirmation state.

function ConfirmButton({
  label,
  armed,
  progress,
  onPress,
  disabled,
  normalCls,
  armedCls,
  busy,
}: {
  label: string;
  armed: boolean;
  progress: number; // 0→1, how much has elapsed
  onPress: () => void;
  disabled: boolean;
  normalCls: string;   // tailwind classes for normal state
  armedCls: string;    // tailwind classes for armed state
  busy: boolean;
}) {
  const secsLeft = Math.ceil(((1 - progress) * CONFIRM_TIMEOUT_MS) / 1000);

  return (
    <button
      disabled={disabled}
      onClick={onPress}
      className={cn(
        "relative py-3 rounded-lg text-white font-bold text-sm disabled:opacity-40",
        "flex flex-col items-center justify-center gap-0.5 overflow-hidden",
        "transition-colors duration-150 select-none",
        armed ? armedCls : normalCls,
      )}
    >
      {/* Countdown drain bar — slides in from right as time elapses */}
      {armed && (
        <div
          className="absolute inset-0 bg-black/25 origin-right transition-none"
          style={{ transform: `scaleX(${progress})`, transformOrigin: "right" }}
        />
      )}

      <span className="relative z-10 leading-none">
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : armed ? (
          `Confirm? (${secsLeft}s)`
        ) : (
          label
        )}
      </span>
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function TradeActions({
  symbol,
  position,
}: {
  symbol: string;
  position: Position | null;
}) {
  const qc = useQueryClient();
  const livePrice = usePrice(symbol);
  const [status, setStatus] = useState<ActionStatus>({ type: "idle", message: "" });
  const [notionalUsdt, setNotionalUsdt] = useState("");
  const [marginOpen, setMarginOpen] = useState(false);

  // Convert the user's USDT input → base-asset size that Bitunix expects.
  const usdt = parseFloat(notionalUsdt);
  const dp = livePrice ? sizeDecimals(livePrice) : 4;
  const computedSize =
    usdt > 0 && livePrice && livePrice > 0 ? roundToDp(usdt / livePrice, dp) : 0;
  const hasValidSize = computedSize > 0;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["positions", symbol] });
    qc.invalidateQueries({ queryKey: ["events"] });
  };

  type CloseEnvelope = { code: number; msg: string; data: { status?: string } | null };

  const withStatus = async (fn: () => Promise<CloseEnvelope>) => {
    setStatus({ type: "pending", message: "Submitting…" });
    try {
      const res = await fn();
      if (res.code !== 0) {
        setStatus({ type: "error", message: res.msg || "Bitunix rejected the request" });
      } else {
        const closeStatus = res.data?.status;
        if (closeStatus === "confirmed_flat") {
          setStatus({ type: "success", message: "Position closed and confirmed flat ✓" });
        } else if (closeStatus === "still_open") {
          setStatus({ type: "still_open", message: "Close submitted — position still open, verify manually" });
        } else if (closeStatus === "no_position") {
          setStatus({ type: "no_position", message: "Nothing to close — no live position on Bitunix" });
        } else {
          setStatus({ type: "success", message: "Submitted ✓" });
        }
      }
      refresh();
    } catch (err) {
      setStatus({ type: "error", message: (err as Error).message });
    }
    setTimeout(() => setStatus({ type: "idle", message: "" }), 5000);
  };

  // ── Double-press guards ────────────────────────────────────────────────────

  const flashDp = useDoublePress(() =>
    withStatus(() =>
      api.post<CloseEnvelope>("/trade/flash-close", {
        symbol,
        positionId: position?.positionId,
      })
    )
  );

  const closeAllDp = useDoublePress(() =>
    withStatus(() => api.post<CloseEnvelope>("/trade/close-all", { symbol }))
  );

  // Pressing one button cancels the other's armed state
  const handleFlashPress = () => {
    closeAllDp.cancel();
    flashDp.press();
  };

  const handleCloseAllPress = () => {
    flashDp.cancel();
    closeAllDp.press();
  };

  const openPosition = async (side: "BUY" | "SELL") => {
    // Opening a position also cancels any armed close
    flashDp.cancel();
    closeAllDp.cancel();

    if (!livePrice) {
      setStatus({ type: "error", message: "Waiting on live price — try again in a moment" });
      setTimeout(() => setStatus({ type: "idle", message: "" }), 3000);
      return;
    }
    if (!hasValidSize) {
      setStatus({ type: "error", message: "Enter a USDT amount first" });
      setTimeout(() => setStatus({ type: "idle", message: "" }), 3000);
      return;
    }
    setStatus({ type: "pending", message: "Placing order…" });
    try {
      await api.post("/trade/open", { symbol, side, size: computedSize });
      setStatus({
        type: "success",
        message: `${side === "BUY" ? "Long" : "Short"} ${computedSize} placed ✓`,
      });
      setNotionalUsdt("");
      refresh();
    } catch (err) {
      setStatus({ type: "error", message: (err as Error).message });
    }
    setTimeout(() => setStatus({ type: "idle", message: "" }), 5000);
  };

  const busy = status.type === "pending" || status.type === "verifying";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-4">
      <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Trade Actions</div>

      {/* Open position */}
      <div>
        <div className="text-xs text-zinc-500 mb-2">Open Position</div>
        <div className="relative mb-2">
          <input
            type="number"
            min={0}
            step={1}
            inputMode="decimal"
            placeholder="Amount in USDT"
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-3 pr-14 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
            value={notionalUsdt}
            onChange={(e) => setNotionalUsdt(e.target.value)}
            disabled={busy}
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 font-semibold pointer-events-none">
            USDT
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mb-2 font-mono min-h-[14px]">
          {hasValidSize && livePrice ? (
            <>≈ {computedSize} {symbol.replace(/USDT$/, "")} @ {livePrice.toLocaleString(undefined, { maximumFractionDigits: 6 })}</>
          ) : usdt > 0 && !livePrice ? (
            <span className="text-yellow-500">Waiting for live price…</span>
          ) : usdt > 0 && livePrice && !hasValidSize ? (
            <span className="text-yellow-500">
              Amount too small — needs at least ≈ {(Math.pow(10, -dp) * livePrice).toFixed(2)} USDT
            </span>
          ) : (
            <span className="opacity-0">.</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            disabled={busy || !hasValidSize}
            onClick={() => openPosition("BUY")}
            className="py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm disabled:opacity-40"
          >
            Long
          </button>
          <button
            disabled={busy || !hasValidSize}
            onClick={() => openPosition("SELL")}
            className="py-3 rounded-lg bg-red-600 hover:bg-red-500 text-white font-bold text-sm disabled:opacity-40"
          >
            Short
          </button>
        </div>
      </div>

      {/* Manage position */}
      <div>
        <div className="text-xs text-zinc-500 mb-2">Manage Position</div>
        <button
          disabled={busy || !position}
          onClick={() => setMarginOpen(true)}
          className="w-full py-2.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-semibold disabled:opacity-40 mb-2"
        >
          Adjust Margin
        </button>
      </div>

      {/* Close controls — double-press guarded */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-zinc-500">Close Position</span>
          {(flashDp.armed || closeAllDp.armed) && (
            <span className="text-[10px] text-amber-400 font-mono animate-pulse">
              Tap again to confirm
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <ConfirmButton
            label="Flash Close"
            armed={flashDp.armed}
            progress={flashDp.progress}
            onPress={handleFlashPress}
            disabled={busy || (!position && !flashDp.armed)}
            normalCls="bg-orange-600 hover:bg-orange-500"
            armedCls="bg-orange-500 ring-2 ring-orange-400/60"
            busy={busy}
          />
          <ConfirmButton
            label="Close All"
            armed={closeAllDp.armed}
            progress={closeAllDp.progress}
            onPress={handleCloseAllPress}
            disabled={busy && !closeAllDp.armed}
            normalCls="bg-red-700 hover:bg-red-600"
            armedCls="bg-red-600 ring-2 ring-red-400/60"
            busy={busy}
          />
        </div>
      </div>

      {status.type !== "idle" && (
        <div
          className={cn(
            "text-xs text-center px-3 py-2 rounded-lg flex items-center justify-center gap-2",
            status.type === "success"   && "bg-emerald-900/40 text-emerald-400",
            status.type === "pending"   && "bg-blue-900/40 text-blue-400",
            status.type === "verifying" && "bg-blue-900/40 text-blue-400",
            status.type === "still_open" && "bg-yellow-900/40 text-yellow-400",
            status.type === "no_position" && "bg-zinc-800 text-zinc-400",
            status.type === "error"     && "bg-red-900/40 text-red-400"
          )}
        >
          {(status.type === "pending" || status.type === "verifying") && (
            <Loader2 size={12} className="animate-spin" />
          )}
          {(status.type === "still_open" || status.type === "no_position") && <AlertTriangle size={12} />}
          {status.message}
        </div>
      )}

      <MarginModal
        open={marginOpen}
        onClose={() => setMarginOpen(false)}
        symbol={symbol}
        position={position}
      />
    </div>
  );
}
