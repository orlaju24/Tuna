import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useAdaptiveInterval } from "./useAppState";
import { usePageVisible } from "./usePageVisible";

export interface AccountData {
  marginCoin: string;
  available: string;
  frozen: string;
  margin: string;
  transfer: string;
  positionMode: string;
  crossUnrealizedPNL: string;
  isolationUnrealizedPNL: string;
  bonus: string;
}

interface AccountResponse {
  code: number;
  msg: string;
  data: AccountData | null;
}

export function useAccount() {
  const visible = usePageVisible();
  const interval = useAdaptiveInterval(
    { idle: 30_000, watching: 30_000, active: 10_000, protecting: 10_000 },
    visible,
  );

  return useQuery<AccountResponse>({
    queryKey: ["account"],
    queryFn: () => api.get<AccountResponse>("/account"),
    refetchInterval: interval,
    refetchOnWindowFocus: true,
    retry: 1,
  });
}
