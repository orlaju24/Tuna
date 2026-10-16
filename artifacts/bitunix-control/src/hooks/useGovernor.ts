import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type GovernorGrade = "clean" | "monitor" | "caution" | "warning" | "freeze";

export interface GovernorComponent {
  score: number;
  max: number;
  label: string;
}

export interface GovernorPenalty {
  label: string;
  points: number;
  detail: string;
}

export interface GovernorState {
  score: number;
  grade: GovernorGrade;
  penalties: GovernorPenalty[];
  adjustments: {
    oracleFloorDelta: number;
    autoBlocked: boolean;
    label: string;
  };
  components: {
    sessionDiscipline: GovernorComponent;
    entryQuality: GovernorComponent;
    postWinDiscipline: GovernorComponent;
    lossRecovery: GovernorComponent;
    nearMissRate: GovernorComponent;
  };
  computedAt: string;
  tradesAnalyzed: number;
}

export function useGovernor() {
  return useQuery<GovernorState>({
    queryKey: ["governor"],
    queryFn: async () => {
      const res = await fetch("/api/governor");
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    refetchInterval: 90_000, // every 90 s (server caches for 60 s)
    staleTime: 60_000,
  });
}

export function useGovernorReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/governor/reset", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ ok: boolean; state: GovernorState }>;
    },
    onSuccess: (data) => {
      qc.setQueryData(["governor"], data.state);
    },
  });
}
