type CacheEntry = { expiresAt: number; value: unknown };

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<unknown>>();
const versions = new Map<string, number>();
const MAX_ENTRIES = 128;

/** Coalesce identical reads and briefly reuse successful results within this process. */
export async function cachedFirestoreRead<T>(key: string, load: () => Promise<T>, ttlMs = 2_000): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  if (hit) cache.delete(key);

  const inFlight = pending.get(key);
  if (inFlight) return inFlight as Promise<T>;

  const version = versions.get(key) ?? 0;
  const read = Promise.resolve().then(load);
  pending.set(key, read);
  try {
    const value = await read;
    if ((versions.get(key) ?? 0) === version && ttlMs > 0) {
      while (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      cache.set(key, { value, expiresAt: Date.now() + ttlMs });
    }
    return value;
  } finally {
    if (pending.get(key) === read) pending.delete(key);
    if (!pending.has(key)) versions.delete(key);
  }
}

/** Invalidate one key or every cached/in-flight read sharing a prefix. */
export function invalidateFirestoreReadCache(prefix: string): void {
  const keys = new Set([...cache.keys(), ...pending.keys()]);
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    cache.delete(key);
    if (pending.has(key)) {
      pending.delete(key);
      versions.set(key, (versions.get(key) ?? 0) + 1);
    }
  }
}
