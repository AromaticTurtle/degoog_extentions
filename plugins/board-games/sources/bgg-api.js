import { Budget, usageFile } from "../budget.js";
import { DEFAULT_API_BASE, buildHeaders, buildSearchUrl, buildThingUrl, normalizeToken } from "../request.js";
import { cacheKey, pickGame, rankCandidates } from "../match.js";
import { SEARCH_MAX_CHARS, SOURCE_API, THING_MAX_CHARS, parseThings, scanSearch } from "../shape.js";
import { Upstream } from "../upstream.js";

const SEARCH_TTL_MS = 24 * 60 * 60_000;
const DETAILS_TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_DAILY_LIMIT = 300;

// Source 1: BoardGameGeek's licensed XML API. Needs a registered application's token.
// Search -> candidate ids by title -> one batch request for their details.
export class BggApiSource {
  id = SOURCE_API;
  label = "BGG XML API";
  enabled = true;
  token = "";

  constructor(host) {
    this.host = host;
    this.base = process.env.DEGOOG_BGG_API_BASE || DEFAULT_API_BASE;
    this.budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => host.now() });
    this.upstream = new Upstream({
      host,
      label: "BGG",
      budgetOf: () => this.budget,
      blockMessage: "BGG rejected the API token or blocked the request",
    });
  }

  configure({ enabled, token, limit }) {
    this.enabled = enabled;
    this.token = normalizeToken(token);
    this.budget.cap = limit;
  }

  usable() {
    return this.enabled && Boolean(this.token) && !this.upstream.paused && !this.budget.exhausted;
  }

  _get(url, { context, deadline }, maxChars) {
    return this.upstream.request(url, { context, deadline, maxChars, headers: buildHeaders(this.token) });
  }

  // Search -> the ids of the results whose title is close to the term (possibly none).
  async _candidates(term, request) {
    const cache = this.host.cache(request.context, `${this.id}:search`, SEARCH_TTL_MS);
    const key = cacheKey(term);
    const cached = await cache.get(key);
    if (cached && Array.isArray(cached.ids)) return { ok: true, ids: cached.ids };
    return this.host.once(`${this.id}:search`, key, async () => {
      const reply = await this._get(buildSearchUrl(term, this.base), request, SEARCH_MAX_CHARS);
      if (!reply.ok) return { ok: false, reason: reply.reason };
      if (!reply.text.trimStart().startsWith("<")) return { ok: false, reason: "invalid" };
      const { items, valid } = scanSearch(reply.text);
      if (!valid) return { ok: false, reason: "invalid" };
      const ids = rankCandidates(term, items);
      await cache.set(key, { ids });
      return { ok: true, ids };
    });
  }

  // The details of the candidates: cached ones as they are, the rest in one batch request.
  async _things(ids, request) {
    const cache = this.host.cache(request.context, `${this.id}:details`, DETAILS_TTL_MS);
    const found = new Map();
    const missing = [];
    for (const id of ids) {
      const cached = await cache.get(id);
      if (!cached || cached.id !== id) missing.push(id);
      else if (!cached.absent) found.set(id, cached);
    }
    if (missing.length) {
      const result = await this.host.once(`${this.id}:details`, missing.join(","), async () => {
        const reply = await this._get(buildThingUrl(missing, this.base), request, THING_MAX_CHARS);
        if (!reply.ok) return { ok: false, reason: reply.reason };
        const games = reply.text.trimStart().startsWith("<") ? parseThings(reply.text) : null;
        if (!games) return { ok: false, reason: "invalid" };
        for (const game of games) await cache.set(game.id, game);
        // An id that BGG answered nothing for is remembered too, so the same query does not ask again.
        for (const id of missing) if (!games.some((game) => game.id === id)) await cache.set(id, { id, absent: true });
        return { ok: true, games };
      });
      if (!result.ok) return result;
      for (const game of result.games) found.set(game.id, game);
    }
    return { ok: true, games: ids.map((id) => found.get(id)).filter(Boolean) };
  }

  // -> { status: "ok", game|null } or { status: "unavailable", reason, hints? }.
  // After a failed details request the candidate ids are handed on as hints.
  async lookup({ term, intent, context, deadline }) {
    const request = { context, deadline };
    const search = await this._candidates(term, request);
    if (!search.ok) return { status: "unavailable", reason: search.reason };
    if (!search.ids.length) return { status: "ok", game: null };
    const details = await this._things(search.ids, request);
    if (!details.ok) return { status: "unavailable", reason: details.reason, hints: { ids: search.ids } };
    return { status: "ok", game: pickGame(term, details.games, intent) };
  }
}
