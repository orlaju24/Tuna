import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface Trigger {
  id: number;
  symbol: string;
  triggerPrice: string;
  direction: string;
  closeMethod: string;
  armed: boolean;
  watcherStatus: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  triggeredAt: string | null;
  completedAt: string | null;
}

export function useTriggers() {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    // Poll fastest while watching — the "triggered" status must appear quickly.
    { idle: 15_000, watching: 5_000, active: 8_000, protecting: 8_000 },
    visible,
  );

  return useQuery<Trigger[]>({
    queryKey: ["triggers"],
    queryFn: () => api.get<Trigger[]>("/triggers"),
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useCreateTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      symbol: string;
      triggerPrice: string;
      direction: string;
      closeMethod: string;
    }) => api.post<Trigger>("/triggers", payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
}

export function useArmTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<Trigger>(`/triggers/${id}/arm`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
}

export function useDisarmTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.post<Trigger>(`/triggers/${id}/disarm`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
}

export function useDeleteTrigger() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<{ ok: boolean }>(`/triggers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["triggers"] }),
  });
}
