import { SETTINGS_SCHEMA } from "./settings.js";
import { Budget, usageFile } from "./budget.js";
import { DEFAULT_BASE, buildDetailUrl, buildHeaders, buildSearchUrl, retryAfterMs } from "./request.js";
import { cacheKey, extractTerm, hasGameWord, looksLikeATitleSearch, pickGame } from "./match.js";
import { compactDetail, compactSearchResult } from "./shape.js";
import { buildPanel } from "./render.js";

const SEARCH_TTL_MS = 24 * 60 * 60_000;
const DETAIL_TTL_MS = 7 * 24 * 60 * 60_000;
const RATE_PAUSE_MS = 10 * 60_000;
const KEY_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const FALLBACK_TEMPLATE = '<div class="command-result rawg-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

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

export class RawgSlot {
  isClientExposed = false;
  id = "rawg";
  name = "RAWG video games";
  description = "Shows a video game information panel (cover, scores, platforms, developer, description) from RAWG.";
  position = "knowledge-panel";
  slotPositions = ["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"];
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  requireGameWord = false;
  showDetails = true;
  apiBase = process.env.DEGOOG_RAWG_API_BASE || DEFAULT_BASE;
  now = Date.now;
  budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: 15_000 });

  template = FALLBACK_TEMPLATE;
  _signProxy = null;
  _pausedUntil = 0;
  _local = {};
  _inflight = new Map();

  init(context) {
    if (context?.template) this.template = context.template;
    if (context?.signProxyUrl) this._signProxy = context.signProxyUrl;
  }

  configure(settings = {}) {
    this.apiKey = String(settings.apiKey || process.env.RAWG_API_KEY || "").trim();
    this.requireGameWord = truthy(settings.requireGameWord, false);
    this.showDetails = truthy(settings.showDetails, true);
    const cap = Number.parseInt(String(settings.monthlyBudget ?? ""), 10);
    this.budget.cap = Number.isFinite(cap) && cap >= 0 ? cap : 15_000;
  }

  get paused() {
    return this.now() < this._pausedUntil;
  }

  trigger(query) {
    if (!this.apiKey || this.paused) return false;
    if (!looksLikeATitleSearch(query)) return false;
    if (this.requireGameWord && !hasGameWord(query)) return false;
    return true;
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:rawg:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  _pause(ms, reason) {
    const wasPaused = this.paused;
    this._pausedUntil = Math.max(this._pausedUntil, this.now() + ms);
    if (!wasPaused) console.warn(`[rawg] ${reason}; paused for ${Math.ceil(ms / 60_000)} min`);
  }

  // One RAWG request. Returns parsed JSON, or null when it failed or must not be made.
  // The URL holds the API key, so it never appears in a log line or an error.
  async _call(url, context) {
    if (this.paused) return null;
    if (!this.budget.spend()) {
      this._pause(60 * 60_000, "the monthly request limit is reached");
      return null;
    }
    const doFetch = context?.fetch ?? fetch;
    let response;
    try {
      response = await doFetch(url, { headers: buildHeaders() });
    } catch {
      this._pause(ERROR_PAUSE_MS, "RAWG could not be reached");
      return null;
    }
    if (response.status === 429) {
      this._pause(retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS), "RAWG rate limited this instance");
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      this._pause(KEY_PAUSE_MS, "RAWG rejected the API key (or the free quota is used up)");
      return null;
    }
    if (response.status >= 500) {
      this._pause(ERROR_PAUSE_MS, `RAWG answered HTTP ${response.status}`);
      return null;
    }
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async _once(name, key, work) {
    const id = `${name}:${key}`;
    if (!this._inflight.has(id)) {
      this._inflight.set(id, work().finally(() => this._inflight.delete(id)));
    }
    return this._inflight.get(id);
  }

  async _search(term, context) {
    const cache = this._cache(context, "search", SEARCH_TTL_MS);
    const key = cacheKey(term);
    const cached = await cache.get(key);
    if (cached) return cached.results;
    return this._once("search", key, async () => {
      const data = await this._call(buildSearchUrl(term, this.apiKey, this.apiBase), context);
      if (!data || !Array.isArray(data.results)) return null;
      const results = data.results.map(compactSearchResult);
      await cache.set(key, { results });
      return results;
    });
  }

  async _detail(id, context) {
    const cache = this._cache(context, "detail", DETAIL_TTL_MS);
    const key = String(id);
    const cached = await cache.get(key);
    if (cached) return cached;
    return this._once("detail", key, async () => {
      const data = await this._call(buildDetailUrl(id, this.apiKey, this.apiBase), context);
      if (!data || typeof data !== "object") return null;
      const detail = compactDetail(data);
      await cache.set(key, detail);
      return detail;
    });
  }

  async execute(query, context) {
    if (!this.trigger(query)) return EMPTY;
    const term = extractTerm(query);
    if (term.length < 2) return EMPTY;
    try {
      const results = await this._search(term, context);
      const game = results && pickGame(term, results, hasGameWord(query));
      if (!game) return EMPTY;
      const detail = this.showDetails ? await this._detail(game.id, context) : null;
      const html = buildPanel({
        game,
        detail,
        signProxy: context?.signProxyUrl ?? this._signProxy,
        locale: context?.locale,
      });
      return { title: game.name, html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }
}

export const slot = new RawgSlot();

export default { slot };
