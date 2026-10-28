import { SETTINGS_SCHEMA } from "./settings.js";
import { FIAT_CODES } from "./currencies.js";
import { parseQuery } from "./match.js";
import { buildResult } from "./convert.js";
import { buildCard } from "./render.js";
import { FiatRates, DEFAULT_DAILY_LIMIT } from "./rates.js";
import { Coinbase } from "./coinbase.js";

// The inline layout puts the detailed card in the main column, above the results; the panel layout puts the compact card
// in the side column. The position follows the setting (no slotPositions are declared, so degoog uses `position`).
export const INLINE_POSITION = "above-results";
export const PANEL_POSITION = "knowledge-panel";
const FALLBACK_TEMPLATE = '<div class="command-result currency-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");
export const USER_AGENT = "degoog-currency/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

export const layoutFrom = (value) => (String(value ?? "").trim().toLowerCase() === "panel" ? "panel" : "inline");

export const decimalsFrom = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return "auto";
  return Math.min(8, Math.max(2, parsed));
};

export const codeFrom = (value, fallback) => {
  const code = String(value ?? "").trim().toUpperCase();
  return FIAT_CODES.has(code) ? code : fallback;
};

export const codesFrom = (value, fallback) => {
  const list = String(value ?? "")
    .split(/[\s,;]+/)
    .map((code) => code.trim().toUpperCase())
    .filter((code, index, all) => FIAT_CODES.has(code) && all.indexOf(code) === index);
  return list.length ? list.slice(0, 8) : fallback;
};

const DEFAULT_SECONDARY = ["EUR", "GBP", "JPY", "CAD", "AUD"];

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

export class CurrencySlot {
  isClientExposed = false;
  id = "currency";
  name = "Currency converter";
  description = "Currency conversion card: fiat rates from open.er-api.com (one cached request a day) and crypto prices from Coinbase's public API.";
  position = INLINE_POSITION;
  settingsSchema = SETTINGS_SCHEMA;

  layout = "inline";
  home = "USD";
  secondary = DEFAULT_SECONDARY;
  dollarMeans = "USD";
  enableCrypto = true;
  decimals = "auto";
  debugMatching = false;
  template = FALLBACK_TEMPLATE;

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
    this.fiat = new FiatRates(this);
    this.coinbase = new Coinbase(this);
  }

  init(context) {
    if (context?.template) this.template = context.template;
  }

  configure(settings = {}) {
    this.layout = layoutFrom(settings.layout);
    this.position = this.layout === "panel" ? PANEL_POSITION : INLINE_POSITION;
    this.home = codeFrom(settings.homeCurrency, "USD");
    this.secondary = codesFrom(settings.secondaryCurrencies, DEFAULT_SECONDARY);
    this.dollarMeans = codeFrom(settings.dollarMeans, "USD");
    this.enableCrypto = truthy(settings.enableCrypto, true);
    this.decimals = decimalsFrom(settings.decimals);
    this.debugMatching = truthy(settings.debugMatching, false);
    this.fiat.budget.cap = limitOf(settings.dailyRequestLimit, DEFAULT_DAILY_LIMIT);
  }

  headers() {
    return { "User-Agent": USER_AGENT, Accept: "application/json" };
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:currency:${name}`, ttlMs);
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
    return parseQuery(query, {
      dollarMeans: this.dollarMeans,
      homeCurrency: this.home,
      secondary: this.secondary,
      enableCrypto: this.enableCrypto,
      crypto: this.coinbase.codes,
    });
  }

  trigger(query) {
    try {
      const result = this.inspect(query);
      if (!result.parsed && this.debugMatching && result.partial) {
        console.info(`[currency] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" not a conversion: ${result.reason}`);
      }
      return Boolean(result.parsed);
    } catch {
      return false;
    }
  }

  // The card's data for a parsed query, or null when a needed price is unavailable. Never throws.
  async compute(parsed, context, deadline) {
    try {
      const { from, to } = parsed;
      const fiatSides = [from, to].filter((side) => side.kind === "fiat");
      const needsRates = parsed.kind === "fiat" || fiatSides.some((side) => side.code !== "USD");
      const cryptoSides = [from, to].filter((side) => side.kind === "crypto");
      const fiatSide = fiatSides[0];
      const statsFor = cryptoSides.length === 1 && fiatSide ? cryptoSides[0].code : null;
      const [rates, spotList, stats] = await Promise.all([
        needsRates ? this.fiat.get({ context, deadline }) : Promise.resolve(null),
        Promise.all(cryptoSides.map((side) => this.coinbase.spot(side.code, { context, deadline }))),
        statsFor ? this.coinbase.stats(statsFor, { context, deadline }) : Promise.resolve(null),
        parsed.kind === "crypto" && !this.coinbase.known ? this.coinbase.list({ context, deadline }) : Promise.resolve(null),
      ]);
      const spots = {};
      cryptoSides.forEach((side, index) => {
        if (spotList[index]) spots[side.code] = spotList[index];
      });
      if (cryptoSides.some((side) => !spots[side.code])) return { result: null, why: "no crypto price", rates, spots, stats };
      let effective = parsed;
      if (needsRates && !rates) {
        // Without fiat rates only a USD price can be shown
        if (parsed.kind === "fiat") return { result: null, why: "no exchange rates", rates, spots, stats };
        effective = { ...parsed, from: from.kind === "fiat" ? { ...from, code: "USD" } : from, to: to.kind === "fiat" ? { ...to, code: "USD" } : to };
        if (effective.from.code === effective.to.code) return { result: null, why: "no exchange rates", rates, spots, stats };
      }
      const table = rates?.rates ?? { USD: 1 };
      const result = buildResult({
        parsed: effective,
        rates: table,
        spots,
        stats,
        secondary: parsed.kind === "fiat" && this.layout === "inline" ? this.secondary : [],
        updated: rates?.updated || rates?.fetchedAt || 0,
        stale: Boolean(rates?.stale),
      });
      return { result, why: result ? "" : "a rate is missing", rates, spots, stats };
    } catch {
      return { result: null, why: "unexpected error" };
    }
  }

  _explain(query, parsed, outcome) {
    const lines = [`[currency] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" -> ${parsed.kind} ${parsed.amount} ${parsed.from.code} -> ${parsed.to.code} (rule: ${parsed.rule}, home=${this.home}, dollar=${this.dollarMeans}, layout=${this.layout})`];
    const rates = outcome.rates;
    lines.push(`  fiat rates: ${rates ? `${rates.stale ? "stale" : "ok"}, fetched ${new Date(rates.fetchedAt).toISOString()}` : "not used or unavailable"}`);
    if (parsed.kind === "crypto") lines.push(`  crypto: spot ${Object.keys(outcome.spots ?? {}).join(",") || "none"}, 24 h stats ${outcome.stats ? "yes" : "no"}`);
    lines.push(`  verdict: ${outcome.result ? "card shown" : `no card (${outcome.why})`}`);
    console.info(lines.join("\n"));
  }

  async build(query, context) {
    const { parsed } = this.inspect(query);
    if (!parsed) return "";
    const answerBy = this.now() + this.answerWindowMs;
    const deadline = this.now() + this.startWindowMs;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, answerBy - this.now()));
    });
    const outcome = await Promise.race([this.compute(parsed, context, deadline), timeout]);
    clearTimeout(timer);
    if (outcome === TIMED_OUT) {
      if (this.debugMatching) console.info(`[currency] "${String(query).slice(0, 100)}" -> too slow for the slot; the reply is cached when it arrives`);
      return "";
    }
    if (this.debugMatching) this._explain(query, parsed, outcome);
    return outcome.result ? buildCard(outcome.result, { layout: this.layout, decimals: this.decimals }) : "";
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

export const slot = new CurrencySlot();

// "!convert 100 usd to eur" renders the same card. Named exports, no default export: degoog's command loader would prefer a
// default export over a named `command` (see the reddit-lens plugin).
export const command = {
  isClientExposed: false,
  name: "Currency converter",
  description: "!convert 100 usd to eur, !convert btc: the currency card.",
  trigger: "convert",
  aliases: ["currency", "cur"],
  settingsSchema: [],

  configure() {},

  async execute(args, context) {
    const query = Array.isArray(args) ? args.join(" ") : String(args ?? "");
    const html = await slot.build(query, context);
    if (!html) return { title: "Currency converter", html: '<div class="command-result currency-result"><div class="currency-card currency-card--inline"><div class="currency-kicker">Currency</div><div class="currency-expression">Try <code>!convert 100 usd to eur</code> or <code>!convert btc</code></div></div></div>' };
    return { title: "", html: slot.template.replace(/\{\{content\}\}/g, () => html) };
  },
};
