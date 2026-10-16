import { usePrice } from "@/hooks/usePrice";
import { type Position } from "@/hooks/usePositions";
import { cn } from "@/lib/utils";

function isPresent(v: string | number | undefined | null): boolean {
  return v !== undefined && v !== null && v !== "";
}

function num(v: string | number): number {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function fmtPrice(v: string | number | undefined | null): string {
  if (!isPresent(v)) return "—";
  const n = num(v as string | number);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function fmtPnl(v: string | number | undefined | null): { text: string; positive: boolean | null } {
  if (!isPresent(v)) return { text: "—", positive: null };
  const n = num(v as string | number);
  if (!Number.isFinite(n)) return { text: "—", positive: null };
  return {
    text: (n >= 0 ? "+" : "") + n.toFixed(4),
    positive: n >= 0,
  };
}

export function PairSummaryCard({
  symbol,
  position,
}: {
  symbol: string;
  position: Position | null;
}) {
  const price = usePrice(symbol);
  const entry = position?.entryPrice ?? position?.avgOpenPrice;
  const pnl = fmtPnl(position?.unrealizedPNL);
  const qty = isPresent(position?.qty) ? num(position!.qty).toFixed(4) : "—";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-zinc-500 uppercase tracking-wide">Selected Pair</div>
          <div className="text-2xl font-bold text-white mt-0.5">{symbol || "—"}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-zinc-500">Live Market Price</div>
          <div className="text-2xl font-mono font-bold text-emerald-400 mt-0.5">
            {price !== null
              ? price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
              : <span className="text-zinc-600 animate-pulse">…</span>}
          </div>
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-zinc-800 flex items-center gap-2">
        {position ? (
          <>
            <span
              className={cn(
                "text-xs font-semibold px-2 py-0.5 rounded-full",
                position.side === "BUY"
                  ? "bg-emerald-900 text-emerald-400"
                  : "bg-red-900 text-red-400"
              )}
            >
              {position.side === "BUY" ? "LONG" : "SHORT"}
            </span>
            <span className="text-xs text-zinc-400">
              {qty} @ {fmtPrice(entry)}
            </span>
            <span className={cn(
              "ml-auto text-xs font-mono font-semibold",
              pnl.positive === null
                ? "text-zinc-400"
                : pnl.positive
                ? "text-emerald-400"
                : "text-red-400"
            )}>
              PnL {pnl.text}
            </span>
          </>
        ) : (
          <span className="text-xs text-zinc-500">FLAT — no open position</span>
        )}
      </div>
    </div>
  );
}
