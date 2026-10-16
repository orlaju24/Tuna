/**
 * Lightweight stale-while-revalidate cache for Bitunix REST responses.
 *
 * Problem: every browser poll (4–12 s depending on hook) triggers a fresh
 * bitunixGet() call to Bitunix's REST API. With multiple tabs or reconnects,
 * the rate multiplies. This cache coalesces all callers behind a single
 * in-flight or recently-stored value.
 *
 * Behaviour:
 *  - Fresh (age < ttl): return cached value immediately, no upstream call.
 *  - Stale (age >= ttl): return cached value immediately AND fire a background
 *    refresh. The next poll will get the refreshed value.
 *  - Cold (no entry): await the fetcher, store, return.
 *
 * The stale-while-revalidate pattern means callers never wait for a refresh
 * after the first successful fetch — responses stay fast.
 */

interface Entry<T> {
  value: T;
  storedAt: number;
  refreshing: boolean;
}

const store = new Map<string, Entry<unknown>>();

export async function cacheGet<T>(
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const entry = store.get(key) as Entry<T> | undefined;
  const now = Date.now();

  if (entry) {
    if (now - entry.storedAt < ttlMs) {
      return entry.value;
    }
    if (!entry.refreshing) {
      entry.refreshing = true;
      fetcher()
        .then((v) => store.set(key, { value: v, storedAt: Date.now(), refreshing: false }))
        .catch(() => {
          entry.refreshing = false;
        });
    }
    return entry.value;
  }

  const value = await fetcher();
  store.set(key, { value, storedAt: Date.now(), refreshing: false });
  return value;
}

export function cacheInvalidate(key: string): void {
  store.delete(key);
}

export function cacheInvalidatePrefix(prefix: string): void {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}
