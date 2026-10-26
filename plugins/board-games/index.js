import { SETTINGS_SCHEMA } from "./settings.js";
import { Budget, usageFile } from "./budget.js";
import {
  DEFAULT_API_BASE,
  buildHeaders,
  buildSearchUrl,
  buildThingUrl,
  looksBlocked,
  normalizeToken,
  readText,
  retryAfterMs,
  sanitizeTerm,
} from "./request.js";
import { cacheKey, extractTerm, hasBoardGameWord, isVideoGameQuery, looksLikeATitleSearch, pickGame, rankCandidates } from "./match.js";
import { SEARCH_MAX_CHARS, THING_MAX_CHARS, parseThings, scanSearch } from "./shape.js";
import { buildPanel } from "./render.js";

const SEARCH_TTL_MS = 24 * 60 * 60_000;
const THING_TTL_MS = 7 * 24 * 60 * 60_000;
const RATE_PAUSE_MS = 10 * 60_000;
const BLOCK_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const BUDGET_RECHECK_MS = 60 * 60_000;
const MIN_SPACING_MS = 1000;
const DEFAULT_DAILY_LIMIT = 300;
// degoog gives a slot 10 s (DEGOOG_SLOT_TIMEOUT_MS). A request may only start while there is still time for it to finish.
const REQUEST_HEADROOM_MS = 3000;
const FALLBACK_TEMPLATE = '<div class="command-result board-games-result">{{content}}</div>';
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

export class BoardGamesSlot {
  isClientExposed = false;
  id = "board-games";
  name = "Board games (BoardGameGeek)";
  description = "Shows a board game information panel (rating, rank, weight, players, playing time, designers, mechanics) from BoardGameGeek.";
  position = "knowledge-panel";
  slotPositions = ["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"];
  settingsSchema = SETTINGS_SCHEMA;

  apiToken = "";
  requireBoardGameWord = false;
  showDescription = true;
  apiBase = process.env.DEGOOG_BGG_API_BASE || DEFAULT_API_BASE;
  now = Date.now;
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  spacingMs = MIN_SPACING_MS;
  startWindowMs = Math.max(1000, slotTimeoutMs() - REQUEST_HEADROOM_MS);
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
    this.apiToken = normalizeToken(String(settings.apiToken ?? "").trim() ? settings.apiToken : process.env.BGG_API_TOKEN);
    this.requireBoardGameWord = truthy(settings.requireBoardGameWord, false);
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
    if (isVideoGameQuery(query)) return false;
    if (this.requireBoardGameWord && !hasBoardGameWord(query)) return false;
    return true;
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:board-games:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  _pause(ms, reason) {
    const wasPaused = this.paused;
    this._pausedUntil = Math.max(this._pausedUntil, this.now() + ms);
    if (!wasPaused) console.warn(`[board-games] ${reason}; paused for ${Math.ceil(ms / 60_000)} min`);
  }

  // Requests queue up here and keep at least spacingMs apart. False means the wait would not fit
  // in the time degoog gives the slot, so the request is skipped rather than made late.
  async _gate(deadline) {
    const before = this._gateChain;
    let release;
    this._gateChain = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const wait = this._lastRequestAt + this.spacingMs - this.now();
      if (wait > 0) {
        if (this.now() + wait > deadline) return false;
        await this.sleep(wait);
      } else if (this.now() > deadline) return false;
      this._lastRequestAt = this.now();
      return true;
    } finally {
      release();
    }
  }

  // One BGG request. Resolves to the XML text, or null when it failed or must not be made.
  // The token is only ever in the Authorization header, and only generic text is logged.
  async _bgg(url, context, deadline, maxChars) {
    if (this.paused || !url) return null;
    if (!(await this._gate(deadline))) return null;
    if (this.paused) return null;
    if (!this.budget.spend()) {
      this._pause(Math.min(BUDGET_RECHECK_MS, this.budget.msUntilReset), "the daily BGG request limit is reached");
      return null;
    }
    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(url, { headers: buildHeaders(this.apiToken) });
    } catch {
      this._pause(ERROR_PAUSE_MS, "BGG could not be reached");
      return null;
    } finally {
      this._lastRequestAt = this.now();
    }
    const status = response.status;
    if (status === 429) {
      this._pause(retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS), "BGG rate limited this instance");
      return null;
    }
    if (status === 401 || status === 403) {
      this._pause(BLOCK_PAUSE_MS, "BGG rejected the API token or blocked the request");
      return null;
    }
    if (status === 202) {
      this._pause(ERROR_PAUSE_MS, "BGG asked to try again later");
      return null;
    }
    if (status >= 500) {
      this._pause(ERROR_PAUSE_MS, `BGG answered HTTP ${status}`);
      return null;
    }
    if (status < 200 || status >= 300) return null;
    const body = await readText(response, maxChars);
    if (looksBlocked(body)) {
      this._pause(BLOCK_PAUSE_MS, "BGG rejected the API token or blocked the request");
      return null;
    }
    return body.trimStart().startsWith("<") ? body : null;
  }

  async _once(name, key, work) {
    const id = `${name}:${key}`;
    if (!this._inflight.has(id)) {
      this._inflight.set(id, work().finally(() => this._inflight.delete(id)));
    }
    return this._inflight.get(id);
  }

  // Search -> the ids of the results whose title is close to the term (possibly none). null when it failed.
  async _candidates(term, context, deadline) {
    const cache = this._cache(context, "search", SEARCH_TTL_MS);
    const key = cacheKey(term);
    const cached = await cache.get(key);
    if (cached && Array.isArray(cached.ids)) return cached.ids;
    return this._once("search", key, async () => {
      const body = await this._bgg(buildSearchUrl(term, this.apiBase), context, deadline, SEARCH_MAX_CHARS);
      if (body === null) return null;
      const { items, valid } = scanSearch(body);
      if (!valid) return null;
      const ids = rankCandidates(term, items);
      await cache.set(key, { ids });
      return ids;
    });
  }

  // The compact details of the candidates: cached ones as they are, the rest in one batch request.
  async _things(ids, context, deadline) {
    const cache = this._cache(context, "thing", THING_TTL_MS);
    const found = new Map();
    const missing = [];
    for (const id of ids) {
      const cached = await cache.get(id);
      if (cached && cached.id === id) found.set(id, cached);
      else missing.push(id);
    }
    if (missing.length) {
      const games = await this._once("thing", missing.join(","), async () => {
        const body = await this._bgg(buildThingUrl(missing, this.apiBase), context, deadline, THING_MAX_CHARS);
        if (body === null) return null;
        const parsed = parseThings(body);
        if (!parsed) return null;
        for (const game of parsed) await cache.set(game.id, game);
        return parsed;
      });
      for (const game of games ?? []) found.set(game.id, game);
    }
    return ids.map((id) => found.get(id)).filter(Boolean);
  }

  async execute(query, context) {
    if (!this.trigger(query)) return EMPTY;
    const term = extractTerm(query);
    if (sanitizeTerm(term).length < 2) return EMPTY;
    const deadline = this.now() + this.startWindowMs;
    try {
      const ids = await this._candidates(term, context, deadline);
      if (!ids || !ids.length) return EMPTY;
      const games = await this._things(ids, context, deadline);
      const game = pickGame(term, games, hasBoardGameWord(query));
      if (!game) return EMPTY;
      const html = buildPanel({
        game,
        signProxy: context?.signProxyUrl ?? this._signProxy,
        showDescription: this.showDescription,
      });
      return { title: game.name, html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }
}

export const slot = new BoardGamesSlot();

export default { slot };
