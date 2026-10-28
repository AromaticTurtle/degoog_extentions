import { SETTINGS_SCHEMA } from "./settings.js";
import { lemmaOf, parseQuery } from "./match.js";
import { compactEntries } from "./shape.js";
import { buildCard } from "./render.js";
import { AudioProxy } from "./audio.js";
import { Budget, usageFile } from "./budget.js";
import { Upstream } from "./upstream.js";

// The inline layout puts the detailed card in the main column, above the results; the panel layout puts the compact card
// in the side column. The position follows the setting (no slotPositions are declared, so degoog uses `position`).
export const INLINE_POSITION = "above-results";
export const PANEL_POSITION = "knowledge-panel";
export const DEFAULT_API_BASE = "https://api.dictionaryapi.dev";
export const USER_AGENT = "degoog-dictionary/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const ENTRY_TTL_MS = 7 * 24 * 60 * 60_000;
export const MISSING_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_DAILY_LIMIT = 500;
const FALLBACK_TEMPLATE = '<div class="command-result dictionary-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

export const layoutFrom = (value) => (String(value ?? "").trim().toLowerCase() === "panel" ? "panel" : "inline");
export const audioFrom = (value) => {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "direct" || mode === "off" ? mode : "proxy";
};
export const maxMeaningsFrom = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(6, Math.max(1, parsed));
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

export class DictionarySlot {
  isClientExposed = false;
  id = "dictionary";
  name = "Dictionary";
  description = "Dictionary card for 'define X', 'X meaning', 'synonyms of X', 'how to pronounce X': definitions, examples, synonyms and pronunciation audio from the Free Dictionary API (English, Wiktionary).";
  position = INLINE_POSITION;
  settingsSchema = SETTINGS_SCHEMA;

  layout = "inline";
  maxMeanings = 3;
  showExamples = true;
  showSynonyms = true;
  audio = "proxy";
  debugMatching = false;
  apiBase = "/api/plugin/dictionary";
  template = FALLBACK_TEMPLATE;
  userAgent = USER_AGENT;
  baseUrl = process.env.DEGOOG_DICTIONARY_API_BASE || DEFAULT_API_BASE;

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
    this.budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => this.now() });
    this.upstream = new Upstream({ host: this, label: "the dictionary service", spacingMs: 1000, budgetOf: () => this.budget, rateDefaultMs: 60_000, rateMaxMs: 3_600_000, rejectedMessage: "the dictionary service refused the request" });
    this.audioProxy = new AudioProxy(this);
  }

  init(context) {
    if (context?.template) this.template = context.template;
    if (typeof context?.apiBase === "string" && context.apiBase.startsWith("/")) this.apiBase = context.apiBase;
  }

  configure(settings = {}) {
    this.layout = layoutFrom(settings.layout);
    this.position = this.layout === "panel" ? PANEL_POSITION : INLINE_POSITION;
    this.maxMeanings = maxMeaningsFrom(settings.maxMeanings);
    this.showExamples = truthy(settings.showExamples, true);
    this.showSynonyms = truthy(settings.showSynonyms, true);
    this.audio = audioFrom(settings.audio);
    this.debugMatching = truthy(settings.debugMatching, false);
    this.budget.cap = limitOf(settings.dailyRequestLimit, DEFAULT_DAILY_LIMIT);
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:dictionary:${name}`, ttlMs);
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

  trigger(query) {
    try {
      const result = parseQuery(query);
      if (!result.parsed && this.debugMatching && /\b(?:define|definition|meaning|mean|synonyms?|antonyms?|pronounce|pronunciation)\b/i.test(String(query ?? ""))) {
        console.info(`[dictionary] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" not a dictionary question: ${result.reason}`);
      }
      return Boolean(result.parsed);
    } catch {
      return false;
    }
  }

  // -> { status: "found", entry, source } | { status: "missing", source } | { status: "unavailable", why }. Never throws.
  async lookup(word, context, deadline) {
    try {
      const found = this._cache(context, "entry", ENTRY_TTL_MS);
      const missing = this._cache(context, "missing", MISSING_TTL_MS);
      const hit = await found.get(word);
      if (hit?.entry) return { status: "found", entry: hit.entry, source: "cache" };
      if (await missing.get(word)) return { status: "missing", source: "cache" };
      return await this._once("lookup", word, async () => {
        const result = await this.upstream.request(`${this.baseUrl}/api/v2/entries/en/${encodeURIComponent(word)}`, {
          context,
          deadline,
          maxChars: 400_000,
          headers: { "User-Agent": this.userAgent, Accept: "application/json" },
        });
        if (!result.ok) {
          if (result.reason === "http" && result.status === 404) {
            await missing.set(word, { missing: true }, MISSING_TTL_MS);
            return { status: "missing", source: "request" };
          }
          return { status: "unavailable", why: result.reason };
        }
        // The service reports how many requests are left this minute; ease off when it says none are.
        if (result.headers?.get?.("x-ratelimit-remaining") === "0") this.upstream.pause(60_000, "the dictionary service reports its rate limit is used up");
        let json = null;
        try {
          json = JSON.parse(result.text);
        } catch {
          /* unreadable */
        }
        const entry = compactEntries(json);
        if (!entry) {
          if (Array.isArray(json) && !json.length) {
            await missing.set(word, { missing: true }, MISSING_TTL_MS);
            return { status: "missing", source: "request" };
          }
          this.upstream.pause(60_000, "the dictionary service sent an unreadable reply");
          return { status: "unavailable", why: "unreadable" };
        }
        await found.set(word, { entry }, ENTRY_TTL_MS);
        return { status: "found", entry, source: "request" };
      });
    } catch {
      return { status: "unavailable", why: "error" };
    }
  }

  async compute(parsed, context, deadline) {
    const steps = [];
    let result = await this.lookup(parsed.word, context, deadline);
    steps.push(`${parsed.word}: ${result.status}${result.source ? ` (${result.source})` : result.why ? ` (${result.why})` : ""}`);
    let requested = "";
    if (result.status === "missing" && !parsed.word.includes(" ")) {
      const lemma = lemmaOf(parsed.word);
      if (lemma) {
        const second = await this.lookup(lemma, context, deadline);
        steps.push(`${lemma}: ${second.status}${second.source ? ` (${second.source})` : second.why ? ` (${second.why})` : ""} [fallback form]`);
        if (second.status === "found") {
          result = second;
          requested = parsed.word;
        }
      }
    }
    return { result, requested, steps };
  }

  async build(query, context) {
    const { parsed } = parseQuery(query);
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
      if (this.debugMatching) console.info(`[dictionary] "${String(query).slice(0, 100)}" -> too slow for the slot; the reply is cached when it arrives`);
      return "";
    }
    if (this.debugMatching) {
      console.info([`[dictionary] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" -> word "${parsed.word}" intent=${parsed.intent} layout=${this.layout} audio=${this.audio}`, ...outcome.steps.map((step) => `  ${step}`), `  verdict: ${outcome.result.status === "found" ? "card shown" : "no card"}`].join("\n"));
    }
    if (outcome.result.status !== "found") return "";
    const entry = outcome.result.entry;
    this.audioProxy.remember(entry);
    return buildCard(entry, {
      layout: this.layout,
      intent: parsed.intent,
      requested: outcome.requested,
      maxMeanings: this.maxMeanings,
      showExamples: this.showExamples,
      showSynonyms: this.showSynonyms,
      audio: this.audio,
      apiBase: this.apiBase,
    });
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

export const slot = new DictionarySlot();

// The audio route: degoog serves it at /api/plugin/dictionary/audio. Named export (see the README).
export const routes = [{ method: "get", path: "/audio", handler: (request) => slot.audioProxy.serve(request) }];

// "!define serendipity" renders the same card. Named exports, no default export: degoog's command loader would prefer a
// default export over a named `command` (see the reddit-lens plugin).
export const command = {
  isClientExposed: false,
  name: "Dictionary",
  description: "!define serendipity: the dictionary card.",
  trigger: "define",
  aliases: ["dict", "dictionary"],
  settingsSchema: [],

  configure() {},

  async execute(args, context) {
    const query = Array.isArray(args) ? args.join(" ") : String(args ?? "");
    const word = query.trim();
    const html = word ? await slot.build(`define ${word}`, context) : "";
    if (!html) return { title: "Dictionary", html: '<div class="command-result dictionary-result"><div class="dictionary-card dictionary-card--inline"><div class="dictionary-kicker">Dictionary · English</div><div class="dictionary-note">Try <code>!define serendipity</code></div></div></div>' };
    return { title: "", html: slot.template.replace(/\{\{content\}\}/g, () => html) };
  },
};
