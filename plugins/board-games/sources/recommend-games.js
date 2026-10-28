import { Budget, recommendGamesUsageFile } from "../budget.js";
import { USER_AGENT, sanitizeTerm } from "../request.js";
import { cacheKey } from "../match.js";
import { RECOMMEND_MAX_CHARS, SOURCE_RECOMMEND_GAMES, parseRecommendGames } from "../shape.js";
import { Upstream } from "../upstream.js";

export const DEFAULT_RECOMMEND_BASE = "https://recommend.games";
const SEARCH_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_DAILY_LIMIT = 500;

// Without an explicit ordering the server sorts every match by its own recommendation rating, and a search such as
// "wingspan" then takes 15 to 20 seconds. Sorted by the number of votes it answers in 1 to 2 seconds (measured), returns
// the same games, and puts the best known ones on the first page, which is the page that is read.
export const RECOMMEND_ORDERING = "-num_votes";

export const recommendSearchUrl = (term, base = DEFAULT_RECOMMEND_BASE) =>
  `${String(base || DEFAULT_RECOMMEND_BASE).replace(/\/+$/, "")}/api/games/?${new URLSearchParams({ search: sanitizeTerm(term), ordering: RECOMMEND_ORDERING })}`;

// Source 2: recommend.games, a small third-party site that mirrors BoardGameGeek data. No key.
// One request returns everything: the fuzzy matches (expansions removed) are matched locally.
export class RecommendGamesSource {
  id = SOURCE_RECOMMEND_GAMES;
  label = "recommend.games";
  enabled = true;

  constructor(host) {
    this.host = host;
    this.base = process.env.DEGOOG_RECOMMEND_GAMES_BASE || DEFAULT_RECOMMEND_BASE;
    this.budget = new Budget({ file: recommendGamesUsageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => host.now() });
    this.upstream = new Upstream({ host, label: "recommend.games", budgetOf: () => this.budget, blockMessage: "recommend.games refused the request" });
  }

  configure({ enabled, limit }) {
    this.enabled = enabled;
    this.budget.cap = limit;
  }

  usable() {
    return this.enabled && !this.upstream.paused && !this.budget.exhausted;
  }

  async _games(term, { context, deadline }) {
    const cache = this.host.cache(context, `${this.id}:search`, SEARCH_TTL_MS);
    const key = cacheKey(term);
    const cached = await cache.get(key);
    if (cached && Array.isArray(cached.games)) return { ok: true, games: cached.games };
    return this.host.once(`${this.id}:search`, key, async () => {
      const reply = await this.upstream.request(recommendSearchUrl(term, this.base), {
        context,
        deadline,
        maxChars: RECOMMEND_MAX_CHARS,
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      });
      if (!reply.ok) return { ok: false, reason: reply.reason };
      const games = parseRecommendGames(reply.text);
      if (!games) return { ok: false, reason: "invalid" };
      await cache.set(key, { games });
      return { ok: true, games };
    });
  }

  // recommend.games lists its matches in search order, so a close first result needs fewer votes (rankBonus).
  async lookup({ term, intent, context, deadline, query }) {
    const found = await this._games(term, { context, deadline });
    if (!found.ok) return { status: "unavailable", reason: found.reason };
    return { status: "ok", game: this.host.decide({ query, term, intent, games: found.games, source: this.id, rankBonus: true }) };
  }
}
