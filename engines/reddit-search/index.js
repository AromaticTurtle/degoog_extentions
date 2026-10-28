import { SETTINGS_SCHEMA } from "./settings.js";
import { Limiter, retryAfterMs } from "./limiter.js";
import { DEFAULT_FEED_BASE, MAX_PAGES, buildFeedUrl, buildHeaders, cacheKey, chainKey, parseSubreddits, sortOf, splitSiteFilters, timeOf } from "./request.js";
import { parseFeed, shapeResults } from "./parse.js";
import { clampInt, truthy } from "./text.js";

const CACHE_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 50;
const CURSOR_MAX_ENTRIES = 150;
const RATE_PAUSE_MS = 2 * 60_000;
const RATE_PAUSE_MAX_MS = 15 * 60_000;
const BLOCK_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const MIN_INTERVAL_MS = 2000;
const MAX_FEED_CHARS = 2_000_000;
const BLOCKED_PAGE = /blocked by network security/i;

// Reddit Search: the posts of Reddit's public Atom search feed, with the date, the subreddit, an excerpt of the post and a
// thumbnail, sorted by relevance. One request per page, no retries, and when Reddit refuses the requests the engine
// pauses. It never tries to get around a block.
export default class RedditSearchEngine {
  isClientExposed = false;
  name = "Reddit Search";
  bangShortcut = "rd";
  settingsSchema = SETTINGS_SCHEMA;

  sortBy = "relevance";
  defaultTime = "all";
  includeNsfw = false;
  onlySubreddits = [];
  excludeSubreddits = [];
  snippetLength = 350;
  dateInSnippet = true;
  showThumbnails = true;
  limiter = new Limiter({ minIntervalMs: MIN_INTERVAL_MS, maxWaitMs: 6000 });
  feedBase = process.env.DEGOOG_REDDIT_FEED_BASE || DEFAULT_FEED_BASE;
  now = Date.now;

  _cache = new Map();
  _inflight = new Map();
  // The last post of each page of a search, which is where the next page continues. degoog hands later pages only what the
  // FIRST page carried, so page 3 needs page 2's last post from here.
  _cursors = new Map();
  _pauseNote = "rate limiting this instance";

  configure(settings = {}) {
    this.sortBy = sortOf(settings.sortBy);
    this.defaultTime = timeOf("any", settings.defaultTime);
    this.includeNsfw = truthy(settings.includeNsfw, false);
    this.onlySubreddits = parseSubreddits(settings.onlySubreddits);
    this.excludeSubreddits = parseSubreddits(settings.excludeSubreddits);
    this.snippetLength = clampInt(settings.snippetLength, 150, 800, 350);
    this.dateInSnippet = truthy(settings.dateInSnippet, true);
    this.showThumbnails = truthy(settings.showThumbnails, true);
    this._cache.clear(); // results are shaped when they arrive, so a changed setting needs fresh ones
    this._cursors.clear();
  }

  _error(context, status, message) {
    return context?.engineError ? context.engineError(status, message, { engine: this.name }) : new Error(message);
  }

  _paused(context, ms) {
    return this._error(context, "rate_limited", `${this.name} is ${this._pauseNote}, paused for ${ms >= 60_000 ? `${Math.ceil(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`}`);
  }

  // One short warning when a pause starts. Never an address, a query or a header.
  _pause(ms, note, log = "") {
    const wasPaused = this.limiter.blockedFor() > 0;
    this._pauseNote = note;
    this.limiter.penalize(ms);
    if (log && !wasPaused) console.warn(`[reddit-search] ${log}`);
  }

  async _request(params, context) {
    const paused = this.limiter.blockedFor();
    if (paused > 0) throw this._paused(context, paused);
    if (!(await this.limiter.acquire())) {
      throw this._error(context, "rate_limited", `${this.name} requests are queued up, skipped to stay polite`);
    }

    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(buildFeedUrl(params, this.feedBase), { headers: buildHeaders(context) });
    } catch {
      this._pause(ERROR_PAUSE_MS, "unreachable", "Reddit could not be reached; the engine pauses for 1 min.");
      throw this._error(context, "network", `${this.name} could not reach Reddit`);
    }

    if (response.status === 429) {
      const pause = retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS, RATE_PAUSE_MAX_MS);
      this._pause(pause, "rate limited by Reddit", `Reddit answered "too many requests"; the engine pauses for ${Math.ceil(pause / 60_000)} min.`);
      throw this._paused(context, pause);
    }
    if (response.status === 403) {
      this._pause(BLOCK_PAUSE_MS, "refused by Reddit (blocked)", "Reddit is refusing requests from this server's address; the engine pauses for 30 min. It does not try to get around that, see the README.");
      throw this._error(context, "blocked", `${this.name} was refused by Reddit (this server's address is blocked), paused for 30 min`);
    }
    if (response.status >= 500) {
      this._pause(ERROR_PAUSE_MS, "having trouble at Reddit", `Reddit answered HTTP ${response.status}; the engine pauses for 1 min.`);
      throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);
    }
    if (context?.sentinel) context.sentinel(response, this.name);
    else if (!response.ok) throw this._error(context, "network", `${this.name} answered HTTP ${response.status}`);

    let text;
    try {
      text = (await response.text()).slice(0, MAX_FEED_CHARS + 1);
    } catch {
      throw this._error(context, "parse_error", `${this.name} returned a response that could not be read`);
    }
    if (BLOCKED_PAGE.test(text.slice(0, 20_000)) && !/<feed[\s>]/i.test(text.slice(0, 2000))) {
      this._pause(BLOCK_PAUSE_MS, "refused by Reddit (blocked)", "Reddit is refusing requests from this server's address; the engine pauses for 30 min. It does not try to get around that, see the README.");
      throw this._error(context, "blocked", `${this.name} was refused by Reddit (this server's address is blocked), paused for 30 min`);
    }
    const feed = parseFeed(text);
    if (!feed) throw this._error(context, "parse_error", `${this.name} response layout was not recognised`);
    return {
      results: shapeResults(
        feed.entries,
        { snippetLength: this.snippetLength, dateInSnippet: this.dateInSnippet, showThumbnails: this.showThumbnails, excludeSubreddits: this.excludeSubreddits },
        this.name,
      ),
      after: feed.last,
    };
  }

  async _page(params, context) {
    const key = cacheKey(params);
    const hit = this._cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value;
    if (hit) this._cache.delete(key);

    let pending = this._inflight.get(key);
    if (!pending) {
      pending = this._request(params, context)
        .then((value) => {
          this._cache.set(key, { at: this.now(), value });
          while (this._cache.size > CACHE_MAX_ENTRIES) this._cache.delete(this._cache.keys().next().value);
          return value;
        })
        .finally(() => this._inflight.delete(key));
      this._inflight.set(key, pending);
    }
    return pending;
  }

  _cursor(params, page) {
    const key = JSON.stringify([chainKey(params), page]);
    const hit = this._cursors.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.after;
    if (hit) this._cursors.delete(key);
    return "";
  }

  _remember(params, page, after) {
    if (!after) return;
    this._cursors.set(JSON.stringify([chainKey(params), page]), { at: this.now(), after });
    while (this._cursors.size > CURSOR_MAX_ENTRIES) this._cursors.delete(this._cursors.keys().next().value);
  }

  async executeSearch(query, page = 1, timeFilter, context) {
    // A site:reddit.com filter (from the Reddit lens) is not part of what is searched; r/<sub> in it restricts the search.
    const { text, subreddits: fromQuery } = splitSiteFilters(query);
    const number = Math.max(1, Math.trunc(Number(page)) || 1);
    if (!text || number > MAX_PAGES) return [];
    const base = { query: text, sort: this.sortBy, time: timeOf(timeFilter, this.defaultTime), nsfw: this.includeNsfw, subreddits: fromQuery.length ? fromQuery : this.onlySubreddits };
    // A later page continues after the last post of the previous one (Reddit's "after"): from this engine's own memory of that
    // page, or, for page 2, from what page 1 handed to degoog with carry().
    let after = "";
    if (number > 1) {
      after = this._cursor(base, number - 1) || (number === 2 ? String(context?.carried?.after ?? "") : "");
      if (!/^t3_[a-z0-9]{1,12}$/.test(after)) return [];
    }

    const value = await this._page({ ...base, page: number, after }, context);
    this._remember(base, number, value.after);
    if (number === 1 && value.after) context?.carry?.({ after: value.after });
    return value.results;
  }
}
