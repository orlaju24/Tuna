import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface JournalEntry {
  id: number;
  symbol: string;
  side: string;
  leverage: number;
  positionId: string | null;
  dataConfidence: string | null;
  entryPrice: string | null;
  exitPrice: string | null;
  armedAt: string | null;
  exitAt: string | null;
  holdDurationMs: number | null;
  mfePct: string | null;
  maePct: string | null;
  peakRoiPct: string | null;
  protectedRoiPct: string | null;
  exitRoiPct: string | null;
  givebackPct: string | null;
  givebackRating: string | null;
  nearMiss: boolean;
  safeguardUsed: boolean;
  ratchetCount: number;
  threshold1Pct: string | null;
  exitReason: string;
  closeMethod: string | null;
  executionLatencyMs: number | null;
  walkAwayActive: boolean;
  patienceLevel: string | null;
  signalScore: string | null;
  htfAlignment: string | null;
  threeMinLead: boolean | null;
  fifteenMinConfirm: boolean | null;
  fourBarStreak: number | null;
  pivotState: string | null;
  velocityState: string | null;
  counterMove: boolean | null;
  resumption: boolean | null;
  patienceBoost: number | null;
  trailWidth: string | null;
  tradePlanId: number | null;
  uploadUsed: boolean | null;
  uploadKey: string | null;
  channelZoneAtPlan: string | null;
  userBiasAtPlan: string | null;
  agreementScoreAtPlan: number | null;
  continuationProbAtPlan: number | null;
  recommendedPatienceAtPlan: string | null;
  outcomeVsPlan: string | null;
  edgeScore: number | null;
  wholeNumberPlayType: string | null;
  walletSizeScore: number | null;
  verdict: string | null;
  setupFingerprint: string | null;
  sourceType: string;
  sourceId: number | null;
  enrichedAt: string | null;
  realizedPnl: string | null;
  entryFee: string | null;
  exitFee: string | null;
  createdAt: string;
}

export interface DebriefCandle {
  open:   string;
  high:   string;
  low:    string;
  close:  string;
  time:   number;
  volume: string;
}

export interface DebriefExchange {
  positionId:  string;
  symbol:      string;
  side:        string;
  leverage:    string;
  qty:         string;
  entryPrice:  string;
  exitPrice:   string;
  realizedPnl: string;
  fee:         string;
  openTime:    number;
  closeTime:   number;
}

export interface DebriefComputed {
  exchangeRoiPct:   number | null;
  netPnl:           number | null;
  totalFee:         number | null;
  holdDurationMs:   number | null;
  priceDelta:       number | null;
  entryConfirmed:   boolean;
}

export interface TradeDebrief {
  journal:  JournalEntry;
  exchange: DebriefExchange | null;
  candles:  DebriefCandle[];
  computed: DebriefComputed;
}

export interface LearningDigest {
  sampleSize: number;
  insufficientData: boolean;
  sessionStats:      Record<string, { wins: number; total: number; winRate: number; avgRoi: number }>;
  velocityStats:     Record<string, { wins: number; total: number; winRate: number; avgRoi: number }>;
  oracleBucketStats: Record<string, { wins: number; total: number; winRate: number; avgRoi: number }>;
  htfStats:          Record<string, { wins: number; total: number; winRate: number; avgRoi: number }>;
  qualityDistribution: Record<string, number>;
  suggestedMinEdge:  number | null;
  bestSession:       string | null;
  bestVelocity:      string | null;
  winningOracleRange: { min: number; max: number } | null;
  recommendations: Array<{
    type: string;
    insight: string;
    confidence: "high" | "medium" | "low";
    actionable: boolean;
    suggestedValue?: number | string;
  }>;
  allWinRate: number | null;
  /** Aggregate outcome of trades whose safeguard floor was set from a trigger cross. */
  triggerFloorStats: { total: number; wins: number; winRate: number; avgRoi: number } | null;
  /** Win-rate breakdown by the HA wave phase at the moment the trigger floor was activated. */
  byFloorWavePhase:  Record<string, { wins: number; total: number; winRate: number; avgRoi: number }>;
}

export function useJournal(opts?: {
  limit?: number;
  symbol?: string;
  safeguardUsed?: boolean;
}) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.symbol) params.set("symbol", opts.symbol);
  if (opts?.safeguardUsed != null) params.set("safeguardUsed", String(opts.safeguardUsed));
  const qs = params.toString();

  const visible  = usePageVisible();
  const interval = useAdaptiveInterval(
    { idle: 30_000, watching: 30_000, active: 20_000, protecting: 20_000 },
    visible,
  );

  return useQuery<JournalEntry[]>({
    queryKey: ["journal", qs],
    queryFn:  () => api.get<JournalEntry[]>(`/journal${qs ? "?" + qs : ""}`),
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useTradeDebrief(id: number | null, enabled = false) {
  return useQuery<TradeDebrief>({
    queryKey: ["trade-debrief", id],
    queryFn:  () => api.get<TradeDebrief>(`/journal/${id}/debrief`),
    enabled:  enabled && id != null,
    retry: 1,
    staleTime: 30_000,
  });
}

export function useEnrichTrade() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; enriched: Partial<JournalEntry>; exchange: DebriefExchange }, Error, number>({
    mutationFn: (id: number) =>
      api.post<{ ok: boolean; enriched: Partial<JournalEntry>; exchange: DebriefExchange }>(
        `/journal/${id}/enrich`, {}
      ),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ["journal"] });
      void qc.invalidateQueries({ queryKey: ["trade-debrief", id] });
    },
  });
}

export function useLearningDigest(symbol?: string) {
  const qs = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
  const visible  = usePageVisible();
  const interval = useAdaptiveInterval(
    { idle: 120_000, watching: 60_000, active: 60_000, protecting: 60_000 },
    visible,
  );

  return useQuery<LearningDigest>({
    queryKey: ["learning-digest", symbol ?? "all"],
    queryFn:  () => api.get<LearningDigest>(`/journal/learning-digest${qs}`),
    refetchInterval: interval,
    refetchOnWindowFocus: false,
    retry: 2,
  });
}
