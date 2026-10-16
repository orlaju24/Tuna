import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Trash2, Plus } from "lucide-react";
import { type AwarenessWindow, DEFAULT_WINDOWS } from "@/lib/schedule";

export function ScheduleSettingsModal({
  open,
  onClose,
  windows,
  scheduleEnabled,
  onSave,
  onToggleSchedule,
}: {
  open: boolean;
  onClose: () => void;
  windows: AwarenessWindow[];
  scheduleEnabled: boolean;
  onSave: (windows: AwarenessWindow[]) => void;
  onToggleSchedule: (enabled: boolean) => void;
}) {
  const [draft, setDraft] = useState<AwarenessWindow[]>(windows);
  const [draftEnabled, setDraftEnabled] = useState<boolean>(scheduleEnabled);

  // Reset both drafts whenever the modal opens so cancelled edits don't
  // linger and the master switch behaves consistently with the window list
  // (both require Save to persist).
  useEffect(() => {
    if (open) {
      setDraft(windows);
      setDraftEnabled(scheduleEnabled);
    }
  }, [open, windows, scheduleEnabled]);

  const updateRow = (i: number, patch: Partial<AwarenessWindow>) => {
    setDraft((d) => d.map((w, idx) => (idx === i ? { ...w, ...patch } : w)));
  };

  const addRow = () => {
    setDraft((d) => [...d, { start: "12:00", end: "13:00", label: "" }]);
  };

  const removeRow = (i: number) => {
    setDraft((d) => d.filter((_, idx) => idx !== i));
  };

  const validate = (w: AwarenessWindow): boolean =>
    /^(\d{1,2}):\d{2}$/.test(w.start) && /^(\d{1,2}):\d{2}$/.test(w.end);

  const allValid = draft.every(validate);

  const handleSave = () => {
    if (!allValid) return;
    if (draftEnabled !== scheduleEnabled) onToggleSchedule(draftEnabled);
    onSave(draft);
    onClose();
  };

  const handleResetDefaults = () => {
    setDraft(DEFAULT_WINDOWS);
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="bg-zinc-900 border-zinc-700 text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white">Awareness Schedule (ET / Toronto)</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Master switch */}
          <div className="bg-zinc-800 rounded-lg p-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold text-white">Cost-aware mode</div>
              <div className="text-[11px] text-zinc-500 mt-0.5">
                Run the awareness gauge only during your critical windows below.
              </div>
            </div>
            <button
              onClick={() => setDraftEnabled((v) => !v)}
              className={`px-3 py-1 rounded-full text-xs font-semibold ${
                draftEnabled
                  ? "bg-emerald-900/40 text-emerald-400"
                  : "bg-zinc-700 text-zinc-400"
              }`}
            >
              {draftEnabled ? "ON" : "OFF"}
            </button>
          </div>

          {/* Windows list */}
          <div>
            <div className="text-xs text-zinc-500 mb-2 font-semibold uppercase tracking-wide">
              Critical windows
            </div>
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {draft.map((w, i) => {
                const valid = validate(w);
                return (
                  <div
                    key={i}
                    className={`bg-zinc-800 rounded-lg p-2 flex items-center gap-2 ${
                      valid ? "" : "ring-1 ring-red-700"
                    }`}
                  >
                    <input
                      type="text"
                      value={w.start}
                      onChange={(e) => updateRow(i, { start: e.target.value })}
                      placeholder="HH:MM"
                      className="w-16 bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none"
                    />
                    <span className="text-zinc-500 text-xs">→</span>
                    <input
                      type="text"
                      value={w.end}
                      onChange={(e) => updateRow(i, { end: e.target.value })}
                      placeholder="HH:MM"
                      className="w-16 bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none"
                    />
                    <input
                      type="text"
                      value={w.label || ""}
                      onChange={(e) => updateRow(i, { label: e.target.value })}
                      placeholder="Label (optional)"
                      className="flex-1 bg-zinc-700 border border-zinc-600 rounded px-2 py-1 text-xs text-white placeholder-zinc-500 focus:outline-none"
                    />
                    <button
                      onClick={() => removeRow(i)}
                      className="p-1 text-zinc-500 hover:text-red-400"
                      title="Remove"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })}
              {draft.length === 0 && (
                <div className="text-xs text-zinc-500 py-4 text-center">
                  No windows configured — awareness will stay quiet at all times.
                </div>
              )}
            </div>

            <button
              onClick={addRow}
              className="mt-2 w-full py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold flex items-center justify-center gap-1"
            >
              <Plus size={12} /> Add window
            </button>
          </div>

          {!allValid && (
            <div className="text-[11px] text-red-400">
              Times must be in HH:MM format (24h).
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              onClick={handleResetDefaults}
              className="flex-1 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-400 text-xs font-semibold"
            >
              Reset to defaults
            </button>
            <button
              onClick={handleSave}
              disabled={!allValid}
              className="flex-1 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-semibold"
            >
              Save
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
