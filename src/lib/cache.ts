/**
 * Simple in-memory TTL cache for server-side data fetching.
 *
 * On Vercel, a single lambda instance is reused for a while between requests.
 * Caching dashboard counts and similar "every-N-seconds is fine" data here
 * eliminates ~1s of round-trip per page load when the instance is warm.
 *
 * Cache is per-instance — does NOT sync across lambdas. That's fine for
 * dashboard counters; we accept slight staleness in exchange for speed.
 */

type CacheEntry = { value: unknown; expiresAt: number };
const store = new Map<string, CacheEntry>();

export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as T;
  }
  const value = await loader();
  store.set(key, { value, expiresAt: now + ttlMs });
  // Garbage collect occasionally (every 100 sets)
  if (store.size > 200) {
    for (const [k, v] of store.entries()) {
      if (v.expiresAt < now) store.delete(k);
    }
  }
  return value;
}

/** Invalidate a cache key. Call after mutations. */
export function invalidate(keyOrPrefix: string) {
  for (const k of store.keys()) {
    if (k === keyOrPrefix || k.startsWith(keyOrPrefix + ":")) {
      store.delete(k);
    }
  }
}
