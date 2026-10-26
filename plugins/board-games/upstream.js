import { looksBlocked, readText, retryAfterMs } from "./request.js";

const RATE_PAUSE_MS = 10 * 60_000;
const BLOCK_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const BUDGET_RECHECK_MS = 60 * 60_000;

// One outgoing connection to a third party: its own pause state, request spacing, daily budget and status handling.
// host supplies now(), sleep(ms) and spacingMs (a slot, or a test double), so a test can drive the clock.
//
// request() resolves to { ok: true, status, text } or { ok: false, status, reason }, where reason is one of
// "invalid", "paused", "time", "budget", "network", "rate", "rejected", "busy", "blocked", "server", "http".
// It never throws and never retries. Only generic text is logged (never an address or a credential),
// and a pause logs one line when it starts.
export class Upstream {
  constructor({ host, label, budgetOf = null, blockMessage = "" }) {
    this.host = host;
    this.label = label;
    this.budgetOf = budgetOf;
    this.blockMessage = blockMessage || `${label} refused the request`;
    this.pausedUntil = 0;
    this._lastRequestAt = 0;
    this._gateChain = Promise.resolve();
  }

  get paused() {
    return this.host.now() < this.pausedUntil;
  }

  pause(ms, reason) {
    const wasPaused = this.paused;
    this.pausedUntil = Math.max(this.pausedUntil, this.host.now() + ms);
    if (!wasPaused) console.warn(`[board-games] ${reason}; paused for ${Math.ceil(ms / 60_000)} min`);
  }

  // Requests queue up here and keep at least host.spacingMs apart. False means the wait would not fit
  // in the time the slot has left, so the request is skipped rather than made late.
  async gate(deadline) {
    const before = this._gateChain;
    let release;
    this._gateChain = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const now = this.host.now();
      const wait = this._lastRequestAt + this.host.spacingMs - now;
      if (wait > 0) {
        if (now + wait > deadline) return false;
        await this.host.sleep(wait);
      } else if (now > deadline) return false;
      this._lastRequestAt = this.host.now();
      return true;
    } finally {
      release();
    }
  }

  async request(url, { context, deadline, maxChars = 1_000_000, headers = {} } = {}) {
    const fail = (reason, status = 0) => ({ ok: false, status, reason });
    if (!url) return fail("invalid");
    if (this.paused) return fail("paused");
    if (!(await this.gate(deadline))) return fail("time");
    if (this.paused) return fail("paused");
    const budget = this.budgetOf ? this.budgetOf() : null;
    if (budget && !budget.spend()) {
      this.pause(Math.min(BUDGET_RECHECK_MS, budget.msUntilReset), `the daily ${this.label} request limit is reached`);
      return fail("budget");
    }
    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(url, { headers });
    } catch {
      this.pause(ERROR_PAUSE_MS, `${this.label} could not be reached`);
      return fail("network");
    } finally {
      this._lastRequestAt = this.host.now();
    }
    const status = response.status;
    if (status === 429) {
      this.pause(retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS), `${this.label} rate limited this instance`);
      return fail("rate", status);
    }
    if (status === 401 || status === 403) {
      this.pause(BLOCK_PAUSE_MS, this.blockMessage);
      return fail("rejected", status);
    }
    if (status === 202) {
      this.pause(ERROR_PAUSE_MS, `${this.label} asked to try again later`);
      return fail("busy", status);
    }
    if (status >= 500) {
      // A Cloudflare challenge can come as a 503. It is never solved or bypassed, only waited out.
      const head = await readText(response, 3000);
      if (looksBlocked(head) || response.headers?.get?.("cf-mitigated")) {
        this.pause(BLOCK_PAUSE_MS, this.blockMessage);
        return fail("blocked", status);
      }
      this.pause(ERROR_PAUSE_MS, `${this.label} answered HTTP ${status}`);
      return fail("server", status);
    }
    if (status < 200 || status >= 300) return fail("http", status);
    const text = await readText(response, maxChars);
    if (looksBlocked(text)) {
      this.pause(BLOCK_PAUSE_MS, this.blockMessage);
      return fail("blocked", status);
    }
    return { ok: true, status, text };
  }
}
