import { useAccount } from "@/hooks/useAccount";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle } from "lucide-react";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-1.5 border-b border-zinc-800 last:border-0">
      <span className="text-xs text-zinc-500">{label}</span>
      <span className="text-xs font-mono font-semibold text-white">{value}</span>
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

function fmtUsdt(v: string | number | undefined | null, withSign = false): string {
  if (!isPresent(v)) return "—";
  const n = num(v as string | number);
  if (!Number.isFinite(n)) return "—";
  const sign = withSign && n >= 0 ? "+" : "";
  return sign + n.toFixed(4) + " USDT";
}

export function AccountCard() {
  const { data, isLoading, isError, error } = useAccount();
  const account = data?.data;

  // Total Equity is a derived value: only show it if all required inputs exist
  let equityText = "—";
  let upnlText = "—";
  if (account) {
    const fields = [
      account.available,
      account.frozen,
      account.margin,
      account.crossUnrealizedPNL,
      account.isolationUnrealizedPNL,
    ];
    if (fields.every(isPresent)) {
      const equity =
        num(account.available) +
        num(account.frozen) +
        num(account.margin) +
        num(account.crossUnrealizedPNL) +
        num(account.isolationUnrealizedPNL);
      if (Number.isFinite(equity)) {
        equityText = equity.toFixed(4) + " USDT";
      }
    }
    if (isPresent(account.crossUnrealizedPNL) && isPresent(account.isolationUnrealizedPNL)) {
      const upnl = num(account.crossUnrealizedPNL) + num(account.isolationUnrealizedPNL);
      if (Number.isFinite(upnl)) {
        upnlText = (upnl >= 0 ? "+" : "") + upnl.toFixed(4) + " USDT";
      }
    }
  }

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide mb-3">Account (USDT)</div>

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-6 w-full bg-zinc-800" />
          ))}
        </div>
      )}

      {isError && (
        <div className="flex items-center gap-2 text-red-400 text-xs">
          <AlertCircle size={14} />
          <span>{(error as Error).message || "Failed to load account"}</span>
        </div>
      )}

      {!isLoading && !isError && !account && (
        <div className="text-xs text-zinc-500">No account data returned from Bitunix.</div>
      )}

      {account && (
        <div>
          <Row label="Available" value={fmtUsdt(account.available)} />
          <Row label="Used Margin" value={fmtUsdt(account.margin)} />
          <Row label="Frozen" value={fmtUsdt(account.frozen)} />
          <Row label="Equity (calc)" value={equityText} />
          <Row label="Unrealized PnL" value={upnlText} />
          <Row label="Position Mode" value={account.positionMode || "—"} />
        </div>
      )}
    </div>
  );
}
