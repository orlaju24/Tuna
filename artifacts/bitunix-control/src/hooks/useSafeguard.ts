import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface StructureContext {
  signalScore: number;
  oneHourDirection: -1 | 0 | 1;
  sixHourDirection: -1 | 0 | 1;
  htfDirection: -1 | 0 | 1;
  htfAligned: boolean;
  threeMinDirection: -1 | 0 | 1;
  fifteenMinDirection: -1 | 0 | 1;
  threeMinLeads: boolean;
  fifteenMinConfirms: boolean;
  fourBarStreak: number;
  fourBarRule: boolean;
  velocityState: "fast" | "slow" | "normal";
  threeMinBodyPct: number;
  nearestPivot: number;
  pivotProximityPct: number;
  nearPivot: boolean;
  pivotState: "clear" | "approach" | "stall" | "bounce" | "break";
  counterMove: boolean;
  resumption: boolean;
  wholeNumberPlayType: string;
  haStreak3m: number;
  haStreak15m: number;
  haBodyStrength3m: number;
  haNoDissent3m: boolean;
  // Wave pattern analysis fields
  wavePhase?: 'pressure_building' | 'first_wave' | 'pullback' | 'resumption_forming' | 'resumption_confirmed' | 'extended' | 'mixed';
  wave1BodyAvg?: number;
  wave1Length?: number;
  pullbackLength?: number;
  wave2BodyAvg?: number;
  wave2Length?: number;
  wave2VsWave1Ratio?: number;
  // Extension health — only present when wavePhase === 'extended'
  extensionScore?: number;                                // 0-100 composite health
  extensionPhase?: 'alive' | 'peaking' | 'dying' | 'dead'; // health classification
  // HA wave quality flags — cross-timeframe direction context
  ha6hBias?: -1 | 0 | 1;          // 6h HA master bias direction (0 = mixed/undecided)
  waveAlignedWithHa6h?: boolean;  // wave direction matches 6h HA bias
  pullbackControlled?: boolean;   // pullback phase but 1h HA still holds trade direction
  waveExhaustionFlag?: boolean;   // extended phase + 1h HA exhaustion = double warning
  fingerprintConfidence: number | null;
  fingerprintSampleCount: number;
  postWinHumility: boolean;
  postWinMinutesLeft: number;
  patternTopMatches: Array<{
    qualityLabel: string;
    outcome: string;
    roiPct: number | null;
    similarity: number;
    isMentorExample: boolean;
    exampleType: string | null;
  }>;
  patienceBoost: number;
  trailWidth: number;
  patienceLevel: string;
}

export type OracleState = "ready" | "wait_mode" | "late_setup" | "no_signal";

export interface EdgeScoreData {
  edgeScore: number;
  grade: "exceptional" | "good" | "moderate" | "weak" | "poor";
  reason: string;
  oracleState: OracleState;
  oracleStateLabel: string;
  /** Specific, dynamic explanation of WHY the oracle is in its current state. */
  oracleNarration?: string;
  safeguardDelta: number;
  safeguardNote: string;
  components: {
    structureAlignment: { score: number; max: number; label: string };
    patienceQuality:    { score: number; max: number; label: string };
    keyLevelBehavior:   { score: number; max: number; label: string; playType: string };
    walletReadiness:    { score: number; max: number; label: string; exposurePct: number };
    timeSuitability:    { score: number; max: number; label: string };
  };
  /** Full structure context (market-structure snapshot at compute time). */
  structure?: StructureContext | null;
}

export interface SafeguardRow {
  id: number;
  symbol: string;
  side: string;
  entryPrice: string;
  qty: string;
  leverage: number;
  positionId: string | null;
  threshold1Pct: string;
  threshold2Pct: string;
  trailStepPct: string;
  trailingMode: string;
  state: string;
  safeguardPrice: string | null;
  highWaterRoiPct: string | null;
  closeMethod: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  triggeredAt: string | null;
  completedAt: string | null;
  liveRoiPct: number | null;
  ratchetCount: number;
  nextMilestoneRoiPct: number | null;
  patienceLevel: string | null;
  signalScore: number | null;
  structure: StructureContext | null;
  plan?: SafeguardPlanSnapshot | null;
  planTrailDelta?: number;
  edgeContext?: EdgeScoreData | null;
}

export interface SafeguardPlanSnapshot {
  id: number;
  symbol: string;
  agreementScore: number | null;
  continuationProbPct: number | null;
  channelZone: string | null;
  recommendedPatience: string | null;
  setupQuality: string | null;
  summary: string | null;
  createdAt: string;
}

export function useSafeguards(symbol: string) {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    { idle: 15_000, watching: 15_000, active: 8_000, protecting: 4_000 },
    visible,
  );

  return useQuery<SafeguardRow[]>({
    queryKey: ["safeguards", symbol],
    queryFn: () =>
      api
        .get<SafeguardRow[]>("/safeguard")
        .then((all) => all.filter((s) => s.symbol === symbol)),
    refetchInterval: (query) => {
      if (!visible) return false;
      const rows = query.state.data as SafeguardRow[] | undefined;
      const hasActiveSafeguard = rows?.some((s) =>
        ["armed", "protecting", "triggered", "closing"].includes(s.state),
      );
      return hasActiveSafeguard ? 4_000 : interval;
    },
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useCreateSafeguard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      symbol: string;
      side: string;
      entryPrice: string | number;
      qty: string | number;
      leverage: number;
      positionId: string;
      threshold1Pct?: number;
      threshold2Pct?: number;
      trailStepPct?: number;
      closeMethod?: string;
      trailingMode?: string;
    }) => api.post<SafeguardRow>("/safeguard", payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["safeguards"] }),
  });
}

export function useUpdateSafeguardMethod() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, closeMethod }: { id: number; closeMethod: string }) =>
      api.patch<SafeguardRow>(`/safeguard/${id}/method`, { closeMethod }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["safeguards"] }),
  });
}

export function useDisarmSafeguard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<SafeguardRow>(`/safeguard/${id}/disarm`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["safeguards"] }),
  });
}

export function useDeleteSafeguard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<{ ok: boolean }>(`/safeguard/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["safeguards"] }),
  });
}
