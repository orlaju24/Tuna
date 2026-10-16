import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const BASE = import.meta.env.BASE_URL;
const api = (path: string) => `${BASE}api/${path}`;

export interface TimeWindow {
  label: string;
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

export interface AutoEntryConfig {
  id: number;
  enabled: boolean;
  symbol: string;
  side: string; // LONG | SHORT | SIGNAL
  maxMarginUsdt: string;
  leverage: number;
  minLiqGapUsdt: string;
  minEdgeScore: number;
  avoidMiddles: boolean;
  allowedWindowsJson: TimeWindow[] | null;
  blockedWindowsJson: TimeWindow[] | null;
  autoArmSafeguard: boolean;
  safeguardThreshold1Pct: string;
  safeguardTrailPct: string;
  /** Hard kill-switch — blocks all auto-entry regardless of signal quality. Survives restarts. */
  sessionFrozen: boolean;
  /** User-engaged stand-down. Stays active until manually resumed. */
  walkAwayMode: boolean;
  updatedAt: string;
}

export interface EvalResult {
  evaluatedAt: string;
  allowed: boolean;
  blockReasons: string[];
  positionFlat: boolean;
  timeWindowOk: boolean;
  avoidMiddlesOk: boolean;
  /** Price is within 20% of the nearest whole-number level. Always evaluated. */
  wholeNumberProximityOk: boolean;
  edgeOk: boolean;
  liqGapOk: boolean;
  // Plan gate — null = no plan uploaded (gate open by default)
  planGateOk: boolean | null;
  planLikelyAction: string | null;       // enter | wait | stand-down
  planConfidenceLevel: number | null;
  planAgreementScore: number | null;
  planReturnToZoneNote: string | null;
  edgeScore: number | null;
  edgeGrade: string | null;
  liqGapEstimate: number | null;
  detectedSide: string | null;
  currentPrice: number | null;
  entryOpened: boolean;
  entrySymbol: string | null;
  entrySide: string | null;
  entryPrice: number | null;
  entryQty: number | null;
  marginUsed: number | null;
  positionId: string | null;
  safeguardArmed: boolean;
  safeguardId: number | null;
  errorMessage: string | null;
}

export interface AutoEntryLogRow {
  id: number;
  evaluatedAt: string;
  allowed: boolean;
  blockReasons: string[];
  positionFlat: boolean;
  timeWindowOk: boolean;
  avoidMiddlesOk: boolean;
  wholeNumberProximityOk: boolean;
  edgeOk: boolean;
  liqGapOk: boolean;
  planGateOk: boolean | null;
  planLikelyAction: string | null;
  planConfidenceLevel: number | null;
  planAgreementScore: number | null;
  planReturnToZoneNote: string | null;
  edgeScore: number | null;
  edgeGrade: string | null;
  liqGapEstimate: string | null;
  detectedSide: string | null;
  currentPrice: string | null;
  entryOpened: boolean;
  entrySymbol: string | null;
  entrySide: string | null;
  entryPrice: string | null;
  entryQty: string | null;
  marginUsed: string | null;
  positionId: string | null;
  safeguardArmed: boolean;
  safeguardId: number | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AutoEntryStatus {
  enabled: boolean;
  lastResult: EvalResult | null;
  recentLog: AutoEntryLogRow[];
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function useAutoEntryConfig() {
  return useQuery<AutoEntryConfig>({
    queryKey: ["auto-entry-config"],
    queryFn: () => fetch(api("auto-entry/config")).then((r) => r.json()),
    staleTime: 10_000,
  });
}

export function useAutoEntryStatus() {
  return useQuery<AutoEntryStatus>({
    queryKey: ["auto-entry-status"],
    queryFn: () => fetch(api("auto-entry/status")).then((r) => r.json()),
    refetchInterval: 20_000,
    staleTime: 15_000,
  });
}

export function useAutoEntryLog(limit = 30) {
  return useQuery<AutoEntryLogRow[]>({
    queryKey: ["auto-entry-log", limit],
    queryFn: () => fetch(api(`auto-entry/log?limit=${limit}`)).then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export function useToggleAutoEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enable: boolean) =>
      fetch(api(`auto-entry/${enable ? "enable" : "disable"}`), { method: "POST" }).then((r) =>
        r.json(),
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auto-entry-config"] });
      void qc.invalidateQueries({ queryKey: ["auto-entry-status"] });
    },
  });
}

export function useFreezeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch(api("auto-entry/freeze"), { method: "POST" }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auto-entry-config"] });
      void qc.invalidateQueries({ queryKey: ["event-log"] });
    },
  });
}

export function useUnfreezeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch(api("auto-entry/unfreeze"), { method: "POST" }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auto-entry-config"] });
      void qc.invalidateQueries({ queryKey: ["event-log"] });
    },
  });
}

export function useWalkAway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch(api("auto-entry/walk-away"), { method: "POST" }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auto-entry-config"] });
      void qc.invalidateQueries({ queryKey: ["event-log"] });
    },
  });
}

export function useResume() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetch(api("auto-entry/resume"), { method: "POST" }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auto-entry-config"] });
      void qc.invalidateQueries({ queryKey: ["event-log"] });
    },
  });
}

export function useUpdateAutoEntryConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<AutoEntryConfig>) =>
      fetch(api("auto-entry/config"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["auto-entry-config"] });
    },
  });
}
