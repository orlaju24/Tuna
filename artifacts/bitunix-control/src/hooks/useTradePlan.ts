import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface TradePlanRow {
  id: number;
  symbol: string;
  side: string | null;
  userBias: string | null;
  uploadKey: string;
  uploadContentType: string | null;
  uploadBytes: number | null;
  channelZone: string | null;
  channelTilt: string | null;
  trendPosture: string | null;
  detectedBias: string | null;
  agreementScore: number | null;
  continuationProbPct: number | null;
  pivotProximityNote: string | null;
  recommendedPatience: string | null;
  recommendedTightening: string | null;
  setupQuality: string | null;
  riskNote: string | null;
  summary: string | null;
  // Image-to-self-trade intelligence
  priceAtUpload: string | null;          // live price at upload time (numeric string)
  returnToZonePct: string | null;        // numeric string from DB, e.g. "1.5"
  returnToZoneNote: string | null;
  entryZoneNote: string | null;
  invalidationZoneNote: string | null;
  confidenceLevel: number | null;        // 0-100
  likelyAction: string | null;           // enter | wait | stand-down | probe
  createdAt: string;
  consumedAt: string | null;
  consumedBySafeguardId: number | null;
}

const PLAN_QK = (symbol: string) => ["trade-plan", "latest", symbol];
const PLAN_LIST_QK = (symbol: string | null) => ["trade-plan", "list", symbol];

export function useLatestTradePlan(symbol: string) {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    // Once a plan is claimed (trade opened), no need to poll — disable polling
    // in active/protecting states so the pre-trade card stays quiet.
    { idle: 30_000, watching: 20_000, active: false, protecting: false },
    visible,
  );

  return useQuery<TradePlanRow | null>({
    queryKey: PLAN_QK(symbol),
    queryFn: async () => {
      const res = await fetch(`/api/trade-plan/${encodeURIComponent(symbol)}/latest`);
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`Failed to load latest plan: ${res.status}`);
      return res.json() as Promise<TradePlanRow>;
    },
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 2,
  });
}

export function useTradePlanList(symbol: string | null) {
  const params = new URLSearchParams();
  if (symbol) params.set("symbol", symbol);
  const qs = params.toString();
  return useQuery<TradePlanRow[]>({
    queryKey: PLAN_LIST_QK(symbol),
    queryFn: () => api.get<TradePlanRow[]>(`/trade-plan${qs ? "?" + qs : ""}`),
    retry: 2,
  });
}

export function useUploadTradePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: {
      file: File;
      symbol: string;
      side?: "LONG" | "SHORT";
      userBias?: "long" | "short" | "unclear";
      note?: string;
    }) => {
      const fd = new FormData();
      fd.append("chart", args.file);
      fd.append("symbol", args.symbol);
      if (args.side) fd.append("side", args.side);
      if (args.userBias) fd.append("userBias", args.userBias);
      if (args.note) fd.append("note", args.note);

      const res = await fetch("/api/trade-plan", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error || "Upload failed");
      }
      return res.json() as Promise<TradePlanRow>;
    },
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: PLAN_QK(row.symbol) });
      qc.invalidateQueries({ queryKey: ["trade-plan", "list"] });
    },
  });
}

export function useDeleteTradePlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.del<{ ok: boolean }>(`/trade-plan/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["trade-plan"] });
    },
  });
}
