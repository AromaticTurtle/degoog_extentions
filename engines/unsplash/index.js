import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { API_BASE, WEB_BASE, buildApiHeaders, buildApiUrl, buildWebHeaders, buildWebUrl } from "./request.js";
import { parsePhotos } from "./parse.js";
import { clampInt } from "./text.js";

export { filters } from "./request.js";
export const type = "images";

const QUOTA_PAUSE_MS = 10 * 60 * 1000;

const sharedApiLimiter = new Limiter({ minIntervalMs: 1000, maxWaitMs: 5000 });
const sharedWebLimiter = new Limiter({ minIntervalMs: 2000, maxWaitMs: 5000 });

class QuotaError extends Error {}

export default class UnsplashEngine {
  isClientExposed = false;
  name = "Unsplash";
  bangShortcut = "unsplash";
  settingsSchema = SETTINGS_SCHEMA;
  challenges = ["anubis"];

  accessKey = "";
  webFallback = true;
  perPage = 20;
  apiLimiter = sharedApiLimiter;
  webLimiter = sharedWebLimiter;
  apiBase = process.env.DEGOOG_UNSPLASH_API_BASE || API_BASE;
  webBase = process.env.DEGOOG_UNSPLASH_WEB_BASE || WEB_BASE;

  configure(settings) {
    this.accessKey = String(settings.accessKey || process.env.UNSPLASH_ACCESS_KEY || "").trim();
    this.webFallback = settings.webFallback !== false && settings.webFallback !== "false";
    this.perPage = clampInt(settings.perPage, 10, 30, 20);
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  async _readJson(response, context) {
    const body = await response.text();
    try {
      return JSON.parse(body);
    } catch {
      if (/^\s*</.test(body)) {
        throw this._error(context, "interstitial", `${this.name} returned a web page instead of JSON (a bot check?)`);
      }
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
  }

  _parse(data, context) {
    const results = parsePhotos(data, this.name);
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return results;
  }

  async _viaApi(text, page, context) {
    if (!(await this.apiLimiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} API requests are queued up, skipped to stay polite`);
    }
    const url = buildApiUrl(text, page, { perPage: this.perPage, imageFilter: context?.imageFilter }, this.apiBase);
    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(url, { headers: buildApiHeaders(this.accessKey) });

    const limited =
      response.status === 429 ||
      (response.status === 403 && /rate limit/i.test(await response.clone().text().catch(() => "")));
    if (limited) {
      const pause = retryAfterMs(response.headers?.get?.("retry-after"), QUOTA_PAUSE_MS, QUOTA_PAUSE_MS);
      this.apiLimiter.penalize(pause);
      throw new QuotaError(`${this.name} API quota used up, paused for ${Math.ceil(pause / 60000)} min`);
    }
    if (response.status === 401) {
      throw this._error(context, "blocked", `${this.name} rejected the access key`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    if (remaining !== null && remaining !== undefined && remaining !== "" && Number(remaining) <= 0) {
      this.apiLimiter.penalize(QUOTA_PAUSE_MS);
    }
    return this._parse(await this._readJson(response, context), context);
  }

  async _viaWeb(text, page, context) {
    const paused = this.webLimiter.blockedFor();
    if (paused > 0) {
      throw this._error(
        context,
        "rate_limited",
        `${this.name} website is rate limiting this instance, paused for ${Math.ceil(paused / 1000)}s`,
      );
    }
    if (!(await this.webLimiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }
    const url = buildWebUrl(text, page, { perPage: this.perPage, imageFilter: context?.imageFilter }, this.webBase);
    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(url, { headers: buildWebHeaders() });

    if ([403, 429, 503].includes(response.status)) {
      this.webLimiter.penalize(retryAfterMs(response.headers?.get?.("retry-after"), QUOTA_PAUSE_MS, QUOTA_PAUSE_MS));
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);
    return this._parse(await this._readJson(response, context), context);
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const text = String(query ?? "").trim();
    if (!text) return [];
    const pageNumber = Math.max(1, page || 1);

    if (this.accessKey) {
      const paused = this.apiLimiter.blockedFor();
      if (paused === 0) {
        try {
          return await this._viaApi(text, pageNumber, context);
        } catch (error) {
          if (!(error instanceof QuotaError)) throw error;
          if (!this.webFallback) throw this._error(context, "rate_limited", error.message);
        }
      } else if (!this.webFallback) {
        throw this._error(
          context,
          "rate_limited",
          `${this.name} API quota used up, paused for ${Math.ceil(paused / 60000)} min`,
        );
      }
    }
    if (!this.webFallback) return [];
    return this._viaWeb(text, pageNumber, context);
  }
}
