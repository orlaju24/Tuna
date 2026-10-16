import { AlertCircle, ShieldCheck } from "lucide-react";
import { ProfitSafeguardCard } from "@/components/ProfitSafeguardCard";
import { useAllOpenPositions, type Position } from "@/hooks/usePositions";

function isOpenPosition(position: Position): boolean {
  const quantity = Number(position.qty);
  return Boolean(
    position.symbol &&
    Number.isFinite(quantity) &&
    Math.abs(quantity) > 0,
  );
}

export function OpenPositionSafeguards({
  selectedSymbol,
  selectedPosition,
}: {
  selectedSymbol: string;
  selectedPosition: Position | null;
}) {
  const { data, isLoading, isError, error } = useAllOpenPositions();
  const livePositions = Array.isArray(data?.data)
    ? data.data.filter(isOpenPosition)
    : [];
  const displayedPositions =
    livePositions.length > 0
      ? livePositions
      : (isLoading || isError) && selectedPosition
        ? [selectedPosition]
        : [];

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-2">
          <ShieldCheck size={14} className="text-blue-400" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">
            Stepped Protection
          </h2>
        </div>
        {!isError && (
          <span className="text-[10px] text-zinc-500">
            {isLoading && livePositions.length === 0
              ? "checking positions…"
              : `${livePositions.length} open position${livePositions.length === 1 ? "" : "s"}`}
          </span>
        )}
      </div>

      {isError && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>
            Could not load the complete open-position list. The selected position may still be shown below.
            {(error as Error)?.message ? ` ${(error as Error).message}` : ""}
          </span>
        </div>
      )}

      {livePositions.some((position) => !position.positionId) && (
        <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2 text-[11px] text-amber-200">
          Bitunix did not return an ID for one or more open positions. Those positions are visible but cannot be safely armed.
        </div>
      )}

      {isLoading && displayedPositions.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-5 text-center text-xs text-zinc-500">
          Loading open positions…
        </div>
      )}

      {displayedPositions.length > 0 ? (
        <div className="space-y-2">
          {displayedPositions.map((position) => (
            <ProfitSafeguardCard
              key={position.positionId || `${position.symbol}-${position.side}`}
              symbol={position.symbol}
              position={position}
              openPositions={livePositions.length > 0 ? livePositions : displayedPositions}
            />
          ))}
        </div>
      ) : (
        !isLoading && !isError && (
          <ProfitSafeguardCard
            symbol={selectedSymbol}
            position={null}
            openPositions={[]}
          />
        )
      )}
    </section>
  );
}
