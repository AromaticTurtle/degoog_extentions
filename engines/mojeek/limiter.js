const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const retryAfterMs = (header, fallbackMs = 60_000, maxMs = 600_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};

export class Limiter {
  constructor({ minIntervalMs = 1000, maxWaitMs = 5000, now = Date.now, wait = sleep } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxWaitMs = maxWaitMs;
    this.now = now;
    this.wait = wait;
    this.nextSlot = 0;
    this.blockedUntil = 0;
  }

  blockedFor() {
    return Math.max(0, this.blockedUntil - this.now());
  }

  penalize(ms) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }

  async acquire() {
    const now = this.now();
    const start = Math.max(now, this.nextSlot);
    const delay = start - now;
    if (delay > this.maxWaitMs) return false;
    this.nextSlot = start + this.minIntervalMs;
    if (delay > 0) await this.wait(delay);
    return true;
  }
}
