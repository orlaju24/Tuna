import { useState } from "react";
import { useTriggers, useCreateTrigger, useArmTrigger, useDisarmTrigger, useDeleteTrigger } from "@/hooks/useTriggers";
import { Loader2, Target, Trash2, Shield, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_COLORS: Record<string, string> = {
  draft: "text-zinc-500",
  armed: "text-blue-400",
  watching: "text-blue-400",
  triggered: "text-yellow-400",
  closing: "text-orange-400",
  verifying: "text-orange-400",
  completed: "text-emerald-400",
  failed: "text-red-400",
  cancelled: "text-zinc-600",
};

export function TriggerPanel({ symbol }: { symbol: string }) {
  const { data: triggers = [], isLoading } = useTriggers();
  const create = useCreateTrigger();
  const arm = useArmTrigger();
  const disarm = useDisarmTrigger();
  const del = useDeleteTrigger();

  const [form, setForm] = useState({
    triggerPrice: "",
    direction: "cross_below",
    closeMethod: "flash_close",
  });
  const [formVisible, setFormVisible] = useState(false);

  const handleCreate = () => {
    if (!form.triggerPrice) return;
    create.mutate(
      {
        symbol,
        triggerPrice: form.triggerPrice,
        direction: form.direction,
        closeMethod: form.closeMethod,
      },
      { onSuccess: () => setForm({ triggerPrice: "", direction: "cross_below", closeMethod: "flash_close" }) }
    );
  };

  const symbolTriggers = triggers.filter((t) => t.symbol === symbol);

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Target size={14} className="text-zinc-400" />
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">Trigger Exit</span>
        </div>
        <button
          className="text-xs text-blue-400 hover:text-blue-300"
          onClick={() => setFormVisible((v) => !v)}
        >
          {formVisible ? "Cancel" : "+ New"}
        </button>
      </div>

      {formVisible && (
        <div className="space-y-3 mb-4 bg-zinc-800 rounded-lg p-3">
          <div className="text-xs text-zinc-400 font-semibold">{symbol}</div>
          <div className="relative">
            <input
              type="number"
              inputMode="decimal"
              placeholder="Trigger price"
              className="w-full bg-zinc-700 border border-zinc-600 rounded-lg pl-3 pr-14 py-2 text-sm text-white placeholder-zinc-500 focus:outline-none"
              value={form.triggerPrice}
              onChange={(e) => setForm((f) => ({ ...f, triggerPrice: e.target.value }))}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-500 font-semibold pointer-events-none">
              USDT
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select
              className="bg-zinc-700 border border-zinc-600 rounded-lg px-2 py-2 text-sm text-white focus:outline-none"
              value={form.direction}
              onChange={(e) => setForm((f) => ({ ...f, direction: e.target.value }))}
            >
              <option value="cross_below">Cross Below</option>
              <option value="cross_above">Cross Above</option>
            </select>
            <select
              className="bg-zinc-700 border border-zinc-600 rounded-lg px-2 py-2 text-sm text-white focus:outline-none"
              value={form.closeMethod}
              onChange={(e) => setForm((f) => ({ ...f, closeMethod: e.target.value }))}
            >
              <option value="flash_close">Flash Close</option>
              <option value="close_all">Close All</option>
            </select>
          </div>
          <button
            disabled={create.isPending || !form.triggerPrice}
            onClick={handleCreate}
            className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {create.isPending && <Loader2 size={12} className="animate-spin" />}
            Create Trigger (Disarmed)
          </button>
        </div>
      )}

      {isLoading && <div className="text-xs text-zinc-500">Loading…</div>}

      {!isLoading && symbolTriggers.length === 0 && (
        <div className="text-xs text-zinc-600 text-center py-3">No triggers for {symbol}</div>
      )}

      <div className="space-y-2">
        {symbolTriggers.map((t) => (
          <div key={t.id} className="bg-zinc-800 rounded-lg p-3">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-zinc-300 font-mono font-semibold">
                  {t.direction === "cross_below" ? "↓ Below" : "↑ Above"}{" "}
                  {parseFloat(t.triggerPrice).toLocaleString(undefined, { maximumFractionDigits: 4 })}
                </div>
                <div className="text-xs text-zinc-500 mt-0.5">
                  {t.closeMethod === "flash_close" ? "Flash Close" : "Close All"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("text-xs font-semibold capitalize", STATUS_COLORS[t.watcherStatus] || "text-zinc-400")}>
                  {t.watcherStatus}
                </span>
                {t.armed ? (
                  <button
                    disabled={disarm.isPending}
                    onClick={() => disarm.mutate(t.id)}
                    className="text-yellow-500 hover:text-yellow-400"
                    title="Disarm"
                  >
                    <ShieldOff size={14} />
                  </button>
                ) : (
                  <button
                    disabled={arm.isPending || t.watcherStatus === "completed" || t.watcherStatus === "failed"}
                    onClick={() => arm.mutate(t.id)}
                    className="text-blue-400 hover:text-blue-300 disabled:opacity-40"
                    title="Arm"
                  >
                    <Shield size={14} />
                  </button>
                )}
                <button
                  disabled={del.isPending}
                  onClick={() => del.mutate(t.id)}
                  className="text-zinc-600 hover:text-red-400"
                  title="Delete"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
            {t.lastError && (
              <div className="mt-1 text-xs text-red-400 truncate">{t.lastError}</div>
            )}
            {t.triggeredAt && (
              <div className="mt-1 text-xs text-zinc-500">
                Triggered {new Date(t.triggeredAt).toLocaleTimeString()}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
