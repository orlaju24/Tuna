/**
 * Post-close notification bridge.
 *
 * Breaks the circular-import that would result from safeguardWatcher or
 * watcher directly importing autoEntryWatcher (which already imports
 * safeguardManager). Instead:
 *
 *   • autoEntryWatcher registers a handler at startup.
 *   • safeguardWatcher and triggerWatcher call notifyPostClose() after a
 *     confirmed close.
 *   • autoEntryWatcher enters a revalidation wait state on receipt.
 *
 * Intentionally simple — no queues, no retry, single handler. The only
 * consumer is the auto-entry watcher, and a missed notification just means
 * the normal flat-position check on the next 30s cycle catches it anyway.
 */

export type CloseReason = "safeguard" | "trigger";

type Handler = (symbol: string, reason: CloseReason) => void;

let _handler: Handler | null = null;

export function registerPostCloseHandler(fn: Handler): void {
  _handler = fn;
}

export function notifyPostClose(symbol: string, reason: CloseReason): void {
  if (_handler) _handler(symbol, reason);
}
