import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface Position {
  positionId: string;
  symbol: string;
  side: string;
  qty: string;
  entryPrice?: string;
  avgOpenPrice?: string;
  margin: string;
  leverage: string | number;
  marginMode: string;
  unrealizedPNL: string;
  realizedPNL?: string;
  liquidationPrice?: string;
  marginRate?: string;
  markPrice?: string;
  ctime?: string;
  mtime?: string;
}

export interface PositionsResponse {
  code: number;
  msg: string;
  data: Position[] | null;
}

export function normalizePositionDirection(side: unknown): "LONG" | "SHORT" | null {
  const normalized = String(side ?? "").trim().toUpperCase();
  if (normalized === "LONG" || normalized === "BUY") return "LONG";
  if (normalized === "SHORT" || normalized === "SELL") return "SHORT";
  return null;
}

export function usePositions(symbol: string) {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    { idle: 15_000, watching: 8_000, active: 4_000, protecting: 4_000 },
    visible,
  );

  return useQuery<PositionsResponse>({
    queryKey: ["positions", symbol],
    queryFn: () =>
      api.get<PositionsResponse>(`/positions?symbol=${encodeURIComponent(symbol)}`),
    enabled: !!symbol,
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/** All exchange positions, independent of the currently selected chart symbol. */
export function useAllOpenPositions() {
  const visible = usePageVisible();

  return useQuery<PositionsResponse>({
    queryKey: ["positions", "all"],
    queryFn: () => api.get<PositionsResponse>("/positions"),
    refetchInterval: visible ? 4_000 : false,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
