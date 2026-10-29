import { SETTINGS_SCHEMA } from "./settings.js";
import { parseQuery } from "./match.js";
import { DEFAULT_BASE, TOKEN_HEADER, candleUrl, metricUrl, parseCandles, parseMetric, parseProfile, parseQuote, parseSearch, parseStatus, pickResult, profileUrl, quoteUrl, searchUrl, sessionOf, statusUrl } from "./finnhub.js";
import { buildCard } from "./render.js";
import { Budget, usageFile } from "./budget.js";
import { Store, cacheFile } from "./store.js";
import { FinnhubUpstream } from "./upstream.js";

// The inline layout puts the detailed card in the main column, above the results; the panel layout puts the compact card
// in the side column. The position follows the setting (no slotPositions are declared, so degoog uses `position`).
export const INLINE_POSITION = "above-results";
export const PANEL_POSITION = "knowledge-panel";
export const USER_AGENT = "degoog-stocks/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const DEFAULT_DAILY_LIMIT = 2000;
export const QUOTE_OPEN_TTL_MS = 45_000;
export const QUOTE_CLOSED_TTL_MS = 10 * 60_000;
export const PROFILE_TTL_MS = 7 * 24 * 60 * 60_000;
export const METRIC_TTL_MS = 6 * 60 * 60_000;
export const STATUS_TTL_MS = 2 * 60_000;
export const CANDLES_TTL_MS = 10 * 60_000;
export const RESOLVE_TTL_MS = 30 * 24 * 60 * 60_000;
export const NEGATIVE_TTL_MS = 24 * 60 * 60_000;
export const SHORT_NEGATIVE_TTL_MS = 60 * 60_000;
export const CANDLES_UNAVAILABLE_TTL_MS = 24 * 60 * 60_000;
const FALLBACK_TEMPLATE = '<div class="command-result stocks-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

export const layoutFrom = (value) => (String(value ?? "").trim().toLowerCase() === "panel" ? "panel" : "inline");
// The key from the settings UI, else FINNHUB_API_KEY. Whitespace and quotes pasted along with it are dropped; anything that cannot be a header value is refused.
export const keyFrom = (value) => {
  const key = String(value ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : "";
};
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

export class StocksSlot {
  isClientExposed = false;
  id = "stocks";
  name = "Stocks (Finnhub)";
  description = "Stock quote card for 'AAPL stock', '$AAPL', 'apple stock price' and (optionally) a bare ticker: price, change, market status, ranges, statistics, from Finnhub's free API (needs a free key; US stocks).";
  position = INLINE_POSITION;
  settingsSchema = SETTINGS_SCHEMA;

  apiKey = "";
  layout = "inline";
  bare = true;
  sparkline = true;
  debugMatching = false;
  template = FALLBACK_TEMPLATE;
  baseUrl = process.env.DEGOOG_STOCKS_API_BASE || DEFAULT_BASE;
  _signProxy = null;
  _marketOpen = null;

  now = Date.now;
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  spacingMs = undefined;
  // degoog gives a slot 10 s (DEGOOG_SLOT_TIMEOUT_MS). No request is started after 70 % of it, and a lookup still running at
  // 95 % is given up on for this search (its reply is still cached when it arrives).
  startWindowMs = Math.max(1000, Math.round(slotTimeoutMs() * 0.7));
  answerWindowMs = Math.max(500, Math.round(slotTimeoutMs() * 0.95));

  _local = {};
  _inflight = new Map();

  constructor() {
    const dataDir = process.env.DEGOOG_DATA_DIR || "data";
    this.budget = new Budget({ file: usageFile(dataDir), cap: DEFAULT_DAILY_LIMIT, now: () => this.now() });
    this.store = new Store({ file: cacheFile(dataDir), now: () => this.now() });
    this.upstream = new FinnhubUpstream({ host: this, perMinute: 50, budgetOf: () => this.budget });
  }

  init(context) {
    if (context?.template) this.template = context.template;
    if (typeof context?.signProxyUrl === "function") this._signProxy = context.signProxyUrl;
  }

  configure(settings = {}) {
    const fromUi = keyFrom(settings.apiKey);
    this.apiKey = fromUi || keyFrom(process.env.FINNHUB_API_KEY);
    this.layout = layoutFrom(settings.layout);
    this.position = this.layout === "panel" ? PANEL_POSITION : INLINE_POSITION;
    this.bare = truthy(settings.triggerOnBareTicker, true);
    this.sparkline = truthy(settings.showSparkline, true);
    this.debugMatching = truthy(settings.debugMatching, false);
    this.budget.cap = limitOf(settings.dailyRequestLimit, DEFAULT_DAILY_LIMIT);
  }

  // The key goes ONLY here, into a header
  headers() {
    return { [TOKEN_HEADER]: this.apiKey, "User-Agent": USER_AGENT, Accept: "application/json" };
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:stocks:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  async _once(name, key, work) {
    const id = `${name}:${key}`;
    if (!this._inflight.has(id)) {
      this._inflight.set(id, work().finally(() => this._inflight.delete(id)));
    }
    return this._inflight.get(id);
  }

  inspect(query) {
    return parseQuery(query, { bare: this.bare });
  }

  _log(query, text) {
    if (this.debugMatching) console.info(`[stocks] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" ${text}`);
  }

  // Why a query that parsed as a stock query gets no lookup ("" when it does)
  _rejection(parsed) {
    if (!this.apiKey) return "no API key is set (settings or FINNHUB_API_KEY)";
    if (this.upstream.paused) return "Finnhub is paused (rejected key, rate limit or error)";
    if (this.budget.exhausted) return "the daily request limit is reached";
    if (parsed.symbol && this.store.has(`neg:${parsed.symbol}`)) return `${parsed.symbol} was recently found not to be a US stock (remembered)`;
    if (!parsed.symbol && this.store.has(`neg:name:${parsed.term}`)) return `"${parsed.term}" was recently found not to be a company (remembered)`;
    return "";
  }

  trigger(query) {
    try {
      const result = this.inspect(query);
      if (!result.parsed) {
        if (this.debugMatching && /\b(?:stocks?|shares?|quote|ticker)\b|^\$|^[A-Za-z]{1,5}(?:\.[A-Za-z])?$/.test(String(query ?? "").trim())) this._log(query, `not a stock query: ${result.reason}`);
        return false;
      }
      const why = this._rejection(result.parsed);
      if (why) this._log(query, `looks like a stock query (${result.reason}) but no lookup: ${why}`);
      return !why;
    } catch {
      return false;
    }
  }

  // A cached Finnhub call. call() -> { value } | { none: true } | { forbidden: true, why } | { why }
  async _cached(context, name, key, ttlMs, noneTtlMs, call) {
    const cache = this._cache(context, name, ttlMs);
    const hit = await cache.get(key);
    if (hit) return hit.none ? { status: "none", source: "cache" } : { status: "ok", value: hit.value, source: "cache" };
    return this._once(name, key, async () => {
      const outcome = await call();
      if (outcome.value !== undefined) {
        await cache.set(key, { value: outcome.value }, ttlMs);
        return { status: "ok", value: outcome.value, source: "request" };
      }
      if (outcome.none) {
        await cache.set(key, { none: true }, noneTtlMs);
        return { status: "none", source: "request" };
      }
      return { status: outcome.forbidden ? "forbidden" : "unavailable", why: outcome.why };
    });
  }

  async _get(url, context, deadline, parse, maxChars = 300_000) {
    const result = await this.upstream.request(url, { context, deadline, maxChars, headers: this.headers() });
    if (!result.ok) return result.reason === "forbidden" ? { forbidden: true, why: "forbidden" } : { why: result.reason };
    const value = parse(result.text);
    if (value === null || value === undefined) return { none: true };
    return { value };
  }

  async quote(symbol, context, deadline) {
    const ttl = this._marketOpen === false ? QUOTE_CLOSED_TTL_MS : QUOTE_OPEN_TTL_MS;
    return this._cached(context, "quote", symbol, ttl, SHORT_NEGATIVE_TTL_MS, () => this._get(quoteUrl(this.baseUrl, symbol), context, deadline, parseQuote, 20_000));
  }

  profile(symbol, context, deadline) {
    return this._cached(context, "profile", symbol, PROFILE_TTL_MS, SHORT_NEGATIVE_TTL_MS, () => this._get(profileUrl(this.baseUrl, symbol), context, deadline, parseProfile, 50_000));
  }

  metric(symbol, context, deadline) {
    return this._cached(context, "metric", symbol, METRIC_TTL_MS, SHORT_NEGATIVE_TTL_MS, () => this._get(metricUrl(this.baseUrl, symbol), context, deadline, parseMetric, 500_000));
  }

  async marketStatus(context, deadline) {
    const result = await this._cached(context, "status", "US", STATUS_TTL_MS, 30_000, () => this._get(statusUrl(this.baseUrl, "US"), context, deadline, parseStatus, 5_000));
    if (result.status === "ok") this._marketOpen = Boolean(result.value.isOpen);
    return result;
  }

  // Candles are a premium endpoint on some plans: ask once, and when Finnhub answers 403 remember it for a day
  async candles(symbol, context, deadline) {
    if (this.store.has("candles-unavailable")) return { status: "skipped", why: "candles are not on this plan (remembered)" };
    const result = await this._cached(context, "candles", symbol, CANDLES_TTL_MS, CANDLES_TTL_MS, () => this._get(candleUrl(this.baseUrl, symbol, this.now() / 1000), context, deadline, parseCandles, 200_000));
    if (result.status === "forbidden") this.store.set("candles-unavailable", true, CANDLES_UNAVAILABLE_TTL_MS);
    return result;
  }

  // Name or bare ticker -> { symbol, name } or null, through /search (remembered 30 days, a miss for 24 h)
  async resolve(parsed, context, deadline, steps) {
    const exact = parsed.kind === "bare" ? parsed.symbol : "";
    const key = exact ? `res:${exact}` : `res:name:${parsed.term}`;
    const known = this.store.get(key);
    if (known) {
      steps.push(`search: remembered ${known.symbol}`);
      return known;
    }
    const outcome = await this._once("search", key, async () => {
      const result = await this._get(searchUrl(this.baseUrl, exact || parsed.term), context, deadline, parseSearch, 200_000);
      if (result.value === undefined) return { failed: result.why ?? "no reply" };
      return { pick: pickResult(result.value, { exact, term: parsed.term }) };
    });
    if (outcome.failed) {
      steps.push(`search: unavailable (${outcome.failed})`);
      return null;
    }
    if (!outcome.pick) {
      this.store.set(exact ? `neg:${exact}` : `neg:name:${parsed.term}`, true, NEGATIVE_TTL_MS);
      steps.push(`search: no ${exact ? "exact symbol match" : "matching common stock"} (remembered for a day)`);
      return null;
    }
    this.store.set(key, outcome.pick, RESOLVE_TTL_MS);
    steps.push(`search: ${outcome.pick.symbol}`);
    return outcome.pick;
  }

  async compute(parsed, context, deadline) {
    const steps = [];
    const negTtl = parsed.kind === "bare" ? NEGATIVE_TTL_MS : SHORT_NEGATIVE_TTL_MS;
    let symbol = "";
    let quote = null;
    let quoteSource = "";

    const tryQuote = async (candidate, label) => {
      const result = await this.quote(candidate, context, deadline);
      steps.push(`quote ${candidate}: ${result.status}${result.source ? ` (${result.source})` : result.why ? ` (${result.why})` : ""}${label ? ` [${label}]` : ""}`);
      if (result.status === "ok") {
        symbol = candidate;
        quote = result.value;
        quoteSource = result.source;
        return true;
      }
      if (result.status === "none" || result.status === "forbidden") this.store.set(`neg:${candidate}`, true, negTtl);
      return false;
    };

    if (parsed.symbol && parsed.direct) {
      await tryQuote(parsed.symbol, "direct");
    } else if (parsed.kind === "bare") {
      const pick = await this.resolve(parsed, context, deadline, steps);
      if (pick) await tryQuote(pick.symbol, "after search");
    }
    if (!quote && parsed.kind === "explicit") {
      const pick = await this.resolve({ ...parsed, symbol: "" }, context, deadline, steps);
      if (pick && pick.symbol !== (parsed.direct ? parsed.symbol : "")) await tryQuote(pick.symbol, "after name search");
    }
    if (!quote) return { html: "", steps, why: "no confirmed US stock quote" };

    const wantsCandles = this.layout === "inline" && this.sparkline;
    const [profile, metric, status, candles] = await Promise.all([
      this.profile(symbol, context, deadline),
      this.metric(symbol, context, deadline),
      this.marketStatus(context, deadline),
      wantsCandles ? this.candles(symbol, context, deadline) : Promise.resolve({ status: "skipped", why: "sparkline off or panel layout" }),
    ]);
    // A quote fetched before the market status was known is kept 45 s; when the market turns out to be closed it can be kept longer
    if (quoteSource === "request" && this._marketOpen === false) await this._cache(context, "quote", QUOTE_CLOSED_TTL_MS).set(symbol, { value: quote }, QUOTE_CLOSED_TTL_MS);
    const describe = (name, r) => `${name}: ${r.status}${r.source ? ` (${r.source})` : r.why ? ` (${r.why})` : ""}`;
    steps.push([describe("profile", profile), describe("metric", metric), describe("market status", status), describe("candles", candles)].join("; "));

    const proxy = context?.signProxyUrl ?? this._signProxy;
    let logoSrc = "";
    if (profile.status === "ok" && profile.value.logo && typeof proxy === "function") {
      try {
        const signed = proxy(profile.value.logo);
        logoSrc = typeof signed === "string" && signed ? signed : "";
      } catch {
        logoSrc = "";
      }
    }
    const html = buildCard(
      {
        symbol,
        quote,
        profile: profile.status === "ok" ? profile.value : null,
        metric: metric.status === "ok" ? metric.value : null,
        session: status.status === "ok" ? sessionOf(status.value) : "",
        holiday: status.status === "ok" ? status.value.holiday : "",
        points: candles.status === "ok" ? candles.value.points : [],
        logoSrc,
      },
      { layout: this.layout },
    );
    return { html, steps, why: "" };
  }

  async build(query, context) {
    const { parsed } = this.inspect(query);
    if (!parsed) return "";
    if (this._rejection(parsed)) return "";
    const answerBy = this.now() + this.answerWindowMs;
    const deadline = this.now() + this.startWindowMs;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, answerBy - this.now()));
    });
    const outcome = await Promise.race([this.compute(parsed, context, deadline), timeout]);
    clearTimeout(timer);
    if (outcome === TIMED_OUT) {
      this._log(query, "-> too slow for the slot; the replies are cached when they arrive");
      return "";
    }
    if (this.debugMatching) {
      console.info([`[stocks] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" -> ${parsed.kind} rule: ${parsed.rule}, symbol=${parsed.symbol || "(by name)"} direct=${parsed.direct}, layout=${this.layout}`, ...outcome.steps.map((step) => `  ${step}`), `  verdict: ${outcome.html ? "card shown" : `no card (${outcome.why})`}`].join("\n"));
    }
    return outcome.html;
  }

  async execute(query, context) {
    try {
      const html = await this.build(query, context);
      if (!html) return EMPTY;
      return { title: "", html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }
}

export const slot = new StocksSlot();
