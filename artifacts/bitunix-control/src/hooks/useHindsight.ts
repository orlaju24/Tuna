import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface HindsightExample {
  id: number;
  symbol: string;
  source: string;
  direction: string | null;
  leverage: number | null;
  entryPrice: string | null;
  exitPrice: string | null;
  roiPct: string | null;
  btcSpotPrice: string | null;
  wholeNumberNearest: string | null;
  wholeNumberRelation: string | null;
  wholeNumberDistPct: string | null;
  tradeTimestamp: string | null;
  sessionBucket: string | null;
  timeOfDayLabel: string | null;
  closeType: string | null;
  triggerType: string | null;
  profitStatus: string | null;
  outcomeClass: string | null;
  marketRegime: string | null;
  confidenceScore: number | null;
  extractionNotes: string | null;
  imageKey: string | null;
  userNotes: string | null;
  tags: string | null;
  journalId: number | null;
  createdAt: string;
}

export interface HindsightSummary {
  total: number;
  wins: number;
  losses: number;
  winRate: number | null;
  shorts: number;
  longs: number;
  shortWinRate: number | null;
  longWinRate: number | null;
  bySession: Record<string, number>;
  byOutcome: Record<string, number>;
}

export function useHindsightExamples(opts?: {
  symbol?: string;
  direction?: string;
  outcomeClass?: string;
  sessionBucket?: string;
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (opts?.symbol) params.set("symbol", opts.symbol);
  if (opts?.direction) params.set("direction", opts.direction);
  if (opts?.outcomeClass) params.set("outcomeClass", opts.outcomeClass);
  if (opts?.sessionBucket) params.set("sessionBucket", opts.sessionBucket);
  if (opts?.limit) params.set("limit", String(opts.limit));
  const qs = params.toString();

  return useQuery<HindsightExample[]>({
    queryKey: ["hindsight", qs],
    queryFn: () => api.get<HindsightExample[]>(`/hindsight${qs ? "?" + qs : ""}`),
    refetchInterval: 60_000,
  });
}

export function useHindsightSummary() {
  return useQuery<HindsightSummary>({
    queryKey: ["hindsight-summary"],
    queryFn: () => api.get<HindsightSummary>("/hindsight/summary"),
    refetchInterval: 60_000,
  });
}

export function useDeleteHindsight() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del(`/hindsight/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["hindsight"] });
      qc.invalidateQueries({ queryKey: ["hindsight-summary"] });
    },
  });
}
