import { Budget, geekdoUsageFile } from "../budget.js";
import { USER_AGENT, isId } from "../request.js";
import { cacheKey } from "../match.js";
import { SOURCE_INTERNAL, compactGeekdo, geekdoId, isGeekdoBoardGame } from "../shape.js";
import { Upstream } from "../upstream.js";
import { Wikidata } from "./wikidata.js";

export const DEFAULT_GEEKDO_BASE = "https://api.geekdo.com/api";
const TTL_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_DAILY_LIMIT = 100;
const MAX_CHARS = 1_000_000;
const MAX_HINTS = 2;

const trimBase = (base) => String(base || DEFAULT_GEEKDO_BASE).replace(/\/+$/, "");
export const geekitemsUrl = (id, base = DEFAULT_GEEKDO_BASE) =>
  isId(id) ? `${trimBase(base)}/geekitems?${new URLSearchParams({ objectid: String(id), objecttype: "thing" })}` : "";
export const dynamicInfoUrl = (id, base = DEFAULT_GEEKDO_BASE) =>
  isId(id) ? `${trimBase(base)}/dynamicinfo?${new URLSearchParams({ objectid: String(id), objecttype: "thing" })}` : "";

const parseJson = (text) => {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && data.item && typeof data.item === "object" ? data : null;
  } catch {
    return null;
  }
};

// Source 3: the JSON API that BoardGameGeek's own website uses. It has details by id only, no search, so a
// name is first turned into an id with Wikidata, unless an earlier source already found candidate ids.
// Opt-in: BGG's terms call this API unlicensed. A Cloudflare challenge is never solved or bypassed.
export class BggInternalSource {
  id = SOURCE_INTERNAL;
  label = "BGG website API";
  enabled = false;

  constructor(host) {
    this.host = host;
    this.base = process.env.DEGOOG_GEEKDO_BASE || DEFAULT_GEEKDO_BASE;
    // Wikidata requests count against the same daily limit.
    this.budget = new Budget({ file: geekdoUsageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => host.now() });
    this.upstream = new Upstream({ host, label: "BGG's website API", budgetOf: () => this.budget, blockMessage: "BGG's website API blocked the request" });
    this.wikidata = new Wikidata({ host, budgetOf: () => this.budget });
  }

  configure({ enabled, limit }) {
    this.enabled = enabled;
    this.budget.cap = limit;
  }

  usable() {
    return this.enabled && !this.upstream.paused && !this.budget.exhausted;
  }

  _get(url, { context, deadline }) {
    return this.upstream.request(url, { context, deadline, maxChars: MAX_CHARS, headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
  }

  // Name -> BoardGameGeek id ("" when Wikidata has none). Cached, "none" too.
  async _resolve(term, request) {
    const cache = this.host.cache(request.context, `${this.id}:search`, TTL_MS);
    const key = cacheKey(term);
    const cached = await cache.get(key);
    if (cached && typeof cached.id === "string") return { ok: true, id: cached.id };
    return this.host.once(`${this.id}:search`, key, async () => {
      const resolved = await this.wikidata.resolve({ term, ...request });
      if (!resolved.ok) return { ok: false, reason: resolved.reason };
      const id = resolved.candidates[0]?.bggId ?? "";
      await cache.set(key, { id });
      return { ok: true, id };
    });
  }

  // One game's details: geekitems for the facts and dynamicinfo for the rank and ratings (2 requests, 1 s apart).
  // game is null for an id that is not a board game itself.
  async _details(id, request) {
    const cache = this.host.cache(request.context, `${this.id}:details`, TTL_MS);
    const cached = await cache.get(id);
    if (cached && Object.hasOwn(cached, "game")) return { ok: true, game: cached.game };
    return this.host.once(`${this.id}:details`, id, async () => {
      const items = await this._get(geekitemsUrl(id, this.base), request);
      if (!items.ok && items.status === 404) {
        await cache.set(id, { game: null });
        return { ok: true, game: null };
      }
      if (!items.ok) return { ok: false, reason: items.reason };
      const itemData = parseJson(items.text);
      if (!itemData || geekdoId(itemData) !== id) return { ok: false, reason: "invalid" };
      if (!isGeekdoBoardGame(itemData)) {
        await cache.set(id, { game: null });
        return { ok: true, game: null };
      }
      const info = await this._get(dynamicInfoUrl(id, this.base), request);
      if (!info.ok) return { ok: false, reason: info.reason };
      const dynamicData = parseJson(info.text);
      if (!dynamicData) return { ok: false, reason: "invalid" };
      const game = compactGeekdo(itemData, dynamicData);
      const value = game.id && game.name ? game : null;
      await cache.set(id, { game: value });
      return { ok: true, game: value };
    });
  }

  async lookup({ term, intent, context, deadline, hints, query }) {
    const request = { context, deadline };
    let ids = (hints?.ids ?? []).filter(isId).slice(0, MAX_HINTS);
    if (!ids.length) {
      const resolved = await this._resolve(term, request);
      if (!resolved.ok) return { status: "unavailable", reason: resolved.reason };
      ids = resolved.id ? [resolved.id] : [];
    }
    if (!ids.length) return { status: "ok", game: null };
    const games = [];
    for (const id of ids) {
      const details = await this._details(id, request);
      if (!details.ok) return { status: "unavailable", reason: details.reason };
      if (details.game) games.push(details.game);
      const game = this.host.decide({ query, term, intent, games, source: this.id });
      if (game) return { status: "ok", game };
    }
    return { status: "ok", game: null };
  }
}
