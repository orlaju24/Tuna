import { useEffect, useState, useCallback } from "react";
import {
  evaluateSchedule,
  loadWindows,
  loadScheduleEnabled,
  saveWindows,
  saveScheduleEnabled,
  type AwarenessWindow,
  type ScheduleStatus,
} from "@/lib/schedule";

// Re-evaluate the awareness schedule on a slow tick. 30s is plenty — windows
// are minute-resolution, and we don't want to thrash React on every render.
const TICK_MS = 30_000;
const WINDOWS_EVENT = "bitunix:awarenessWindowsChanged";

function compute(): ScheduleStatus {
  return evaluateSchedule(new Date(), loadWindows(), loadScheduleEnabled());
}

export function useScheduleStatus(): {
  status: ScheduleStatus;
  windows: AwarenessWindow[];
  setWindows: (w: AwarenessWindow[]) => void;
  setScheduleEnabled: (enabled: boolean) => void;
} {
  const [status, setStatus] = useState<ScheduleStatus>(compute);
  const [windows, setWindowsState] = useState<AwarenessWindow[]>(loadWindows);

  useEffect(() => {
    const id = setInterval(() => setStatus(compute()), TICK_MS);
    // Also re-evaluate when settings change so the UI flips immediately
    // instead of waiting for the next tick.
    const handler = () => {
      setWindowsState(loadWindows());
      setStatus(compute());
    };
    window.addEventListener(WINDOWS_EVENT, handler);
    return () => {
      clearInterval(id);
      window.removeEventListener(WINDOWS_EVENT, handler);
    };
  }, []);

  const setWindows = useCallback((w: AwarenessWindow[]) => {
    saveWindows(w);
    setWindowsState(w);
    setStatus(compute());
    window.dispatchEvent(new CustomEvent(WINDOWS_EVENT));
  }, []);

  const setScheduleEnabled = useCallback((enabled: boolean) => {
    saveScheduleEnabled(enabled);
    setStatus(compute());
    window.dispatchEvent(new CustomEvent(WINDOWS_EVENT));
  }, []);

  return { status, windows, setWindows, setScheduleEnabled };
}
