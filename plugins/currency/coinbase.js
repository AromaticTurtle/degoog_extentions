import { Upstream } from "./upstream.js";

export const DEFAULT_COINBASE_BASE = "https://api.coinbase.com";
export const DEFAULT_EXCHANGE_BASE = "https://api.exchange.coinbase.com";
export const SPOT_TTL_MS = 30_000;
export const STATS_TTL_MS = 5 * 60_000;
export const LIST_TTL_MS = 24 * 60 * 60_000;

const CODE = /^[A-Z0-9]{2,12}$/;

const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// { data: { amount: "81466.435", base: "BTC", currency: "USD" } }
export const parseSpot = (text) => positive(json(text)?.data?.amount);

// { open, high, low, last, volume, volume_30day, ... } (all strings). Everything is in USD.
export const parseStats = (text) => {
  const body = json(text);
  if (!body || typeof body !== "object") return null;
  const last = positive(body.last);
  const open = positive(body.open);
  const high = positive(body.high);
  const low = positive(body.low);
  if (!last || !open || !high || !low || high < low) return null;
  const volume = Number(body.volume);
  return { last, open, high, low, volume: Number.isFinite(volume) && volume >= 0 ? volume : 0 };
};

// { data: [ { code: "BTC", name: "Bitcoin", type: "crypto", ... }, ... ] } -> [[code, name], ...]
export const parseList = (text) => {
  const list = json(text)?.data;
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const code = typeof item?.code === "string" ? item.code.toUpperCase() : "";
    if (CODE.test(code)) out.push([code, String(item.name ?? code).slice(0, 60)]);
  }
  return out.length ? out : null;
};

// Coinbase's public (keyless) endpoints: spot price, 24 hour stats and the list of crypto currencies. Each has its own
// upstream (pause state and spacing), so a problem with the stats never stops prices.
export class Coinbase {
  constructor(host) {
    this.host = host;
    this.base = process.env.DEGOOG_CURRENCY_COINBASE_BASE || DEFAULT_COINBASE_BASE;
    this.exchange = process.env.DEGOOG_CURRENCY_EXCHANGE_BASE || DEFAULT_EXCHANGE_BASE;
    const make = (label, spacingMs) => new Upstream({ host, label, spacingMs, rejectedMessage: `${label} refused the request` });
    this.spotUpstream = make("Coinbase prices", 500);
    this.statsUpstream = make("Coinbase statistics", 500);
    this.listUpstream = make("Coinbase currency list", 1000);
    this.known = null; // Map code -> name once the list has been fetched
    this.knownAt = 0;
  }

  get upstreams() {
    return [this.spotUpstream, this.statsUpstream, this.listUpstream];
  }

  // The crypto codes seen so far (null until the list has been fetched in this process).
  get codes() {
    return this.known ? new Set(this.known.keys()) : null;
  }

  async spot(code, { context, deadline }) {
    if (!CODE.test(code)) return null;
    const cache = this.host._cache(context, "crypto-spot", SPOT_TTL_MS);
    const cached = await cache.get(code);
    if (cached && positive(cached.price)) return cached.price;
    return this.host._once("spot", code, async () => {
      const result = await this.spotUpstream.request(`${this.base}/v2/prices/${code}-USD/spot`, { context, deadline, maxChars: 20_000, headers: this.host.headers() });
      if (!result.ok) return null;
      const price = parseSpot(result.text);
      if (!price) return null;
      await cache.set(code, { price }, SPOT_TTL_MS);
      return price;
    });
  }

  // null when there is no such product or the request failed; a missing product is remembered for the cache time
  async stats(code, { context, deadline }) {
    if (!CODE.test(code)) return null;
    const cache = this.host._cache(context, "crypto-stats", STATS_TTL_MS);
    const cached = await cache.get(code);
    if (cached) return cached.stats ?? null;
    return this.host._once("stats", code, async () => {
      const result = await this.statsUpstream.request(`${this.exchange}/products/${code}-USD/stats`, { context, deadline, maxChars: 20_000, headers: this.host.headers() });
      if (!result.ok) {
        if (result.reason === "http" && result.status === 404) await cache.set(code, { stats: null }, STATS_TTL_MS);
        return null;
      }
      const stats = parseStats(result.text);
      await cache.set(code, { stats }, STATS_TTL_MS);
      return stats;
    });
  }

  async list({ context, deadline }) {
    if (this.known && this.host.now() - this.knownAt < LIST_TTL_MS) return this.known;
    const cache = this.host._cache(context, "crypto-list", LIST_TTL_MS);
    const cached = await cache.get("list");
    if (Array.isArray(cached) && cached.length) {
      this.known = new Map(cached);
      this.knownAt = this.host.now();
      return this.known;
    }
    return this.host._once("list", "all", async () => {
      const result = await this.listUpstream.request(`${this.base}/v2/currencies/crypto`, { context, deadline, maxChars: 400_000, headers: this.host.headers() });
      if (!result.ok) return null;
      const list = parseList(result.text);
      if (!list) return null;
      this.known = new Map(list);
      this.knownAt = this.host.now();
      await cache.set("list", list, LIST_TTL_MS);
      return this.known;
    });
  }
}
