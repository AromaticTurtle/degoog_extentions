import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { buildHeaders, buildSearchUrl, DEFAULT_API_BASE } from "./request.js";
import { parseWorks } from "./parse.js";
import { clampInt } from "./text.js";

export const type = "scholar";

const sharedLimiter = new Limiter({ minIntervalMs: 2500, maxWaitMs: 6000 });

export default class CoreEngine {
  isClientExposed = false;
  name = "CORE";
  bangShortcut = "core";
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  perPage = 10;
  limiter = sharedLimiter;
  apiBase = process.env.DEGOOG_CORE_API_BASE || DEFAULT_API_BASE;

  configure(settings) {
    this.apiKey = String(settings.apiKey || process.env.CORE_API_KEY || "").trim();
    this.perPage = clampInt(settings.perPage, 10, 50, 10);
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const text = String(query ?? "").trim();
    if (!this.apiKey || !text) return [];

    const paused = this.limiter.blockedFor();
    if (paused > 0) {
      throw this._error(
        context,
        "rate_limited",
        `${this.name} is rate limiting this instance, paused for ${Math.ceil(paused / 1000)}s`,
      );
    }
    if (!(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }

    const url = buildSearchUrl(text, Math.max(1, page || 1), { perPage: this.perPage }, this.apiBase);
    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(url, { headers: buildHeaders(this.apiKey) });

    if (response.status === 429 || response.status === 503) {
      this.limiter.penalize(retryAfterMs(response.headers?.get?.("retry-after")));
    }
    if (response.status === 401 || response.status === 403) {
      throw this._error(context, "blocked", `${this.name} refused the request: the API key is missing or invalid`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that was not JSON`);
    }
    const results = parseWorks(data, this.name);
    if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return results;
  }
}
