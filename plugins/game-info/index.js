import { SETTINGS_SCHEMA } from "./settings.js";
import { TokenStore, tokenFile } from "./token.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_PROTONDB_BASE,
  DEFAULT_STEAM_BASE,
  DEFAULT_TOKEN_URL,
  buildIgdbHeaders,
  buildSearchQuery,
  buildTimeToBeatQuery,
  igdbUrl,
  isAppId,
  pluginHeaders,
  protonSummaryUrl,
  retryAfterMs,
  sanitizeTerm,
  steamSearchUrl,
} from "./request.js";
import {
  cacheKey,
  decideBothMatch,
  evaluate,
  extractTerm,
  formatExplanation,
  hasGameWord,
  hasVideoGameWord,
  isBoardGameQuery,
  looksLikeATitleSearch,
  normalizeTitle,
  normalizeWhenBoth,
  validYear,
} from "./match.js";
import { compactGame, compactProton, compactTimeToBeat } from "./shape.js";
import { buildPanel } from "./render.js";

const SEARCH_TTL_MS = 24 * 60 * 60_000;
const TTB_TTL_MS = 7 * 24 * 60 * 60_000;
const PROTON_TTL_MS = 24 * 60 * 60_000;
const STEAM_TTL_MS = 7 * 24 * 60 * 60_000;
const RATE_PAUSE_MS = 10 * 60_000;
const KEY_PAUSE_MS = 30 * 60_000;
const ERROR_PAUSE_MS = 60_000;
const MIN_SPACING_MS = 300;
const FALLBACK_TEMPLATE = '<div class="command-result game-info-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };

// The board-games plugin (same degoog process) registers a lookup function under this symbol; see its README.
export const BOARD_GAMES_LOOKUP = Symbol.for("degoog-extentions.board-games.lookup");
// And this plugin registers its own, so the board-games plugin can ask the other way round. Neither function ever calls
// the other plugin, so there is no recursion.
export const GAME_INFO_LOOKUP = Symbol.for("degoog-extentions.game-info.lookup");
const TIMED_OUT = Symbol("timed out");
const UNKNOWN = Object.freeze({ status: "unknown" });
const NONE = Object.freeze({ status: "none" });

// A module that is loaded again (degoog reloads plugins) drops what an earlier copy registered. init() registers the new
// copy, and only runs when the plugin is enabled, so a disabled plugin never stays registered.
delete globalThis[GAME_INFO_LOOKUP];

// The release year of a compact game (its ISO "released" date), 0 when unknown.
const yearOf = (game) => validYear(String(game?.released ?? "").slice(0, 4));
const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const BOARD_WAIT_DEFAULT_SECONDS = 5;
const BOARD_WAIT_MIN_SECONDS = 1;
const BOARD_WAIT_MAX_SECONDS = 8;
const BOARD_WAIT_MIN_MS = 200;

// The setting in seconds, clamped to 1..8; anything unreadable is the default.
export const boardWaitFromSetting = (value) => {
  const seconds = Number.parseFloat(String(value ?? ""));
  if (!Number.isFinite(seconds)) return BOARD_WAIT_DEFAULT_SECONDS * 1000;
  return Math.round(Math.min(BOARD_WAIT_MAX_SECONDS, Math.max(BOARD_WAIT_MIN_SECONDS, seconds)) * 1000);
};

const slotTimeoutMs = () => {
  const configured = Number.parseInt(process.env.DEGOOG_SLOT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
};
const LABELS = { igdb: "IGDB", protondb: "ProtonDB", steam: "Steam" };
const PC_PLATFORM = /\b(?:pc|windows|linux|mac|macos)\b/i;

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

export class GameInfoSlot {
  isClientExposed = false;
  id = "game-info";
  name = "Game info (IGDB + ProtonDB)";
  description = "Shows a video game information panel (scores, platforms, developer, time to beat, ProtonDB tier, Steam link) from IGDB.";
  position = "knowledge-panel";
  slotPositions = ["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"];
  settingsSchema = SETTINGS_SCHEMA;

  clientId = "";
  clientSecret = "";
  requireGameWord = false;
  showProtonDb = true;
  steamFallback = true;
  showDescription = true;
  debugMatching = false;
  whenBoth = "oldest";
  disabled = false;
  boardWaitMs = BOARD_WAIT_DEFAULT_SECONDS * 1000;
  // degoog gives a slot 10 s (DEGOOG_SLOT_TIMEOUT_MS). The wait for the board game answer never ends after 70 % of it,
  // which leaves the rest for the IGDB follow-up requests.
  startWindowMs = Math.max(1000, Math.round(slotTimeoutMs() * 0.7));
  // A lookup that is still running shortly before degoog's own timeout is given up on for this search; its work is not
  // cancelled and fills the cache. The lookup for the other plugin then says "unknown" (no video game panel is coming).
  answerWindowMs = Math.max(500, Math.round(slotTimeoutMs() * 0.95));
  boardLookup = () => globalThis[BOARD_GAMES_LOOKUP];
  apiBase = process.env.DEGOOG_IGDB_API_BASE || DEFAULT_API_BASE;
  tokenUrl = process.env.DEGOOG_IGDB_TOKEN_URL || DEFAULT_TOKEN_URL;
  protonBase = process.env.DEGOOG_PROTONDB_BASE || DEFAULT_PROTONDB_BASE;
  steamBase = process.env.DEGOOG_STEAM_BASE || DEFAULT_STEAM_BASE;
  now = Date.now;
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  spacingMs = MIN_SPACING_MS;
  tokens = new TokenStore({ file: tokenFile(process.env.DEGOOG_DATA_DIR || "data"), now: () => this.now() });

  template = FALLBACK_TEMPLATE;
  _signProxy = null;
  _pausedUntil = { igdb: 0, protondb: 0, steam: 0 };
  _lastIgdbAt = 0;
  _gateChain = Promise.resolve();
  _local = {};
  _inflight = new Map();
  _missed = new Set();

  init(context) {
    if (context?.template) this.template = context.template;
    if (context?.signProxyUrl) this._signProxy = context.signProxyUrl;
    // Replaces an earlier registration, so running init more than once is safe.
    this._lookup ??= (request) => this.lookupTitle(request);
    globalThis[GAME_INFO_LOOKUP] = this._lookup;
  }

  configure(settings = {}) {
    this.clientId = String(settings.clientId ?? "").trim() || String(process.env.IGDB_CLIENT_ID ?? "").trim();
    this.clientSecret = String(settings.clientSecret ?? "").trim() || String(process.env.IGDB_CLIENT_SECRET ?? "").trim();
    this.requireGameWord = truthy(settings.requireGameWord, false);
    this.showProtonDb = truthy(settings.showProtonDb, true);
    this.steamFallback = truthy(settings.steamFallback, true);
    this.showDescription = truthy(settings.showDescription, true);
    this.debugMatching = truthy(settings.debugMatching, false);
    this.whenBoth = normalizeWhenBoth(settings.whenBothMatch);
    // degoog passes the stored "disabled" flag along with the settings when the user switches the plugin off.
    this.disabled = truthy(settings.disabled, false);
    this.boardWaitMs = boardWaitFromSetting(settings.boardGameWaitSeconds);
  }

  isPaused(upstream) {
    return this.now() < this._pausedUntil[upstream];
  }

  get paused() {
    return this.isPaused("igdb");
  }

  // Why a query does not get a lookup ("" when it does).
  _rejection(query) {
    if (!this.clientId || !this.clientSecret) return "no Twitch client id and secret are set";
    if (this.paused) return "IGDB is paused after an error";
    if (!looksLikeATitleSearch(query)) return "not a title search";
    if (isBoardGameQuery(query)) return "the query has a board game word and no video game word";
    if (this.requireGameWord && !hasGameWord(query)) return "requireGameWord is on and the query has no game word";
    return "";
  }

  // With debugMatching a title-like query that is turned away is logged with the rule that did it.
  trigger(query) {
    const why = this._rejection(query);
    if (why && this.debugMatching && why !== "not a title search" && looksLikeATitleSearch(query)) {
      console.info(`[game-info] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" skipped: ${why}`);
    }
    return !why;
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:game-info:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  _pause(upstream, ms, reason) {
    const wasPaused = this.isPaused(upstream);
    this._pausedUntil[upstream] = Math.max(this._pausedUntil[upstream], this.now() + ms);
    if (!wasPaused) console.warn(`[game-info] ${reason}; paused for ${Math.ceil(ms / 60_000)} min`);
  }

  // One request to an upstream. Resolves to { status, data }: status 0 means it failed or was not made.
  // Only generic text is ever logged. Addresses and credentials never are.
  async _send(upstream, doFetch, url, init) {
    const label = LABELS[upstream];
    let response;
    try {
      response = await doFetch(url, init);
    } catch {
      this._pause(upstream, ERROR_PAUSE_MS, `${label} could not be reached`);
      return { status: 0 };
    }
    const status = response.status;
    if (status === 429) {
      this._pause(upstream, retryAfterMs(response.headers?.get?.("retry-after"), RATE_PAUSE_MS), `${label} rate limited this instance`);
      return { status };
    }
    // IGDB answers 401 for an expired token, which the caller handles. 403 means the credentials are not accepted.
    if (status === 401 && upstream === "igdb") return { status };
    if (status === 401 || status === 403) {
      this._pause(upstream, upstream === "igdb" ? KEY_PAUSE_MS : RATE_PAUSE_MS, `${label} refused the request (HTTP ${status})`);
      return { status };
    }
    if (status >= 500) {
      this._pause(upstream, ERROR_PAUSE_MS, `${label} answered HTTP ${status}`);
      return { status };
    }
    if (status < 200 || status >= 300) return { status };
    try {
      return { status, data: await response.json() };
    } catch {
      return { status: 0 };
    }
  }

  async _token(doFetch) {
    try {
      return await this.tokens.get({ clientId: this.clientId, clientSecret: this.clientSecret, url: this.tokenUrl, fetch: doFetch });
    } catch (error) {
      if (error?.kind === "rejected") this._pause("igdb", KEY_PAUSE_MS, "Twitch rejected the IGDB credentials");
      else if (error?.kind === "rate") this._pause("igdb", error.retryAfterMs || RATE_PAUSE_MS, "Twitch rate limited the token request");
      else this._pause("igdb", ERROR_PAUSE_MS, "the Twitch token service could not be reached");
      return null;
    }
  }

  // IGDB allows 4 requests a second. Requests queue up here and keep at least spacingMs apart.
  async _gate() {
    const before = this._gateChain;
    let release;
    this._gateChain = new Promise((resolve) => {
      release = resolve;
    });
    await before;
    try {
      const wait = this._lastIgdbAt + this.spacingMs - this.now();
      if (wait > 0) await this.sleep(wait);
    } finally {
      this._lastIgdbAt = this.now();
      release();
    }
  }

  // One IGDB query. A 401 means the token is no good: fetch a fresh one and retry that request once.
  async _igdb(endpoint, body, context) {
    if (this.paused) return null;
    const doFetch = context?.fetch ?? fetch;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this._token(doFetch);
      if (!token) return null;
      await this._gate();
      if (this.paused) return null;
      const result = await this._send("igdb", doFetch, igdbUrl(this.apiBase, endpoint), {
        method: "POST",
        headers: buildIgdbHeaders(this.clientId, token),
        body,
      });
      if (result.status === 401) {
        this.tokens.invalidate(token);
        continue;
      }
      return result.status === 200 ? result.data : null;
    }
    this._pause("igdb", KEY_PAUSE_MS, "IGDB rejected the credentials");
    return null;
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
    if (cached && Array.isArray(cached.results)) return cached.results;
    return this._once("search", key, async () => {
      const data = await this._igdb("games", buildSearchQuery(term), context);
      if (!Array.isArray(data)) return null;
      const results = data.map(compactGame);
      await cache.set(key, { results });
      return results;
    });
  }

  async _timeToBeat(id, context) {
    if (!Number.isInteger(id) || id <= 0) return null;
    const cache = this._cache(context, "ttb", TTB_TTL_MS);
    const key = String(id);
    const cached = await cache.get(key);
    if (cached?.ttb) return cached.ttb;
    return this._once("ttb", key, async () => {
      const data = await this._igdb("game_time_to_beats", buildTimeToBeatQuery(id), context);
      if (!Array.isArray(data)) return null;
      const ttb = compactTimeToBeat(data[0]);
      await cache.set(key, { ttb });
      return ttb;
    });
  }

  async _proton(appId, context) {
    if (!isAppId(appId) || this.isPaused("protondb")) return null;
    const cache = this._cache(context, "proton", PROTON_TTL_MS);
    const key = String(appId);
    const cached = await cache.get(key);
    if (cached && Object.hasOwn(cached, "proton")) return cached.proton;
    return this._once("proton", key, async () => {
      const result = await this._send("protondb", context?.fetch ?? fetch, protonSummaryUrl(this.protonBase, appId), { headers: pluginHeaders() });
      if (result.status !== 200 && result.status !== 404) return null;
      const proton = result.status === 200 ? compactProton(result.data) : null;
      await cache.set(key, { proton });
      return proton;
    });
  }

  // The Steam app id: from IGDB when it knows one, else (optionally) an exact-name Steam store search for PC games.
  async _steamAppId(game, context) {
    if (isAppId(game.steamAppId)) return String(game.steamAppId);
    if (!this.steamFallback || this.isPaused("steam")) return "";
    if (!(game.platformNames ?? []).some((name) => PC_PLATFORM.test(name))) return "";
    const wanted = normalizeTitle(game.name);
    if (!wanted) return "";
    const cache = this._cache(context, "steam", STEAM_TTL_MS);
    const cached = await cache.get(wanted);
    if (cached && Object.hasOwn(cached, "appId")) return cached.appId;
    return this._once("steam", wanted, async () => {
      const result = await this._send("steam", context?.fetch ?? fetch, steamSearchUrl(this.steamBase, game.name), { headers: pluginHeaders() });
      if (result.status !== 200) return "";
      const items = Array.isArray(result.data?.items) ? result.data.items : [];
      const match = items.find((item) => item?.type === "app" && normalizeTitle(item?.name) === wanted && isAppId(item?.id));
      const appId = match ? String(match.id) : "";
      await cache.set(wanted, { appId });
      return appId;
    });
  }

  // The confident video game pick for a title, shared with execute() through _search(): -> { answered, game }.
  async _pickFor(term, context, intent, { explain = false, query = term } = {}) {
    const results = await this._search(term, context);
    if (!results) return { answered: false, game: null };
    const result = evaluate(term, results, intent, { explain });
    if (explain) console.info(formatExplanation(query, term, intent, result));
    return { answered: true, game: result.pick };
  }

  _logLookup(term, outcome) {
    if (!this.debugMatching) return;
    const label = outcome.status === "match" ? `match "${clean(outcome.name, 70)}" ${outcome.year || "(year unknown)"}` : outcome.status;
    console.info(`[game-info] "${clean(term, 100)}" asked about by board-games: ${label}`);
  }

  // The contract with board-games, the other way round from boardLookup(): is there a confident video game for this
  // title? Only this plugin's own IGDB search and pick (no time to beat, ProtonDB or Steam request), with the same
  // single-flight and cache as execute(). Never throws, never calls the other plugin, makes no request without
  // credentials, and waits at most deadlineMs (a slower reply keeps running and fills the cache).
  // -> { status: "match", name, id, year, mode } | { status: "none" } | { status: "unknown" }
  async lookupTitle(request) {
    try {
      const { term, deadlineMs, context } = request ?? {};
      const raw = String(term ?? "").trim();
      const title = extractTerm(raw);
      // the gating looks at the term as given: "skyrim board game" is not a video game search, whatever is left of it
      if (this.disabled || sanitizeTerm(title).length < 2 || this._rejection(raw) || this._rejection(title)) return UNKNOWN;
      // execute() for this title already gave up and its answer is still on the way: no video game panel this time.
      if (this._missed.has(cacheKey(title))) {
        this._logLookup(title, UNKNOWN);
        return UNKNOWN;
      }
      const waitMs = Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : this.startWindowMs;
      if (waitMs <= 0) return UNKNOWN;
      const work = this._pickFor(title, context, false);
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
      else if (found.game) outcome = { status: "match", name: String(found.game.name ?? ""), id: String(found.game.id ?? ""), year: yearOf(found.game), mode: this.whenBoth };
      else if (found.answered) outcome = NONE;
      this._logLookup(title, outcome);
      return outcome;
    } catch {
      return UNKNOWN;
    }
  }

  // Does a board game with the same title match, and does it win? Only asked after this plugin has a confident pick, never
  // for a query with a video-game-specific word, never when the setting already settles it ("always the video game",
  // "show both"), and never longer than the time left. Anything but a clear "match" keeps the video game.
  async _boardGameWins(query, term, context, startedAt, game) {
    const mode = this.whenBoth;
    const say = (text) => this.debugMatching && console.info(`[game-info] "${clean(term, 100)}" ${text}`);
    if (hasVideoGameWord(query)) return false;
    if (mode === "video-game" || mode === "both") {
      say(`board game lookup skipped: mode=${mode}`);
      return false;
    }
    const lookup = this.boardLookup();
    if (typeof lookup !== "function") {
      say("video game shown: the board games plugin is not available");
      return false;
    }
    const waitMs = Math.min(this.boardWaitMs, startedAt + this.startWindowMs - this.now());
    let outcome = { status: "unknown" };
    if (waitMs >= BOARD_WAIT_MIN_MS) {
      let timer;
      const late = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs + 100);
      });
      try {
        const answer = await Promise.race([Promise.resolve(lookup({ term, deadlineMs: waitMs, context })), late]);
        if (answer && typeof answer === "object") outcome = answer;
      } catch {
        /* the video game stays */
      } finally {
        clearTimeout(timer);
      }
    }
    if (outcome.status !== "match") {
      say(`video game shown: board game lookup ${outcome.status === "none" ? "none" : "unknown or too slow"}`);
      return false;
    }
    const boardYear = validYear(outcome.year);
    const videoYear = yearOf(game);
    const shows = decideBothMatch({ mode, boardYear, videoYear });
    say(`both match: board "${clean(outcome.name, 70)}" ${boardYear || "(year unknown)"} vs video "${clean(game.name, 70)}" ${videoYear || "(year unknown)"}, mode=${mode} -> showing ${shows}`);
    return shows === "board";
  }

  async _render(query, term, context, startedAt) {
    try {
      const intent = hasGameWord(query);
      const { answered, game } = await this._pickFor(term, context, intent, { explain: this.debugMatching, query });
      if (!answered || !game) return EMPTY;
      if (await this._boardGameWins(query, term, context, startedAt, game)) return EMPTY;
      const [ttb, steamAppId] = await Promise.all([this._timeToBeat(game.id, context), this._steamAppId(game, context)]);
      const proton = this.showProtonDb && steamAppId ? await this._proton(steamAppId, context) : null;
      const html = buildPanel({
        game: { ...game, steamAppId },
        ttb,
        proton,
        signProxy: context?.signProxyUrl ?? this._signProxy,
        locale: context?.locale,
        showDescription: this.showDescription,
      });
      return { title: game.name, html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }

  async execute(query, context) {
    const startedAt = this.now();
    if (!this.trigger(query)) return EMPTY;
    const term = extractTerm(query);
    if (sanitizeTerm(term).length < 2) return EMPTY;
    const work = this._render(query, term, context, startedAt);
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), this.answerWindowMs);
    });
    let out;
    try {
      out = await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
    }
    if (out !== TIMED_OUT) return out;
    const missed = cacheKey(term);
    this._missed.add(missed);
    work.then(
      () => this._missed.delete(missed),
      () => this._missed.delete(missed),
    );
    if (this.debugMatching) console.info(`[game-info] "${clean(query, 100)}" is still being looked up; the reply is cached when it arrives, so searching again in a moment shows the panel`);
    return EMPTY;
  }
}

export const slot = new GameInfoSlot();

export default { slot };
