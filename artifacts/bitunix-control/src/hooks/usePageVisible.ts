import { useState, useEffect } from "react";

/**
 * Returns true when the browser tab is visible, false when hidden.
 *
 * Used to pause all polling hooks when the user switches away from the tab,
 * eliminating compute on the server and on Bitunix's API while idle.
 * React Query re-fetches on window focus when the tab becomes visible again.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document !== "undefined" ? !document.hidden : true,
  );

  useEffect(() => {
    const handler = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", handler);
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);

  return visible;
}
