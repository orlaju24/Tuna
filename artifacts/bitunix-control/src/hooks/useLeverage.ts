import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface LeverageData {
  symbol: string;
  marginCoin: string;
  marginMode: string;
  leverage: number;
  longLeverage: number;
  shortLeverage: number;
}

interface LeverageResponse {
  code: number;
  msg: string;
  data: LeverageData | null;
}

export function useLeverage(symbol: string) {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    // Leverage rarely changes between user actions; the POST route invalidates
    // the server cache immediately so the next poll always gets fresh data.
    { idle: 60_000, watching: 60_000, active: 30_000, protecting: 30_000 },
    visible,
  );

  return useQuery<LeverageResponse>({
    queryKey: ["leverage", symbol],
    queryFn: () =>
      api.get<LeverageResponse>(`/leverage?symbol=${encodeURIComponent(symbol)}`),
    enabled: !!symbol,
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
