import { usePositions, type Position } from "@/hooks/usePositions";
import { useLeverage } from "@/hooks/useLeverage";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect } from "react";

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-zinc-800 last:border-0">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className={cn("text-xs font-mono font-semibold", accent || "text-white")}>{value}</span>
    </div>
  );
}

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
  return n.toLocaleString(undefined, { maximumFractionDigits: 6, minimumFractionDigits: 2 });
}

function fmtUsdt(v: string | number | undefined | null, withSign = false): string {
  if (!isPresent(v)) return "—";
  const n = num(v as string | number);
  if (!Number.isFinite(n)) return "—";
  const sign = withSign && n >= 0 ? "+" : "";
  return sign + n.toFixed(4) + " USDT";
}

function fmtSize(v: string | number | undefined | null): string {
  if (!isPresent(v)) return "—";
  const n = num(v as string | number);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(6);
}

export function PositionCard({
  symbol,
  onPosition,
}: {
  symbol: string;
  onPosition: (p: Position | null) => void;
}) {
  const { data, isLoading, isError, error } = usePositions(symbol);
  const { data: leverageData } = useLeverage(symbol);

  const positions = Array.isArray(data?.data) ? data!.data! : [];
  const position = positions[0] ?? null;

  useEffect(() => {
    onPosition(position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position?.positionId, position?.qty, position?.unrealizedPNL]);

  const lev = leverageData?.data;

  // Margin ratio: prefer Bitunix-supplied marginRate; otherwise approximate
  // as |unrealized loss| / margin. If neither input is present, render `—`.
  let marginRatioText = "—";
  let marginRatioAccent = "text-white";
  if (position) {
    if (isPresent(position.marginRate)) {
      const mr = num(position.marginRate as string) * 100;
      if (Number.isFinite(mr)) {
        marginRatioText = mr.toFixed(2) + "%";
        marginRatioAccent =
          mr < 50 ? "text-emerald-400" : mr < 80 ? "text-amber-400" : "text-red-400";
      }
    } else if (isPresent(position.margin) && isPresent(position.unrealizedPNL)) {
      const m = num(position.margin);
      const u = num(position.unrealizedPNL);
      if (Number.isFinite(m) && m > 0 && Number.isFinite(u)) {
        const mr = (Math.max(0, -u) / m) * 100;
        marginRatioText = mr.toFixed(2) + "% (est)";
        marginRatioAccent =
          mr < 50 ? "text-emerald-400" : mr < 80 ? "text-amber-400" : "text-red-400";
      }
    }
  }

  const entry = position ? (position.entryPrice ?? position.avgOpenPrice) : undefined;
  const realized = position?.realizedPNL;
  const upnl = position?.unrealizedPNL;
  const upnlAccent = isPresent(upnl)
    ? num(upnl as string) >= 0
      ? "text-emerald-400"
      : "text-red-400"
    : "text-white";
  const realizedAccent = isPresent(realized)
    ? num(realized as string) >= 0
      ? "text-emerald-400"
      : "text-red-400"
    : "text-white";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Open Position</div>
        {position ? (
          <span
            className={cn(
              "text-xs font-bold px-2 py-0.5 rounded-full",
              position.side === "BUY" ? "bg-emerald-900 text-emerald-400" : "bg-red-900 text-red-400"
            )}
          >
            {position.side === "BUY" ? "LONG" : "SHORT"}
          </span>
        ) : (
          <span className="text-xs text-zinc-600 font-bold">FLAT</span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-6 w-full bg-zinc-800" />)}
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-red-400 text-xs">
          <AlertCircle size={14} />
          <span>{(error as Error).message}</span>
        </div>
      )}

      {!isLoading && !isError && !position && (
        <div className="text-center py-4 text-zinc-600 text-sm">No open position for {symbol}</div>
      )}

      {position && (
        <div>
          <Row label="Symbol" value={position.symbol} />
          <Row label="Size" value={fmtSize(position.qty)} />
          <Row label="Entry Price" value={fmtPrice(entry)} />
          {isPresent(position.markPrice) && (
            <Row label="Mark Price" value={fmtPrice(position.markPrice)} />
          )}
          <Row label="Position Margin" value={fmtUsdt(position.margin)} />
          <Row
            label="Unrealized PnL"
            value={fmtUsdt(upnl, true)}
            accent={upnlAccent}
          />
          <Row
            label="Realized PnL"
            value={fmtUsdt(realized, true)}
            accent={realizedAccent}
          />
          <Row
            label="Margin Ratio"
            value={marginRatioText}
            accent={marginRatioAccent}
          />
          {isPresent(position.liquidationPrice) && num(position.liquidationPrice as string) > 0 && (
            <Row label="Liq. Price" value={fmtPrice(position.liquidationPrice)} />
          )}
        </div>
      )}

      {lev && (
        <div className="mt-3 pt-3 border-t border-zinc-800 flex gap-4">
          <div>
            <div className="text-xs text-zinc-500">Leverage</div>
            <div className="text-sm font-bold text-white">
              {lev.longLeverage}x / {lev.shortLeverage}x
            </div>
          </div>
          <div>
            <div className="text-xs text-zinc-500">Margin Mode</div>
            <div className="text-sm font-bold text-white capitalize">{lev.marginMode?.toLowerCase() || "—"}</div>
          </div>
        </div>
      )}
    </div>
  );
}
