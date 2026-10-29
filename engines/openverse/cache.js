// A small result cache with in-flight de-duplication, in memory. (degoog gives engines no cache of their own: the useCache of slot
// plugins is not part of an engine's context.) Entries expire after ttlMs and the oldest ones go first when there are too many.
// Keys must never contain a credential.

export class ResultCache {
  constructor({ ttlMs = 3_600_000, max = 200, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
    this.now = now;
    this.entries = new Map();
    this.inflight = new Map();
  }

  get(key) {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.at >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value) {
    this.entries.delete(key);
    this.entries.set(key, { at: this.now(), value });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value);
  }

  clear() {
    this.entries.clear();
  }

  // The cached value, or the one request already running for this key, or a new one from work()
  async once(key, work) {
    const hit = this.get(key);
    if (hit !== undefined) return { value: hit, cached: true };
    let pending = this.inflight.get(key);
    const shared = Boolean(pending);
    if (!pending) {
      pending = work()
        .then((value) => {
          this.set(key, value);
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return { value: await pending, cached: false, shared };
  }
}
