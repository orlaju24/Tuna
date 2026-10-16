// Awareness scheduler — controls when the Signal Awareness gauge polls the
// backend. The PDF cost-aware spec is explicit: scan only during the user's
// critical ET (Toronto) windows; stay quiet otherwise. Walk-away, triggers,
// price stream, and protection state are independent of this and stay live.

const WINDOWS_STORAGE_KEY = "bitunix.awarenessWindows";
const SCHEDULE_ENABLED_KEY = "bitunix.awarenessScheduleEnabled";

export interface AwarenessWindow {
  start: string; // "HH:MM" in ET
  end: string;   // "HH:MM" in ET
  label?: string;
}

// Default critical windows for an ET-based crypto trader. The user can edit
// these via the settings modal; they're stored in localStorage.
export const DEFAULT_WINDOWS: AwarenessWindow[] = [
  { start: "03:00", end: "05:00", label: "London open" },
  { start: "09:00", end: "11:00", label: "NY open" },
  { start: "14:00", end: "16:00", label: "NY PM / close" },
  { start: "20:00", end: "21:30", label: "Asia open" },
];

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

// Read what time it is *in Toronto*. Using Intl is the only safe way — naive
// new Date() math drifts whenever DST flips.
export function getETMinutes(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Toronto",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
  // Intl can return "24" for midnight in some runtimes; normalise.
  return ((hour % 24) * 60 + minute) % (24 * 60);
}

export function loadWindows(): AwarenessWindow[] {
  try {
    const raw = localStorage.getItem(WINDOWS_STORAGE_KEY);
    if (!raw) return DEFAULT_WINDOWS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_WINDOWS;
    // Validate every entry; one bad row falls back to defaults rather than
    // silently silencing awareness with corrupt config.
    const ok = parsed.every(
      (w) =>
        w &&
        typeof w.start === "string" &&
        typeof w.end === "string" &&
        parseHHMM(w.start) !== null &&
        parseHHMM(w.end) !== null
    );
    return ok ? (parsed as AwarenessWindow[]) : DEFAULT_WINDOWS;
  } catch {
    return DEFAULT_WINDOWS;
  }
}

export function saveWindows(windows: AwarenessWindow[]): void {
  try {
    localStorage.setItem(WINDOWS_STORAGE_KEY, JSON.stringify(windows));
  } catch {
    /* quota / disabled storage — ignore */
  }
}

export function loadScheduleEnabled(): boolean {
  try {
    const v = localStorage.getItem(SCHEDULE_ENABLED_KEY);
    // Default to enabled (cost-aware mode ON) per the PDF's core rule.
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

export function saveScheduleEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SCHEDULE_ENABLED_KEY, enabled ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export interface ScheduleStatus {
  scheduleEnabled: boolean; // master switch — false = always-on (legacy mode)
  inWindow: boolean;
  currentWindow: AwarenessWindow | null;
  nextWindow: AwarenessWindow | null;
  minutesUntilNext: number | null; // null when already in a window
  minutesUntilWindowEnd: number | null; // null when not in a window
  etNowMinutes: number;
}

// Returns whether right-now ET is inside any configured window plus useful
// "next window starts at" data for the UI. Pure function — given the same
// time, windows, and enabled flag, returns the same status.
export function evaluateSchedule(
  now: Date,
  windows: AwarenessWindow[],
  scheduleEnabled: boolean
): ScheduleStatus {
  const etNow = getETMinutes(now);

  // Master switch off → behave like the old always-on app.
  if (!scheduleEnabled) {
    return {
      scheduleEnabled: false,
      inWindow: true,
      currentWindow: null,
      nextWindow: null,
      minutesUntilNext: null,
      minutesUntilWindowEnd: null,
      etNowMinutes: etNow,
    };
  }

  // Find current window (if any).
  let currentWindow: AwarenessWindow | null = null;
  let minutesUntilWindowEnd: number | null = null;
  for (const w of windows) {
    const start = parseHHMM(w.start);
    const end = parseHHMM(w.end);
    if (start === null || end === null) continue;
    // Treat windows that wrap midnight (e.g. 22:00 → 02:00) explicitly so we
    // don't accidentally exclude the second half.
    const inside =
      start <= end ? etNow >= start && etNow < end : etNow >= start || etNow < end;
    if (inside) {
      currentWindow = w;
      minutesUntilWindowEnd = start <= end ? end - etNow : (end + 24 * 60 - etNow) % (24 * 60);
      break;
    }
  }

  // Find next upcoming window start.
  let nextWindow: AwarenessWindow | null = null;
  let minutesUntilNext: number | null = null;
  if (!currentWindow) {
    let bestDelta = Infinity;
    for (const w of windows) {
      const start = parseHHMM(w.start);
      if (start === null) continue;
      const delta = (start - etNow + 24 * 60) % (24 * 60);
      if (delta > 0 && delta < bestDelta) {
        bestDelta = delta;
        nextWindow = w;
      }
    }
    if (Number.isFinite(bestDelta)) minutesUntilNext = bestDelta;
  }

  return {
    scheduleEnabled: true,
    inWindow: !!currentWindow,
    currentWindow,
    nextWindow,
    minutesUntilNext,
    minutesUntilWindowEnd,
    etNowMinutes: etNow,
  };
}

export function fmtDuration(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
