/**
 * Bounded least-recently-used cache for async results. It holds the in-flight
 * promise, so concurrent callers for a key share one load. Failures are dropped
 * rather than cached.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; expiresAt: number }>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  getOrLoad(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    this.entries.delete(key);
    if (hit && hit.expiresAt > Date.now()) {
      // Re-inserting moves the key to the newest end of the Map's order.
      this.entries.set(key, hit);
      return hit.value;
    }

    const entry = { value: load(), expiresAt: Date.now() + ttlMs };
    this.entries.set(key, entry);
    entry.value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
    return entry.value;
  }
}
