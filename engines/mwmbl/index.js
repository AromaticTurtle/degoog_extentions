import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { DEFAULT_API_BASE, buildHeaders, buildSearchUrl, cacheKey } from "./request.js";
import { parseResults } from "./parse.js";
import { clampInt } from "./text.js";

const CACHE_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 50;
const RATE_PAUSE_MS = 60_000;
const QUOTA_PAUSE_MS = 6 * 60 * 60_000;

export default class MwmblEngine {
  isClientExposed = false;
  name = "Mwmbl";
  bangShortcut = "mwmbl";
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  perPage = 10;
  requireSnippet = false;
  limiter = new Limiter({ minIntervalMs: 1000, maxWaitMs: 5000 });
  apiBase = process.env.DEGOOG_MWMBL_API_BASE || DEFAULT_API_BASE;
  now = Date.now;

  _cache = new Map();
  _inflight = new Map();
  _pauseNote = "rate limiting this instance";

  configure(settings) {
    this.apiKey = String(settings.apiKey || process.env.MWMBL_API_KEY || "").trim();
    this.perPage = clampInt(settings.perPage, 5, 50, 10);
    this.requireSnippet = settings.requireSnippet === true || settings.requireSnippet === "true";
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  _paused(context, ms) {
    return this._error(
      context,
      "rate_limited",
      `${this.name} is ${this._pauseNote}, paused for ${ms >= 3_600_000 ? `${Math.ceil(ms / 3_600_000)} h` : `${Math.ceil(ms / 1000)} s`}`,
    );
  }

  async _request(text, context) {
    const paused = this.limiter.blockedFor();
    if (paused > 0) throw this._paused(context, paused);
    if (!(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }

    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(buildSearchUrl(text, this.apiBase), { headers: buildHeaders(this.apiKey) });

    if (response.status === 429 || response.status === 503) {
      const body = await response.clone().text().catch(() => "");
      const monthly = /monthly quota/i.test(body);
      this._pauseNote = monthly ? "out of its monthly quota for this key" : "rate limiting this instance";
      const pause = monthly ? QUOTA_PAUSE_MS : retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS, 10 * 60_000);
      this.limiter.penalize(pause);
      throw this._paused(context, pause);
    }
    if (response.status === 401) {
      throw this._error(context, "blocked", `${this.name} rejected the API key`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
    const results = parseResults(data, this.name);
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return results;
  }

  async _results(text, context) {
    const key = cacheKey(text);
    const hit = this._cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.results;
    if (hit) this._cache.delete(key);

    let pending = this._inflight.get(key);
    if (!pending) {
      pending = this._request(text, context)
        .then((results) => {
          this._cache.set(key, { at: this.now(), results });
          while (this._cache.size > CACHE_MAX_ENTRIES) this._cache.delete(this._cache.keys().next().value);
          return results;
        })
        .finally(() => this._inflight.delete(key));
      this._inflight.set(key, pending);
    }
    return pending;
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const text = String(query ?? "").trim();
    if (!text) return [];
    const all = (await this._results(text, context)).filter((result) => !this.requireSnippet || result.snippet);
    const start = (Math.max(1, page || 1) - 1) * this.perPage;
    return all.slice(start, start + this.perPage);
  }
}
