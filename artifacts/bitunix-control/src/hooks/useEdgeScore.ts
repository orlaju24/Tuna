import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { usePageVisible } from "./usePageVisible";
import type { EdgeScoreData } from "./useSafeguard";

export type { EdgeScoreData };

export function useEdgeScore(symbol: string) {
  const visible = usePageVisible();

  return useQuery<EdgeScoreData>({
    queryKey: ["edgeScore", symbol],
    queryFn: () => api.get<EdgeScoreData>(`/edge-score/${symbol}`),
    enabled: !!symbol && visible,
    refetchInterval: visible ? 30_000 : false,
    refetchOnWindowFocus: true,
    retry: 2,
    staleTime: 25_000,
  });
}
