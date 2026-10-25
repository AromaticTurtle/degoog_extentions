import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter } from "./limiter.js";
import { pauseFromHeaders } from "./budget.js";
import { buildHeaders, buildSearchUrl, dateFilters, DEFAULT_API_BASE } from "./request.js";
import { parseWorks } from "./parse.js";
import { clampInt } from "./text.js";

export const type = "scholar";

const sharedLimiter = new Limiter();

export default class OpenAlexEngine {
  isClientExposed = false;
  name = "OpenAlex";
  bangShortcut = "oa";
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  perPage = 10;
  openAccessOnly = false;
  limiter = sharedLimiter;
  apiBase = process.env.DEGOOG_OPENALEX_API_BASE || DEFAULT_API_BASE;

  configure(settings) {
    this.apiKey = String(settings.apiKey || process.env.OPENALEX_API_KEY || "").trim();
    this.perPage = clampInt(settings.perPage, 1, 50, 10);
    this.openAccessOnly = settings.openAccessOnly === true || settings.openAccessOnly === "true";
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  async executeSearch(query, page = 1, timeFilter, context) {
    const text = String(query ?? "").trim();
    if (!text) return [];

    const paused = this.limiter.blockedFor();
    if (paused > 0) {
      throw this._error(
        context,
        "rate_limited",
        `${this.name} budget or rate limit reached, paused for ${Math.ceil(paused / 1000)}s`,
      );
    }
    if (!(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }

    const url = buildSearchUrl(
      text,
      Math.max(1, page || 1),
      {
        perPage: this.perPage,
        openAccessOnly: this.openAccessOnly,
        language: context?.lang,
        dateFilters: dateFilters(timeFilter, context),
      },
      this.apiBase,
    );
    const doFetch = context?.fetch ?? fetch;
    const response = await doFetch(url, { headers: buildHeaders(this.apiKey) });

    const pause = pauseFromHeaders(response.status, response.headers);
    if (pause > 0) this.limiter.penalize(pause);
    if (response.status === 401 || response.status === 403) {
      throw this._error(context, "blocked", `${this.name} refused the request: the API key is invalid or not yet activated`);
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
