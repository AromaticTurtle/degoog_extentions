import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { buildHeaders, buildSearchUrl, clampInt, DEFAULT_API_BASE } from "./request.js";
import { parseResults } from "./parse.js";

const sharedLimiter = new Limiter();

export default class MarginaliaEngine {
  isClientExposed = false;
  name = "Marginalia";
  bangShortcut = "marg";
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  count = 20;
  maxPerDomain = 2;
  reduceExplicit = false;
  limiter = sharedLimiter;
  apiBase = process.env.DEGOOG_MARGINALIA_API_BASE || DEFAULT_API_BASE;

  configure(settings) {
    this.apiKey = String(settings.apiKey || process.env.MARGINALIA_API_KEY || "").trim();
    this.count = clampInt(settings.count, 1, 100, 20);
    this.maxPerDomain = clampInt(settings.maxPerDomain, 0, 100, 2);
    this.reduceExplicit = settings.reduceExplicit === true || settings.reduceExplicit === "true";
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

    const url = buildSearchUrl(
      text,
      Math.max(1, page || 1),
      { count: this.count, maxPerDomain: this.maxPerDomain, reduceExplicit: this.reduceExplicit },
      this.apiBase,
    );
    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(url, { headers: buildHeaders(this.apiKey) });

    if (response.status === 429 || response.status === 503) {
      this.limiter.penalize(retryAfterMs(response.headers?.get?.("retry-after")));
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
}
