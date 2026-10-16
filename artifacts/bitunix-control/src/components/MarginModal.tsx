import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type Position } from "@/hooks/usePositions";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export function MarginModal({
  open,
  onClose,
  symbol,
  position,
}: {
  open: boolean;
  onClose: () => void;
  symbol: string;
  position: Position | null;
}) {
  const [amount, setAmount] = useState("");
  const [type, setType] = useState<"add" | "reduce">("add");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const qc = useQueryClient();

  const handleSubmit = async () => {
    if (!position || !amount || pending) return;
    setPending(true);
    setStatus("Submitting…");
    try {
      await api.post("/margin/adjust", {
        symbol,
        positionId: position.positionId,
        amount: parseFloat(amount),
        type,
      });
      await qc.invalidateQueries({ queryKey: ["positions", symbol] });
      setStatus("Margin adjusted ✓");
      setTimeout(() => {
        setStatus(null);
        onClose();
      }, 1500);
    } catch (err) {
      setStatus("Error: " + (err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-zinc-900 border-zinc-700 text-white max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-white">Adjust Margin — {symbol}</DialogTitle>
        </DialogHeader>

        {!position ? (
          <div className="text-sm text-zinc-500 py-4 text-center">No open position to adjust.</div>
        ) : (
          <div className="space-y-4">
            <div className="bg-zinc-800 rounded-lg p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Current Margin</span>
                <span className="font-mono text-white">{parseFloat(position.margin).toFixed(4)} USDT</span>
              </div>
              <div className="flex justify-between mt-1">
                <span className="text-zinc-400">Leverage</span>
                <span className="font-mono text-white">{position.leverage}x</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setType("add")}
                className={cn(
                  "py-2 rounded-lg text-sm font-semibold",
                  type === "add" ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"
                )}
              >
                + Add
              </button>
              <button
                onClick={() => setType("reduce")}
                className={cn(
                  "py-2 rounded-lg text-sm font-semibold",
                  type === "reduce" ? "bg-red-700 text-white" : "bg-zinc-800 text-zinc-400"
                )}
              >
                − Reduce
              </button>
            </div>

            <input
              type="number"
              min={0}
              step={0.01}
              placeholder="Amount (USDT)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={pending}
            />

            {status && <div className="text-xs text-center text-zinc-400">{status}</div>}

            <button
              disabled={pending || !amount}
              onClick={handleSubmit}
              className="w-full py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Confirm {type === "add" ? "Add" : "Reduce"} Margin
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
