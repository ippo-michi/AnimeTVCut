interface CacheStats {
  entries: number;
  limit: number;
  hits: number;
  misses: number;
  evicted: number;
  expired: number;
}
const caches = new Set<WeakRef<{ cleanup(): void; stats(): CacheStats }>>();

/** TTL entries with an LRU capacity ceiling. Keys and values never enter diagnostics. */
export class BoundedCache<K, V extends { expiresAt: number }> extends Map<
  K,
  V
> {
  private hits = 0;
  private misses = 0;
  private evicted = 0;
  private expired = 0;

  public constructor(
    private readonly limit = 512,
    private readonly now: () => number = Date.now,
  ) {
    super();
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Cache capacity must be a positive integer.");
    caches.add(new WeakRef(this));
  }

  public override get(key: K): V | undefined {
    const value = super.get(key);
    if (value !== undefined && value.expiresAt <= this.now()) {
      super.delete(key);
      this.expired += 1;
    } else if (value !== undefined) {
      this.hits += 1;
      super.delete(key);
      super.set(key, value);
      return value;
    }
    this.misses += 1;
    return undefined;
  }

  public override set(key: K, value: V): this {
    super.delete(key);
    if (this.size >= this.limit) this.cleanup();
    if (this.size >= this.limit) {
      super.delete(this.keys().next().value!);
      this.evicted += 1;
    }
    super.set(key, value);
    return this;
  }

  public cleanup(): void {
    const now = this.now();
    for (const [key, value] of this)
      if (value.expiresAt <= now) {
        super.delete(key);
        this.expired += 1;
      }
  }

  public stats(): CacheStats {
    return {
      entries: this.size,
      limit: this.limit,
      hits: this.hits,
      misses: this.misses,
      evicted: this.evicted,
      expired: this.expired,
    };
  }
}

export function cleanupCaches(): void {
  for (const reference of caches) {
    const cache = reference.deref();
    if (cache === undefined) caches.delete(reference);
    else cache.cleanup();
  }
}

export function cacheStats(): CacheStats {
  const total: CacheStats = {
    entries: 0,
    limit: 0,
    hits: 0,
    misses: 0,
    evicted: 0,
    expired: 0,
  };
  for (const reference of caches) {
    const stats = reference.deref()?.stats();
    if (stats !== undefined)
      for (const key of Object.keys(total) as (keyof CacheStats)[])
        total[key] += stats[key];
  }
  return total;
}
