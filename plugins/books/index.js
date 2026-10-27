import { SETTINGS_SCHEMA } from "./settings.js";
import { Budget, usageFile } from "./budget.js";
import {
  DEFAULT_API_URL,
  buildHeaders,
  buildRequestBody,
  normalizeToken,
  parseRateLimit,
  readText,
  retryAfterMs,
  sanitizeTerm,
} from "./request.js";
import { cacheKey, isOtherMediaQuery, looksLikeATitleSearch, parseQuery, pickBook } from "./match.js";
import { REPLY_MAX_CHARS, parseSearchReply } from "./shape.js";
import { buildPanel } from "./render.js";

const SEARCH_TTL_MS = 24 * 60 * 60_000;
const RATE_PAUSE_MS = 60_000;
const TOKEN_PAUSE_MS = 30 * 60_000;
const REFUSED_PAUSE_MS = 10 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const BUDGET_RECHECK_MS = 60 * 60_000;
const MIN_SPACING_MS = 1000;
const DEFAULT_DAILY_LIMIT = 1500;
const FALLBACK_TEMPLATE = '<div class="command-result books-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

const slotTimeoutMs = () => {
  const configured = Number.parseInt(process.env.DEGOOG_SLOT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
};

// Used only when degoog does not hand the slot its own cache (for example in tests).
const localCache = (ttlMs, now) => {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttl = ttlMs) {
      store.set(key, { value, expiresAt: now() + ttl });
    },
  };
};

export class BooksSlot {
  isClientExposed = false;
  id = "books";
  name = "Books (Hardcover)";
  description = "Shows a book information panel (cover, authors, series, Hardcover rating and readers, genres, pages, description) from Hardcover.";
  position = "knowledge-panel";
  slotPositions = ["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"];
  settingsSchema = SETTINGS_SCHEMA;

  apiToken = "";
  requireBookWord = false;
  showDescription = true;
  apiUrl = process.env.DEGOOG_HARDCOVER_API_URL || DEFAULT_API_URL;
  now = Date.now;
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  spacingMs = MIN_SPACING_MS;
  // degoog gives a slot 10 s (DEGOOG_SLOT_TIMEOUT_MS). No request is started after 70 % of it.
  startWindowMs = Math.max(1000, Math.round(slotTimeoutMs() * 0.7));
  budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => this.now() });

  template = FALLBACK_TEMPLATE;
  _signProxy = null;
  _pausedUntil = 0;
  _lastRequestAt = 0;
  _gateChain = Promise.resolve();
  _local = {};
  _inflight = new Map();

  init(context) {
    if (context?.template) this.template = context.template;
    if (context?.signProxyUrl) this._signProxy = context.signProxyUrl;
  }

  configure(settings = {}) {
    const uiToken = String(settings.apiToken ?? "").trim();
    this.apiToken = normalizeToken(uiToken ? settings.apiToken : process.env.HARDCOVER_API_TOKEN);
    this.requireBookWord = truthy(settings.requireBookWord, false);
    this.showDescription = truthy(settings.showDescription, true);
    const limit = Number.parseInt(String(settings.dailyRequestLimit ?? ""), 10);
    this.budget.cap = Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_DAILY_LIMIT;
  }

  get paused() {
    return this.now() < this._pausedUntil;
  }

  trigger(query) {
    if (!this.apiToken || this.paused || this.budget.exhausted) return false;
    if (!looksLikeATitleSearch(query)) return false;
    if (isOtherMediaQuery(query)) return false;
    if (this.requireBookWord && !parseQuery(query).intent) return false;
    return true;
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:books:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  _pause(ms, reason) {
    const wasPaused = this.paused;
    this._pausedUntil = Math.max(this._pausedUntil, this.now() + ms);
    if (!wasPaused) console.warn(`[books] ${reason}; paused for ${Math.ceil(ms / 60_000)} min`);
  }

  // Requests keep at least spacingMs apart. False means the wait would not fit in the time degoog gives the slot,
  // so the request is skipped rather than made late.
  async _gate(deadline) {
    const before = this._gateChain;
    let release;
    this._gateChain = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const now = this.now();
      const wait = this._lastRequestAt + this.spacingMs - now;
      if (wait > 0) {
        if (now + wait > deadline) return false;
        await this.sleep(wait);
      } else if (now > deadline) return false;
      this._lastRequestAt = this.now();
      return true;
    } finally {
      release();
    }
  }

  // The daily bucket is empty: wait for the reset, but look again after an hour at the latest.
  _dailyPause(response) {
    const limits = parseRateLimit(response.headers?.get?.("ratelimit"));
    const resetMs = limits.daily?.t > 0 ? limits.daily.t * 1000 : this.budget.msUntilReset;
    this._pause(Math.min(BUDGET_RECHECK_MS, resetMs), "Hardcover's daily request limit is used up");
  }

  async _throttled(response) {
    const limits = parseRateLimit(response.headers?.get?.("ratelimit"));
    if (limits.daily?.r === 0 || response.headers?.get?.("x-ratelimit-daily-remaining") === "0") {
      this._dailyPause(response);
      return;
    }
    this._pause(retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS), "Hardcover rate limited this instance");
  }

  async _refused(response) {
    let error = "";
    try {
      error = String(JSON.parse(await readText(response, 4000))?.error ?? "");
    } catch {
      /* not JSON */
    }
    if (error === "insufficient_scope") this._pause(TOKEN_PAUSE_MS, "Hardcover refused the token: it needs the read:catalog scope");
    else this._pause(REFUSED_PAUSE_MS, "Hardcover refused the request (HTTP 403)");
  }

  // One Hardcover search request. Resolves to { books } or null when it failed or must not be made.
  // The token is only ever in the authorization header, and only generic text is logged.
  async _query(term, context, deadline) {
    if (this.paused) return null;
    if (!(await this._gate(deadline))) return null;
    if (this.paused) return null;
    if (!this.budget.spend()) {
      this._pause(Math.min(BUDGET_RECHECK_MS, this.budget.msUntilReset), "the daily Hardcover request limit is reached");
      return null;
    }
    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(this.apiUrl, { method: "POST", headers: buildHeaders(this.apiToken), body: buildRequestBody(term) });
    } catch {
      this._pause(ERROR_PAUSE_MS, "Hardcover could not be reached");
      return null;
    } finally {
      this._lastRequestAt = this.now();
    }
    const status = response.status;
    if (status === 429) {
      await this._throttled(response);
      return null;
    }
    if (status === 401) {
      this._pause(TOKEN_PAUSE_MS, "Hardcover rejected the token (invalid or expired)");
      return null;
    }
    if (status === 403) {
      await this._refused(response);
      return null;
    }
    if (status === 400) {
      this._pause(ERROR_PAUSE_MS, "Hardcover rejected the request (HTTP 400)");
      return null;
    }
    if (status === 408 || status >= 500) {
      this._pause(ERROR_PAUSE_MS, `Hardcover answered HTTP ${status}`);
      return null;
    }
    if (status < 200 || status >= 300) return null;
    const body = await readText(response, REPLY_MAX_CHARS);
    if (body.length > REPLY_MAX_CHARS) return null;
    const reply = parseSearchReply(body);
    if (reply.error === "errors") {
      this._pause(ERROR_PAUSE_MS, "Hardcover answered with a GraphQL error");
      return null;
    }
    return reply.books ? { books: reply.books } : null;
  }

  async _once(name, key, work) {
    const id = `${name}:${key}`;
    if (!this._inflight.has(id)) {
      this._inflight.set(id, work().finally(() => this._inflight.delete(id)));
    }
    return this._inflight.get(id);
  }

  // Search -> the compact books of the best matches (possibly none). null when it failed.
  async _search(term, context, deadline) {
    const cache = this._cache(context, "search", SEARCH_TTL_MS);
    const key = cacheKey(term);
    const cached = await cache.get(key);
    if (cached && Array.isArray(cached.books)) return cached.books;
    return this._once("search", key, async () => {
      const reply = await this._query(term, context, deadline);
      if (!reply) return null;
      await cache.set(key, { books: reply.books });
      return reply.books;
    });
  }

  async execute(query, context) {
    if (!this.trigger(query)) return EMPTY;
    const parsed = parseQuery(query);
    if (sanitizeTerm(parsed.search).length < 2) return EMPTY;
    const deadline = this.now() + this.startWindowMs;
    try {
      const books = await this._search(parsed.search, context, deadline);
      const book = books && pickBook(parsed, books);
      if (!book) return EMPTY;
      const html = buildPanel({
        book,
        signProxy: context?.signProxyUrl ?? this._signProxy,
        showDescription: this.showDescription,
      });
      return { title: book.title, html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }
}

export const slot = new BooksSlot();

export default { slot };
