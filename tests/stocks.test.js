// Tests for the stocks slot plugin: trigger grammar, stoplist, Finnhub requests and replies, rate limiting, caching, negative caches,
// cards, layout and settings.
//
// NOTE: tests/fixtures/finnhub-data.js builds replies from INVENTED companies (Quillfern Systems "QFRN", Brambleton Foods "BRMB",
// Midsummer Optics "MIDS") in Finnhub's documented layouts. Nothing here is a recording; the trigger tables use real-looking words
// only as query text.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KNOWN, candlesFor, metricFor, profileFor, quoteFor, searchFor, statusFor } from "./fixtures/finnhub-data.js";
import { Budget } from "../plugins/stocks/budget.js";
import { candleUrl, isSymbol, metricUrl, parseCandles, parseMetric, parseProfile, parseQuote, parseSearch, parseStatus, pickResult, profileUrl, quoteUrl, searchUrl, sessionOf, statusUrl, typeOk } from "../plugins/stocks/finnhub.js";
import { directionOf, exchangeLabel, fmtCap, fmtChange, fmtPercent, fmtPrice, fmtRatio, fmtYield, formatStamp, percentOf, sparkPoints } from "../plugins/stocks/format.js";
import { parseQuery } from "../plugins/stocks/match.js";
import { buildCard } from "../plugins/stocks/render.js";
import { SETTINGS_SCHEMA } from "../plugins/stocks/settings.js";
import { Store } from "../plugins/stocks/store.js";
import { BARE_STOPLIST, NOT_FINANCIAL, REJECT_FIRST, WELL_KNOWN } from "../plugins/stocks/stoplist.js";
import { FinnhubUpstream } from "../plugins/stocks/upstream.js";
import { CANDLES_UNAVAILABLE_TTL_MS, INLINE_POSITION, NEGATIVE_TTL_MS, PANEL_POSITION, QUOTE_CLOSED_TTL_MS, QUOTE_OPEN_TTL_MS, StocksSlot, USER_AGENT, keyFrom, layoutFrom, slot as sharedSlot } from "../plugins/stocks/index.js";

const KEY = "test-key-0123456789";
const BASE = "https://finnhub.example/api/v1";

beforeAll(() => {
  // a well-known ticker the invented fixtures can answer for
  KNOWN.AMD = { ...KNOWN.QFRN, name: "Quillfern Micro Devices Inc" };
});
afterAll(() => {
  delete KNOWN.AMD;
});

// A fake Finnhub: answers the six endpoints from the invented data, records every request.
const world = (overrides = {}, state = { market: "open" }) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const route = u.pathname.replace(/^\/api\/v1/, "");
    calls.push({ url: String(url), route, params: u.searchParams, headers: init.headers ?? {} });
    const handler = overrides[route] ?? overrides["*"];
    if (handler) {
      const custom = await handler(u, calls.length);
      if (custom) return custom;
    }
    const symbol = (u.searchParams.get("symbol") ?? "").toUpperCase();
    const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
    if ((init.headers ?? {})["X-Finnhub-Token"] !== KEY) return new Response(JSON.stringify({ error: "Invalid API key" }), { status: 401 });
    if (route === "/quote") return symbol.includes(".") ? new Response("{}", { status: 403 }) : ok(quoteFor(symbol));
    if (route === "/stock/profile2") return ok(profileFor(symbol));
    if (route === "/stock/metric") return ok(metricFor(symbol));
    if (route === "/stock/market-status") return ok(statusFor(state.market));
    if (route === "/search") return ok(searchFor(u.searchParams.get("q")));
    if (route === "/stock/candle") return ok(candlesFor(symbol));
    return new Response("nope", { status: 404 });
  };
  const count = (route) => calls.filter((c) => c.route === route).length;
  return { fetch, calls, count, state };
};

const clock = (start = Date.parse("2026-10-28T15:00:00Z")) => {
  const state = { t: start };
  return { state, now: () => state.t, sleep: async (ms) => { state.t += ms; } };
};

const makeSlot = (settings = {}, { time, store } = {}) => {
  const slot = new StocksSlot();
  slot.baseUrl = BASE;
  slot.spacingMs = 0;
  slot.budget.file = "";
  slot.store.file = "";
  if (store) slot.store = store;
  if (time) {
    slot.now = time.now;
    slot.sleep = time.sleep;
    slot.store.now = time.now;
  }
  slot.configure({ apiKey: KEY, ...settings });
  return slot;
};

const capture = async (work) => {
  const lines = [];
  const original = { info: console.info, warn: console.warn, log: console.log, error: console.error };
  for (const level of ["info", "warn", "log", "error"]) console[level] = (...args) => lines.push(args.join(" "));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const parsedOf = (query, options) => {
  const { parsed } = parseQuery(query, options);
  return parsed ? `${parsed.kind}:${parsed.direct || parsed.kind === "bare" ? parsed.symbol : parsed.term}${parsed.direct ? ":direct" : ""}` : null;
};

describe("explicit stock queries", () => {
  const table = [
    ["AAPL stock", "explicit:AAPL:direct"],
    ["aapl stock", "explicit:AAPL:direct"],
    ["AAPL stock price", "explicit:AAPL:direct"],
    ["AAPL share price", "explicit:AAPL:direct"],
    ["AAPL stock price today", "explicit:AAPL:direct"],
    ["AAPL quote", "explicit:AAPL:direct"],
    ["AAPL shares", "explicit:AAPL:direct"],
    ["stock AAPL", "explicit:AAPL:direct"],
    ["stock price AAPL", "explicit:AAPL:direct"],
    ["stock price of AAPL", "explicit:AAPL:direct"],
    ["what is the stock price of AAPL", "explicit:AAPL:direct"],
    ["what's the AAPL stock price", "explicit:AAPL:direct"],
    ["buy AAPL stock", "explicit:AAPL:direct"],
    ["should I buy AAPL stock", "explicit:AAPL:direct"],
    ["$AAPL", "dollar:AAPL:direct"],
    ["$aapl", "dollar:AAPL:direct"],
    ["$BRK.B", "dollar:BRK.B:direct"],
    ["$AAPL stock", "dollar:AAPL:direct"],
    ["$ALL", "dollar:ALL:direct"],
    ["$NOW", "dollar:NOW:direct"],
    ["$BTC", "dollar:BTC:direct"],
    ["apple stock", "explicit:apple"],
    ["apple stock price", "explicit:apple"],
    ["apple shares", "explicit:apple"],
    ["tesla stock price today", "explicit:tesla"],
    ["tesla stock", "explicit:tesla"],
    ["coca cola stock", "explicit:coca cola"],
    ["procter & gamble stock", "explicit:procter & gamble"],
    ["stock tesla", "explicit:tesla"],
    ["stock price of tesla", "explicit:tesla"],
    ["QFRN stock", "explicit:QFRN:direct"],
    ["qfrn stock", "explicit:qfrn"],
    ["Qfrn stock", "explicit:qfrn"],
    ["quillfern stock", "explicit:quillfern"],
    ["target stock", "explicit:target"],
    ["gap stock", "explicit:gap"],
    ["ford stock", "explicit:ford"],
    ["meta stock", "explicit:META:direct"],
    ["APPLE stock", "explicit:APPLE:direct"],
  ];
  for (const [query, expected] of table) test(`${query} => ${expected}`, () => expect(parsedOf(query)).toBe(expected));

  const negatives = [
    "chicken stock", "beef stock", "vegetable stock", "stock pot", "stock photo", "stock photos", "stock car", "stock cars", "stock car racing", "stock market", "stock markets", "stock exchange",
    "out of stock", "in stock", "stock room", "stock image", "stock footage", "stock options", "stock chart", "stocks", "stock", "stock price", "share price", "best stock", "top stocks",
    "best stock to buy", "penny stock", "blue chip stock", "growth stock", "meme stock", "tech stock", "dividend stock", "buy stock", "sell stock", "define stock", "what is stock", "what is a stock",
    "how to buy stock", "the stock", "a stock", "my stock", "good stock", "cheap stock", "stock broth", "chicken stock recipe", "homemade stock", "stock market today", "stock quote api", "stock screener",
    "stock symbol lookup", "stock trading", "stock analysis", "lamb stock", "usd stock", "btc stock", "eth stock", "eur stock", "stock usd", "stock btc", "2+2 stock", "x".repeat(80),
    "stock for the soup and more words here", "one two three four five stock",
  ];
  for (const query of negatives) test(`not a stock query: ${JSON.stringify(query.slice(0, 40))}`, () => expect(parsedOf(query), query).toBeNull());

  test("currency and crypto words need the dollar sign", () => {
    for (const code of ["usd", "eur", "btc", "eth", "doge"]) {
      expect(parsedOf(`${code} stock`)).toBeNull();
      expect(parsedOf(`$${code}`)).toBe(`dollar:${code.toUpperCase()}:direct`);
    }
  });

  test("a reason says why", () => {
    expect(parseQuery("chicken stock").reason).toContain("chicken");
    expect(parseQuery("define stock").reason).toContain("define");
    expect(parseQuery("usd stock").reason).toContain("currency or crypto");
  });
});

describe("bare tickers", () => {
  test("capitals, or a well-known ticker", () => {
    expect(parsedOf("QFRN")).toBe("bare:QFRN");
    expect(parsedOf("BRMB")).toBe("bare:BRMB");
    expect(parsedOf("AAPL")).toBe("bare:AAPL:direct");
    expect(parsedOf("aapl")).toBe("bare:AAPL:direct");
    expect(parsedOf("Tsla")).toBe("bare:TSLA:direct");
    expect(parsedOf("msft")).toBe("bare:MSFT:direct");
    expect(parsedOf("NVDA")).toBe("bare:NVDA:direct");
    expect(parsedOf("brk.b")).toBe("bare:BRK.B:direct");
    expect(parsedOf("BRK.B")).toBe("bare:BRK.B:direct");
    expect(parsedOf("V")).toBe("bare:V:direct");
    expect(parsedOf("MA")).toBe("bare:MA:direct");
    expect(parsedOf("KO")).toBe("bare:KO:direct");
    expect(parsedOf("F")).toBe("bare:F:direct");
    expect(parsedOf("  AAPL  ")).toBe("bare:AAPL:direct");
  });

  test("short well-known tickers need capitals (a lowercase one or two letter word is just a word)", () => {
    for (const word of ["v", "ma", "ko", "f", "t", "c", "ba", "ge", "gm", "mu", "sq"]) expect(parsedOf(word), word).toBeNull();
  });

  test("other bare tickers need capitals", () => {
    expect(parsedOf("qfrn")).toBeNull();
    expect(parsedOf("Qfrn")).toBeNull();
    expect(parsedOf("xyzq")).toBeNull();
    expect(parsedOf("XYZQ")).toBe("bare:XYZQ");
  });

  test("common words, abbreviations, currency and crypto codes never trigger, even in capitals", () => {
    const words = ["A", "ALL", "ARE", "CAN", "FOR", "NOW", "ON", "ONE", "IT", "SO", "TV", "HAS", "WELL", "SEE", "GO", "LOVE", "FUN", "REAL", "TRUE", "BEST", "LOW", "HE", "CAT", "THE", "AND", "YOU", "OPEN", "HOME", "NEWS", "PLAY", "FREE", "GOOD", "TIME", "LIFE", "WORK", "NEW", "OLD", "BIG", "UP", "US", "UK", "EU", "PC", "AI", "CEO", "ETF", "USA", "NASA", "NFL", "NBA", "CPU", "GPU", "USB", "PDF", "HTML", "API"];
    for (const word of words) {
      expect(parsedOf(word), word).toBeNull();
      expect(parsedOf(word.toLowerCase()), word.toLowerCase()).toBeNull();
    }
    for (const code of ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "BTC", "ETH", "XRP", "DOGE", "LTC", "ADA", "SOL", "USDT", "USDC"]) {
      expect(parsedOf(code), code).toBeNull();
      expect(parsedOf(code.toLowerCase()), code).toBeNull();
    }
  });

  test("the dollar sign forces a stoplist word", () => {
    for (const word of ["ALL", "NOW", "IT", "A", "ON", "LOW", "BTC", "USD"]) expect(parsedOf(`$${word}`)).toBe(`dollar:${word}:direct`);
  });

  test("not tickers: too long, digits, punctuation, several words", () => {
    for (const query of ["QFRNXY", "QFRN1", "QF RN", "Q.F", "U.S", "QFRN.AB", "qfrn.b9", "AAPL MSFT", "AA-PL", "123", "AAPL 2026", "weather", "hello", "serendipity", ""]) {
      expect(parsedOf(query), query).toBeNull();
    }
    expect(parsedOf("AAPL!!")).toBe("bare:AAPL:direct");
  });

  test("the setting turns bare tickers off but leaves the explicit forms", () => {
    expect(parsedOf("AAPL", { bare: false })).toBeNull();
    expect(parsedOf("QFRN", { bare: false })).toBeNull();
    expect(parsedOf("AAPL stock", { bare: false })).toBe("explicit:AAPL:direct");
    expect(parsedOf("$AAPL", { bare: false })).toBe("dollar:AAPL:direct");
    expect(parseQuery("AAPL", { bare: false }).reason).toContain("turned off");
  });

  test("the reason names the rule", () => {
    expect(parseQuery("NOW").reason).toContain("common word");
    expect(parseQuery("NOW").reason).toContain("$NOW");
    expect(parseQuery("qfrn").reason).toContain("lowercase");
  });

  test("never throws", () => {
    for (const query of [null, undefined, 5, {}, "\u0000", "💥", "$", "$$$$", "$A$B", "stock $", "x".repeat(500)]) expect(() => parseQuery(query)).not.toThrow();
  });
});

describe("the word lists", () => {
  test("the well-known tickers and the stoplist do not overlap", () => {
    for (const symbol of WELL_KNOWN) expect(BARE_STOPLIST.has(symbol), symbol).toBe(false);
  });
  test("every entry is a plain token", () => {
    for (const word of BARE_STOPLIST) expect(word).toMatch(/^[A-Z]{1,5}$/);
    for (const word of WELL_KNOWN) expect(word).toMatch(/^[A-Z]{1,5}(?:\.[A-Z])?$/);
    for (const word of [...NOT_FINANCIAL, ...REJECT_FIRST]) expect(word).toMatch(/^[a-z]+$/);
  });
  test("the lists are decent in size and keep the words the user named", () => {
    expect(BARE_STOPLIST.size).toBeGreaterThan(250);
    expect(WELL_KNOWN.size).toBeGreaterThan(50);
    for (const word of ["A", "ALL", "ARE", "CAN", "FOR", "NOW", "ON", "ONE", "IT", "SO", "TV", "HAS", "WELL", "SEE", "GO", "LOVE", "FUN", "REAL", "TRUE", "BEST", "LOW", "HE", "CAT", "USD", "EUR", "GBP", "JPY", "BTC", "ETH"]) expect(BARE_STOPLIST.has(word), word).toBe(true);
    for (const symbol of ["AAPL", "MSFT", "GOOG", "GOOGL", "AMZN", "TSLA", "META", "NVDA", "NFLX", "AMD", "INTC", "IBM", "DIS", "KO", "PEP", "WMT", "JPM", "BAC", "V", "MA", "PYPL", "UBER", "ABNB"]) expect(WELL_KNOWN.has(symbol), symbol).toBe(true);
  });
});

describe("Finnhub requests and replies", () => {
  test("urls carry the symbol and never a key", () => {
    const urls = [quoteUrl(BASE, "AAPL"), profileUrl(BASE, "AAPL"), metricUrl(BASE, "AAPL"), statusUrl(BASE), searchUrl(BASE, "apple"), candleUrl(BASE, "AAPL", 1793223480)];
    expect(urls.map((u) => new URL(u).pathname)).toEqual(["/api/v1/quote", "/api/v1/stock/profile2", "/api/v1/stock/metric", "/api/v1/stock/market-status", "/api/v1/search", "/api/v1/stock/candle"]);
    expect(new URL(urls[0]).searchParams.get("symbol")).toBe("AAPL");
    expect(new URL(urls[2]).searchParams.get("metric")).toBe("all");
    expect(new URL(urls[3]).searchParams.get("exchange")).toBe("US");
    expect(new URL(urls[4]).searchParams.get("q")).toBe("apple");
    const candles = new URL(urls[5]).searchParams;
    expect(Number(candles.get("to")) - Number(candles.get("from"))).toBe(6 * 86_400);
    expect(candles.get("resolution")).toBe("60");
    for (const u of urls) expect(u).not.toMatch(/token|apikey|key=/i);
    expect(new URL(searchUrl(BASE, "x".repeat(200))).searchParams.get("q").length).toBe(60);
  });

  test("symbols", () => {
    for (const symbol of ["A", "AAPL", "BRK.B", "GOOGL"]) expect(isSymbol(symbol)).toBe(true);
    for (const symbol of ["", "aapl", "TOOLONG", "A B", "A;B", "../x", null, 5]) expect(isSymbol(symbol)).toBe(false);
  });

  test("a quote", () => {
    expect(parseQuote(JSON.stringify(quoteFor("QFRN")))).toMatchObject({ price: 189.84, change: 2.32, high: 190.7, low: 186.9, open: 187.9, prevClose: 187.52, time: 1793223480 });
    expect(parseQuote(JSON.stringify(quoteFor("QFRN"))).percent).toBeCloseTo(1.2372, 3);
    // an unknown symbol is all zeros: not a quote
    expect(parseQuote(JSON.stringify(quoteFor("NOPE")))).toBeNull();
    for (const bad of ["", "x", "[]", "null", '{"c":-1}', '{"c":"abc"}', '{"c":null}', "{}"]) expect(parseQuote(bad), bad).toBeNull();
    // missing change fields are derived from the previous close
    const derived = parseQuote('{"c":110,"pc":100}');
    expect(derived.change).toBe(10);
    expect(derived.percent).toBe(10);
    expect(parseQuote('{"c":110}').change).toBeNull();
    expect(parseQuote('{"c":"110","d":"1.5","dp":"1.38","h":0,"l":null}')).toMatchObject({ price: 110, change: 1.5, high: null, low: null });
  });

  test("a profile", () => {
    const p = parseProfile(JSON.stringify(profileFor("QFRN")));
    expect(p).toMatchObject({ name: "Quillfern Systems Inc", ticker: "QFRN", exchange: "NASDAQ NMS - GLOBAL MARKET", marketCap: 2910450.5, industry: "Technology", currency: "USD" });
    expect(p.logo).toBe("https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/QFRN.png");
    expect(p.website).toBe("https://www.quillfern.example/");
    expect(parseProfile("{}")).toBeNull();
    for (const bad of ["", "x", "[]", "null", "5"]) expect(parseProfile(bad)).toBeNull();
    const odd = parseProfile(JSON.stringify({ name: "<b>X</b>", logo: "http://static.finnhub.io/x.png", weburl: "javascript:alert(1)", marketCapitalization: "abc", currency: "usd" }));
    expect(odd.name).toBe("<b>X</b>");
    expect(odd.logo).toBe("");
    expect(odd.website).toBe("");
    expect(odd.marketCap).toBeNull();
    expect(odd.currency).toBe("USD");
    expect(parseProfile(JSON.stringify({ name: "X", logo: "https://evil.example/finnhub.io/x.png" })).logo).toBe("");
    expect(parseProfile(JSON.stringify({ name: "X", logo: "https://user:pw@static.finnhub.io/x.png" })).logo).toBe("");
  });

  test("metrics, with their near-synonyms", () => {
    expect(parseMetric(JSON.stringify(metricFor("QFRN")))).toEqual({ high52: 214.3, low52: 141.2, pe: 29.41, eps: 6.45, dividendYield: 0.52, beta: 1.21 });
    expect(parseMetric(JSON.stringify({ metric: { peBasicExclExtraTTM: 12, epsBasicExclExtraItemsTTM: 2.5, currentDividendYieldTTM: 1.1 } }))).toMatchObject({ pe: 12, eps: 2.5, dividendYield: 1.1, beta: null });
    expect(parseMetric(JSON.stringify({ metric: { peTTM: null, peBasicExclExtraTTM: 9 } })).pe).toBe(9);
    for (const bad of ["", "x", "{}", '{"metric":{}}', '{"metric":{"x":1}}', '{"metric":5}', "[]"]) expect(parseMetric(bad), bad).toBeNull();
  });

  test("market status and the session", () => {
    for (const [mode, session] of [["open", "open"], ["pre", "pre"], ["post", "post"], ["closed", "closed"], ["holiday", "holiday"]]) {
      expect(sessionOf(parseStatus(JSON.stringify(statusFor(mode)))), mode).toBe(session);
    }
    expect(sessionOf(parseStatus('{"isOpen":true}'))).toBe("open");
    expect(sessionOf(parseStatus('{"isOpen":false,"session":null}'))).toBe("closed");
    expect(sessionOf(null)).toBe("");
    for (const bad of ["", "x", "{}", '{"isOpen":"yes"}', "[]"]) expect(parseStatus(bad)).toBeNull();
  });

  test("search results", () => {
    const list = parseSearch(JSON.stringify(searchFor("quillfern")));
    expect(list.map((r) => r.symbol)).toEqual(["QFRN", "QFRN.DE", "QFRNW"]);
    expect(list[0]).toMatchObject({ description: "QUILLFERN SYSTEMS INC", type: "Common Stock" });
    expect(parseSearch('{"count":0,"result":[]}')).toEqual([]);
    for (const bad of ["", "x", "{}", '{"result":5}', "[]"]) expect(parseSearch(bad), bad).toBeNull();
    expect(parseSearch(JSON.stringify({ result: [null, 5, { symbol: "" }, { symbol: "ok", type: 5 }] }))).toEqual([{ symbol: "OK", display: "", description: "", type: "5" }]);
  });

  test("picking a result: exact symbols, company names, no foreign listings, no warrants", () => {
    const list = parseSearch(JSON.stringify(searchFor("quillfern")));
    expect(pickResult(list, { term: "quillfern" })).toEqual({ symbol: "QFRN", name: "QUILLFERN SYSTEMS INC" });
    expect(pickResult(list, { exact: "QFRN" })).toEqual({ symbol: "QFRN", name: "QUILLFERN SYSTEMS INC" });
    expect(pickResult(list, { exact: "QFRNW" })).toBeNull();
    expect(pickResult(list, { exact: "QFRN.DE" })).toEqual({ symbol: "QFRN.DE", name: "QUILLFERN SYSTEMS INC" });
    expect(pickResult(list, { exact: "NOPE" })).toBeNull();
    expect(pickResult(parseSearch(JSON.stringify(searchFor("berlin"))), { term: "berlin" })).toBeNull();
    expect(pickResult(parseSearch(JSON.stringify({ result: [{ symbol: "BRK.B", description: "BERKSHIRE HATHAWAY INC-CL B", type: "Common Stock" }, { symbol: "BRK.A", description: "BERKSHIRE HATHAWAY INC-CL A", type: "Common Stock" }] })), { term: "berkshire hathaway" }).symbol).toBe("BRK.B");
    expect(pickResult([], { term: "x" })).toBeNull();
    expect(pickResult(null, { term: "x" })).toBeNull();
    // the best named match beats the first result
    const named = [{ symbol: "AAA", description: "UNRELATED", type: "Common Stock" }, { symbol: "BBB", description: "TESLA INC", type: "Common Stock" }];
    expect(pickResult(named, { term: "tesla" }).symbol).toBe("BBB");
    expect(pickResult(named, { term: "zzz" }).symbol).toBe("AAA");
    for (const type of ["Common Stock", "ETP", "ADR", "REIT", "", "Unknown type"]) expect(typeOk(type), type).toBe(true);
    for (const type of ["Warrant", "Right", "Preferred Stock", "Unit", "Bond", "Crypto"]) expect(typeOk(type), type).toBe(false);
  });

  test("candles", () => {
    expect(parseCandles(JSON.stringify(candlesFor("QFRN"))).points).toHaveLength(35);
    expect(parseCandles('{"s":"no_data"}')).toEqual({ points: [] });
    expect(parseCandles('{"s":"ok","c":[1,"x",null,2,-1]}').points).toEqual([1, 2]);
    expect(parseCandles("x")).toBeNull();
    const many = parseCandles(JSON.stringify({ s: "ok", c: Array.from({ length: 1000 }, (_, i) => i + 1) }));
    expect(many.points.length).toBeLessThanOrEqual(400);
  });
});

describe("formatting", () => {
  test("prices and changes", () => {
    expect(fmtPrice(189.839)).toBe("189.84");
    expect(fmtPrice(1234567.891)).toBe("1,234,567.89");
    expect(fmtPrice(0.4321)).toBe("0.4321");
    expect(fmtPrice(null)).toBe("–");
    expect(fmtChange(2.32)).toBe("+2.32");
    expect(fmtChange(-0.88)).toBe("-0.88");
    expect(fmtChange(0)).toBe("0.00");
    expect(fmtChange(null)).toBe("");
    expect(fmtPercent(1.2372)).toBe("1.24%");
    expect(fmtPercent(-0.5)).toBe("0.50%");
    expect(fmtPercent(null)).toBe("");
    expect(directionOf(1)).toBe("up");
    expect(directionOf(-1)).toBe("down");
    expect(directionOf(0)).toBe("flat");
  });
  test("market cap, in millions", () => {
    expect(fmtCap(2_910_450.5)).toBe("$2.91T");
    expect(fmtCap(412_300)).toBe("$412.3B");
    expect(fmtCap(1000)).toBe("$1.0B");
    expect(fmtCap(850.24)).toBe("$850.2M");
    expect(fmtCap(5000, "EUR")).toBe("EUR 5.0B");
    for (const bad of [0, -5, null, Number.NaN, "x"]) expect(fmtCap(bad)).toBe("–");
  });
  test("ratios and yield", () => {
    expect(fmtRatio(29.4123)).toBe("29.41");
    expect(fmtRatio(null)).toBe("–");
    expect(fmtYield(0.523)).toBe("0.52%");
    expect(fmtYield(0)).toBe("–");
  });
  test("exchange names", () => {
    expect(exchangeLabel("NASDAQ NMS - GLOBAL MARKET")).toBe("NASDAQ");
    expect(exchangeLabel("NEW YORK STOCK EXCHANGE, INC.")).toBe("NYSE");
    expect(exchangeLabel("NYSE ARCA")).toBe("NYSE Arca");
    expect(exchangeLabel("NYSE AMERICAN, LLC")).toBe("NYSE American");
    expect(exchangeLabel("CBOE BZX")).toBe("Cboe");
    expect(exchangeLabel("SOME OTHER EXCHANGE LTD")).toBe("SOME OTHER");
    expect(exchangeLabel("")).toBe("");
    expect(exchangeLabel(null)).toBe("");
  });
  test("range positions", () => {
    expect(percentOf(5, 0, 10)).toBe(50);
    expect(percentOf(-5, 0, 10)).toBe(0);
    expect(percentOf(50, 0, 10)).toBe(100);
    expect(percentOf(5, 5, 5)).toBe(50);
    expect(percentOf(188.8, 186.9, 190.7)).toBeCloseTo(50, 5);
  });
  test("sparkline points", () => {
    const points = sparkPoints([1, 2, 3, 2, 1]);
    expect(points.split(" ")).toHaveLength(5);
    expect(points.startsWith("0.0,")).toBe(true);
    expect(points.split(" ").at(-1).startsWith("100.0,")).toBe(true);
    expect(sparkPoints([1])).toBe("");
    expect(sparkPoints([])).toBe("");
    expect(sparkPoints(null)).toBe("");
    expect(sparkPoints([5, 5, 5])).not.toContain("NaN");
    // higher values are drawn higher (smaller y)
    const [first, second] = sparkPoints([1, 3]).split(" ").map((p) => Number(p.split(",")[1]));
    expect(second).toBeLessThan(first);
  });
  test("time stamps", () => {
    expect(formatStamp(1793223480)).toMatch(/Oct 2[89]/);
    expect(formatStamp(0)).toBe("");
    expect(formatStamp("x")).toBe("");
  });
});

describe("cards", () => {
  const data = (symbol = "QFRN", extra = {}) => ({
    symbol,
    quote: parseQuote(JSON.stringify(quoteFor(symbol))),
    profile: parseProfile(JSON.stringify(profileFor(symbol))),
    metric: parseMetric(JSON.stringify(metricFor(symbol))),
    session: "open",
    holiday: "",
    points: [],
    logoSrc: "",
    ...extra,
  });

  test("inline: kicker, name, price, change with arrow and sign, status, ranges, statistics, link, attribution", () => {
    const html = buildCard(data(), { layout: "inline" });
    expect(html).toContain("stocks-card--inline");
    expect(html).toContain("Stock · NASDAQ: QFRN");
    expect(html).toContain("Quillfern Systems Inc");
    expect(html).toContain("NASDAQ · Technology");
    expect(html).toContain(">189.84<");
    expect(html).toContain(">USD<");
    expect(html).toContain("stocks-change--up");
    expect(html).toContain("+2.32 (1.24%)");
    expect(html).toContain("<svg");
    expect(html).toContain("Market open");
    expect(html).toContain("stocks-pill--open");
    expect(html).toContain("Updated Oct 2");
    expect(html).toContain("Day range");
    expect(html).toContain("52-week range");
    expect(html).toContain("141.20");
    expect(html).toContain("214.30");
    for (const [label, value] of [["Open", "187.90"], ["Prev. close", "187.52"], ["Market cap", "$2.91T"], ["P/E", "29.41"], ["EPS", "6.45"], ["Dividend yield", "0.52%"], ["Beta", "1.21"]]) {
      expect(html).toContain(`>${value}<`);
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('href="https://www.quillfern.example/"');
    expect(html).toContain(">quillfern.example<");
    expect(html).toContain('<a href="https://finnhub.io" target="_blank" rel="noopener noreferrer">Finnhub</a>');
    expect(html).toContain("Data from");
  });

  test("a falling stock gets a down arrow and a minus sign, a flat one neither colour", () => {
    const down = buildCard(data("BRMB"), { layout: "inline" });
    expect(down).toContain("stocks-change--down");
    expect(down).toContain("-0.88 (1.49%)");
    expect(down).toContain("NYSE · Food Products");
    expect(down).toContain("2.84%");
    const flat = buildCard(data("MIDS"), { layout: "inline" });
    expect(flat).toContain("stocks-change--flat");
    expect(flat).not.toContain("Dividend yield");
    expect(flat).not.toContain(">P/E<");
    expect(flat).toContain(">0.4321<");
    expect(flat).toContain("NYSE Arca");
  });

  test("the market status pills", () => {
    for (const [session, text, cls] of [["open", "Market open", "open"], ["pre", "Pre-market", "pre"], ["post", "After hours", "post"], ["closed", "Market closed", "closed"]]) {
      const html = buildCard(data("QFRN", { session }), { layout: "inline" });
      expect(html).toContain(text);
      expect(html).toContain(`stocks-pill--${cls}`);
    }
    expect(buildCard(data("QFRN", { session: "holiday", holiday: "Thanksgiving Day" }), { layout: "inline" })).toContain("Closed · Thanksgiving Day");
    expect(buildCard(data("QFRN", { session: "" }), { layout: "inline" })).not.toContain("stocks-pill");
  });

  test("the logo needs a signed address; the sparkline needs points", () => {
    expect(buildCard(data(), { layout: "inline" })).not.toContain("<img");
    const logo = buildCard(data("QFRN", { logoSrc: "/api/proxy/image?url=x&sig=y" }), { layout: "inline" });
    expect(logo).toContain('<img class="stocks-logo" src="/api/proxy/image?url=x&amp;sig=y"');
    expect(logo).not.toContain("static2.finnhub.io");
    expect(buildCard(data(), { layout: "inline" })).not.toContain("stocks-spark");
    const spark = buildCard(data("QFRN", { points: [1, 2, 3, 2, 4] }), { layout: "inline" });
    expect(spark).toContain("<polyline");
    expect(spark).toContain("stocks-spark--up");
  });

  test("missing data leaves out only what is missing", () => {
    const html = buildCard({ symbol: "QFRN", quote: parseQuote(JSON.stringify(quoteFor("QFRN"))), profile: null, metric: null, session: "", points: [], logoSrc: "" }, { layout: "inline" });
    expect(html).toContain("Stock · QFRN");
    expect(html).toContain(">189.84<");
    expect(html).toContain(">USD<");
    expect(html).toContain("Day range");
    expect(html).not.toContain("52-week range");
    expect(html).toContain(">Open<");
    expect(html).not.toContain("Market cap");
    expect(html).toContain("Data from");
  });

  test("panel: compact, price, change, status, day range, no statistics", () => {
    const inline = buildCard(data(), { layout: "inline" });
    const panel = buildCard(data(), { layout: "panel" });
    expect(panel).toContain("stocks-card--panel");
    expect(panel).toContain("Stock · NASDAQ: QFRN");
    expect(panel).toContain("+2.32 (1.24%)");
    expect(panel).toContain("Market open");
    expect(panel).toContain("Day range");
    expect(panel).not.toContain("52-week");
    expect(panel).not.toContain("stocks-grid");
    expect(panel).not.toContain("<img");
    expect(panel).toContain("Finnhub");
    expect(panel.length).toBeLessThan(inline.length);
  });

  test("the range marker sits where the price is", () => {
    const html = buildCard(data(), { layout: "inline" });
    const markers = [...html.matchAll(/class="stocks-range-marker" x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(markers).toHaveLength(2);
    // day range 186.9 .. 190.7: 189.84 is at about 77 %; 52-week 141.2 .. 214.3: about 66 %
    expect(markers[0]).toBeGreaterThan(70);
    expect(markers[1]).toBeGreaterThan(60);
    expect(markers[1]).toBeLessThan(70);
  });

  test("everything is escaped; no inline styles or handlers; links are ours or the company's https site", () => {
    const hostile = data("QFRN", {
      profile: { name: '<img src=x onerror="alert(1)">', exchange: "NASDAQ", industry: "<b>x</b>", marketCap: 5, currency: 'U"S', website: "https://evil.example/a?b=<c>", logo: "" },
      logoSrc: '"><script>alert(1)</script>',
      holiday: "<i>",
      session: "holiday",
    });
    const html = buildCard(hostile, { layout: "inline" }) + buildCard(hostile, { layout: "panel" });
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).not.toMatch(/<[^>]*\sstyle=/);
    expect(html).not.toMatch(/<[^>]*\son[a-z]+=/i);
    for (const href of [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])) expect(href).toMatch(/^https:\/\//);
  });
});

describe("the store", () => {
  test("remembers, expires, and survives a restart", () => {
    const folder = mkdtempSync(join(tmpdir(), "stocks-test-"));
    try {
      const file = join(folder, "stocks", "cache.json");
      const time = clock();
      const store = new Store({ file, now: time.now });
      expect(store.get("neg:ZZZ")).toBeUndefined();
      store.set("neg:ZZZ", true, 1000);
      store.set("res:apple", { symbol: "QFRN", name: "x" }, 60_000);
      expect(store.has("neg:ZZZ")).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}.tmp`)).toBe(false);
      const reborn = new Store({ file, now: time.now });
      expect(reborn.get("neg:ZZZ")).toBe(true);
      expect(reborn.get("res:apple")).toEqual({ symbol: "QFRN", name: "x" });
      time.state.t += 2000;
      expect(reborn.has("neg:ZZZ")).toBe(false);
      expect(reborn.has("res:apple")).toBe(true);
      expect(new Store({ file, now: time.now }).has("neg:ZZZ")).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  test("an unreadable file starts empty; an empty file name stays in memory", () => {
    const folder = mkdtempSync(join(tmpdir(), "stocks-test-"));
    try {
      const file = join(folder, "cache.json");
      writeFileSync(file, "{ nope");
      const store = new Store({ file });
      expect(store.get("x")).toBeUndefined();
      store.set("x", 1, 1000);
      expect(store.get("x")).toBe(1);
      const memory = new Store({ file: "" });
      memory.set("y", 2, 1000);
      expect(memory.get("y")).toBe(2);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
  test("it stays small", () => {
    const store = new Store({ file: "" });
    for (let i = 0; i < 3200; i += 1) store.set(`k${i}`, i, 60_000);
    expect(store.map.size).toBeLessThanOrEqual(3000);
    expect(store.get("k3199")).toBe(3199);
    expect(store.get("k0")).toBeUndefined();
  });
});

describe("the upstream: rate limit and statuses", () => {
  const make = (extra = {}) => {
    const time = clock();
    const host = { now: time.now, sleep: time.sleep, debugMatching: false, ...extra };
    return { time, host, up: new FinnhubUpstream({ host, perMinute: 50, spacingMs: 0 }) };
  };
  const reply = (status, headers = {}, body = "{}") => async () => new Response(body, { status, headers });

  test("at most 50 requests in any minute: the 51st waits", async () => {
    const { time, up } = make();
    const stamps = [];
    const context = { fetch: async () => { stamps.push(time.state.t); return new Response("{}"); } };
    for (let i = 0; i < 51; i += 1) expect((await up.request("https://x/y", { context, deadline: time.state.t + 120_000 })).ok).toBe(true);
    expect(stamps).toHaveLength(51);
    expect(stamps[50] - stamps[0]).toBeGreaterThanOrEqual(60_000);
    expect(stamps[49] - stamps[0]).toBeLessThan(60_000);
  });

  test("a request that would have to wait past the deadline is skipped, not made late", async () => {
    const { time, up } = make();
    const context = { fetch: async () => new Response("{}") };
    for (let i = 0; i < 50; i += 1) await up.request("https://x/y", { context, deadline: time.state.t + 120_000 });
    const result = await up.request("https://x/y", { context, deadline: time.state.t + 5000 });
    expect(result).toMatchObject({ ok: false, reason: "time" });
  });

  test("429 pauses for Retry-After (a minute by default, five at most) with one warning", async () => {
    for (const [headers, minutes] of [[{}, 1], [{ "retry-after": "120" }, 2], [{ "retry-after": "99999" }, 5]]) {
      const { up, time } = make();
      let calls = 0;
      const context = { fetch: async () => { calls += 1; return new Response("{}", { status: 429, headers }); } };
      const lines = await capture(async () => {
        expect(await up.request("https://x/y", { context, deadline: time.state.t + 9000 })).toMatchObject({ ok: false, reason: "rate" });
        expect(await up.request("https://x/y", { context, deadline: time.state.t + 9000 })).toMatchObject({ ok: false, reason: "paused" });
      });
      expect(calls).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`paused for ${minutes} min`);
    }
  });

  test("401 pauses for 30 minutes quietly: only debugMatching says so", async () => {
    const quiet = make();
    const lines = await capture(async () => {
      expect(await quiet.up.request("https://x/y", { context: { fetch: reply(401) }, deadline: quiet.time.state.t + 9000 })).toMatchObject({ ok: false, reason: "unauthorized" });
    });
    expect(lines).toEqual([]);
    expect(quiet.up.paused).toBe(true);
    quiet.time.state.t += 29 * 60_000;
    expect(quiet.up.paused).toBe(true);
    quiet.time.state.t += 2 * 60_000;
    expect(quiet.up.paused).toBe(false);
    const loud = make({ debugMatching: true });
    const debugLines = await capture(async () => {
      await loud.up.request("https://x/y", { context: { fetch: reply(401) }, deadline: loud.time.state.t + 9000 });
    });
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain("rejected the API key");
    expect(debugLines[0]).toContain("paused for 30 min");
  });

  test("403 is not a pause: it is what the free plan answers for a foreign symbol or a premium endpoint", async () => {
    const { up, time } = make();
    const lines = await capture(async () => {
      expect(await up.request("https://x/y", { context: { fetch: reply(403) }, deadline: time.state.t + 9000 })).toMatchObject({ ok: false, reason: "forbidden", status: 403 });
    });
    expect(lines).toEqual([]);
    expect(up.paused).toBe(false);
  });

  test("5xx and network errors pause for a minute; other statuses do not", async () => {
    const a = make();
    await capture(async () => {
      expect(await a.up.request("https://x/y", { context: { fetch: reply(503) }, deadline: a.time.state.t + 9000 })).toMatchObject({ reason: "server" });
    });
    expect(a.up.paused).toBe(true);
    const b = make();
    const lines = await capture(async () => {
      expect(await b.up.request("https://x/y", { context: { fetch: async () => { throw new Error("boom https://secret.example"); } }, deadline: b.time.state.t + 9000 })).toMatchObject({ reason: "network" });
    });
    expect(lines.join("")).not.toContain("secret");
    expect(b.up.paused).toBe(true);
    const c = make();
    expect(await c.up.request("https://x/y", { context: { fetch: reply(404) }, deadline: c.time.state.t + 9000 })).toMatchObject({ reason: "notfound" });
    expect(await c.up.request("https://x/y", { context: { fetch: reply(418) }, deadline: c.time.state.t + 9000 })).toMatchObject({ reason: "http" });
    expect(c.up.paused).toBe(false);
  });

  test("the daily budget stops requests", async () => {
    const time = clock();
    const budget = new Budget({ file: "", cap: 2, now: time.now });
    const up = new FinnhubUpstream({ host: { now: time.now, sleep: time.sleep }, spacingMs: 0, budgetOf: () => budget });
    let calls = 0;
    const context = { fetch: async () => { calls += 1; return new Response("{}"); } };
    await up.request("https://x/y", { context, deadline: time.state.t + 9000 });
    await up.request("https://x/y", { context, deadline: time.state.t + 9000 });
    await capture(async () => {
      expect(await up.request("https://x/y", { context, deadline: time.state.t + 9000 })).toMatchObject({ reason: "budget" });
    });
    expect(calls).toBe(2);
  });
});

describe("the slot: no key, header only", () => {
  const ctx = (w) => ({ fetch: w.fetch });

  test("no key: nothing triggers, nothing is requested, and debugMatching says why", async () => {
    const previous = process.env.FINNHUB_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    try {
      const w = world();
      const slot = makeSlot({ apiKey: "", debugMatching: "true" });
      expect(slot.apiKey).toBe("");
      const lines = await capture(async () => {
        expect(slot.trigger("AAPL stock")).toBe(false);
        expect(slot.trigger("QFRN")).toBe(false);
        expect(slot.trigger("hello world")).toBe(false);
        expect(await slot.execute("AAPL stock", ctx(w))).toEqual({ title: "", html: "" });
      });
      expect(w.calls).toHaveLength(0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]).toContain("no API key is set");
      const quiet = makeSlot({ apiKey: "" });
      expect(await capture(async () => quiet.trigger("AAPL stock"))).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.FINNHUB_API_KEY = previous;
    }
  });

  test("the key comes from the settings, else FINNHUB_API_KEY; the settings win", () => {
    const previous = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = "env-key-0123456789";
    try {
      expect(makeSlot({ apiKey: "" }).apiKey).toBe("env-key-0123456789");
      expect(makeSlot({ apiKey: undefined }).apiKey).toBe("env-key-0123456789");
      expect(makeSlot({ apiKey: "ui-key-0123456789" }).apiKey).toBe("ui-key-0123456789");
      expect(keyFrom('  "abc-DEF_123456"  ')).toBe("abc-DEF_123456");
      for (const bad of ["short", "has space in it 1234", "bad\nkey123456789", "x".repeat(200), "ünïcode-key-1234", null, undefined, 5]) expect(keyFrom(bad), String(bad)).toBe("");
    } finally {
      if (previous === undefined) delete process.env.FINNHUB_API_KEY;
      else process.env.FINNHUB_API_KEY = previous;
    }
  });

  test("the key is sent only in the X-Finnhub-Token header: never in a URL, a log line, the html or the saved cache", async () => {
    const folder = mkdtempSync(join(tmpdir(), "stocks-test-"));
    try {
      const w = world();
      const store = new Store({ file: join(folder, "cache.json") });
      const slot = makeSlot({ debugMatching: "true" }, { store });
      let out;
      const lines = await capture(async () => {
        out = await slot.execute("QFRN", ctx(w));
        await slot.execute("zzzzq stock", ctx(w));
        await slot.execute("$ZZZ", ctx(w));
      });
      expect(out.html).toContain("stocks-card");
      expect(w.calls.length).toBeGreaterThan(5);
      for (const call of w.calls) {
        expect(call.url).not.toContain(KEY);
        expect(call.url).not.toMatch(/token|apikey|api_key/i);
        expect(call.headers["X-Finnhub-Token"]).toBe(KEY);
        expect(call.headers["User-Agent"]).toBe(USER_AGENT);
        expect(Object.keys(call.headers).sort()).toEqual(["Accept", "User-Agent", "X-Finnhub-Token"]);
      }
      expect(out.html).not.toContain(KEY);
      expect(lines.join("\n")).not.toContain(KEY);
      expect(readFileSync(join(folder, "cache.json"), "utf8")).not.toContain(KEY);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("the slot: lookups, costs and caches", () => {
  const ctx = (w) => ({ fetch: w.fetch });

  test("a bare uppercase ticker: search, quote, then profile, statistics, market status and candles; the second search is free", async () => {
    const w = world();
    const slot = makeSlot();
    const out = await slot.execute("QFRN", ctx(w));
    expect(w.calls[0].route).toBe("/search");
    expect(w.calls[1].route).toBe("/quote");
    expect(w.calls.slice(2).map((c) => c.route).sort()).toEqual(["/stock/candle", "/stock/market-status", "/stock/metric", "/stock/profile2"]);
    expect(w.calls).toHaveLength(6);
    expect(out.title).toBe("");
    expect(out.html.startsWith('<div class="command-result stocks-result">')).toBe(true);
    expect(out.html).toContain("Stock · NASDAQ: QFRN");
    expect(out.html).toContain("<polyline");
    await slot.execute("QFRN", ctx(w));
    await slot.execute("$QFRN", ctx(w));
    await slot.execute("QFRN stock", ctx(w));
    await slot.execute("quillfern stock price", ctx(w));
    expect(w.calls).toHaveLength(7);
    expect(w.count("/search")).toBe(2);
  });

  test("a well-known ticker skips the search: one quote validates it", async () => {
    const w = world();
    const slot = makeSlot();
    const out = await slot.execute("amd", ctx(w));
    expect(w.count("/search")).toBe(0);
    expect(w.count("/quote")).toBe(1);
    expect(out.html).toContain("Quillfern Micro Devices Inc");
  });

  test("a company name goes through /search, picks the common stock on a US listing, and is remembered", async () => {
    const w = world();
    const slot = makeSlot();
    const out = await slot.execute("quillfern stock price", ctx(w));
    expect(w.calls[0].route).toBe("/search");
    expect(w.calls[0].params.get("q")).toBe("quillfern");
    expect(w.calls[1].params.get("symbol")).toBe("QFRN");
    expect(out.html).toContain("Quillfern Systems Inc");
    await slot.execute("quillfern shares", ctx(w));
    await slot.execute("stock quillfern", ctx(w));
    expect(w.count("/search")).toBe(1);
  });

  test("explicit forms: a typed ticker is quoted directly; a lowercase unknown one goes through the search", async () => {
    const w = world();
    const slot = makeSlot();
    await slot.execute("QFRN stock", ctx(w));
    expect(w.calls[0].route).toBe("/quote");
    expect(w.count("/search")).toBe(0);
    const w2 = world();
    await makeSlot().execute("qfrn stock", ctx(w2));
    expect(w2.calls[0].route).toBe("/search");
    expect(w2.calls[1].route).toBe("/quote");
  });

  test("a typed ticker that has no quote falls back to a company-name search ('QUILLFERN stock')", async () => {
    const w = world();
    const slot = makeSlot();
    const out = await slot.execute("QUILL stock", ctx(w));
    expect(w.calls.slice(0, 3).map((c) => c.route)).toEqual(["/quote", "/search", "/quote"]);
    expect(w.calls[0].params.get("symbol")).toBe("QUILL");
    expect(w.calls[2].params.get("symbol")).toBe("QFRN");
    expect(out.html).toContain("Quillfern Systems Inc");
    // a long company name is never tried as a ticker
    const w2 = world();
    await makeSlot().execute("QUILLFERN stock", ctx(w2));
    expect(w2.calls[0].route).toBe("/search");
  });

  test("a bare candidate costs at most two calls to reject, and the rejection is remembered (persisted)", async () => {
    const folder = mkdtempSync(join(tmpdir(), "stocks-test-"));
    try {
      const file = join(folder, "stocks", "cache.json");
      const w = world();
      const slot = makeSlot({}, { store: new Store({ file }) });
      // a symbol Finnhub's search knows but that has no quote
      expect(await slot.execute("ZZZ", ctx(w))).toEqual({ title: "", html: "" });
      expect(w.calls.map((c) => c.route)).toEqual(["/search", "/quote"]);
      // a symbol the search does not know: one call
      expect(await slot.execute("XQXQ", ctx(w))).toEqual({ title: "", html: "" });
      expect(w.calls).toHaveLength(3);
      // remembered: trigger is false and nothing is requested
      expect(slot.trigger("ZZZ")).toBe(false);
      expect(slot.trigger("XQXQ")).toBe(false);
      expect(await slot.execute("ZZZ", ctx(w))).toEqual({ title: "", html: "" });
      expect(w.calls).toHaveLength(3);
      // ... and still remembered after a restart
      const restarted = makeSlot({}, { store: new Store({ file }) });
      expect(restarted.trigger("ZZZ")).toBe(false);
      expect(restarted.trigger("XQXQ")).toBe(false);
      expect(restarted.trigger("QFRN")).toBe(true);
      // the memory lasts a day
      const time = clock();
      const timed = makeSlot({}, { time, store: new Store({ file: "", now: time.now }) });
      await timed.execute("XQXQ", ctx(world()));
      expect(timed.trigger("XQXQ")).toBe(false);
      time.state.t += NEGATIVE_TTL_MS + 1000;
      expect(timed.trigger("XQXQ")).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("a well-known ticker with no quote is rejected with one call", async () => {
    const w = world({ "/quote": () => new Response(JSON.stringify({ c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 })) });
    const slot = makeSlot();
    expect(await slot.execute("MSFT", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(1);
    expect(slot.trigger("MSFT")).toBe(false);
  });

  test("a foreign listing is not a card (and a 403 on a quote is remembered, not a pause)", async () => {
    const w = world();
    const slot = makeSlot();
    expect(await slot.execute("berlin stock", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.count("/quote")).toBe(0);
    const w2 = world({ "/quote": () => new Response("{}", { status: 403 }) });
    const slot2 = makeSlot();
    expect(await slot2.execute("$QFRN", ctx(w2))).toEqual({ title: "", html: "" });
    expect(slot2.upstream.paused).toBe(false);
    expect(slot2.trigger("$QFRN")).toBe(false);
  });

  test("profile 7 days, statistics 6 hours, market status 2 minutes, quote 45 s open and 10 minutes closed", async () => {
    const time = clock();
    const w = world();
    const slot = makeSlot({}, { time });
    await slot.execute("$QFRN", ctx(w));
    const first = w.calls.length;
    time.state.t += QUOTE_OPEN_TTL_MS - 1000;
    await slot.execute("$QFRN", ctx(w));
    expect(w.calls.length).toBe(first);
    time.state.t += 2000;
    await slot.execute("$QFRN", ctx(w));
    expect(w.count("/quote")).toBe(2);
    expect(w.count("/stock/market-status")).toBe(1);
    expect(w.count("/stock/profile2")).toBe(1);
    expect(w.count("/stock/metric")).toBe(1);
    time.state.t += 3 * 60_000;
    await slot.execute("$QFRN", ctx(w));
    expect(w.count("/stock/market-status")).toBe(2);
    time.state.t += 7 * 3600_000;
    await slot.execute("$QFRN", ctx(w));
    expect(w.count("/stock/metric")).toBe(2);
    expect(w.count("/stock/profile2")).toBe(1);
    time.state.t += 7 * 86_400_000;
    await slot.execute("$QFRN", ctx(w));
    expect(w.count("/stock/profile2")).toBe(2);
    // closed market: the quote is kept longer
    const closed = world({}, { market: "closed" });
    const slot2 = makeSlot({}, { time });
    await slot2.execute("$QFRN", ctx(closed));
    await slot2.execute("$QFRN", ctx(closed));
    time.state.t += QUOTE_CLOSED_TTL_MS - 5000;
    await slot2.execute("$QFRN", ctx(closed));
    expect(closed.count("/quote")).toBe(1);
    time.state.t += 10_000;
    await slot2.execute("$QFRN", ctx(closed));
    expect(closed.count("/quote")).toBe(2);
  });

  test("concurrent identical searches share their requests", async () => {
    const w = world({ "/quote": async () => { await new Promise((r) => setTimeout(r, 30)); return null; } });
    const slot = makeSlot();
    await Promise.all([slot.execute("$QFRN", ctx(w)), slot.execute("QFRN stock", ctx(w)), slot.execute("$QFRN", ctx(w))]);
    expect(w.count("/quote")).toBe(1);
    expect(w.count("/stock/profile2")).toBe(1);
  });

  test("candles: a 403 is remembered for a day (and across restarts); the card still shows, without a sparkline", async () => {
    const folder = mkdtempSync(join(tmpdir(), "stocks-test-"));
    try {
      const file = join(folder, "cache.json");
      const time = clock();
      const w = world({ "/stock/candle": () => new Response('{"error":"You don\'t have access to this resource."}', { status: 403 }) });
      const slot = makeSlot({ debugMatching: "true" }, { time, store: new Store({ file, now: time.now }) });
      let out;
      const lines = await capture(async () => {
        out = await slot.execute("$QFRN", ctx(w));
      });
      expect(out.html).toContain("stocks-card");
      expect(out.html).not.toContain("<polyline");
      expect(w.count("/stock/candle")).toBe(1);
      expect(lines.join("\n")).toContain("candles: forbidden");
      expect(slot.upstream.paused).toBe(false);
      time.state.t += 20 * 60_000;
      await capture(async () => {
        await slot.execute("$QFRN", ctx(w));
        await slot.execute("$QFRN", ctx(w));
      });
      expect(w.count("/stock/candle")).toBe(1);
      const restarted = makeSlot({}, { time, store: new Store({ file, now: time.now }) });
      await restarted.execute("$BRMB", ctx(w));
      expect(w.count("/stock/candle")).toBe(1);
      time.state.t += CANDLES_UNAVAILABLE_TTL_MS + 1000;
      const later = makeSlot({}, { time, store: new Store({ file, now: time.now }) });
      const w2 = world();
      await later.execute("$BRMB", ctx(w2));
      expect(w2.count("/stock/candle")).toBe(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("candles that work make a sparkline; they are skipped in the panel and when the setting is off", async () => {
    expect((await makeSlot().execute("$QFRN", ctx(world()))).html).toContain("stocks-spark");
    const panel = world();
    expect((await makeSlot({ layout: "panel" }).execute("$QFRN", ctx(panel))).html).toContain("stocks-card--panel");
    expect(panel.count("/stock/candle")).toBe(0);
    const off = world();
    expect((await makeSlot({ showSparkline: "false" }).execute("$QFRN", ctx(off))).html).not.toContain("stocks-spark");
    expect(off.count("/stock/candle")).toBe(0);
    const nodata = world({ "/stock/candle": () => new Response('{"s":"no_data"}') });
    const html = (await makeSlot().execute("$QFRN", ctx(nodata))).html;
    expect(html).not.toContain("stocks-spark");
    expect(nodata.count("/stock/candle")).toBe(1);
  });

  test("the market status decides the pill", async () => {
    for (const [mode, text] of [["open", "Market open"], ["closed", "Market closed"], ["pre", "Pre-market"], ["post", "After hours"], ["holiday", "Thanksgiving Day"]]) {
      const html = (await makeSlot().execute("$QFRN", ctx(world({}, { market: mode })))).html;
      expect(html, mode).toContain(text);
    }
    let noStatus = "";
    await capture(async () => {
      noStatus = (await makeSlot().execute("$QFRN", ctx(world({ "/stock/market-status": () => new Response("{}", { status: 500 }) })))).html;
    });
    expect(noStatus).toContain("stocks-card");
    expect(noStatus).not.toContain("stocks-pill");
  });

  test("a failing profile call leaves a thinner card, not no card", async () => {
    const w = world({ "/stock/profile2": () => new Response("{}", { status: 500 }) });
    let html = "";
    await capture(async () => {
      html = (await makeSlot().execute("$QFRN", ctx(w))).html;
    });
    expect(html).toContain("Stock · QFRN");
    expect(html).toContain(">189.84<");
    expect(html).not.toContain("Quillfern Systems Inc");
  });

  test("the logo goes through signProxyUrl only; without it there is no logo", async () => {
    const w = world();
    const signed = [];
    const withProxy = await makeSlot().execute("$QFRN", { fetch: w.fetch, signProxyUrl: (u) => { signed.push(u); return `/api/proxy/image?u=${encodeURIComponent(u)}&sig=s`; } });
    expect(signed).toEqual(["https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/QFRN.png"]);
    expect(withProxy.html).toContain('class="stocks-logo" src="/api/proxy/image?u=');
    expect(withProxy.html).not.toContain('src="https://static2');
    const without = await makeSlot().execute("$BRMB", { fetch: w.fetch });
    expect(without.html).not.toContain("<img");
    const failing = await makeSlot().execute("$BRMB", { fetch: w.fetch, signProxyUrl: () => { throw new Error("no"); } });
    expect(failing.html).toContain("stocks-card");
    expect(failing.html).not.toContain("<img");
    const init = makeSlot();
    init.init({ signProxyUrl: (u) => `/p?u=${u}` });
    expect((await init.execute("$QFRN", { fetch: world().fetch })).html).toContain('src="/p?u=');
  });
});

describe("the slot: failures", () => {
  const ctx = (w) => ({ fetch: w.fetch });

  test("401 pauses the plugin for 30 minutes without a log line, and debugMatching explains it", async () => {
    const time = clock();
    const w = world({ "*": () => new Response('{"error":"Invalid API key"}', { status: 401 }) });
    const slot = makeSlot({}, { time });
    const quiet = await capture(async () => {
      expect(await slot.execute("$QFRN", ctx(w))).toEqual({ title: "", html: "" });
    });
    expect(quiet).toEqual([]);
    const callsAfter = w.calls.length;
    expect(slot.trigger("$QFRN")).toBe(false);
    expect(await slot.execute("AAPL stock", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls.length).toBe(callsAfter);
    const loud = makeSlot({ debugMatching: "true" }, { time });
    const lines = await capture(async () => {
      await loud.execute("$QFRN", ctx(w));
      loud.trigger("$QFRN");
    });
    expect(lines.join("\n")).toContain("rejected the API key");
    expect(lines.join("\n")).toContain("Finnhub is paused");
    time.state.t += 31 * 60_000;
    expect(slot.trigger("$QFRN")).toBe(true);
  });

  test("429 pauses with one warning; the cards come back afterwards", async () => {
    const time = clock();
    const w = world({ "/quote": () => new Response("{}", { status: 429, headers: { "retry-after": "45" } }) });
    const slot = makeSlot({}, { time });
    const lines = await capture(async () => {
      expect(await slot.execute("$QFRN", ctx(w))).toEqual({ title: "", html: "" });
      expect(await slot.execute("$BRMB", ctx(w))).toEqual({ title: "", html: "" });
    });
    expect(w.count("/quote")).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("paused for 1 min");
    expect(slot.trigger("$QFRN")).toBe(false);
    time.state.t += 46_000;
    expect((await slot.execute("$QFRN", ctx(world()))).html).toContain("stocks-card");
  });

  test("the daily budget", async () => {
    const w = world();
    const slot = makeSlot({ dailyRequestLimit: "2", showSparkline: "false" });
    await capture(async () => {
      expect(await slot.execute("$QFRN", ctx(w))).toBeDefined();
    });
    expect(w.calls).toHaveLength(2);
    expect(slot.budget.used).toBe(2);
    expect(slot.trigger("$BRMB")).toBe(false);
    expect(makeSlot({ dailyRequestLimit: "0" }).budget.cap).toBe(0);
  });

  test("a lookup that is too slow for the slot gives up; the replies are cached for the next search", async () => {
    const gate = Promise.withResolvers();
    const w = world({ "/stock/profile2": async () => { await gate.promise; return null; } });
    const slot = makeSlot();
    slot.answerWindowMs = 100;
    expect(await slot.execute("$QFRN", ctx(w))).toEqual({ title: "", html: "" });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    slot.answerWindowMs = 5000;
    expect((await slot.execute("$QFRN", ctx(w))).html).toContain("stocks-card");
    expect(w.count("/stock/profile2")).toBe(1);
  });

  test("no request is started after 70 % of the slot time", async () => {
    const w = world();
    const slot = makeSlot();
    slot.startWindowMs = -1;
    expect(await slot.execute("$QFRN", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
  });

  test("not a stock query: no request; never throws", async () => {
    const w = world();
    const slot = makeSlot();
    for (const query of ["chicken stock", "weather in paris", "2+2", "100 usd to eur", "define stock", "btc", "serendipity", ""]) expect(await slot.execute(query, ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
    await capture(async () => {
      for (const query of [null, undefined, "", "$QFRN"]) {
        expect(await slot.execute(query, { fetch: async () => { throw new Error("x"); } })).toBeDefined();
        expect(await slot.execute(query, undefined)).toBeDefined();
      }
    });
  });
});

describe("settings and layout", () => {
  test("the bare ticker setting", async () => {
    const off = makeSlot({ triggerOnBareTicker: "false" });
    expect(off.trigger("AAPL")).toBe(false);
    expect(off.trigger("QFRN")).toBe(false);
    expect(off.trigger("AAPL stock")).toBe(true);
    expect(off.trigger("$AAPL")).toBe(true);
    const on = makeSlot({ triggerOnBareTicker: "true" });
    expect(on.trigger("AAPL")).toBe(true);
    expect(makeSlot({}).trigger("AAPL")).toBe(true);
    const w = world();
    expect(await off.execute("QFRN", { fetch: w.fetch })).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
  });

  test("layouts: position, size and content differ; the card moves with the setting", async () => {
    const inline = makeSlot({ layout: "inline" });
    const panel = makeSlot({ layout: "panel" });
    expect(inline.position).toBe(INLINE_POSITION);
    expect(panel.position).toBe(PANEL_POSITION);
    expect(inline.slotPositions).toBeUndefined();
    const w = world();
    const a = (await inline.execute("$QFRN", { fetch: w.fetch })).html;
    const b = (await panel.execute("$QFRN", { fetch: w.fetch })).html;
    expect(a).toContain("stocks-card--inline");
    expect(b).toContain("stocks-card--panel");
    expect(a.length).toBeGreaterThan(b.length);
    inline.configure({ apiKey: KEY, layout: "panel" });
    expect(inline.position).toBe(PANEL_POSITION);
  });

  test("clamping and defaults", () => {
    expect(layoutFrom("PANEL")).toBe("panel");
    expect(layoutFrom(undefined)).toBe("inline");
    const slot = makeSlot({ dailyRequestLimit: "9" });
    expect(slot.budget.cap).toBe(9);
    slot.configure({ apiKey: KEY, dailyRequestLimit: "x" });
    expect(slot.budget.cap).toBe(2000);
    expect(slot.sparkline).toBe(true);
    expect(slot.bare).toBe(true);
  });

  test("the schema", () => {
    expect(SETTINGS_SCHEMA.map((f) => f.key)).toEqual(["apiKey", "layout", "showSparkline", "triggerOnBareTicker", "dailyRequestLimit", "debugMatching"]);
    expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey")).toMatchObject({ type: "password", secret: true });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey").required).toBeUndefined();
    expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey").description).toContain("finnhub.io");
    expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey").description).toContain("FINNHUB_API_KEY");
    expect(SETTINGS_SCHEMA.find((f) => f.key === "layout")).toMatchObject({ default: "inline", options: ["inline", "panel"] });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "triggerOnBareTicker")).toMatchObject({ type: "toggle", default: "true" });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "showSparkline")).toMatchObject({ type: "toggle", default: "true" });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "dailyRequestLimit")).toMatchObject({ default: "2000", advanced: true });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "debugMatching")).toMatchObject({ default: "false", advanced: true });
    expect(SETTINGS_SCHEMA.some((f) => f.required)).toBe(false);
  });
});

describe("debugMatching", () => {
  test("off by default: nothing is logged", async () => {
    const w = world();
    const slot = makeSlot();
    const lines = await capture(async () => {
      slot.trigger("chicken stock");
      slot.trigger("NOW");
      await slot.execute("QFRN", { fetch: w.fetch });
      await slot.execute("XQXQ", { fetch: w.fetch });
    });
    expect(lines).toEqual([]);
  });

  test("on: rejections with the rule, and one block per lookup with the steps", async () => {
    const w = world();
    const slot = makeSlot({ debugMatching: "true" });
    const near = await capture(async () => {
      expect(slot.trigger("chicken stock")).toBe(false);
      expect(slot.trigger("NOW")).toBe(false);
      expect(slot.trigger("hello world")).toBe(false);
    });
    expect(near).toHaveLength(2);
    expect(near[0]).toContain("chicken");
    expect(near[1]).toContain("common word");
    const lines = await capture(async () => {
      await slot.execute("QFRN", { fetch: w.fetch });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("bare rule: uppercase ticker");
    expect(lines[0]).toContain("search: QFRN");
    expect(lines[0]).toContain("quote QFRN: ok (request) [after search]");
    expect(lines[0]).toContain("profile: ok (request)");
    expect(lines[0]).toContain("verdict: card shown");
    const rejected = await capture(async () => {
      await slot.execute("XQXQ", { fetch: w.fetch });
      slot.trigger("XQXQ");
    });
    expect(rejected.join("\n")).toContain("no exact symbol match (remembered for a day)");
    expect(rejected.join("\n")).toContain("no card (no confirmed US stock quote)");
    expect(rejected.join("\n")).toContain("recently found not to be a US stock");
    expect(rejected.join("\n")).not.toContain(KEY);
  });
});

describe("one menu entry", () => {
  test("the module exports a slot and no bang command (a command would add a second entry to degoog's plugin list)", async () => {
    const mod = await import("../plugins/stocks/index.js");
    expect(mod.slot).toBe(sharedSlot);
    expect("command" in mod).toBe(false);
    expect("default" in mod).toBe(false);
  });
});
