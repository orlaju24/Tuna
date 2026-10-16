import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface Favorite {
  id: number;
  symbol: string;
  sortOrder: number;
  enabled: boolean;
}

export function useFavorites() {
  return useQuery<Favorite[]>({
    queryKey: ["favorites"],
    queryFn: () => api.get<Favorite[]>("/favorites"),
    retry: 2,
  });
}

export function useAddFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, sortOrder }: { symbol: string; sortOrder?: number }) =>
      api.post<Favorite>("/favorites", { symbol, sortOrder }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["favorites"] }),
  });
}

export function useDeleteFavorite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<{ ok: boolean }>(`/favorites/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["favorites"] }),
  });
}
