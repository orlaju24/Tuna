import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type Direction = "up" | "down" | "mixed";
export type Confidence = "low" | "medium" | "high";

export interface TimeframeRead {
  direction: Direction;
  score: number;
  lastCandlePct: number;
  windowPct: number;
  weight: number;
  ok: boolean;
}

export interface SignalData {
  symbol: string;
  price: number;
  verdict: {
    label: string;
    confidence: Confidence;
    score: number;
  };
  timeframes: {
    "3m": TimeframeRead;
    "15m": TimeframeRead;
    "1h": TimeframeRead;
    "6h": TimeframeRead;
  };
  wholeNumber: {
    nearby: boolean;
    level: number;
    distancePct: number;
    step: number;
  };
}

export interface SignalEnvelope {
  code: number;
  msg: string;
  data: SignalData | null;
}

export interface UseSignalOptions {
  // Schedule-driven enable flag. When false (outside critical ET windows),
  // the query is fully disabled — no fetch, no polling, no credit cost.
  enabled?: boolean;
  // Polling cadence in ms. Default 15s for legacy always-on mode; the
  // schedule-aware caller bumps this to 1h ("one clean update per hour is
  // enough" per the cost-aware spec).
  refetchIntervalMs?: number;
}

export function useSignal(symbol: string, opts: UseSignalOptions = {}) {
  const { enabled = true, refetchIntervalMs = 15_000 } = opts;
  return useQuery<SignalEnvelope>({
    queryKey: ["signal", symbol],
    queryFn: () => api.get<SignalEnvelope>(`/signal/${encodeURIComponent(symbol)}`),
    enabled: !!symbol && enabled,
    refetchInterval: enabled ? refetchIntervalMs : false,
    refetchOnWindowFocus: enabled,
    retry: 1,
  });
}
