import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { API_BASE, buildApiHeaders, buildApiUrl } from "./request.js";
import { parsePhotos } from "./parse.js";
import { clampInt } from "./text.js";

export { filters } from "./request.js";
export const type = "images";

const QUOTA_PAUSE_MS = 10 * 60 * 1000;

const sharedLimiter = new Limiter({ minIntervalMs: 1000, maxWaitMs: 5000 });

export default class UnsplashEngine {
  isClientExposed = false;
  name = "Unsplash";
  bangShortcut = "unsplash";
  settingsSchema = SETTINGS_SCHEMA;

  accessKey = "";
  perPage = 20;
  limiter = sharedLimiter;
  apiBase = process.env.DEGOOG_UNSPLASH_API_BASE || API_BASE;

  configure(settings) {
    this.accessKey = String(settings.accessKey || process.env.UNSPLASH_ACCESS_KEY || "").trim();
    this.perPage = clampInt(settings.perPage, 10, 30, 20);
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  _quotaError(context, pausedMs) {
    return this._error(
      context,
      "rate_limited",
      `${this.name} API quota used up, paused for ${Math.ceil(pausedMs / 60000)} min`,
    );
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const text = String(query ?? "").trim();
    if (!this.accessKey || !text) return [];

    const paused = this.limiter.blockedFor();
    if (paused > 0) throw this._quotaError(context, paused);
    if (!(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }

    const url = buildApiUrl(
      text,
      Math.max(1, page || 1),
      { perPage: this.perPage, imageFilter: context?.imageFilter },
      this.apiBase,
    );
    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(url, { headers: buildApiHeaders(this.accessKey) });

    const quotaSpent =
      response.status === 429 ||
      (response.status === 403 && /rate limit/i.test(await response.clone().text().catch(() => "")));
    if (quotaSpent) {
      const pause = retryAfterMs(response.headers?.get?.("retry-after"), QUOTA_PAUSE_MS, QUOTA_PAUSE_MS);
      this.limiter.penalize(pause);
      throw this._quotaError(context, pause);
    }
    if (response.status === 401) {
      throw this._error(context, "blocked", `${this.name} rejected the access key`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    if (remaining !== null && remaining !== undefined && remaining !== "" && Number(remaining) <= 0) {
      this.limiter.penalize(QUOTA_PAUSE_MS);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
    const results = parsePhotos(data, this.name);
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return results;
  }
}
