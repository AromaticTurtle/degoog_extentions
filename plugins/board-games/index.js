import { SETTINGS_SCHEMA } from "./settings.js";
import { sanitizeTerm } from "./request.js";
import { cacheKey, evaluate, extractTerm, formatExplanation, hasBoardGameWord, isVideoGameQuery, looksLikeATitleSearch } from "./match.js";
import { buildPanel } from "./render.js";
import { BggApiSource } from "./sources/bgg-api.js";
import { RecommendGamesSource } from "./sources/recommend-games.js";
import { BggInternalSource } from "./sources/bgg-internal.js";

const MIN_SPACING_MS = 1000;
const FALLBACK_TEMPLATE = '<div class="command-result board-games-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");

// A tiny in-process contract with the game-info plugin, which runs in the same degoog process: when a title is both a
// board game and a video game, game-info asks this function whether a board game matches and then hides its own panel.
// Nothing is imported across plugin folders: the function is found under this global symbol (see the README).
export const LOOKUP_KEY = Symbol.for("degoog-extentions.board-games.lookup");
const UNKNOWN = Object.freeze({ status: "unknown" });
const NONE = Object.freeze({ status: "none" });

// A module that is loaded again (degoog reloads plugins) drops what an earlier copy registered. init() registers the new
// copy, and only runs when the plugin is enabled, so a disabled plugin never stays registered.
delete globalThis[LOOKUP_KEY];

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

// A daily request limit: a whole number of 0 or more (0 = no cap), else the default.
const limitOf = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

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

// The panel is filled by the first usable source that answers, in a fixed order:
// 1) the BGG XML API, 2) recommend.games, 3) BGG's website JSON API (ids from Wikidata or from an earlier source).
// A source that answers ("ok") ends the chain, even with "no confident match". One that is
// "unavailable" (disabled, paused, over its limit, an error, a block page...) hands over to the next.
export class BoardGamesSlot {
  isClientExposed = false;
  id = "board-games";
  name = "Board games (BoardGameGeek)";
  description = "Shows a board game information panel (rating, rank, weight, players, playing time, designers, mechanics) from BoardGameGeek data.";
  position = "knowledge-panel";
  slotPositions = ["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"];
  settingsSchema = SETTINGS_SCHEMA;

  requireBoardGameWord = false;
  showDescription = true;
  debugMatching = false;
  disabled = false;
  now = Date.now;
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  spacingMs = MIN_SPACING_MS;
  // degoog gives a slot 10 s (DEGOOG_SLOT_TIMEOUT_MS). No request is started after 70 % of it, in the whole chain.
  startWindowMs = Math.max(1000, Math.round(slotTimeoutMs() * 0.7));
  // A lookup that is still running shortly before degoog's own timeout is given up on for this search. The request
  // itself is not cancelled: its reply is cached when it arrives, so the next search for the same title is instant.
  answerWindowMs = Math.max(500, Math.round(slotTimeoutMs() * 0.95));

  template = FALLBACK_TEMPLATE;
  _signProxy = null;
  _local = {};
  _inflight = new Map();
  // Titles whose panel this plugin gave up on (too slow for the slot) while the lookup is still running. The panel is not
  // coming for that search, so lookupTitle() must not tell game-info that a board game will show.
  _missed = new Set();

  constructor() {
    this.sources = {
      api: new BggApiSource(this),
      recommend: new RecommendGamesSource(this),
      internal: new BggInternalSource(this),
    };
  }

  get chain() {
    return [this.sources.api, this.sources.recommend, this.sources.internal];
  }

  init(context) {
    if (context?.template) this.template = context.template;
    if (context?.signProxyUrl) this._signProxy = context.signProxyUrl;
    // Replaces an earlier registration, so running init more than once is safe.
    this._lookup ??= (request) => this.lookupTitle(request);
    globalThis[LOOKUP_KEY] = this._lookup;
  }

  configure(settings = {}) {
    const uiToken = String(settings.apiToken ?? "").trim();
    this.sources.api.configure({
      enabled: truthy(settings.enableApi, true),
      token: uiToken ? settings.apiToken : process.env.BGG_API_TOKEN,
      limit: limitOf(settings.dailyRequestLimit, 300),
    });
    this.sources.recommend.configure({
      enabled: truthy(settings.enableRecommendGames, true),
      limit: limitOf(settings.recommendGamesDailyLimit, 500),
    });
    this.sources.internal.configure({
      enabled: truthy(settings.enableBggInternal, false),
      limit: limitOf(settings.internalDailyLimit, 100),
    });
    this.requireBoardGameWord = truthy(settings.requireBoardGameWord, false);
    this.showDescription = truthy(settings.showDescription, true);
    this.debugMatching = truthy(settings.debugMatching, false);
    // degoog passes the stored "disabled" flag along with the settings when the user switches the plugin off.
    this.disabled = truthy(settings.disabled, false);
  }

  // Why a query does not get a lookup ("" when it does).
  _rejection(query) {
    if (!this.chain.some((source) => source.usable())) return "no source is usable (disabled, no token, paused or over its limit)";
    if (!looksLikeATitleSearch(query)) return "not a title search";
    if (isVideoGameQuery(query)) return "the query has a video game word and no board game word";
    if (this.requireBoardGameWord && !hasBoardGameWord(query)) return "requireBoardGameWord is on and the query has no board game word";
    return "";
  }

  // With debugMatching a title-like query that is turned away is logged with the rule that did it.
  trigger(query) {
    const why = this._rejection(query);
    if (why && this.debugMatching && why !== "not a title search" && looksLikeATitleSearch(query)) {
      console.info(`[board-games] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" skipped: ${why}`);
    }
    return !why;
  }

  // The sources hand their candidate games here: the confident pick (or null), with the explain block when debugging.
  decide({ query, term, intent, games, source, rankBonus = false }) {
    const result = evaluate(term, games, intent, { explain: this.debugMatching, rankBonus });
    if (this.debugMatching) console.info(formatExplanation(query ?? term, term, intent, result, source));
    return result.pick;
  }

  // What the sources need from the slot: a cache (degoog's, or a local one) and in-flight de-duplication.
  cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:board-games:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  async once(name, key, work) {
    const id = `${name}:${key}`;
    if (!this._inflight.has(id)) {
      this._inflight.set(id, work().finally(() => this._inflight.delete(id)));
    }
    return this._inflight.get(id);
  }

  // -> { answered, game }: answered is true when a source answered (its "no confident match" is final).
  async _find({ term, intent, context, deadline, query }) {
    let hints = {};
    for (const source of this.chain) {
      if (this.now() >= deadline) break;
      if (!source.usable()) continue;
      let result;
      try {
        result = await source.lookup({ term, intent, context, deadline, hints, query });
      } catch {
        result = { status: "unavailable", reason: "error" };
      }
      if (result?.status === "ok") return { answered: true, game: result.game ?? null };
      if (result?.hints?.ids?.length) hints = { ...hints, ids: result.hints.ids };
    }
    return { answered: false, game: null };
  }

  _answered(title, outcome) {
    if (this.debugMatching) {
      const label = outcome.status === "match" ? `match "${outcome.name.replace(/\s+/g, " ").slice(0, 70)}"` : outcome.status;
      console.info(`[board-games] "${title.replace(/\s+/g, " ").slice(0, 100)}" asked about by game-info: ${label}`);
    }
    return outcome;
  }

  // The contract with game-info: does a board game match this title? Runs the normal pipeline for the term (no board game
  // word, so the strict bars), sharing requests and caches with execute(). Never throws, makes no request when no source
  // is usable, and waits at most deadlineMs; a slower reply keeps running and fills the cache.
  // -> { status: "match", name, id } | { status: "none" } | { status: "unknown" }
  async lookupTitle(request) {
    try {
      const { term, deadlineMs, context } = request ?? {};
      const title = extractTerm(String(term ?? "").trim());
      if (this.disabled || sanitizeTerm(title).length < 2 || this._rejection(title)) return UNKNOWN;
      // execute() for this title already gave up and its answer is still on the way: no board game panel this time.
      if (this._missed.has(cacheKey(title))) return this._answered(title, UNKNOWN);
      const waitMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : this.startWindowMs;
      if (waitMs <= 0) return UNKNOWN;
      const work = this._find({ term: title, intent: false, context, deadline: this.now() + this.startWindowMs, query: title });
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), waitMs);
      });
      let found;
      try {
        found = await Promise.race([work, late]);
      } finally {
        clearTimeout(timer);
      }
      let outcome = UNKNOWN;
      if (found === TIMED_OUT) work.catch(() => {});
      else if (found.game) outcome = { status: "match", name: String(found.game.name ?? ""), id: String(found.game.id ?? "") };
      else if (found.answered) outcome = NONE;
      return this._answered(title, outcome);
    } catch {
      return UNKNOWN;
    }
  }

  async execute(query, context) {
    if (!this.trigger(query)) return EMPTY;
    const term = extractTerm(query);
    if (sanitizeTerm(term).length < 2) return EMPTY;
    const deadline = this.now() + this.startWindowMs;
    try {
      const work = this._find({ term, intent: hasBoardGameWord(query), context, deadline, query });
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), this.answerWindowMs);
      });
      let found;
      try {
        found = await Promise.race([work, late]);
      } finally {
        clearTimeout(timer);
      }
      if (found === TIMED_OUT) {
        const missed = cacheKey(term);
        this._missed.add(missed);
        work.then(
          () => this._missed.delete(missed),
          () => this._missed.delete(missed),
        );
        if (this.debugMatching) {
          console.info(`[board-games] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" is still being looked up; the reply is cached when it arrives, so searching again in a moment shows the panel`);
        }
        return EMPTY;
      }
      const game = found.game;
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
