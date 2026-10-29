import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { Budget } from "./budget.js";
import { ResultCache } from "./cache.js";
import { answerWindowMs, deadlineSignal, startWindowMs } from "./timing.js";
import { API_BASE, IMAGE_TYPES, MAX_HITS, ORDERS, ORIENTATIONS, buildHeaders, buildRequest, languageOf, redact } from "./request.js";
import { parseHits, totalOf } from "./parse.js";
import { clampInt } from "./text.js";

export { filters } from "./request.js";
export const type = "images";

const CACHE_MS = 24 * 60 * 60 * 1000; // Pixabay: "requests must be cached for 24 hours"
const CACHE_MAX_ENTRIES = 300;
const REJECT_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const RATE_PAUSE_MS = 60_000;
const RATE_PAUSE_MAX_MS = 5 * 60_000;
const MAX_BODY_CHARS = 2_000_000;

// Pixabay images through the official API. One request per page, no retries, every search cached for 24 hours. The API key is part
// of the request address (Pixabay has no header authentication), so no address, query or key is ever logged or put in an error.
export default class PixabayEngine {
  isClientExposed = false;
  name = "Pixabay";
  bangShortcut = "pixabay";
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  perPage = 30;
  imageType = "all";
  orientation = "all";
  order = "popular";
  safeAlways = true;
  language = "";
  debugMatching = false;
  apiBase = process.env.DEGOOG_PIXABAY_API_BASE || API_BASE;
  extraHosts = (process.env.DEGOOG_PIXABAY_EXTRA_HOSTS || "").split(",").map((h) => h.trim()).filter(Boolean); // tests against a mock only
  now = Date.now;

  limiter = new Limiter({ minIntervalMs: 700, maxWaitMs: 5000 });
  budget = new Budget({ windows: [{ name: "minute", unit: "minute", limit: 80 }] });
  cache = new ResultCache({ ttlMs: CACHE_MS, max: CACHE_MAX_ENTRIES });
  _pauseNote = "paused";

  configure(settings = {}) {
    this.apiKey = String(settings.apiKey || process.env.PIXABAY_API_KEY || "").trim();
    this.perPage = clampInt(settings.perPage, 3, 100, 30);
    this.imageType = IMAGE_TYPES.includes(settings.imageType) ? settings.imageType : "all";
    this.orientation = ORIENTATIONS.includes(settings.orientation) ? settings.orientation : "all";
    this.order = ORDERS.includes(settings.order) ? settings.order : "popular";
    this.safeAlways = settings.safeSearch !== "follow";
    this.language = String(settings.language ?? "").trim();
    this.debugMatching = settings.debugMatching === true || settings.debugMatching === "true";
    this.budget.setLimit("minute", clampInt(settings.requestsPerMinute, 0, 100, 80));
  }

  _error(context, status, message) {
    return context?.engineError ? context.engineError(status, message, { engine: this.name }) : new Error(message);
  }

  _debug(text) {
    if (this.debugMatching) console.info(`[pixabay] ${text}`);
  }

  _pause(ms, note, log = "") {
    const wasPaused = this.limiter.blockedFor() > 0;
    this._pauseNote = note;
    this.limiter.penalize(ms);
    if (log && !wasPaused) console.warn(`[pixabay] ${log}`);
  }

  _paused(context, ms) {
    return this._error(context, "rate_limited", `${this.name} is ${this._pauseNote}, paused for ${ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`}`);
  }

  async _request(request, context, startedAt) {
    const paused = this.limiter.blockedFor();
    if (paused > 0) throw this._paused(context, paused);
    const elapsed = this.now() - startedAt;
    this.limiter.maxWaitMs = Math.min(5000, startWindowMs() - elapsed);
    if (this.limiter.maxWaitMs <= 0 || !(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }
    if (this.now() - startedAt > startWindowMs()) throw this._error(context, "rate_limited", `${this.name} skipped: too little time left in this search`);
    if (!this.budget.spend()) {
      const wait = this.budget.waitMs();
      this._pause(wait, "at its requests-per-minute cap", "");
      throw this._paused(context, wait);
    }

    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(request.url, { headers: buildHeaders(), signal: deadlineSignal(answerWindowMs() - (this.now() - startedAt), context?.signal) });
    } catch (error) {
      // never pass the original message on: a fetch error names the address, and the address holds the key
      const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
      if (!timedOut) this._pause(ERROR_PAUSE_MS, "unreachable", "Pixabay could not be reached; the engine pauses for 1 min.");
      throw this._error(context, timedOut ? "timeout" : "network", `${this.name} ${timedOut ? "did not answer in time" : "could not be reached"}`);
    }

    const resetSeconds = Number.parseInt(String(response.headers?.get?.("x-ratelimit-reset") ?? ""), 10);
    const resetMs = Number.isFinite(resetSeconds) && resetSeconds > 0 ? Math.min(RATE_PAUSE_MAX_MS, resetSeconds * 1000) : 0;
    if (response.status === 429) {
      const pause = resetMs || retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS, RATE_PAUSE_MAX_MS);
      this._pause(pause, "rate limited by Pixabay", `Pixabay answered "rate limit exceeded"; the engine pauses for ${Math.ceil(pause / 1000)} s.`);
      throw this._paused(context, pause);
    }
    if (response.status === 401 || response.status === 403) {
      this._pause(REJECT_PAUSE_MS, "refused by Pixabay (check the API key)", "Pixabay rejected the API key; the engine pauses for 30 min.");
      throw this._error(context, "blocked", `${this.name} rejected the API key`);
    }
    if (response.status === 400) {
      // asking for a page beyond the 500 images Pixabay serves answers 400 with a plain-text message
      const text = await response.text().catch(() => "");
      if (/out of valid range/i.test(text)) return { results: [], total: undefined };
      // an unknown key is answered with 400 and a plain-text message that names the key problem
      if (/api key/i.test(text.slice(0, 500))) {
        this._pause(REJECT_PAUSE_MS, "refused by Pixabay (check the API key)", "Pixabay rejected the API key; the engine pauses for 30 min.");
        throw this._error(context, "blocked", `${this.name} rejected the API key`);
      }
      throw this._error(context, "network", `${this.name} rejected the request (HTTP 400)`);
    }
    if (response.status >= 500) {
      this._pause(ERROR_PAUSE_MS, "having trouble", `Pixabay answered HTTP ${response.status}; the engine pauses for 1 min.`);
      throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    if (remaining !== null && remaining !== undefined && remaining !== "" && Number(remaining) <= 0) {
      this._pause(resetMs || RATE_PAUSE_MS, "at Pixabay's rate limit", "");
    }

    let data;
    try {
      const text = await response.text();
      if (text.length > MAX_BODY_CHARS) throw new Error("too long");
      data = JSON.parse(text);
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
    const results = parseHits(data, this.name, this.extraHosts);
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return { results, total: totalOf(data) };
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const startedAt = this.now();
    const text = String(query ?? "").trim();
    if (!text) return [];
    if (!this.apiKey) {
      this._debug("no api key: nothing asked (set one in the engine's settings or PIXABAY_API_KEY)");
      return [];
    }
    const number = Math.max(1, Math.trunc(Number(page)) || 1);
    if ((number - 1) * this.perPage >= MAX_HITS) {
      this._debug("page beyond the 500 images Pixabay serves per search: nothing asked");
      return [];
    }

    const safe = this.safeAlways || ["on", "moderate"].includes(context?.imageFilter?.nsfw);
    const request = buildRequest(
      this.apiKey,
      text,
      number,
      { perPage: this.perPage, imageType: this.imageType, orientation: this.orientation, order: this.order, safe, language: this.language || languageOf(context?.lang), imageFilter: context?.imageFilter },
      this.apiBase,
    );
    try {
      const { value, cached, shared } = await this.cache.once(request.cacheKey, () => this._request(request, context, startedAt));
      this._debug(`page ${number}: ${cached ? "cache hit" : shared ? "joined a request already running" : "requested"}, ${value.results.length} images`);
      if (typeof value.total === "number") context?.pagination?.({ total: value.total });
      return value.results;
    } catch (error) {
      this._debug(`page ${number}: ${redact(error?.message, this.apiKey)}`);
      throw error;
    }
  }
}
