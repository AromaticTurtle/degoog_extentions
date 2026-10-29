import { SETTINGS_SCHEMA } from "./settings.js";
import { parseQuery } from "./match.js";
import { norm, pickPlace, placeLabel, splitPlace } from "./places.js";
import { DEFAULT_AIR_BASE, DEFAULT_FORECAST_BASE, DEFAULT_GEOCODING_BASE, airUrl, forecastUrl, geocodeUrl, parseAir, parseForecast, parseGeocode } from "./request.js";
import { unitsFor } from "./format.js";
import { buildCard, buildPrompt } from "./render.js";
import { labelFromTimezone, parseCardRequest, roundCoord, safeApiBase } from "./location.js";
import { Budget, usageFile } from "./budget.js";
import { Upstream } from "./upstream.js";

// The inline layout puts the detailed card in the main column, above the results; the panel layout puts the compact card
// in the side column. The position follows the setting (no slotPositions are declared, so degoog uses `position`).
export const INLINE_POSITION = "above-results";
export const PANEL_POSITION = "knowledge-panel";
export const USER_AGENT = "degoog-weather/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const FORECAST_TTL_MS = 10 * 60_000;
export const GEOCODE_TTL_MS = 30 * 24 * 60 * 60_000;
export const GEOCODE_NONE_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_DAILY_LIMIT = 5000;
const FALLBACK_TEMPLATE = '<div class="command-result weather-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

export const layoutFrom = (value) => (String(value ?? "").trim().toLowerCase() === "panel" ? "panel" : "inline");
export const unitsFrom = (value) => (String(value ?? "").trim().toLowerCase() === "metric" ? "metric" : "imperial");
export const homeFrom = (value) => String(value ?? "").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
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

export class WeatherSlot {
  isClientExposed = false;
  id = "weather";
  name = "Weather";
  description = "Weather card for 'weather in Paris', 'forecast', 'is it raining in Seattle': current conditions, hourly and 7-day forecast, air quality, from Open-Meteo (no key).";
  position = INLINE_POSITION;
  settingsSchema = SETTINGS_SCHEMA;

  layout = "inline";
  system = "imperial";
  home = "";
  showAirQuality = true;
  debugMatching = false;
  template = FALLBACK_TEMPLATE;
  forecastBase = process.env.DEGOOG_WEATHER_FORECAST_BASE || DEFAULT_FORECAST_BASE;
  geocodingBase = process.env.DEGOOG_WEATHER_GEOCODING_BASE || DEFAULT_GEOCODING_BASE;
  airBase = process.env.DEGOOG_WEATHER_AIR_BASE || DEFAULT_AIR_BASE;
  apiBase = "/api/plugin/weather";
  _initContext = null;

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
    // One budget for all three services: Open-Meteo's free tier counts them together.
    this.budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => this.now() });
    const make = (label) => new Upstream({ host: this, label, spacingMs: 250, budgetOf: () => this.budget, rateDefaultMs: 5 * 60_000, rateMaxMs: 3_600_000, rejectedMessage: `${label} refused the request` });
    this.geoUpstream = make("Open-Meteo geocoding");
    this.forecastUpstream = make("Open-Meteo forecast");
    this.airUpstream = make("Open-Meteo air quality");
  }

  init(context) {
    if (context?.template) this.template = context.template;
    this.apiBase = safeApiBase(context?.apiBase, this.apiBase);
    // The card route is called by the page script with no slot context: it uses degoog's fetch and cache from here.
    this._initContext = context ?? null;
  }

  configure(settings = {}) {
    this.layout = layoutFrom(settings.layout);
    this.position = this.layout === "panel" ? PANEL_POSITION : INLINE_POSITION;
    this.system = unitsFrom(settings.units);
    this.home = homeFrom(settings.homeLocation);
    this.showAirQuality = truthy(settings.showAirQuality, true);
    this.debugMatching = truthy(settings.debugMatching, false);
    this.budget.cap = limitOf(settings.dailyRequestLimit, DEFAULT_DAILY_LIMIT);
  }

  headers() {
    return { "User-Agent": USER_AGENT, Accept: "application/json" };
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:weather:${name}`, ttlMs);
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
    return parseQuery(query);
  }

  trigger(query) {
    try {
      const result = this.inspect(query);
      if (!result.parsed && this.debugMatching && /\b(?:weather|forecast|temperature|temp|raining|snowing)\b/i.test(String(query ?? ""))) {
        console.info(`[weather] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" not a weather question: ${result.reason}`);
      }
      return Boolean(result.parsed);
    } catch {
      return false;
    }
  }

  // Place text -> { status: "found", place, candidates, reason, source } | { status: "none", reason } | { status: "unavailable", why }
  async geocode(text, context, deadline) {
    try {
      const key = norm(text);
      if (!key) return { status: "none", reason: "empty place" };
      const found = this._cache(context, "geocode", GEOCODE_TTL_MS);
      const none = this._cache(context, "geocode-none", GEOCODE_NONE_TTL_MS);
      const hit = await found.get(key);
      if (hit?.place) return { status: "found", ...hit, source: "cache" };
      const miss = await none.get(key);
      if (miss) return { status: "none", reason: miss.reason, source: "cache" };
      return await this._once("geocode", key, async () => {
        const split = splitPlace(text);
        const result = await this.geoUpstream.request(geocodeUrl(this.geocodingBase, split.name, split.hint ? 20 : 10), { context, deadline, maxChars: 200_000, headers: this.headers() });
        if (!result.ok) return { status: "unavailable", why: result.reason };
        const list = parseGeocode(result.text);
        if (!list) return { status: "unavailable", why: "unreadable" };
        const pick = pickPlace(list, split);
        if (!pick.place) {
          await none.set(key, { reason: pick.reason }, GEOCODE_NONE_TTL_MS);
          return { status: "none", reason: pick.reason, source: "request" };
        }
        const entry = { place: pick.place, reason: pick.reason, candidates: pick.candidates.map((c) => ({ name: placeLabel(c.result), population: c.result.population, verdict: c.verdict })) };
        await found.set(key, entry, GEOCODE_TTL_MS);
        return { status: "found", ...entry, source: "request" };
      });
    } catch {
      return { status: "unavailable", why: "error" };
    }
  }

  async forecast(place, context, deadline) {
    try {
      const cache = this._cache(context, "forecast", FORECAST_TTL_MS);
      const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}:${this.system}`;
      const hit = await cache.get(key);
      if (hit?.forecast) return { forecast: hit.forecast, source: "cache" };
      return await this._once("forecast", key, async () => {
        const result = await this.forecastUpstream.request(forecastUrl(this.forecastBase, place.lat, place.lon, this.system), { context, deadline, maxChars: 400_000, headers: this.headers() });
        if (!result.ok) return { forecast: null, why: result.reason };
        const forecast = parseForecast(result.text);
        if (!forecast) {
          this.forecastUpstream.pause(60_000, "Open-Meteo forecast sent an unreadable reply");
          return { forecast: null, why: "unreadable" };
        }
        await cache.set(key, { forecast }, FORECAST_TTL_MS);
        return { forecast, source: "request" };
      });
    } catch {
      return { forecast: null, why: "error" };
    }
  }

  async air(place, context, deadline) {
    try {
      const cache = this._cache(context, "air", FORECAST_TTL_MS);
      const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
      const hit = await cache.get(key);
      if (hit) return hit.air ?? null;
      return await this._once("air", key, async () => {
        const result = await this.airUpstream.request(airUrl(this.airBase, place.lat, place.lon), { context, deadline, maxChars: 100_000, headers: this.headers() });
        if (!result.ok) return null;
        const air = parseAir(result.text);
        await cache.set(key, { air }, FORECAST_TTL_MS);
        return air;
      });
    } catch {
      return null;
    }
  }

  // Forecast (and air quality) for a resolved place -> { html, steps, why }
  async cardFor(place, label, context, deadline, options = {}) {
    const steps = [];
    const wantsAir = this.showAirQuality && this.layout === "inline";
    const [forecast, air] = await Promise.all([this.forecast(place, context, deadline), wantsAir ? this.air(place, context, deadline) : Promise.resolve(null)]);
    steps.push(`forecast: ${forecast.forecast ? `ok (${forecast.source})` : `unavailable (${forecast.why})`}; air quality: ${wantsAir ? (air ? `ok (US AQI ${air.aqi})` : "unavailable") : "off"}`);
    if (!forecast.forecast) return { html: "", steps, why: "no forecast" };
    const shownLabel = label || labelFromTimezone(forecast.forecast.timezone) || "Your location";
    const html = buildCard({ label: shownLabel, forecast: forecast.forecast, air, units: unitsFor(this.system), place: options.saved ? { lat: roundCoord(place.lat), lon: roundCoord(place.lon) } : null }, { layout: this.layout, changeLink: Boolean(options.saved) });
    return { html, steps, why: "" };
  }

  prompt(message = "") {
    return buildPrompt({ layout: this.layout, api: this.apiBase, message });
  }

  async compute(parsed, context, deadline) {
    const steps = [];
    const text = parsed.home ? this.home : parsed.place;
    if (!text) {
      const promptOk = parsed.bare || (parsed.home && parsed.rule !== "question");
      steps.push(promptOk ? "generic weather query, no home location: rendered location prompt" : "no place in the query and no home location set: nothing");
      return { html: promptOk ? this.prompt() : "", steps, why: "no place" };
    }
    steps.push(`place text "${text}"${parsed.home ? " (home location)" : ""}`);
    const geo = await this.geocode(text, context, deadline);
    steps.push(`geocoding: ${geo.status}${geo.source ? ` (${geo.source})` : ""}${geo.reason ? `: ${geo.reason}` : geo.why ? ` (${geo.why})` : ""}`);
    for (const candidate of geo.candidates ?? []) steps.push(`  ${candidate.verdict}: ${candidate.name}${candidate.population ? ` (population ${candidate.population})` : ""}`);
    if (geo.status !== "found") {
      // A home location that cannot be resolved must not fail silently: say so, and offer the other ways to set a place.
      if (parsed.home) {
        const problem = geo.status === "none" ? `Couldn't find “${text}”. Check the Home location setting, or use your location.` : "Weather isn't available right now (the weather service could not be reached). Try again in a minute.";
        steps.push("home location failed: rendered the location prompt with the problem");
        return { html: this.prompt(problem), steps, why: geo.status === "none" ? "home location not found" : "geocoding unavailable" };
      }
      return { html: "", steps, why: geo.status === "none" ? "no such place" : "geocoding unavailable" };
    }
    const done = await this.cardFor(geo.place, placeLabel(geo.place), context, deadline);
    steps.push(...done.steps);
    if (!done.html && parsed.home) {
      steps.push("home location: forecast failed, rendered the location prompt with the problem");
      return { html: this.prompt("Weather isn't available right now (the weather service could not be reached). Try again in a minute."), steps, why: done.why };
    }
    return { html: done.html, steps, why: done.why };
  }

  // The route the page script calls (GET <api>/card). -> { status, html?, error? }
  async cardForRequest(request, context) {
    const parsed = parseCardRequest(request);
    if (parsed.error) return { status: 400, error: parsed.error };
    const answerBy = this.now() + this.answerWindowMs;
    const deadline = this.now() + this.startWindowMs;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, answerBy - this.now()));
    });
    const work = (async () => {
      if (parsed.kind === "coords") {
        const place = { lat: roundCoord(parsed.lat), lon: roundCoord(parsed.lon) };
        return { ...(await this.cardFor(place, parsed.label, context, deadline, { saved: true })), steps: [] };
      }
      const geo = await this.geocode(parsed.q, context, deadline);
      if (geo.status === "none") return { html: "", why: "not found", status: 404 };
      if (geo.status !== "found") return { html: "", why: "geocoding unavailable", status: 503 };
      return this.cardFor(geo.place, placeLabel(geo.place), context, deadline, { saved: true });
    })();
    const outcome = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (this.debugMatching) {
      const what = parsed.kind === "coords" ? "browser location" : `typed place "${parsed.q.slice(0, 60)}"`;
      console.info(`[weather] card route: ${what} -> ${outcome === TIMED_OUT ? "too slow for the slot; the reply is cached when it arrives" : outcome.html ? "card shown" : `no card (${outcome.why})`}`);
    }
    if (outcome === TIMED_OUT) return { status: 504, error: "too slow" };
    if (outcome.html) return { status: 200, html: this.template.replace(/\{\{content\}\}/g, () => outcome.html) };
    return { status: outcome.status ?? 503, error: outcome.why || "unavailable" };
  }

  async serveCard(request) {
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    try {
      const result = await this.cardForRequest(new URL(request.url).searchParams, this._initContext ?? {});
      if (result.html) return new Response(result.html, { status: 200, headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
      return new Response(JSON.stringify({ error: result.error }), { status: result.status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    } catch {
      return new Response(JSON.stringify({ error: "unavailable" }), { status: 500, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });
    }
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
      if (this.debugMatching) console.info(`[weather] "${String(query).slice(0, 100)}" -> too slow for the slot; the reply is cached when it arrives`);
      return "";
    }
    if (this.debugMatching) {
      console.info([`[weather] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" -> rule: ${parsed.rule}, units=${this.system}, layout=${this.layout}`, ...outcome.steps.map((step) => `  ${step}`), `  verdict: ${outcome.html ? "card shown" : `no card (${outcome.why})`}`].join("\n"));
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

export const slot = new WeatherSlot();

// The card route: degoog serves it at <apiBase>/card (the page script reads the address from the prompt card). Named export.
export const routes = [{ method: "get", path: "/card", rateLimit: true, handler: (request) => slot.serveCard(request) }];
