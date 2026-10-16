import { useState } from "react";
import { useLeverage } from "@/hooks/useLeverage";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Loader2 } from "lucide-react";

export function LeverageControl({ symbol }: { symbol: string }) {
  const { data, isLoading } = useLeverage(symbol);
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [customVal, setCustomVal] = useState("");

  const current = data?.data?.longLeverage ?? null;

  const setLeverage = async (lev: number) => {
    if (!symbol || pending) return;
    setPending(true);
    setStatus("Submitting…");
    try {
      await api.post("/leverage", { symbol, leverage: lev });
      await qc.invalidateQueries({ queryKey: ["leverage", symbol] });
      setStatus("Verified ✓");
    } catch (err) {
      setStatus("Error: " + (err as Error).message);
    } finally {
      setPending(false);
      setTimeout(() => setStatus(null), 3000);
    }
  };

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Leverage</div>
        {isLoading ? (
          <Loader2 size={14} className="animate-spin text-zinc-500" />
        ) : (
          <span className="text-sm font-bold text-white">{current !== null ? `${current}x` : "—"}</span>
        )}
      </div>

      <div className="flex gap-2">
        <input
          type="number"
          min={1}
          max={200}
          placeholder="Custom…"
          className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
          value={customVal}
          onChange={(e) => setCustomVal(e.target.value)}
          disabled={pending}
        />
        <button
          disabled={pending || !customVal}
          onClick={() => {
            const v = parseInt(customVal);
            if (v > 0) setLeverage(v);
          }}
          className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40"
        >
          Set
        </button>
      </div>

      {status && (
        <div className="mt-2 text-xs text-center text-zinc-400">{status}</div>
      )}
    </div>
  );
}
