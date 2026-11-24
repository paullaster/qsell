/**
 * A small result cache for reports. Dashboards are opened by many people at once, so identical requests inside the
 * time window share one read, and requests that arrive while the first is still being worked out wait for it instead
 * of starting their own. The key must carry everything that changes the answer, including the viewer's permissions
 * (the runner builds it that way), so one person's view can never be served to someone allowed less.
 *
 * The cache lives in one process; another server keeps its own. It is bounded and never holds an error.
 */
export class ResultCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** The kept value if it is still fresh. */
  peek(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /**
   * The value for a key: from the cache (`source: 'cache'`), from a read already running (`'shared'`), or from
   * `compute` (`'fresh'`). A failed `compute` is not kept and is seen by everyone who was waiting on it.
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<T>,
  ): Promise<{ value: T; source: 'cache' | 'shared' | 'fresh' }> {
    const kept = this.peek(key);
    if (kept !== undefined) return { value: kept, source: 'cache' };
    const running = this.inFlight.get(key);
    if (running !== undefined) return { value: await running, source: 'shared' };

    const run = compute()
      .then((value) => {
        this.remember(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, run);
    return { value: await run, source: 'fresh' };
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  private remember(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.clock() + this.ttlMs });
  }
}
