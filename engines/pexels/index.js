import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { Budget, dataFile } from "./budget.js";
import { ResultCache } from "./cache.js";
import { answerWindowMs, deadlineSignal, startWindowMs } from "./timing.js";
import { API_BASE, FULL_SIZES, ORIENTATIONS, SIZES, buildHeaders, buildRequest, localeOf } from "./request.js";
import { parsePhotos, totalOf } from "./parse.js";
import { clampInt } from "./text.js";

export { filters } from "./request.js";
export const type = "images";

const CACHE_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const RATE_PAUSE_MS = 15 * 60_000;
const RATE_PAUSE_MAX_MS = 60 * 60_000;
const REJECT_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const MAX_BODY_CHARS = 2_000_000;
const MAX_MONTH_PAUSE_MS = 32 * 24 * 3_600_000;

const minutes = (ms) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;

// Pexels photos through the official API. The key goes in the Authorization header only. One request per page, no retries, an hourly
// and a monthly request budget kept on disk, and every result credits the photographer and links to the photo page on Pexels.
export default class PexelsEngine {
  isClientExposed = false;
  name = "Pexels";
  bangShortcut = "pexels";
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  perPage = 30;
  orientation = "any";
  size = "any";
  locale = "";
  fullSize = "large2x";
  debugMatching = false;
  apiBase = process.env.DEGOOG_PEXELS_API_BASE || API_BASE;
  extraHosts = (process.env.DEGOOG_PEXELS_EXTRA_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean); // tests against a mock only
  now = Date.now;

  limiter = new Limiter({ minIntervalMs: 1000, maxWaitMs: 5000 });
  budget = new Budget({
    file: dataFile("pexels", "DEGOOG_PEXELS_USAGE_FILE"),
    windows: [
      { name: "hour", unit: "hour", limit: 200 },
      { name: "month", unit: "month", limit: 20000 },
    ],
  });
  cache = new ResultCache({ ttlMs: CACHE_MS, max: CACHE_MAX_ENTRIES });
  _pauseNote = "paused";

  configure(settings = {}) {
    this.apiKey = String(settings.apiKey || process.env.PEXELS_API_KEY || "").trim();
    this.perPage = clampInt(settings.perPage, 10, 80, 30);
    this.orientation = ORIENTATIONS.includes(settings.orientation) ? settings.orientation : "any";
    this.size = SIZES.includes(settings.size) ? settings.size : "any";
    this.locale = String(settings.locale ?? "").trim();
    this.fullSize = FULL_SIZES.includes(settings.fullSize) ? settings.fullSize : "large2x";
    this.debugMatching = settings.debugMatching === true || settings.debugMatching === "true";
    this.budget.setLimit("hour", clampInt(settings.hourlyLimit, 0, 1_000_000, 200));
    this.budget.setLimit("month", clampInt(settings.monthlyLimit, 0, 100_000_000, 20000));
    this.cache.clear(); // results are shaped when they arrive, so a changed setting needs fresh ones
  }

  _error(context, status, message) {
    return context?.engineError ? context.engineError(status, message, { engine: this.name }) : new Error(message);
  }

  _debug(text) {
    if (this.debugMatching) console.info(`[pexels] ${text}`);
  }

  _pause(ms, note, log = "") {
    const wasPaused = this.limiter.blockedFor() > 0;
    this._pauseNote = note;
    this.limiter.penalize(ms);
    if (log && !wasPaused) console.warn(`[pexels] ${log}`);
  }

  _paused(context, ms) {
    return this._error(context, "rate_limited", `${this.name} is ${this._pauseNote}, paused for ${ms >= 60_000 ? minutes(ms) : `${Math.ceil(ms / 1000)} s`}`);
  }

  async _request(request, context, startedAt) {
    const paused = this.limiter.blockedFor();
    if (paused > 0) throw this._paused(context, paused);
    const wait = this.budget.waitMs();
    if (wait > 0) {
      this._pause(wait, "at its request budget (hourly or monthly)", `the request budget is used up; the engine waits ${minutes(wait)}.`);
      throw this._paused(context, wait);
    }
    this.limiter.maxWaitMs = Math.min(5000, startWindowMs() - (this.now() - startedAt));
    if (this.limiter.maxWaitMs <= 0 || !(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }
    if (this.now() - startedAt > startWindowMs()) throw this._error(context, "rate_limited", `${this.name} skipped: too little time left in this search`);
    this.budget.spend();

    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(request.url, { headers: buildHeaders(this.apiKey), signal: deadlineSignal(answerWindowMs() - (this.now() - startedAt), context?.signal) });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (!timedOut) this._pause(ERROR_PAUSE_MS, "unreachable", "Pexels could not be reached; the engine pauses for 1 min.");
      throw this._error(context, timedOut ? "timeout" : "network", `${this.name} ${timedOut ? "did not answer in time" : "could not be reached"}`);
    }

    if (response.status === 429) {
      // Pexels sends no rate limit headers with a 429: wait for Retry-After, or a quarter of an hour
      const pause = retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS, RATE_PAUSE_MAX_MS);
      this._pause(pause, "rate limited by Pexels", `Pexels answered "too many requests"; the engine pauses for ${minutes(pause)}.`);
      throw this._paused(context, pause);
    }
    if (response.status === 401 || response.status === 403) {
      this._pause(REJECT_PAUSE_MS, "refused by Pexels (check the API key)", "Pexels rejected the API key; the engine pauses for 30 min.");
      throw this._error(context, "blocked", `${this.name} rejected the API key`);
    }
    if (response.status >= 500) {
      this._pause(ERROR_PAUSE_MS, "having trouble", `Pexels answered HTTP ${response.status}; the engine pauses for 1 min.`);
      throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    // successful replies carry the monthly quota: X-Ratelimit-Limit / -Remaining / -Reset (a UNIX time)
    const header = (name) => response.headers?.get?.(name);
    const limit = Number(header("x-ratelimit-limit"));
    const remaining = header("x-ratelimit-remaining");
    if (Number.isFinite(limit) && limit > 0 && remaining !== null && remaining !== undefined && remaining !== "" && Number.isFinite(Number(remaining))) {
      this.budget.syncUsed("month", limit - Number(remaining));
      if (Number(remaining) <= 0) {
        const resetAt = Number(header("x-ratelimit-reset")) * 1000;
        const ms = Number.isFinite(resetAt) && resetAt > this.now() ? Math.min(MAX_MONTH_PAUSE_MS, resetAt - this.now()) : 60 * 60_000;
        this.budget.exhaust("month");
        this._pause(ms, "out of its monthly requests", `the monthly request quota is used up; the engine waits ${minutes(ms)}.`);
      }
    }

    let data;
    try {
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) throw new Error("too long");
      data = JSON.parse(text);
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
    const results = parsePhotos(data, this.name, { fullSize: this.fullSize, extraHosts: this.extraHosts });
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return { results, total: totalOf(data) };
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const startedAt = this.now();
    const text = String(query ?? "").trim();
    if (!text) return [];
    if (!this.apiKey) {
      this._debug("no api key: nothing asked (set one in the engine's settings or PEXELS_API_KEY)");
      return [];
    }
    const number = Math.max(1, Math.trunc(Number(page)) || 1);
    const request = buildRequest(
      text,
      number,
      { perPage: this.perPage, orientation: this.orientation, size: this.size, locale: this.locale || localeOf(context?.lang), imageFilter: context?.imageFilter },
      this.apiBase,
    );
    const key = `${request.cacheKey}|${this.fullSize}`;
    try {
      const { value, cached, shared } = await this.cache.once(key, () => this._request(request, context, startedAt));
      this._debug(`page ${number}: ${cached ? "cache hit" : shared ? "joined a request already running" : "requested"}, ${value.results.length} photos`);
      if (typeof value.total === "number") context?.pagination?.({ total: value.total });
      return value.results;
    } catch (error) {
      this._debug(`page ${number}: ${error?.message}`);
      throw error;
    }
  }
}
