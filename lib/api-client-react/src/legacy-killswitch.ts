import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  MutationFunction,
  QueryKey,
  UseMutationOptions,
  UseQueryOptions,
} from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export interface AccountResult {
  available: string;
  balance: string;
  frozen: string;
  unrealizedPNL: string;
  bonus: string;
  positionMode: string;
}

export interface SymbolInfoResult {
  symbol: string;
  leverage: number;
  marginMode: string;
  hasPosition: boolean;
  position: {
    positionId: string;
    side: string;
    qty: string;
    entryPrice: string;
    liqPrice: string;
    unrealizedPNL: string;
    margin: string;
    leverage: string;
    marginMode: string;
  } | null;
}

export interface LogEntry {
  ts: number;
  action: string;
  source?: string;
  status?: string;
  symbol?: string;
  error?: string;
  [key: string]: unknown;
}

export interface LogsResult {
  logs: LogEntry[];
}

export interface LeverageBody {
  leverage: number;
  symbol?: string;
}

export interface LeverageResult {
  ok: boolean;
  leverage: number;
  symbol: string;
  durationMs?: number;
}

export interface KillBody {
  symbol?: string;
}

export interface KillResult {
  ok: boolean;
  status: "CLOSED" | "STILL_OPEN";
  remaining?: number;
  symbol?: string;
}

export interface ClosePositionResult {
  ok: boolean;
  status: "CLOSED" | "STILL_OPEN";
  positionId: string;
  durationMs?: number;
}

export interface TradeBody {
  amount: string;
  leverage?: number;
  symbol?: string;
}

export interface TradeResult {
  ok: boolean;
  orderId?: string;
  symbol: string;
  side: "LONG" | "SHORT";
  leverage: number;
  durationMs?: number;
}

export interface MarginBody {
  positionId: string;
  amount: string;
  type: "ADD" | "REDUCE";
  side: string;
  symbol?: string;
}

export interface MarginResult {
  ok: boolean;
  positionId: string;
  type: "ADD" | "REDUCE";
  amount: string;
  durationMs?: number;
}

type RequestOptions = { request?: RequestInit };
type QueryOptions<T> = RequestOptions & {
  query?: Omit<UseQueryOptions<T, Error, T, QueryKey>, "queryKey" | "queryFn"> & {
    queryKey?: QueryKey;
  };
};
type MutationOptions<T, V> = RequestOptions & {
  mutation?: UseMutationOptions<T, Error, V, unknown>;
};

async function request<T>(
  path: string,
  options?: RequestInit,
  init?: RequestInit,
): Promise<T> {
  return customFetch<T>(path, { ...options, ...init, responseType: "json" });
}

export const getGetAccountQueryKey = (): QueryKey => ["/api/account"];
export const getGetLogsQueryKey = (): QueryKey => ["/api/logs"];
export const getGetSymbolInfoQueryKey = (symbol: string): QueryKey => [
  "/api/symbol",
  symbol,
  "info",
];

export function useGetAccount(options?: QueryOptions<AccountResult>) {
  const queryKey = options?.query?.queryKey ?? getGetAccountQueryKey();
  return useQuery({
    ...options?.query,
    queryKey,
    queryFn: () => request<AccountResult>("/api/account", options?.request),
  });
}

export function useGetSymbolInfo(
  symbol: string,
  options?: QueryOptions<SymbolInfoResult>,
) {
  const queryKey = options?.query?.queryKey ?? getGetSymbolInfoQueryKey(symbol);
  return useQuery({
    ...options?.query,
    queryKey,
    queryFn: () =>
      request<SymbolInfoResult>(
        `/api/symbol/${encodeURIComponent(symbol)}/info`,
        options?.request,
      ),
  });
}

export function useGetLogs(options?: QueryOptions<LogsResult>) {
  const queryKey = options?.query?.queryKey ?? getGetLogsQueryKey();
  return useQuery({
    ...options?.query,
    queryKey,
    queryFn: () => request<LogsResult>("/api/logs", options?.request),
  });
}

function usePost<T, V>(
  path: string | ((variables: V) => string),
  options?: MutationOptions<T, V>,
) {
  const mutationFn: MutationFunction<T, V> = async (variables) =>
    request<T>(typeof path === "function" ? path(variables) : path, options?.request, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        typeof variables === "object" && variables !== null && "data" in variables
          ? (variables as { data: unknown }).data
          : variables,
      ),
    });
  return useMutation({ ...options?.mutation, mutationFn });
}

export const useSetLeverage = (options?: MutationOptions<LeverageResult, { data: LeverageBody }>) =>
  usePost<LeverageResult, { data: LeverageBody }>(
    "/api/leverage",
    options,
  );

export const useKillAll = (options?: MutationOptions<KillResult, { data: KillBody }>) =>
  usePost<KillResult, { data: KillBody }>("/api/kill", options);

export const useTradeLong = (options?: MutationOptions<TradeResult, { data: TradeBody }>) =>
  usePost<TradeResult, { data: TradeBody }>("/api/trade/long", options);

export const useTradeShort = (options?: MutationOptions<TradeResult, { data: TradeBody }>) =>
  usePost<TradeResult, { data: TradeBody }>("/api/trade/short", options);

export const useClosePosition = (
  options?: MutationOptions<ClosePositionResult, { positionId: string; data?: { symbol?: string } }>,
) =>
  usePost<ClosePositionResult, { positionId: string; data?: { symbol?: string } }>(
    (variables) => `/api/positions/${encodeURIComponent(variables.positionId)}/close`,
    options,
  );

export const useAdjustMargin = (
  options?: MutationOptions<MarginResult, { positionId: string; data: Omit<MarginBody, "positionId"> }>,
) =>
  usePost<MarginResult, { positionId: string; data: Omit<MarginBody, "positionId"> }>(
    (variables) => `/api/positions/${encodeURIComponent(variables.positionId)}/margin`,
    options,
  );