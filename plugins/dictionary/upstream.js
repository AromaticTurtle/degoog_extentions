// One outgoing connection to a third party: its own pause state, request spacing, optional daily budget and status handling.
// host supplies now(), sleep(ms) and optionally spacingMs (a number, mostly for tests that drive the clock).
//
// request() resolves to { ok: true, status, text, headers } or { ok: false, status, reason }, where reason is one of
// "invalid", "paused", "time", "budget", "network", "rate", "rejected", "server", "http".
// It never throws and never retries. Only generic text is logged (never an address or a credential),
// and a pause logs one line when it starts.

const BUDGET_RECHECK_MS = 60 * 60_000;
const REJECTED_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;

export const retryAfterMs = (header, fallbackMs, maxMs = 3_600_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};

// Reads at most maxChars (plus one, so a longer reply can be told apart) and stops downloading after that.
export const readText = async (response, maxChars) => {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") return (await response.text()).slice(0, maxChars + 1);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > maxChars) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return out.slice(0, maxChars + 1);
  } catch {
    return "";
  }
};

export class Upstream {
  constructor({ host, label, spacingMs = 1000, budgetOf = null, rateDefaultMs = 60_000, rateMaxMs = 3_600_000, rejectedMessage = "" }) {
    this.host = host;
    this.label = label;
    this.minSpacingMs = spacingMs;
    this.budgetOf = budgetOf;
    this.rateDefaultMs = rateDefaultMs;
    this.rateMaxMs = rateMaxMs;
    this.rejectedMessage = rejectedMessage || `${label} refused the request`;
    this.pausedUntil = 0;
    this._lastRequestAt = 0;
    this._gateChain = Promise.resolve();
  }

  get spacing() {
    return typeof this.host.spacingMs === "number" ? this.host.spacingMs : this.minSpacingMs;
  }

  get paused() {
    return this.host.now() < this.pausedUntil;
  }

  pause(ms, reason) {
    const wasPaused = this.paused;
    this.pausedUntil = Math.max(this.pausedUntil, this.host.now() + ms);
    if (!wasPaused) console.warn(`[dictionary] ${reason}; paused for ${Math.max(1, Math.ceil(ms / 60_000))} min`);
  }

  // Requests queue up here and keep at least `spacing` apart. False means the wait would not fit in the time the slot
  // has left, so the request is skipped rather than made late.
  async gate(deadline) {
    const before = this._gateChain;
    let release;
    this._gateChain = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const now = this.host.now();
      const wait = this._lastRequestAt + this.spacing - now;
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
      this.pause(retryAfterMs(response.headers?.get?.("retry-after"), this.rateDefaultMs, this.rateMaxMs), `${this.label} rate limited this instance`);
      return fail("rate", status);
    }
    if (status === 401 || status === 403) {
      this.pause(REJECTED_PAUSE_MS, this.rejectedMessage);
      return fail("rejected", status);
    }
    if (status >= 500) {
      this.pause(ERROR_PAUSE_MS, `${this.label} answered HTTP ${status}`);
      return fail("server", status);
    }
    if (status < 200 || status >= 300) return fail("http", status);
    const text = await readText(response, maxChars);
    return { ok: true, status, text, headers: response.headers };
  }
}
