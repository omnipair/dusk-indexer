interface CacheEntry {
  data: any;
  timestamp: number;
  ttl: number; 
}

const MAX_CACHE_ENTRIES = 10_000;

class SimpleCache {
  private cache: Map<string, CacheEntry> = new Map();
  private inflight: Map<string, Promise<any>> = new Map();

  set(key: string, data: any, ttlMs: number = 60000): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(key)) {
      this.evictOldest();
    }
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttlMs
    });
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Returns cached data if available. On a miss, only the first caller runs
   * the fetcher; concurrent callers await the same in-flight promise.
   */
  async getOrSet<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== null) {
      return cached as T;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return pending as Promise<T>;
    }

    const promise = fetcher()
      .then((data) => {
        if (data != null) {
          this.set(key, data, ttlMs);
        }
        return data;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  private evictOldest(): void {
    this.cleanup();
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
  }
}

export const cache = new SimpleCache();

setInterval(() => {
  cache.cleanup();
}, 5 * 60 * 1000);

export default cache;
