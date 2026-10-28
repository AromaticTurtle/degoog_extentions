// Finnhub requests and replies. The API key is NEVER part of a URL: the slot sends it only in the X-Finnhub-Token header.
// Replies are normalised defensively: every number is coerced, anything unusable is dropped, nothing throws.

export const DEFAULT_BASE = "https://finnhub.io/api/v1";
export const TOKEN_HEADER = "X-Finnhub-Token";

const SYMBOL = /^[A-Z]{1,5}(?:\.[A-Z]{1,2})?$/;
export const isSymbol = (value) => typeof value === "string" && SYMBOL.test(value);

export const clean = (value, max = 80) => String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const url = (base, path, params) => {
  const u = new URL(`${base.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, String(value));
  return u.toString();
};

export const quoteUrl = (base, symbol) => url(base, "/quote", { symbol });
export const profileUrl = (base, symbol) => url(base, "/stock/profile2", { symbol });
export const metricUrl = (base, symbol) => url(base, "/stock/metric", { symbol, metric: "all" });
export const statusUrl = (base, exchange = "US") => url(base, "/stock/market-status", { exchange });
export const searchUrl = (base, q) => url(base, "/search", { q: clean(q, 60) });
// About five trading days of hourly candles ending now
export const candleUrl = (base, symbol, nowSeconds) => url(base, "/stock/candle", { symbol, resolution: 60, from: Math.floor(nowSeconds) - 6 * 86_400, to: Math.floor(nowSeconds) });

const json = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// { c: current, d: change, dp: percent change, h, l, o, pc: previous close, t: unix seconds }. A symbol Finnhub does not know
// answers all zeros (and null change), which is NOT a quote: c must be positive.
export const parseQuote = (text) => {
  const q = json(text);
  if (!q || typeof q !== "object") return null;
  const c = num(q.c);
  if (c === null || c <= 0) return null;
  const pc = num(q.pc);
  let d = num(q.d);
  let dp = num(q.dp);
  if (d === null && pc !== null && pc > 0) d = c - pc;
  if (dp === null && pc !== null && pc > 0) dp = ((c - pc) / pc) * 100;
  const positive = (v) => (v !== null && v > 0 ? v : null);
  return { price: c, change: d, percent: dp, high: positive(num(q.h)), low: positive(num(q.l)), open: positive(num(q.o)), prevClose: positive(pc), time: positive(num(q.t)) };
};

const httpsLogo = (value) => {
  try {
    const u = new URL(String(value ?? ""));
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && (host === "finnhub.io" || host.endsWith(".finnhub.io")) ? u.toString() : "";
  } catch {
    return "";
  }
};

const httpsSite = (value) => {
  try {
    const u = new URL(String(value ?? ""));
    return u.protocol === "https:" && !u.username && u.hostname.includes(".") ? u.toString() : "";
  } catch {
    return "";
  }
};

// { name, ticker, exchange, logo, marketCapitalization (millions), finnhubIndustry, weburl, currency, shareOutstanding, ipo }
// An unknown symbol answers {}.
export const parseProfile = (text) => {
  const p = json(text);
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const name = clean(p.name, 80);
  if (!name && !p.ticker) return null;
  return {
    name,
    ticker: clean(p.ticker, 12).toUpperCase(),
    exchange: clean(p.exchange, 60),
    logo: httpsLogo(p.logo),
    marketCap: num(p.marketCapitalization),
    industry: clean(p.finnhubIndustry, 60),
    website: httpsSite(p.weburl),
    currency: clean(p.currency, 4).toUpperCase(),
  };
};

// { metric: { "52WeekHigh", "52WeekLow", peTTM, peBasicExclExtraTTM, epsTTM, dividendYieldIndicatedAnnual, beta, ... }, series: {...} }
// Several fields have near-synonyms, so a missing one never zeroes the others.
export const parseMetric = (text) => {
  const body = json(text);
  const m = body?.metric;
  if (!m || typeof m !== "object") return null;
  const first = (...keys) => {
    for (const key of keys) {
      const n = num(m[key]);
      if (n !== null) return n;
    }
    return null;
  };
  const out = {
    high52: first("52WeekHigh"),
    low52: first("52WeekLow"),
    pe: first("peTTM", "peBasicExclExtraTTM", "peExclExtraTTM", "peNormalizedAnnual"),
    eps: first("epsTTM", "epsBasicExclExtraItemsTTM", "epsInclExtraItemsTTM", "epsNormalizedAnnual"),
    dividendYield: first("dividendYieldIndicatedAnnual", "currentDividendYieldTTM"),
    beta: first("beta"),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
};

// { exchange: "US", holiday: null, isOpen: true, session: "pre-market" | "regular" | "post-market" | null, t, timezone }
export const parseStatus = (text) => {
  const s = json(text);
  if (!s || typeof s !== "object" || typeof s.isOpen !== "boolean") return null;
  const session = typeof s.session === "string" ? s.session.toLowerCase() : "";
  return { isOpen: s.isOpen, session, holiday: clean(s.holiday, 60), timezone: clean(s.timezone, 40) };
};

// -> "open" | "pre" | "post" | "closed" | "holiday"
export const sessionOf = (status) => {
  if (!status) return "";
  if (status.holiday && !status.isOpen) return "holiday";
  if (/pre/.test(status.session)) return "pre";
  if (/post|after/.test(status.session)) return "post";
  if (status.isOpen) return "open";
  return "closed";
};

// { count, result: [{ description, displaySymbol, symbol, type }] }
export const parseSearch = (text) => {
  const body = json(text);
  if (!body || typeof body !== "object" || !Array.isArray(body.result)) return null;
  const out = [];
  for (const item of body.result.slice(0, 50)) {
    if (!item || typeof item !== "object") continue;
    const symbol = clean(item.symbol, 16).toUpperCase();
    if (!symbol) continue;
    out.push({ symbol, display: clean(item.displaySymbol, 16).toUpperCase(), description: clean(item.description, 80), type: clean(item.type, 30) });
  }
  return out;
};

// { c: [closes], h, l, o, s: "ok" | "no_data", t: [seconds], v }
export const parseCandles = (text) => {
  const body = json(text);
  if (!body || typeof body !== "object") return null;
  if (body.s !== "ok" || !Array.isArray(body.c)) return { points: [] };
  const points = body.c.map(num).filter((v) => v !== null && v > 0);
  return { points: points.length > 400 ? points.filter((_, i) => i % Math.ceil(points.length / 200) === 0) : points };
};

// Which search results can be a stock quote: anything but obvious non-equities. Unknown or empty types are accepted.
const BAD_TYPE = /warrant|right|unit|preferred|bond|note|crypto|forex|index|option|future/i;
export const typeOk = (type) => !BAD_TYPE.test(String(type ?? ""));

// US-listed symbols have no suffix, or a one-letter class ("BRK.B"); "BMW.DE" is a foreign listing the free plan does not serve.
const usLike = (symbol) => /^[A-Z]{1,5}(?:\.[A-Z])?$/.test(symbol);

// -> { symbol, name } or null. `exact`: a symbol the query already named (bare ticker). Otherwise the first sensible result of
// Finnhub's own relevance order, preferring an exact symbol match, then a US-like symbol.
export const pickResult = (results, { exact = "", term = "" } = {}) => {
  const list = (Array.isArray(results) ? results : []).filter((r) => isSymbol(r.symbol) && typeOk(r.type));
  if (exact) {
    const hit = list.find((r) => r.symbol === exact.toUpperCase());
    return hit ? { symbol: hit.symbol, name: hit.description } : null;
  }
  const us = list.filter((r) => usLike(r.symbol));
  const words = String(term).toLowerCase().split(/\s+/).filter(Boolean);
  const named = us.find((r) => words.length && words.every((w) => r.description.toLowerCase().includes(w)));
  const symbolHit = us.find((r) => r.symbol === String(term).toUpperCase());
  const pick = symbolHit ?? named ?? us[0];
  return pick ? { symbol: pick.symbol, name: pick.description } : null;
};
