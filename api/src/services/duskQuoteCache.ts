/** Small process cache for immutable computations; never stores envelopes.
 * Every caller still reads the transactionally committed history revision and
 * passes the live deployment bracket. Versioned keys survive missed NOTIFYs.
 */
export class QuoteCache<T> {
  private entries = new Map<string,{ value: T; until: number }>();
  private pending = new Map<string,Promise<T>>();
  private generation = 0;
  constructor(private readonly limit: number,private readonly ttl: number) {}
  clear() { this.generation++; this.entries.clear(); this.pending.clear(); }
  async get(key: string,load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.until>Date.now()) {
      this.entries.delete(key); this.entries.set(key,hit);
      return hit.value;
    }
    this.entries.delete(key);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const generation = this.generation;
    const operation = load().then(value => {
      if (generation===this.generation) {
        while (this.entries.size>=this.limit) this.entries.delete(this.entries.keys().next().value!);
        this.entries.set(key,{ value,until:Date.now()+this.ttl });
      }
      return value;
    }).finally(() => { if (this.pending.get(key)===operation) this.pending.delete(key); });
    this.pending.set(key,operation);
    return operation;
  }
}
