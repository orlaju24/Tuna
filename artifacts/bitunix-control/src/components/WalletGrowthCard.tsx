/**
 * Wallet Growth Card
 *
 * Shows cumulative performance from the system's safeguard-protected trade
 * history — the "wallet increaser" scoreboard. Only safeguard-managed exits
 * are counted: these are the trades the system actively held and protected.
 *
 * Image-guided win rate is shown separately so the user can see whether
 * chart uploads improve outcomes.
 *
 * Returns null until at least one protected trade exists — no empty state.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

interface WalletSummary {
  totalTrades: number;
  protectedTrades: number;
  winCount: number;
  winRate: number | null;
  avgExitRoiPct: number;
  avgRatchetCount: number;
  uploadGuidedTrades: number;
  uploadGuidedWinRate: number | null;
}

function useWalletSummary(symbol: string) {
  return useQuery<WalletSummary>({
    queryKey: ["wallet-summary", symbol],
    queryFn: () => api.get<WalletSummary>(`/journal/wallet-summary?symbol=${symbol}`),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

function fmtPct(n: number | null | undefined) {
  if (n == null) return "—";
  return `${(n * 100).toFixed(0)}%`;
}
function fmtRoi(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function fmtRatchet(n: number) {
  return n.toFixed(1);
}

function WinRateBar({ rate }: { rate: number }) {
  const pct = Math.round(rate * 100);
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 50 ? "bg-blue-500" : "bg-red-500";
  return (
    <div className="mt-1 h-1 rounded-full bg-zinc-800 overflow-hidden">
      <div className={cn("h-full rounded-full transition-all duration-700", color)}
        style={{ width: `${pct}%` }} />
    </div>
  );
}

export function WalletGrowthCard({ symbol }: { symbol: string }) {
  const { data } = useWalletSummary(symbol);

  if (!data || data.protectedTrades === 0) return null;

  const winRate = data.winRate;
  const winColor = winRate == null ? "text-zinc-500"
    : winRate >= 0.7  ? "text-emerald-400"
    : winRate >= 0.5  ? "text-blue-400"
    : "text-red-400";

  const roiColor = data.avgExitRoiPct >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2.5">
        <span className="text-sm font-semibold text-zinc-200">Wallet Performance</span>
        <span className="text-[10px] text-zinc-600 font-mono uppercase tracking-wide">
          {data.protectedTrades} protected · {data.totalTrades} total
        </span>
      </div>

      {/* Main stats grid */}
      <div className="grid grid-cols-2 gap-2 mb-2">
        {/* Win rate */}
        <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
          <div className="text-[10px] text-zinc-600 uppercase tracking-wide mb-0.5">Win Rate</div>
          <div className={cn("text-xl font-bold font-mono", winColor)}>
            {fmtPct(winRate)}
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">
            {data.winCount} / {data.protectedTrades} exits
          </div>
          {winRate != null && <WinRateBar rate={winRate} />}
        </div>

        {/* Avg exit ROI */}
        <div className="bg-zinc-800/50 rounded-lg px-3 py-2">
          <div className="text-[10px] text-zinc-600 uppercase tracking-wide mb-0.5">Avg Exit ROI</div>
          <div className={cn("text-xl font-bold font-mono", roiColor)}>
            {fmtRoi(data.avgExitRoiPct)}
          </div>
          <div className="text-[10px] text-zinc-600 mt-0.5">
            avg ladder: {fmtRatchet(data.avgRatchetCount)} ratchets
          </div>
        </div>
      </div>

      {/* Image-guided breakdown — only shown when uploads have been used */}
      {data.uploadGuidedTrades > 0 && (
        <div className="flex items-center justify-between text-[11px] pt-2 border-t border-zinc-800/60">
          <span className="text-zinc-500">
            Image-guided win rate
            <span className="text-zinc-700 ml-1">({data.uploadGuidedTrades} trades)</span>
          </span>
          <span className={cn(
            "font-mono font-semibold",
            data.uploadGuidedWinRate != null && data.uploadGuidedWinRate >= 0.6
              ? "text-emerald-400"
              : "text-zinc-400",
          )}>
            {fmtPct(data.uploadGuidedWinRate)}
          </span>
        </div>
      )}

      {/* Subtle footer */}
      <div className="mt-1.5 text-[9px] text-zinc-700 italic">
        Safeguard-protected exits only — trigger-only and manual closes excluded.
      </div>
    </div>
  );
}
