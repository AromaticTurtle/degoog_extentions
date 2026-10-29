import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { Budget, dataFile } from "./budget.js";
import { ResultCache } from "./cache.js";
import { TokenSource } from "./auth.js";
import { answerWindowMs, deadlineSignal, startWindowMs } from "./timing.js";
import { API_BASE, CATEGORIES, LICENSE_TYPES, buildHeaders, buildRequest, redact } from "./request.js";
import { parseImages, totalOf } from "./parse.js";
import { clampInt } from "./text.js";

export { filters } from "./request.js";
export const type = "images";

const CACHE_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const RATE_PAUSE_MS = 10 * 60_000;
const RATE_PAUSE_MAX_MS = 6 * 3_600_000;
const REJECT_PAUSE_MS = 10 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const MAX_BODY_CHARS = 3_000_000;
const ANONYMOUS_MAX_PAGE_SIZE = 20;
const ANON = ["anon-hour", "anon-day"];
const REGISTERED = ["auth-minute", "auth-day"];

const minutes = (ms) => `${Math.max(1, Math.ceil(ms / 60_000))} min`;

// Openverse images (Creative Commons and public domain) through the official API, anonymously or, with a client ID and secret,
// with an OAuth2 token for higher limits. Every result carries its licence and creator; mature results are never asked for unless
// the user turns that on. One request per page, no retries, budgets kept on disk, results cached for an hour.
export default class OpenverseEngine {
  isClientExposed = false;
  name = "Openverse";
  bangShortcut = "openverse";
  settingsSchema = SETTINGS_SCHEMA;

  pageSize = 20;
  licenseType = "all";
  category = "any";
  source = "";
  extension = "";
  includeMature = false;
  debugMatching = false;
  apiBase = process.env.DEGOOG_OPENVERSE_API_BASE || API_BASE;
  now = Date.now;

  limiter = new Limiter({ minIntervalMs: 1500, maxWaitMs: 5000 });
  budget = new Budget({
    file: dataFile("openverse", "DEGOOG_OPENVERSE_USAGE_FILE"),
    windows: [
      { name: "anon-hour", unit: "hour", limit: 5 },
      { name: "anon-day", unit: "day", limit: 100 },
      { name: "auth-minute", unit: "minute", limit: 100 },
      { name: "auth-day", unit: "day", limit: 10000 },
    ],
  });
  cache = new ResultCache({ ttlMs: CACHE_MS, max: CACHE_MAX_ENTRIES });
  tokens = new TokenSource({ base: this.apiBase });
  _pauseNote = "paused";

  configure(settings = {}) {
    this.tokens.base = this.apiBase;
    this.tokens.configure(settings.clientId || process.env.OPENVERSE_CLIENT_ID, settings.clientSecret || process.env.OPENVERSE_CLIENT_SECRET);
    this.pageSize = clampInt(settings.pageSize, 1, 50, 20);
    this.licenseType = LICENSE_TYPES.includes(settings.licenseType) ? settings.licenseType : "all";
    this.category = CATEGORIES.includes(settings.category) ? settings.category : "any";
    this.source = String(settings.source ?? "");
    this.extension = String(settings.extension ?? "");
    this.includeMature = settings.includeMature === true || settings.includeMature === "true";
    this.debugMatching = settings.debugMatching === true || settings.debugMatching === "true";
    this.budget.setLimit("anon-hour", clampInt(settings.anonymousHourlyLimit, 0, 100_000, 5));
    this.budget.setLimit("anon-day", clampInt(settings.anonymousDailyLimit, 0, 1_000_000, 100));
    this.budget.setLimit("auth-day", clampInt(settings.registeredDailyLimit, 0, 100_000_000, 10000));
    this.cache.clear();
  }

  _error(context, status, message) {
    return context?.engineError ? context.engineError(status, message, { engine: this.name }) : new Error(message);
  }

  _debug(text) {
    if (this.debugMatching) console.info(`[openverse] ${text}`);
  }

  _pause(ms, note, log = "") {
    const wasPaused = this.limiter.blockedFor() > 0;
    this._pauseNote = note;
    this.limiter.penalize(ms);
    if (log && !wasPaused) console.warn(`[openverse] ${log}`);
  }

  _paused(context, ms) {
    return this._error(context, "rate_limited", `${this.name} is ${this._pauseNote}, paused for ${ms >= 60_000 ? minutes(ms) : `${Math.ceil(ms / 1000)} s`}`);
  }

  _secrets() {
    return [this.tokens.clientSecret, this.tokens.token];
  }

  async _request(request, context, startedAt) {
    const paused = this.limiter.blockedFor();
    if (paused > 0) throw this._paused(context, paused);
    const doFetch = context?.fetch ?? fetch;

    // credentials -> a token (or "" and anonymous when it cannot be had). The token request gets at most 40 % of the answer window
    // (3 s at most) so a slow token endpoint never leaves the search itself without time.
    const wasEnabled = this.tokens.enabled;
    const tokenMs = Math.min(3000, Math.round(answerWindowMs() * 0.4), answerWindowMs() - (this.now() - startedAt));
    const token = await this.tokens.get(doFetch, { signal: deadlineSignal(tokenMs, context?.signal) });
    if (wasEnabled && !token && this.tokens.lastProblem) this._debug(`no access token (${this.tokens.lastProblem}); searching anonymously`);
    const windows = token ? REGISTERED : ANON;

    const wait = this.budget.waitMs(windows);
    if (wait > 0) {
      this._pause(wait, token ? "at its daily request budget" : "at the anonymous request limit", `${token ? "the request budget" : "the anonymous request limit"} is used up; the engine waits ${minutes(wait)}.`);
      throw this._paused(context, wait);
    }
    this.limiter.maxWaitMs = Math.min(5000, startWindowMs() - (this.now() - startedAt));
    if (this.limiter.maxWaitMs <= 0 || !(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }
    if (this.now() - startedAt > startWindowMs()) throw this._error(context, "rate_limited", `${this.name} skipped: too little time left in this search`);
    this.budget.spend(windows);

    let response;
    try {
      response = await doFetch(request.url, { headers: buildHeaders(token), signal: deadlineSignal(answerWindowMs() - (this.now() - startedAt), context?.signal) });
    } catch (error) {
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (!timedOut) this._pause(ERROR_PAUSE_MS, "unreachable", "Openverse could not be reached; the engine pauses for 1 min.");
      throw this._error(context, timedOut ? "timeout" : "network", `${this.name} ${timedOut ? "did not answer in time" : "could not be reached"}`);
    }

    if (response.status === 429) {
      const pause = retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS, RATE_PAUSE_MAX_MS);
      this._pause(pause, token ? "rate limited by Openverse" : "rate limited by Openverse (anonymous use is limited, see the README)", `Openverse answered "too many requests"; the engine pauses for ${minutes(pause)}.`);
      throw this._paused(context, pause);
    }
    if (response.status === 401 || response.status === 403) {
      if (token) {
        this.tokens.invalidate();
        this.tokens.failedUntil = this.now() + REJECT_PAUSE_MS;
      }
      this._pause(REJECT_PAUSE_MS, token ? "refused by Openverse (the access token was rejected)" : "refused by Openverse", `Openverse refused the request${token ? " (the access token was rejected; anonymous for a while)" : ""}; the engine pauses for 10 min.`);
      throw this._error(context, "blocked", `${this.name} refused the request`);
    }
    if (response.status === 400) {
      // a page beyond what Openverse serves answers 400 with a short message
      const text = await response.text().catch(() => "");
      if (/pagination|out of range|invalid page|page_size/i.test(text.slice(0, 2000))) return { results: [], total: undefined };
      throw this._error(context, "network", `${this.name} rejected the request (HTTP 400)`);
    }
    if (response.status >= 500) {
      // a gateway time-out or an overloaded API usually says when to come back (Retry-After); never less than a minute, at most 10
      const pause = Math.max(ERROR_PAUSE_MS, retryAfterMs(response.headers?.get?.("retry-after"), ERROR_PAUSE_MS, 10 * 60_000));
      this._pause(pause, "having trouble", `Openverse answered HTTP ${response.status}; the engine pauses for ${minutes(pause)}.`);
      throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    let data;
    try {
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) throw new Error("too long");
      data = JSON.parse(text);
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
    const results = parseImages(data, this.name);
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return { results, total: totalOf(data) };
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const startedAt = this.now();
    const text = String(query ?? "").trim();
    if (!text) return [];
    const number = Math.max(1, Math.trunc(Number(page)) || 1);
    // anonymous requests may ask for fewer results per page than registered ones
    const pageSize = this.tokens.enabled ? this.pageSize : Math.min(this.pageSize, ANONYMOUS_MAX_PAGE_SIZE);
    const request = buildRequest(
      text,
      number,
      { pageSize, licenseType: this.licenseType, category: this.category, source: this.source, extension: this.extension, includeMature: this.includeMature, imageFilter: context?.imageFilter },
      this.apiBase,
    );
    try {
      const { value, cached, shared } = await this.cache.once(request.cacheKey, () => this._request(request, context, startedAt));
      this._debug(`page ${number}: ${cached ? "cache hit" : shared ? "joined a request already running" : "requested"}, ${value.results.length} images (${this.tokens.token ? "with credentials" : "anonymous"})`);
      if (typeof value.total === "number") context?.pagination?.({ total: value.total });
      return value.results;
    } catch (error) {
      this._debug(`page ${number}: ${redact(error?.message, this._secrets())}`);
      throw error;
    }
  }
}
