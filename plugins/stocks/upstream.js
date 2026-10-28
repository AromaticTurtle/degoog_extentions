// The one outgoing connection to Finnhub: pause state, a request spacing, a sliding per-minute cap (the free plan allows 60 calls a
// minute; this stays at 50), a daily budget and status handling. host supplies now(), sleep(ms), spacingMs (optional number),
// and debugMatching (a boolean).
//
// request() resolves to { ok: true, status, text } or { ok: false, status, reason }, where reason is one of
// "invalid", "paused", "time", "budget", "network", "rate", "unauthorized", "forbidden", "notfound", "server", "http".
// It never throws and never retries. The API key is only ever put in a request HEADER (by the caller); it is never logged, and only
// generic text is logged. A 401 pauses quietly (explained in debugMatching only), a 403 is NOT a pause: it is what Finnhub answers
// for a symbol or an endpoint the plan does not include.

const BUDGET_RECHECK_MS = 60 * 60_000;
const UNAUTHORIZED_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const WINDOW_MS = 60_000;

export const retryAfterMs = (header, fallbackMs, maxMs = 300_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};

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

export class FinnhubUpstream {
  constructor({ host, spacingMs = 200, perMinute = 50, budgetOf = null }) {
    this.host = host;
    this.minSpacingMs = spacingMs;
    this.perMinute = perMinute;
    this.budgetOf = budgetOf;
    this.pausedUntil = 0;
    this._lastRequestAt = 0;
    this._stamps = [];
    this._gateChain = Promise.resolve();
  }

  get spacing() {
    return typeof this.host.spacingMs === "number" ? this.host.spacingMs : this.minSpacingMs;
  }

  get paused() {
    return this.host.now() < this.pausedUntil;
  }

  pause(ms, reason, { quiet = false } = {}) {
    const wasPaused = this.paused;
    this.pausedUntil = Math.max(this.pausedUntil, this.host.now() + ms);
    if (wasPaused) return;
    const line = `[stocks] ${reason}; paused for ${Math.max(1, Math.ceil(ms / 60_000))} min`;
    if (!quiet) console.warn(line);
    else if (this.host.debugMatching) console.info(line);
  }

  // Requests queue up here, keep `spacing` apart and stay under the per-minute cap. False means the wait would not fit in the
  // time the slot has left, so the request is skipped rather than made late.
  async gate(deadline) {
    const before = this._gateChain;
    let release;
    this._gateChain = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      let now = this.host.now();
      let wait = this._lastRequestAt + this.spacing - now;
      this._stamps = this._stamps.filter((t) => now - t < WINDOW_MS);
      if (this._stamps.length >= this.perMinute) wait = Math.max(wait, this._stamps[0] + WINDOW_MS - now);
      if (wait > 0) {
        if (now + wait > deadline) return false;
        await this.host.sleep(wait);
        now = this.host.now();
      } else if (now > deadline) return false;
      this._lastRequestAt = now;
      this._stamps.push(now);
      return true;
    } finally {
      release();
    }
  }

  async request(url, { context, deadline, maxChars = 500_000, headers = {} } = {}) {
    const fail = (reason, status = 0) => ({ ok: false, status, reason });
    if (!url) return fail("invalid");
    if (this.paused) return fail("paused");
    if (!(await this.gate(deadline))) return fail("time");
    if (this.paused) return fail("paused");
    const budget = this.budgetOf ? this.budgetOf() : null;
    if (budget && !budget.spend()) {
      this.pause(Math.min(BUDGET_RECHECK_MS, budget.msUntilReset), "the daily Finnhub request limit is reached");
      return fail("budget");
    }
    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(url, { headers });
    } catch {
      this.pause(ERROR_PAUSE_MS, "Finnhub could not be reached");
      return fail("network");
    } finally {
      this._lastRequestAt = this.host.now();
    }
    const status = response.status;
    if (status === 429) {
      this.pause(retryAfterMs(response.headers?.get?.("retry-after"), 60_000), "Finnhub rate limited this instance");
      return fail("rate", status);
    }
    if (status === 401) {
      this.pause(UNAUTHORIZED_PAUSE_MS, "Finnhub rejected the API key (invalid or revoked)", { quiet: true });
      return fail("unauthorized", status);
    }
    if (status === 403) return fail("forbidden", status);
    if (status === 404) return fail("notfound", status);
    if (status >= 500) {
      this.pause(ERROR_PAUSE_MS, `Finnhub answered HTTP ${status}`);
      return fail("server", status);
    }
    if (status < 200 || status >= 300) return fail("http", status);
    const text = await readText(response, maxChars);
    return { ok: true, status, text };
  }
}
