import { useState } from "react";
import { useEventLog } from "@/hooks/useEventLog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

const TYPE_COLOR: Record<string, string> = {
  // Flash Close / manual exits
  flash_close:             "text-orange-400 bg-orange-400/10",
  flash_close_confirmed:   "text-emerald-400 bg-emerald-400/10",
  flash_close_error:       "text-red-400 bg-red-400/10",
  flash_close_pending:     "text-yellow-400 bg-yellow-400/10",
  close_all:               "text-orange-400 bg-orange-400/10",
  close_all_confirmed:     "text-emerald-400 bg-emerald-400/10",
  close_all_error:         "text-red-400 bg-red-400/10",
  close_all_pending:       "text-yellow-400 bg-yellow-400/10",
  open_position:           "text-emerald-400 bg-emerald-400/10",
  // Triggers
  trigger_armed:                    "text-blue-400 bg-blue-400/10",
  trigger_disarmed:                 "text-zinc-400 bg-zinc-400/10",
  trigger_fired:                    "text-yellow-400 bg-yellow-400/10",
  trigger_completed:                "text-emerald-400 bg-emerald-400/10",
  trigger_failed:                   "text-red-400 bg-red-400/10",
  trigger_error:                    "text-red-400 bg-red-400/10",
  trigger_absorbed_momentum_ok:     "text-cyan-400 bg-cyan-400/10",
  trigger_allowed_momentum_fading:  "text-orange-400 bg-orange-400/10",
  trigger_converted_to_floor:       "text-violet-400 bg-violet-400/10",
  trigger_floor_rejected:           "text-zinc-500 bg-zinc-500/10",
  trigger_floor_skipped:            "text-zinc-500 bg-zinc-500/10",
  watcher_connected:                "text-blue-400 bg-blue-400/10",
  // Safeguard
  safeguard_armed:                  "text-indigo-400 bg-indigo-400/10",
  safeguard_protecting:             "text-cyan-400 bg-cyan-400/10",
  safeguard_ratchet:                "text-violet-400 bg-violet-400/10",
  safeguard_triggered:              "text-yellow-300 bg-yellow-300/10",
  safeguard_completed:              "text-emerald-300 bg-emerald-300/10",
  safeguard_failed:                 "text-red-400 bg-red-400/10",
  safeguard_error:                  "text-red-400 bg-red-400/10",
  safeguard_created:                "text-indigo-400 bg-indigo-400/10",
  safeguard_disarmed:               "text-zinc-400 bg-zinc-400/10",
  safeguard_method_changed:         "text-zinc-400 bg-zinc-400/10",
  safeguard_plan_linked:            "text-indigo-300 bg-indigo-300/10",
  safeguard_floor_set:              "text-violet-400 bg-violet-400/10",
  // Momentum gate events
  safeguard_retrace_held:           "text-cyan-300 bg-cyan-300/10",
  safeguard_momentum_failed:        "text-orange-400 bg-orange-400/10",
  safeguard_hold_expired:           "text-amber-400 bg-amber-400/10",
  // Auto-entry governance states
  auto_entry_opened:       "text-emerald-400 bg-emerald-400/10",
  auto_entry_rejected:     "text-red-400 bg-red-400/10",
  cooldown_started:        "text-amber-400 bg-amber-400/10",
  freeze_activated:        "text-red-300 bg-red-300/10",
  freeze_lifted:           "text-emerald-300 bg-emerald-300/10",
  walk_away_engaged:       "text-amber-300 bg-amber-300/10",
  walk_away_lifted:        "text-blue-300 bg-blue-300/10",
};

/** Human-readable label map aligned with the PDF governance document. */
const FRIENDLY_LABEL: Record<string, string> = {
  // Exits
  flash_close:             "Flash Close",
  flash_close_confirmed:   "Flash Close Confirmed",
  flash_close_error:       "Flash Close Error",
  flash_close_pending:     "Flash Close Pending",
  close_all:               "Close All",
  close_all_confirmed:     "Close All Confirmed",
  close_all_error:         "Close All Error",
  close_all_pending:       "Close All Pending",
  open_position:           "Position Opened",
  // Triggers
  trigger_armed:                    "Trigger Armed",
  trigger_disarmed:                 "Trigger Disarmed",
  trigger_fired:                    "Trigger Exit",
  trigger_completed:                "Trigger Exit Confirmed",
  trigger_failed:                   "Trigger Exit Failed",
  trigger_error:                    "Trigger Error",
  trigger_absorbed_momentum_ok:     "Trigger Absorbed — Momentum OK",
  trigger_allowed_momentum_fading:  "Trigger Allowed — Momentum Fading",
  trigger_converted_to_floor:       "Trigger → Profit Floor",
  trigger_floor_rejected:           "Trigger Floor Rejected",
  trigger_floor_skipped:            "Floor Already Tighter",
  watcher_connected:                "Watcher Connected",
  // Safeguard / Protect Profit
  safeguard_armed:                  "Protect Profit Armed",
  safeguard_protecting:             "Protect Profit Active",
  safeguard_ratchet:                "Protect Profit Ratchet",
  safeguard_triggered:              "Protect Profit Triggered",
  safeguard_completed:              "Protect Profit Confirmed",
  safeguard_failed:                 "Protect Profit Failed",
  safeguard_error:                  "Protect Profit Error",
  safeguard_created:                "Protect Profit Created",
  safeguard_disarmed:               "Protect Profit Disarmed",
  safeguard_method_changed:         "Close Method Changed",
  safeguard_plan_linked:            "Plan Linked to Protect Profit",
  safeguard_floor_set:              "Profit Floor Established",
  // Momentum gate
  safeguard_retrace_held:           "Retrace Held — Momentum Intact",
  safeguard_momentum_failed:        "Momentum Failed — Closing",
  safeguard_hold_expired:           "Hold Window Expired — Closing",
  // Auto-entry governance
  auto_entry_opened:       "Auto Entry Approved",
  auto_entry_rejected:     "Auto Entry Rejected",
  cooldown_started:        "Cooldown Started",
  freeze_activated:        "Freeze Activated",
  freeze_lifted:           "Freeze Lifted",
  walk_away_engaged:       "Walk Away",
  walk_away_lifted:        "Resumed",
};

function friendlyType(type: string): string {
  if (type in FRIENDLY_LABEL) return FRIENDLY_LABEL[type];
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

type Filter = "all" | "trigger" | "safeguard" | "exec";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all",      label: "All" },
  { key: "trigger",  label: "Trigger" },
  { key: "safeguard",label: "Guard" },
  { key: "exec",     label: "Exec" },
];

function matchesFilter(type: string, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "trigger")
    return type.startsWith("trigger_") || type.startsWith("watcher_");
  if (filter === "safeguard") return type.startsWith("safeguard_");
  if (filter === "exec")
    return (
      type.startsWith("flash_close") ||
      type.startsWith("close_all") ||
      type === "open_position"
    );
  return true;
}

export function EventLog() {
  const { data: events = [], isLoading } = useEventLog(80);
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = events.filter((e) => matchesFilter(e.eventType, filter));

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          Event Log
          {filtered.length > 0 && (
            <span className="ml-2 font-mono font-normal text-zinc-600 normal-case tracking-normal">
              {filtered.length}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-full font-medium transition-colors",
                filter === f.key
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading && <div className="text-xs text-zinc-500 py-2">Loading…</div>}

      <ScrollArea className="h-72">
        <div className="space-y-0.5 pr-1">
          {filtered.length === 0 && !isLoading && (
            <div className="text-xs text-zinc-600 text-center py-4">No events</div>
          )}
          {filtered.map((e) => {
            const colorClass = TYPE_COLOR[e.eventType] || "text-zinc-400 bg-zinc-400/10";
            return (
              <div
                key={e.id}
                className="rounded-lg px-2.5 py-2 hover:bg-zinc-800/50 transition-colors"
              >
                {/* Row 1: timestamp + type badge */}
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] text-zinc-600 font-mono shrink-0">
                    {new Date(e.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span
                    className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded font-semibold shrink-0 leading-none",
                      colorClass
                    )}
                  >
                    {friendlyType(e.eventType)}
                  </span>
                </div>
                {/* Row 2: full message — wraps naturally */}
                <p className="text-[12px] text-zinc-300 leading-snug break-words whitespace-pre-wrap pl-0.5">
                  {e.eventMessage}
                </p>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
