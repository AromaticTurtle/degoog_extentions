import { SETTINGS_SCHEMA } from "./settings.js";
import { sanitizeTerm } from "./request.js";
import { evaluate, extractTerm, formatExplanation, hasBoardGameWord, isVideoGameQuery, looksLikeATitleSearch } from "./match.js";
import { buildPanel } from "./render.js";
import { BggApiSource } from "./sources/bgg-api.js";
import { RecommendGamesSource } from "./sources/recommend-games.js";
import { BggInternalSource } from "./sources/bgg-internal.js";

const MIN_SPACING_MS = 1000;
const FALLBACK_TEMPLATE = '<div class="command-result board-games-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");

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

  async _find({ term, intent, context, deadline, query }) {
    let hints = {};
    for (const source of this.chain) {
      if (this.now() >= deadline) return null;
      if (!source.usable()) continue;
      let result;
      try {
        result = await source.lookup({ term, intent, context, deadline, hints, query });
      } catch {
        result = { status: "unavailable", reason: "error" };
      }
      if (result?.status === "ok") return result.game ?? null;
      if (result?.hints?.ids?.length) hints = { ...hints, ids: result.hints.ids };
    }
    return null;
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
      let game;
      try {
        game = await Promise.race([work, late]);
      } finally {
        clearTimeout(timer);
      }
      if (game === TIMED_OUT) {
        work.catch(() => {});
        if (this.debugMatching) {
          console.info(`[board-games] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" is still being looked up; the reply is cached when it arrives, so searching again in a moment shows the panel`);
        }
        return EMPTY;
      }
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
