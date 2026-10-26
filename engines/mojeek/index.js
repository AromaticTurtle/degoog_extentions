import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { MAX_PAGE, DEFAULT_BASE, buildHeaders, buildSearchUrl, sinceParam } from "./request.js";
import { Session, SessionError, sessionFile } from "./session.js";
import { pageKind, parseResults } from "./parse.js";

const BLOCK_PAUSE_MS = 10 * 60_000;

const sharedSession = new Session({
  cacheFile: process.env.DEGOOG_MOJEEK_SESSION_FILE || sessionFile(process.env.DEGOOG_DATA_DIR || "data"),
  base: process.env.DEGOOG_MOJEEK_BASE || DEFAULT_BASE,
});

export default class MojeekEngine {
  isClientExposed = false;
  name = "Mojeek";
  bangShortcut = "mojeek";
  settingsSchema = SETTINGS_SCHEMA;

  safeSearch = false;
  session = sharedSession;
  limiter = new Limiter({ minIntervalMs: 2000, maxWaitMs: 6000 });
  base = process.env.DEGOOG_MOJEEK_BASE || DEFAULT_BASE;

  configure(settings) {
    this.safeSearch = settings.safeSearch === "on" || settings.safeSearch === true || settings.safeSearch === "true";
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  async _page(url, doFetch, context) {
    const cookie = await this.session.ensure(doFetch);
    const response = await doFetch(url, { headers: buildHeaders(cookie) });
    if ([403, 429, 503].includes(response.status)) {
      this.limiter.penalize(retryAfterMs(response.headers?.get?.("retry-after"), BLOCK_PAUSE_MS, 60 * 60_000));
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);
    return response.text();
  }

  async executeSearch(query, page = 1, timeFilter, context) {
    const text = String(query ?? "").trim();
    const pageNumber = Math.max(1, page || 1);
    if (!text || pageNumber > MAX_PAGE) return [];

    const paused = this.limiter.blockedFor();
    if (paused > 0) {
      throw this._error(context, "rate_limited", `${this.name} is refusing requests, paused for ${Math.ceil(paused / 60_000)} min`);
    }
    if (!(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }

    const doFetch = context?.fetch ?? fetch;
    const url = buildSearchUrl(text, pageNumber, { safeSearch: this.safeSearch, since: sinceParam(timeFilter, context) }, this.base);

    let html;
    try {
      html = await this._page(url, doFetch, context);
      if (pageKind(html) === "captcha") {
        this.session.invalidate();
        html = await this._page(url, doFetch, context);
      }
    } catch (error) {
      if (error instanceof SessionError) {
        this.limiter.penalize(BLOCK_PAUSE_MS);
        throw this._error(context, error.status, error.message);
      }
      throw error;
    }

    switch (pageKind(html)) {
      case "empty":
        return [];
      case "captcha":
        this.limiter.penalize(BLOCK_PAUSE_MS);
        throw this._error(context, "captcha", `${this.name} still showed its bot check after it was solved`);
      case "results": {
        const results = parseResults(html, this.name);
        if (!results) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
        return results;
      }
      default:
        throw this._error(context, "parse_error", `${this.name} returned a page this engine does not recognise`);
    }
  }
}
