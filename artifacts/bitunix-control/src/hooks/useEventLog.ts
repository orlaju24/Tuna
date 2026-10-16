import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface EventLog {
  id: number;
  symbol: string | null;
  eventType: string;
  eventMessage: string;
  source: string | null;
  createdAt: string;
}

export function useEventLog(limit = 30) {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    // Event log is noncritical display — slow down when nothing is happening.
    { idle: 20_000, watching: 10_000, active: 8_000, protecting: 8_000 },
    visible,
  );

  return useQuery<EventLog[]>({
    queryKey: ["events", limit],
    queryFn: () => api.get<EventLog[]>(`/events?limit=${limit}`),
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}
