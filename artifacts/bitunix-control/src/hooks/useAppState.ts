import {
  createElement,
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePageVisible } from "./usePageVisible";

/**
 * App-state machine — drives adaptive polling rates across all hooks.
 *
 *  idle       No position open, no armed watcher or safeguard.
 *             Polls slow down aggressively; server idles.
 *
 *  watching   A trigger is armed and watching (price hasn't hit yet).
 *             Trigger list polls faster so the UI reflects the fire quickly.
 *
 *  active     A position is open but no safeguard is protecting it yet.
 *             Position + account poll at medium rate.
 *
 *  protecting Position is open AND a safeguard is in armed/protecting state.
 *             Critical path — position + safeguard poll at their highest rate.
 */
export type AppState = "idle" | "watching" | "active" | "protecting";

const AppStateContext = createContext<AppState>("idle");

interface PositionsResponse {
  data: Array<unknown> | null;
}
interface SafeguardMin {
  state: string;
  symbol: string;
}
interface TriggerMin {
  armed: boolean;
  watcherStatus: string;
}

/**
 * Wrap your top-level component (Dashboard) with this provider.
 *
 * It reads exclusively from the React Query cache — no extra fetches.
 * Whenever any cached query updates (from component polls), this re-derives
 * the app state and all dependent hooks adapt their refetch intervals.
 */
export function AppStateProvider({
  symbol,
  children,
}: {
  symbol: string;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();

  function derive(): AppState {
    const positions = queryClient.getQueryData<PositionsResponse>([
      "positions",
      symbol,
    ]);
    const safeguards = queryClient.getQueryData<SafeguardMin[]>([
      "safeguards",
      symbol,
    ]);
    const triggers = queryClient.getQueryData<TriggerMin[]>(["triggers"]);

    const hasPosition = (positions?.data?.length ?? 0) > 0;
    const hasProtecting =
      safeguards?.some(
        (s) =>
          s.symbol === symbol &&
          (s.state === "armed" || s.state === "protecting"),
      ) ?? false;
    const hasWatching =
      triggers?.some((t) => t.armed && t.watcherStatus === "watching") ?? false;

    if (hasPosition && hasProtecting) return "protecting";
    if (hasPosition) return "active";
    if (hasWatching) return "watching";
    return "idle";
  }

  const [appState, setAppState] = useState<AppState>(derive);

  useEffect(() => {
    // Subscribe to every cache change — no polling, pure reactive derivation.
    const unsub = queryClient.getQueryCache().subscribe(() => {
      setAppState((prev) => {
        const next = derive();
        return next !== prev ? next : prev;
      });
    });
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, symbol]);

  return createElement(AppStateContext.Provider, { value: appState }, children);
}

export function useAppState(): AppState {
  return useContext(AppStateContext);
}

/**
 * Returns the correct refetch interval for the current app state.
 * Returns `false` (pause all polling) when the browser tab is hidden.
 *
 * @param intervals  Per-state millisecond values. Use `false` to disable
 *                   polling in a specific state.
 * @param visible    Result of usePageVisible() from the calling hook.
 */
export function useAdaptiveInterval(
  intervals: Record<AppState, number | false>,
  visible: boolean,
): number | false {
  const state = useAppState();
  if (!visible) return false;
  return intervals[state];
}
