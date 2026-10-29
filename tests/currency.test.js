// Tests for the currency slot plugin: parsing, rates cache and pauses, Coinbase calls, cards, layout and settings.
//
// NOTE: tests/fixtures/er-api-usd.json and tests/fixtures/coinbase-*.json are HAND-WRITTEN to the documented layouts of
// open.er-api.com and Coinbase's public API. The numbers are invented; they are not real rates or prices.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../plugins/currency/budget.js";
import { Coinbase, parseList, parseSpot, parseStats } from "../plugins/currency/coinbase.js";
import { CRYPTO_ALIASES, FIAT_ALIASES } from "../plugins/currency/aliases.js";
import { CRYPTO_NAMES, FIAT_CODES, FIAT_NAMES, STARTER_CRYPTO } from "../plugins/currency/currencies.js";
import { buildResult, formatMoney, formatPercent, formatRate, rateBetween } from "../plugins/currency/convert.js";
import { parseQuery, resolveCurrency } from "../plugins/currency/match.js";
import { FiatRates, RATES_TTL_MS, STALE_MAX_MS, parseFiat } from "../plugins/currency/rates.js";
import { buildCard, formatStamp } from "../plugins/currency/render.js";
import { SETTINGS_SCHEMA } from "../plugins/currency/settings.js";
import { CurrencySlot, slot as sharedSlot, INLINE_POSITION, PANEL_POSITION, USER_AGENT, codeFrom, codesFrom, decimalsFrom, layoutFrom } from "../plugins/currency/index.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ER = fixture("er-api-usd.json");
const SPOT = fixture("coinbase-spot-btc.json");
const STATS = fixture("coinbase-stats-btc.json");
const LIST = fixture("coinbase-crypto-list.json");

// A fake world: answers the four endpoints from the fixtures, counts and records every request.
const world = (overrides = {}) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, headers: init.headers ?? {} });
    const kind = u.pathname === "/v6/latest/USD" ? "er" : /\/spot$/.test(u.pathname) ? "spot" : /\/stats$/.test(u.pathname) ? "stats" : u.pathname === "/v2/currencies/crypto" ? "list" : "other";
    const handler = overrides[kind];
    if (handler) {
      const custom = await handler(u, calls.length);
      if (custom) return custom;
    }
    if (kind === "er") return new Response(ER, { status: 200 });
    if (kind === "spot") return new Response(SPOT, { status: 200 });
    if (kind === "stats") return new Response(STATS, { status: 200 });
    if (kind === "list") return new Response(LIST, { status: 200 });
    return new Response("nope", { status: 404 });
  };
  return { fetch, calls, count: (kind) => calls.filter((c) => (kind === "er" ? c.path === "/v6/latest/USD" : kind === "spot" ? /\/spot$/.test(c.path) : kind === "stats" ? /\/stats$/.test(c.path) : kind === "list" ? c.path === "/v2/currencies/crypto" : true)).length };
};

const clock = (start = Date.parse("2026-10-28T12:00:00Z")) => {
  const state = { t: start };
  return { state, now: () => state.t, sleep: async (ms) => { state.t += ms; } };
};

const makeSlot = (settings = {}, { time } = {}) => {
  const slot = new CurrencySlot();
  slot.spacingMs = 0;
  slot.fiat.file = "";
  slot.fiat.budget.file = "";
  if (time) {
    slot.now = time.now;
    slot.sleep = time.sleep;
  }
  slot.configure(settings);
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

const summary = (query, options = {}) => {
  const { parsed } = parseQuery(query, { secondary: ["EUR", "GBP", "JPY"], ...options });
  return parsed ? `${parsed.amount} ${parsed.from.code}>${parsed.to.code}` : null;
};

describe("parsing: conversions", () => {
  const table = [
    ["100 usd to eur", "100 USD>EUR"],
    ["100 USD TO EUR", "100 USD>EUR"],
    ["usd to eur", "1 USD>EUR"],
    ["eur/usd", "1 EUR>USD"],
    ["eur / usd", "1 EUR>USD"],
    ["100 dollars in euros", "100 USD>EUR"],
    ["convert 50 gbp to yen", "50 GBP>JPY"],
    ["how much is 20 euros", "20 EUR>USD"],
    ["how much is 20 euros in dollars", "20 EUR>USD"],
    ["what is 100 usd in eur", "100 USD>EUR"],
    ["20 eur", "20 EUR>USD"],
    ["20 usd", "20 USD>EUR"],
    ["100 dollars", "100 USD>EUR"],
    ["5 bucks", "5 USD>EUR"],
    ["100 yen", "100 JPY>USD"],
    ["$100 to eur", "100 USD>EUR"],
    ["$100", "100 USD>EUR"],
    ["€50 in usd", "50 EUR>USD"],
    ["100€ to usd", "100 EUR>USD"],
    ["£20 to usd", "20 GBP>USD"],
    ["¥1000 to usd", "1000 JPY>USD"],
    ["₹500 to usd", "500 INR>USD"],
    ["1,000.50 usd to eur", "1000.5 USD>EUR"],
    ["1.5 eur to gbp", "1.5 EUR>GBP"],
    ["20 canadian dollars to usd", "20 CAD>USD"],
    ["20 australian dollars to us dollars", "20 AUD>USD"],
    ["100 us dollars in pounds sterling", "100 USD>GBP"],
    ["50 pounds sterling to usd", "50 GBP>USD"],
    ["10 pesos in dollars", "10 MXN>USD"],
    ["10 rupees to usd", "10 INR>USD"],
    ["100 swiss francs to euros", "100 CHF>EUR"],
    ["100 reais to usd", "100 BRL>USD"],
    ["100 kronor to usd", "100 SEK>USD"],
    ["100 yuan to eur", "100 CNY>EUR"],
    ["100 renminbi to eur", "100 CNY>EUR"],
    ["usd to eur exchange rate", "1 USD>EUR"],
    ["usd to eur rate", "1 USD>EUR"],
    ["usd → eur", "1 USD>EUR"],
    ["100 usd -> eur", "100 USD>EUR"],
    ["convert 5 eur into gbp", "5 EUR>GBP"],
    ["currency converter usd to eur", "1 USD>EUR"],
  ];
  for (const [query, expected] of table) test(`${query} => ${expected}`, () => expect(summary(query)).toBe(expected));

  test("the dollarMeans setting decides what a plain dollar is", () => {
    const options = { dollarMeans: "CAD", homeCurrency: "EUR" };
    expect(summary("100 dollars to eur", options)).toBe("100 CAD>EUR");
    expect(summary("$5 to usd", options)).toBe("5 CAD>USD");
    expect(summary("100 us dollars to eur", options)).toBe("100 USD>EUR");
    expect(summary("5 us$ to eur", options)).toBe("5 USD>EUR");
    expect(summary("100 dollars", options)).toBe("100 CAD>EUR");
    expect(summary("100 eur", options)).toBe("100 EUR>GBP");
  });

  test("a lone amount goes to the home currency, or to the first other secondary currency", () => {
    expect(summary("20 eur", { homeCurrency: "GBP" })).toBe("20 EUR>GBP");
    expect(summary("20 eur", { homeCurrency: "EUR", secondary: ["EUR", "GBP"] })).toBe("20 EUR>GBP");
  });

  test("amounts: zero, huge or negative are refused", () => {
    expect(summary("0 usd to eur")).toBeNull();
    expect(summary("1e30 usd to eur")).toBeNull();
    expect(summary("99999999999999999999 usd to eur")).toBeNull();
  });
});

describe("parsing: crypto", () => {
  const table = [
    ["1 btc to usd", "1 BTC>USD"],
    ["bitcoin price", "1 BTC>USD"],
    ["btc", "1 BTC>USD"],
    ["bitcoin", "1 BTC>USD"],
    ["eth", "1 ETH>USD"],
    ["eth to eur", "1 ETH>EUR"],
    ["price of ethereum", "1 ETH>USD"],
    ["what is the price of bitcoin", "1 BTC>USD"],
    ["bitcoin price in eur", "1 BTC>EUR"],
    ["btc price", "1 BTC>USD"],
    ["0.5 eth to usd", "0.5 ETH>USD"],
    ["100 usd to btc", "100 USD>BTC"],
    ["1 eth to doge", "1 ETH>DOGE"],
    ["2 bitcoins to gbp", "2 BTC>GBP"],
    ["1 btc", "1 BTC>USD"],
    ["₿ to usd", "1 BTC>USD"],
    ["doge", "1 DOGE>USD"],
    ["100 sol to usd", "100 SOL>USD"],
    ["chainlink price", "1 LINK>USD"],
  ];
  for (const [query, expected] of table) test(`${query} => ${expected}`, () => expect(summary(query)).toBe(expected));

  test("kind is crypto when either side is", () => {
    expect(parseQuery("1 btc to eur").parsed.kind).toBe("crypto");
    expect(parseQuery("100 usd to eur").parsed.kind).toBe("fiat");
  });

  test("crypto off: nothing crypto parses", () => {
    for (const query of ["btc", "1 btc to usd", "bitcoin price", "100 usd to btc"]) expect(summary(query, { enableCrypto: false }), query).toBeNull();
    expect(summary("100 usd to eur", { enableCrypto: false })).toBe("100 USD>EUR");
  });

  test("coins from the live Coinbase list are known once it was fetched", () => {
    const known = new Set(["ZZZCOIN", "ONE", "LINK"]);
    expect(summary("zzzcoin price")).toBeNull();
    expect(summary("zzzcoin price", { crypto: known })).toBe("1 ZZZCOIN>USD");
    expect(summary("5 zzzcoin to usd", { crypto: known })).toBe("5 ZZZCOIN>USD");
    expect(summary("5 one to usd", { crypto: known })).toBe("5 ONE>USD");
    expect(summary("one to usd", { crypto: known })).toBeNull();
    expect(summary("link price", { crypto: known })).toBeNull();
    expect(summary("zzzcoin", { crypto: known })).toBeNull();
  });
});

describe("parsing: ambiguous English words", () => {
  const unambiguous = [
    ["100 try to usd", "100 TRY>USD"],
    ["50 all to usd", "50 ALL>USD"],
    ["convert try to usd", "1 TRY>USD"],
    ["100 usd in try", "100 USD>TRY"],
    ["20 pounds to usd", "20 GBP>USD"],
    ["20 won to usd", "20 KRW>USD"],
    ["20 pen to usd", "20 PEN>USD"],
    ["5 top to usd", "5 TOP>USD"],
    ["10 mad in eur", "10 MAD>EUR"],
    ["convert 20 pounds", "20 GBP>USD"],
  ];
  for (const [query, expected] of unambiguous) test(`${query} => ${expected}`, () => expect(summary(query)).toBe(expected));
  for (const query of ["try", "all", "try to usd", "all to usd", "20 pounds", "20 won", "20 all", "50 try", "top", "pen", "mad", "can", "lei", "one", "sat", "pound", "5 real", "mad/pen", "try/all", "eur try"]) {
    test(`not a conversion: ${query}`, () => expect(summary(query), query).toBeNull());
  }
  test("the reason says what to do", () => {
    expect(parseQuery("20 pounds").reason).toContain("ordinary word");
    expect(parseQuery("20 pounds").partial).toBe(true);
  });
});

describe("natural phrasings", () => {
  const table = [
    ["usd to euro", "1 USD>EUR"],
    ["usd to pound", "1 USD>GBP"],
    ["usd to pounds", "1 USD>GBP"],
    ["1 usd to pound", "1 USD>GBP"],
    ["1 usd to euro", "1 USD>EUR"],
    ["dollars to euros", "1 USD>EUR"],
    ["dollar to euro", "1 USD>EUR"],
    ["100 dollars in euros", "100 USD>EUR"],
    ["5 quid in dollars", "5 GBP>USD"],
    ["quid to dollars", "1 GBP>USD"],
    ["how much is 20 euros in dollars", "20 EUR>USD"],
    ["how much is 20 euros", "20 EUR>USD"],
    ["convert 50 gbp to usd", "50 GBP>USD"],
    ["usd in gbp", "1 USD>GBP"],
    ["usd/eur", "1 USD>EUR"],
    ["usd eur", "1 USD>EUR"],
    ["eur usd", "1 EUR>USD"],
    ["gbp jpy", "1 GBP>JPY"],
    ["btc usd", "1 BTC>USD"],
    ["euro to usd", "1 EUR>USD"],
    ["1 bitcoin to usd", "1 BTC>USD"],
    ["btc to eur", "1 BTC>EUR"],
    ["20 bucks to yen", "20 USD>JPY"],
    ["what is 100 yen in dollars", "100 JPY>USD"],
    ["what is the price of 100 yen in dollars", null],
    ["eur to usd rate", "1 EUR>USD"],
    ["usd to eur exchange rate", "1 USD>EUR"],
    ["usd to eur rate today", "1 USD>EUR"],
    ["exchange rate between usd and eur", "1 USD>EUR"],
    ["the exchange rate from gbp to usd", "1 GBP>USD"],
    ["what is the exchange rate of gbp to usd", "1 GBP>USD"],
    ["pound to dollar", "1 GBP>USD"],
    ["pounds to dollars", "1 GBP>USD"],
    ["pound sterling to usd", "1 GBP>USD"],
    ["sterling to euro", "1 GBP>EUR"],
    ["british pound to euro", "1 GBP>EUR"],
    ["canadian dollar to us dollar", "1 CAD>USD"],
    ["loonie to usd", "1 CAD>USD"],
    ["aussie dollar to kiwi dollar", "1 AUD>NZD"],
    ["won to usd", "1 KRW>USD"],
    ["real to usd", "1 BRL>USD"],
    ["rand to dollar", "1 ZAR>USD"],
    ["100 baht in dollars", "100 THB>USD"],
    ["ringgit to sgd", "1 MYR>SGD"],
    ["peso to usd", "1 MXN>USD"],
    ["argentine peso to usd", "1 ARS>USD"],
    ["swiss francs to euros", "1 CHF>EUR"],
    ["rupees to dollars", "1 INR>USD"],
    ["10 reais to dollars", "10 BRL>USD"],
    ["shekels to euro", "1 ILS>EUR"],
    ["dirham to usd", "1 AED>USD"],
    ["doge to usd", "1 DOGE>USD"],
    ["1 dogecoin to usd", "1 DOGE>USD"],
    ["ether to euro", "1 ETH>EUR"],
  ];
  for (const [query, expected] of table) test(`${query} => ${expected}`, () => expect(summary(query)).toBe(expected));

  test("the dollarMeans setting decides what a bare dollar is", () => {
    expect(summary("dollars to euros", { dollarMeans: "CAD" })).toBe("1 CAD>EUR");
    expect(summary("usd to dollars", { dollarMeans: "CAD" })).toBe("1 USD>CAD");
    expect(summary("canadian dollars to euros", { dollarMeans: "AUD" })).toBe("1 CAD>EUR");
  });

  test("only one currency side: not a conversion", () => {
    for (const query of ["usd to kg", "kg to usd", "usd to apples", "usd to", "to eur", "usd to xyz", "5 usd to km", "pound to kg", "pound to oz", "usd to pound cake"]) expect(summary(query), query).toBeNull();
  });

  test("a word that is also a code needs an amount, or 'convert'", () => {
    for (const query of ["usd to try", "try to usd", "all to usd", "usd to all", "can usd", "all usd", "mad usd", "usd top", "one usd"]) expect(summary(query), query).toBeNull();
    expect(summary("1 usd to try")).toBe("1 USD>TRY");
    expect(summary("convert usd to try")).toBe("1 USD>TRY");
  });

  test("two bare tokens are a pair only when both are real, non-word codes", () => {
    for (const query of ["usd foo", "hello usd", "usd dollar", "euro dollar", "usd 5", "usd usd", "pound dollar"]) expect(summary(query), query).toBeNull();
  });

  test("the reason names the ordinary word that stopped the match", () => {
    expect(parseQuery("try to usd").reason).toContain('"TRY"');
    expect(parseQuery("usd to pound cake").reason).toContain("not a currency");
    expect(parseQuery("won to won").reason).toBeTruthy();
  });
});

describe("the alias table", () => {
  test("every alias points at a code the provider serves", () => {
    for (const [code, names] of Object.entries(FIAT_ALIASES)) {
      expect(FIAT_CODES.has(code), code).toBe(true);
      expect(names.length, code).toBeGreaterThan(0);
    }
    for (const [name, code] of FIAT_NAMES) expect(code === "$" || FIAT_CODES.has(code), `${name} -> ${code}`).toBe(true);
  });

  test("every crypto alias points at a known crypto code", () => {
    for (const code of Object.keys(CRYPTO_ALIASES)) expect(STARTER_CRYPTO.has(code), code).toBe(true);
    for (const [name, code] of CRYPTO_NAMES) expect(STARTER_CRYPTO.has(code), `${name} -> ${code}`).toBe(true);
  });

  test("names are lower case and not listed for two currencies", () => {
    const seen = new Map();
    for (const [code, names] of Object.entries(FIAT_ALIASES)) {
      for (const name of names) {
        expect(name, name).toBe(name.toLowerCase());
        expect(seen.has(name) && seen.get(name) !== code, `${name} is listed for ${seen.get(name)} and ${code}`).toBe(false);
        seen.set(name, code);
      }
    }
  });

  test("every currency the provider serves has at least one name", () => {
    const named = new Set([...FIAT_NAMES.values()]);
    expect([...FIAT_CODES].filter((code) => !named.has(code))).toEqual([]);
  });

  test("every alias resolves to its code, alone and as a plural where it is a plain noun", () => {
    for (const [name, code] of FIAT_NAMES) {
      const resolved = resolveCurrency(name, { dollarMeans: "USD" });
      expect(resolved?.code, name).toBe(code === "$" ? "USD" : code);
    }
    for (const name of ["euro", "yen", "dollar", "peso", "rupee", "baht", "franc", "shekel", "dirham", "ringgit", "zloty", "forint", "krone"]) {
      expect(resolveCurrency(`${name}s`)?.code, `${name}s`).toBe(resolveCurrency(name)?.code);
    }
  });

  test("the colloquial words", () => {
    for (const [text, code] of [["bucks", "USD"], ["buck", "USD"], ["greenbacks", "USD"], ["quid", "GBP"], ["sterling", "GBP"], ["loonies", "CAD"], ["aussie", "AUD"], ["kiwi", "NZD"], ["renminbi", "CNY"], ["rmb", "CNY"], ["yuan", "CNY"], ["rupees", "INR"], ["pesos", "MXN"], ["francs", "CHF"], ["reais", "BRL"], ["rand", "ZAR"], ["roubles", "RUB"], ["lira", "TRY"], ["naira", "NGN"], ["cedis", "GHS"], ["rupiah", "IDR"], ["dong", "VND"], ["won", "KRW"], ["riyals", "SAR"], ["rials", "IRR"], ["zlotys", "PLN"], ["hryvnia", "UAH"], ["bitcoins", "BTC"], ["doge", "DOGE"], ["ether", "ETH"], ["ethereum", "ETH"]]) {
      expect(resolveCurrency(text)?.code, text).toBe(code);
    }
  });

  test("qualified pesos, kronor and dinars", () => {
    for (const [text, code] of [["argentine peso", "ARS"], ["colombian pesos", "COP"], ["chilean peso", "CLP"], ["philippine peso", "PHP"], ["swedish krona", "SEK"], ["norwegian kroner", "NOK"], ["danish krone", "DKK"], ["kuwaiti dinar", "KWD"], ["serbian dinars", "RSD"], ["swiss franc", "CHF"], ["hong kong dollars", "HKD"], ["singapore dollar", "SGD"], ["new zealand dollars", "NZD"]]) {
      expect(resolveCurrency(text)?.code, text).toBe(code);
    }
  });
});

describe("parsing: things that are not currency questions", () => {
  const negatives = [
    "", " ", "2+2", "100", "2026", "usd", "eur", "euro", "dollar", "pounds", "euro 2024", "euro truck simulator", "bitcoin news", "btc wallet", "bitcoin mining", "ethereum merge",
    "what is love", "iphone 15", "20 apples", "5 + 5 usd", "10 percent of 100", "15% of 80", "5 km to miles", "5 km to usd", "100 usd to kg", "100 pounds to kg", "10 kg to lb",
    "255 in hex", "3 x 4", "usd to xyz", "xyz to usd", "100 usd to usd", "20 eur to eur", "and/or", "w/o", "n/a", "1/2", "24/7", "100 usd to", "to eur", "https://example.com/usd", "me@usd.com",
    "convert", "convert 5", "currency", "exchange", "how much is", "how much is it", "weather in usa", "dollar tree", "pound cake", "yen for", "xrp lawsuit", "sol", "eth wallet", "doge meme",
  ];
  for (const query of negatives) test(`negative: ${JSON.stringify(query)}`, () => expect(summary(query), query).toBeNull());

  test("pure math never triggers", () => {
    for (const query of ["1+1", "2 * 3", "sqrt(16)", "5!", "2^10", "100/4"]) expect(parseQuery(query).parsed).toBeNull();
  });

  test("long and hostile input never throws", () => {
    for (const query of ["a".repeat(500), "$".repeat(100), "1,".repeat(50), "\u0000", "💥", "usd to ".repeat(30), "100 ".repeat(40)]) expect(() => parseQuery(query)).not.toThrow();
  });
});

describe("resolveCurrency", () => {
  test("codes, names, plurals and symbols", () => {
    for (const [text, code] of [["eur", "EUR"], ["EUR", "EUR"], ["euros", "EUR"], ["Euro", "EUR"], ["canadian dollars", "CAD"], ["pesos", "MXN"], ["reais", "BRL"], ["kroner", "DKK"], ["krona", "SEK"], ["yen", "JPY"], ["¥", "JPY"], ["€", "EUR"], ["£", "GBP"], ["₹", "INR"], ["₩", "KRW"], ["₽", "RUB"], ["₺", "TRY"], ["rmb", "CNY"], ["zloty", "PLN"], ["shekels", "ILS"], ["dirhams", "AED"], ["rand", "ZAR"], ["rubles", "RUB"], ["francs", "CHF"]]) {
      expect(resolveCurrency(text)?.code, text).toBe(code);
    }
    expect(resolveCurrency("$").code).toBe("USD");
    expect(resolveCurrency("$", { dollarMeans: "AUD" }).code).toBe("AUD");
    expect(resolveCurrency("xyz")).toBeNull();
    expect(resolveCurrency("")).toBeNull();
    expect(resolveCurrency("x".repeat(100))).toBeNull();
    expect(resolveCurrency("btc").kind).toBe("crypto");
    expect(resolveCurrency("bitcoin").kind).toBe("crypto");
    expect(resolveCurrency("pound").wordlike).toBe(true);
    expect(resolveCurrency("eur").wordlike).toBe(false);
    expect(resolveCurrency("try").wordlike).toBe(true);
  });

  test("every code the provider serves is known to the parser", () => {
    expect(FIAT_CODES.size).toBe(166);
    for (const code of Object.keys(JSON.parse(ER).rates)) expect(FIAT_CODES.has(code), code).toBe(true);
    for (const code of FIAT_CODES) expect(resolveCurrency(code.toLowerCase())?.code, code).toBe(code);
  });
});

describe("provider replies", () => {
  test("fiat", () => {
    const parsed = parseFiat(ER);
    expect(parsed.rates.EUR).toBe(0.9132);
    expect(parsed.rates.USD).toBe(1);
    expect(parsed.updated).toBe(1793145752 * 1000);
    expect(parsed.next).toBe(1793233322 * 1000);
    for (const bad of ["", "nope", "[]", "{}", '{"result":"error"}', '{"result":"success","rates":{}}', '{"result":"success","rates":[1,2]}']) expect(parseFiat(bad)).toBeNull();
    const dirty = JSON.parse(ER);
    dirty.rates.EUR = "0.9";
    dirty.rates.XXX = -1;
    dirty.rates.lower = 3;
    dirty.rates.NAN = null;
    const cleaned = parseFiat(JSON.stringify(dirty));
    expect(cleaned.rates.EUR).toBeUndefined();
    expect(cleaned.rates.XXX).toBeUndefined();
    expect(cleaned.rates.lower).toBeUndefined();
    expect(cleaned.rates.GBP).toBe(0.7741);
  });

  test("coinbase spot, stats and list", () => {
    expect(parseSpot(SPOT)).toBe(64250.5);
    for (const bad of ["", "x", "{}", '{"data":{}}', '{"data":{"amount":"-1"}}', '{"data":{"amount":"abc"}}', '{"data":{"amount":0}}']) expect(parseSpot(bad)).toBeNull();
    expect(parseStats(STATS)).toEqual({ last: 64250.5, open: 62800, high: 65100, low: 62100.5, volume: 10432.1875 });
    for (const bad of ["", "[]", "{}", '{"last":"1"}', '{"open":"1","high":"1","low":"2","last":"1"}', '{"open":"x","high":"1","low":"1","last":"1"}']) expect(parseStats(bad)).toBeNull();
    expect(parseStats('{"open":"1","high":"2","low":"1","last":"1.5"}').volume).toBe(0);
    const list = parseList(LIST);
    expect(list.map(([code]) => code)).toContain("ZZZCOIN");
    expect(list.find(([code]) => code === "BTC")[1]).toBe("Bitcoin");
    for (const bad of ["", "{}", '{"data":{}}', '{"data":[]}', '{"data":[{"code":5}]}', '{"data":[{"code":"bad code!"}]}']) expect(parseList(bad)).toBeNull();
  });
});

describe("conversion maths and number formatting", () => {
  const rates = JSON.parse(ER).rates;
  const fiat = (code) => ({ code, kind: "fiat" });
  const crypto = (code) => ({ code, kind: "crypto" });

  test("cross rates are computed locally through USD", () => {
    expect(rateBetween(fiat("USD"), fiat("EUR"), { rates })).toBeCloseTo(0.9132, 10);
    expect(rateBetween(fiat("EUR"), fiat("USD"), { rates })).toBeCloseTo(1 / 0.9132, 10);
    expect(rateBetween(fiat("EUR"), fiat("GBP"), { rates })).toBeCloseTo(0.7741 / 0.9132, 10);
    expect(rateBetween(fiat("EUR"), fiat("XXX"), { rates })).toBeNull();
    expect(rateBetween(crypto("BTC"), fiat("USD"), { rates, spots: { BTC: 64250.5 } })).toBe(64250.5);
    expect(rateBetween(crypto("BTC"), fiat("EUR"), { rates, spots: { BTC: 64250.5 } })).toBeCloseTo(64250.5 * 0.9132, 6);
    expect(rateBetween(fiat("EUR"), crypto("BTC"), { rates, spots: { BTC: 64250.5 } })).toBeCloseTo(1 / (64250.5 * 0.9132), 12);
    expect(rateBetween(crypto("ETH"), crypto("BTC"), { rates, spots: { BTC: 64250.5, ETH: 3120.75 } })).toBeCloseTo(3120.75 / 64250.5, 12);
    expect(rateBetween(crypto("ETH"), fiat("USD"), { rates, spots: {} })).toBeNull();
  });

  test("a result has the secondary grid, without the two currencies of the pair", () => {
    const parsed = { amount: 100, from: fiat("USD"), to: fiat("EUR"), kind: "fiat" };
    const result = buildResult({ parsed, rates, secondary: ["EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "SEK"], updated: 1 });
    expect(result.converted).toBeCloseTo(91.32, 10);
    expect(result.grid.map((cell) => cell.code)).toEqual(["GBP", "JPY", "CAD", "AUD", "CHF"]);
    expect(result.grid[0].value).toBeCloseTo(77.41, 10);
    expect(buildResult({ parsed: { ...parsed, to: fiat("XXX") }, rates })).toBeNull();
  });

  test("crypto results carry the 24 h figures in the fiat currency of the pair", () => {
    const parsed = { amount: 1, from: crypto("BTC"), to: fiat("EUR"), kind: "crypto" };
    const result = buildResult({ parsed, rates, spots: { BTC: 64250.5 }, stats: { last: 64250.5, open: 62800, high: 65100, low: 62100.5, volume: 10432.1875 } });
    expect(result.crypto.change).toBeCloseTo((64250.5 - 62800) / 62800, 10);
    expect(result.crypto.fiat).toBe("EUR");
    expect(result.crypto.high).toBeCloseTo(65100 * 0.9132, 6);
    expect(result.crypto.low).toBeCloseTo(62100.5 * 0.9132, 6);
    expect(result.usesCoinbase).toBe(true);
    expect(result.usesFiat).toBe(true);
    const usd = buildResult({ parsed: { ...parsed, to: fiat("USD") }, rates: { USD: 1 }, spots: { BTC: 64250.5 } });
    expect(usd.usesFiat).toBe(false);
    expect(usd.crypto.change).toBeUndefined();
  });

  test("money formatting", () => {
    expect(formatMoney(89.8199)).toBe("89.82");
    expect(formatMoney(1234567.891)).toBe("1,234,567.89");
    expect(formatMoney(0.0345)).toBe("0.0345");
    expect(formatMoney(0.000012)).toBe("0.000012");
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney(1.5, { decimals: 4 })).toBe("1.5000");
    expect(formatMoney(1.5, { decimals: 99 })).toBe("1.50");
    expect(formatMoney(0.01554, { kind: "crypto" })).toBe("0.01554");
    expect(formatMoney(0.00000123, { kind: "crypto" })).toBe("0.00000123");
    expect(formatMoney(1.5, { kind: "crypto" })).toBe("1.5");
    expect(formatMoney(64250.5, { kind: "crypto" })).toBe("64,250.50");
    expect(formatMoney(Number.NaN)).toBe("—");
    expect(formatMoney(-5.5)).toBe("-5.50");
  });

  test("rates and percents", () => {
    expect(formatRate(0.9132)).toBe("0.9132");
    expect(formatRate(1 / 0.9132)).toBe("1.0951");
    expect(formatRate(151.2)).toBe("151.20");
    expect(formatRate(64250.5)).toBe("64,250.50");
    expect(formatRate(0.00001554)).toBe("0.00001554");
    expect(formatPercent(0.023096)).toBe("2.31%");
    expect(formatPercent(-0.0121)).toBe("1.21%");
  });

  test("timestamps", () => {
    expect(formatStamp(Date.parse("2026-10-28T00:02:32Z"))).toMatch(/2026/);
    expect(formatStamp(0)).toBe("");
    expect(formatStamp(Number.NaN)).toBe("");
  });
});

describe("fiat rates: one request, cached, persisted", () => {
  const rates = (time, overrides) => {
    const w = world(overrides);
    const slot = makeSlot({}, { time });
    return { w, slot, fiat: slot.fiat, context: { fetch: w.fetch } };
  };
  const ask = (fiat, context, time) => fiat.get({ context, deadline: time.state.t + 7000 });

  test("the first call fetches USD once; later calls come from the cache", async () => {
    const time = clock();
    const { w, fiat, context } = rates(time);
    const first = await ask(fiat, context, time);
    expect(first.rates.EUR).toBe(0.9132);
    expect(first.stale).toBe(false);
    for (let i = 0; i < 5; i += 1) await ask(fiat, context, time);
    expect(w.count("er")).toBe(1);
    expect(w.calls[0].path).toBe("/v6/latest/USD");
    expect(w.calls[0].headers["User-Agent"]).toBe(USER_AGENT);
  });

  test("concurrent callers share one request", async () => {
    const time = clock();
    const { w, fiat, context } = rates(time);
    await Promise.all([ask(fiat, context, time), ask(fiat, context, time), ask(fiat, context, time)]);
    expect(w.count("er")).toBe(1);
  });

  test("no refresh before the provider's next update, however old the data is (up to 7 days)", async () => {
    const time = clock(1793145752 * 1000 + 60_000);
    const { w, fiat, context } = rates(time);
    await ask(fiat, context, time);
    time.state.t += RATES_TTL_MS + 3_600_000; // 7 h later, but the next update is at +24 h
    await ask(fiat, context, time);
    expect(w.count("er")).toBe(1);
    time.state.t = 1793233322 * 1000 + 1000; // past the next update time
    await ask(fiat, context, time);
    expect(w.count("er")).toBe(2);
  });

  test("a stale copy is used when the refresh fails, for up to 7 days", async () => {
    const time = clock(1793145752 * 1000 + 60_000);
    let fail = false;
    const { w, fiat, context } = rates(time, { er: () => (fail ? new Response("down", { status: 500 }) : null) });
    await ask(fiat, context, time);
    fail = true;
    time.state.t += 2 * 86_400_000;
    let stale;
    await capture(async () => {
      stale = await ask(fiat, context, time);
    });
    expect(stale.stale).toBe(true);
    expect(stale.rates.GBP).toBe(0.7741);
    expect(w.count("er")).toBe(2);
    time.state.t += 6 * 86_400_000; // 8 days old now
    fiat.upstream.pausedUntil = 0;
    await capture(async () => expect(await ask(fiat, context, time)).toBeNull());
    expect(STALE_MAX_MS).toBe(7 * 86_400_000);
  });

  test("429 pauses for Retry-After (20 minutes by default, one hour at most), 401/403 for 30 minutes, 5xx for a minute", async () => {
    const check = async (response, minutes) => {
      const time = clock();
      const { w, fiat, context } = rates(time, { er: () => response });
      const lines = await capture(async () => {
        expect(await ask(fiat, context, time)).toBeNull();
        expect(await ask(fiat, context, time)).toBeNull();
      });
      expect(w.count("er")).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`paused for ${minutes} min`);
      expect(lines[0]).not.toContain("http");
      time.state.t += minutes * 60_000 + 1000;
      return { w, fiat, context, time };
    };
    await check(new Response("", { status: 429 }), 20);
    await check(new Response("", { status: 429, headers: { "retry-after": "120" } }), 2);
    await check(new Response("", { status: 429, headers: { "retry-after": "999999" } }), 60);
    await check(new Response("", { status: 403 }), 30);
    await check(new Response("", { status: 401 }), 30);
    await check(new Response("", { status: 503 }), 1);
    const again = await check(new Response("", { status: 500 }), 1);
    const healthy = world();
    expect((await ask(again.fiat, { fetch: healthy.fetch }, again.time)).rates.EUR).toBe(0.9132);
  });

  test("a network error pauses for a minute; an unreadable reply too", async () => {
    const time = clock();
    const { fiat, context } = rates(time, { er: () => { throw new Error("boom https://secret.example/x"); } });
    const lines = await capture(async () => expect(await ask(fiat, context, time)).toBeNull());
    expect(lines.join("")).not.toContain("secret");
    expect(fiat.upstream.paused).toBe(true);
    const time2 = clock();
    const bad = rates(time2, { er: () => new Response('{"result":"success","rates":{}}') });
    await capture(async () => expect(await ask(bad.fiat, bad.context, time2)).toBeNull());
    expect(bad.fiat.upstream.paused).toBe(true);
  });

  test("the daily budget stops requests and is not spent by cache hits", async () => {
    const time = clock();
    const { w, slot, fiat, context } = rates(time);
    slot.configure({ dailyRequestLimit: "1" });
    await ask(fiat, context, time);
    await ask(fiat, context, time);
    expect(w.count("er")).toBe(1);
    expect(fiat.budget.used).toBe(1);
    // cap 1 and another day: the budget starts again
    time.state.t += 86_400_000 * 9;
    expect(fiat.budget.exhausted).toBe(false);
    const capped = rates(clock());
    capped.slot.configure({ dailyRequestLimit: "0" });
    expect(capped.fiat.budget.cap).toBe(0);
  });

  test("the rates survive a restart through data/currency/rates.json", async () => {
    const folder = mkdtempSync(join(tmpdir(), "currency-test-"));
    try {
      const file = join(folder, "currency", "rates.json");
      const time = clock();
      const first = rates(time);
      first.fiat.file = file;
      await ask(first.fiat, first.context, time);
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")).rates.EUR).toBe(0.9132);
      expect(readFileSync(file, "utf8")).not.toContain("authorization");
      const second = rates(time);
      second.fiat.file = file;
      const got = await ask(second.fiat, second.context, time);
      expect(got.rates.EUR).toBe(0.9132);
      expect(second.w.count("er")).toBe(0);
      writeFileSync(file, "{ not json");
      const third = rates(time);
      third.fiat.file = file;
      await ask(third.fiat, third.context, time);
      expect(third.w.count("er")).toBe(1);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test("the usage count is written atomically per day", () => {
    const folder = mkdtempSync(join(tmpdir(), "currency-test-"));
    try {
      const file = join(folder, "deep", "usage.json");
      const budget = new Budget({ file, cap: 2, now: () => Date.parse("2026-10-28T10:00:00Z") });
      expect(budget.spend()).toBe(true);
      expect(budget.spend()).toBe(true);
      expect(budget.spend()).toBe(false);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-10-28", used: 2 });
      expect(existsSync(`${file}.tmp`)).toBe(false);
      const reload = new Budget({ file, cap: 2, now: () => Date.parse("2026-10-28T23:00:00Z") });
      expect(reload.exhausted).toBe(true);
      const nextDay = new Budget({ file, cap: 2, now: () => Date.parse("2026-10-29T00:00:01Z") });
      expect(nextDay.exhausted).toBe(false);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("Coinbase", () => {
  const make = (overrides, time = clock()) => {
    const w = world(overrides);
    const slot = makeSlot({}, { time });
    return { w, slot, cb: slot.coinbase, context: { fetch: w.fetch }, time, deadline: time.state.t + 7000 };
  };

  test("spot is cached for 30 s, stats for 5 minutes, the list for a day", async () => {
    const { w, cb, context, time, deadline } = make();
    expect(await cb.spot("BTC", { context, deadline })).toBe(64250.5);
    await cb.spot("BTC", { context, deadline });
    expect(w.count("spot")).toBe(1);
    time.state.t += 31_000;
    await cb.spot("BTC", { context, deadline: time.state.t + 7000 });
    expect(w.count("spot")).toBe(2);

    const fresh = () => ({ context, deadline: time.state.t + 7000 });
    expect((await cb.stats("BTC", fresh()))?.high).toBe(65100);
    await cb.stats("BTC", fresh());
    expect(w.count("stats")).toBe(1);
    time.state.t += 301_000;
    await cb.stats("BTC", fresh());
    expect(w.count("stats")).toBe(2);

    const list = await cb.list(fresh());
    expect(list.get("BTC")).toBe("Bitcoin");
    await cb.list(fresh());
    expect(w.count("list")).toBe(1);
    expect(cb.codes.has("ZZZCOIN")).toBe(true);
    time.state.t += 25 * 3_600_000;
    await cb.list(fresh());
    expect(w.count("list")).toBe(2);
  });

  test("the paths carry only the coin code; nothing else is sent", async () => {
    const { w, cb, context, deadline } = make();
    await cb.spot("BTC", { context, deadline });
    await cb.stats("BTC", { context, deadline });
    expect(w.calls.map((c) => c.path)).toEqual(["/v2/prices/BTC-USD/spot", "/products/BTC-USD/stats"]);
    expect(w.calls[0].url).not.toContain("?");
    for (const call of w.calls) expect(Object.keys(call.headers).sort()).toEqual(["Accept", "User-Agent"]);
    expect(await cb.spot("btc/../x", { context, deadline })).toBeNull();
    expect(await cb.spot("B", { context, deadline })).toBeNull();
    expect(w.calls).toHaveLength(2);
  });

  test("a coin without a USD product is not an error and is remembered", async () => {
    const { w, cb, context, deadline } = make({ stats: () => new Response("{}", { status: 404 }) });
    expect(await cb.stats("ZZZ", { context, deadline })).toBeNull();
    expect(await cb.stats("ZZZ", { context, deadline })).toBeNull();
    expect(w.count("stats")).toBe(1);
    expect(cb.statsUpstream.paused).toBe(false);
  });

  test("each upstream pauses on its own", async () => {
    const { w, cb, context, deadline } = make({ stats: () => new Response("", { status: 500 }), spot: (u, n) => (n === 99 ? null : null) });
    await capture(async () => expect(await cb.stats("BTC", { context, deadline })).toBeNull());
    expect(cb.statsUpstream.paused).toBe(true);
    expect(await cb.spot("BTC", { context, deadline })).toBe(64250.5);
    expect(cb.spotUpstream.paused).toBe(false);
    await cb.stats("BTC", { context, deadline });
    expect(w.count("stats")).toBe(1);
  });

  test("429 on prices pauses for Retry-After with one warning", async () => {
    const { w, cb, context, deadline } = make({ spot: () => new Response("", { status: 429, headers: { "retry-after": "45" } }) });
    const lines = await capture(async () => {
      expect(await cb.spot("BTC", { context, deadline })).toBeNull();
      expect(await cb.spot("ETH", { context, deadline })).toBeNull();
    });
    expect(w.count("spot")).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("paused for 1 min");
  });
});

describe("the slot", () => {
  const ctx = (w) => ({ fetch: w.fetch });
  const run = async (query, settings = {}, overrides = {}) => {
    const w = world(overrides);
    const slot = makeSlot(settings);
    const result = await slot.execute(query, ctx(w));
    return { w, slot, result, html: result.html };
  };

  test("a fiat conversion: one request, the card, the attribution", async () => {
    const { w, html, result } = await run("100 usd to eur");
    expect(w.count("er")).toBe(1);
    expect(w.count("spot") + w.count("stats") + w.count("list")).toBe(0);
    expect(result.title).toBe("");
    expect(html.startsWith('<div class="command-result currency-result">')).toBe(true);
    expect(html).toContain("Currency · USD → EUR");
    expect(html).toContain("100 USD =");
    expect(html).toContain(">91.32<");
    expect(html).toContain("1 USD = 0.9132 EUR");
    expect(html).toContain("1 EUR = 1.0951 USD");
    expect(html).toContain('<a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a>');
    expect(html).toContain("currency-grid");
    for (const code of ["GBP", "JPY", "CAD", "AUD"]) expect(html).toContain(`>${code}<`);
    expect(html).toContain("Swap");
    expect(html).toContain(`search?q=${encodeURIComponent("100 EUR to USD")}`);
    expect(html).not.toContain("Coinbase");
  });

  test("a second query is served from the cache", async () => {
    const w = world();
    const slot = makeSlot();
    await slot.execute("100 usd to eur", ctx(w));
    await slot.execute("5 gbp to jpy", ctx(w));
    await slot.execute("eur/usd", ctx(w));
    expect(w.count("er")).toBe(1);
  });

  test("a crypto price: spot, stats and the list, Coinbase attribution, change with an arrow", async () => {
    const { w, html } = await run("btc");
    expect(w.count("spot")).toBe(1);
    expect(w.count("stats")).toBe(1);
    expect(w.count("list")).toBe(1);
    expect(w.count("er")).toBe(0);
    expect(html).toContain("Crypto · BTC → USD");
    expect(html).toContain("64,250.50");
    expect(html).toContain("currency-change--up");
    expect(html).toContain("2.31%");
    expect(html).toContain("<svg");
    expect(html).toContain("currency-range");
    expect(html).toContain("Prices from");
    expect(html).toContain("Coinbase");
    expect(html).not.toContain("Exchange Rate API");
    expect(html).not.toContain("currency-grid");
  });

  test("crypto into another fiat currency goes through the fiat rates", async () => {
    const { w, html } = await run("1 btc to eur");
    expect(w.count("er")).toBe(1);
    expect(html).toContain((64250.5 * 0.9132).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(html).toContain("Coinbase");
    expect(html).toContain("Exchange Rate API");
  });

  test("fiat into crypto and crypto into crypto", async () => {
    const a = await run("1000 usd to btc");
    expect(a.html).toContain("0.01556");
    const b = await run("1 eth to doge");
    expect(b.w.count("spot")).toBe(2);
    expect(b.w.count("stats")).toBe(0);
    expect(b.html).toContain("Crypto · ETH → DOGE");
  });

  test("without a stats product the card still shows the price", async () => {
    const { html } = await run("btc", {}, { stats: () => new Response("{}", { status: 404 }) });
    expect(html).toContain("64,250.50");
    expect(html).not.toContain("currency-range");
    expect(html).not.toContain("currency-change");
  });

  test("no price: no card", async () => {
    const { result } = await run("btc", {}, { spot: () => new Response("{}", { status: 404 }) });
    expect(result).toEqual({ title: "", html: "" });
  });

  test("without fiat rates a crypto card falls back to USD; a fiat conversion shows nothing", async () => {
    const down = { er: () => new Response("", { status: 500 }) };
    const a = await capture(async () => {});
    expect(a).toEqual([]);
    let html = "";
    let none = null;
    await capture(async () => {
      html = (await run("1 btc to eur", {}, down)).html;
      none = (await run("100 usd to eur", {}, down)).result;
    });
    expect(html).toContain("BTC → USD");
    expect(none).toEqual({ title: "", html: "" });
  });

  test("stale rates are labelled", async () => {
    const time = clock(1793145752 * 1000 + 60_000);
    const w = world();
    const slot = makeSlot({}, { time });
    await slot.execute("100 usd to eur", ctx(w));
    time.state.t += 2 * 86_400_000;
    const down = world({ er: () => new Response("", { status: 500 }) });
    let html = "";
    await capture(async () => {
      html = (await slot.execute("100 usd to eur", ctx(down))).html;
    });
    expect(html).toContain("could not refresh");
    expect(html).toContain("91.32");
  });

  test("layouts: position, size and content differ", async () => {
    const inline = makeSlot({ layout: "inline" });
    const panel = makeSlot({ layout: "panel" });
    expect(inline.position).toBe(INLINE_POSITION);
    expect(panel.position).toBe(PANEL_POSITION);
    const w = world();
    for (const query of ["100 usd to eur", "btc"]) {
      const a = (await inline.execute(query, ctx(w))).html;
      const b = (await panel.execute(query, ctx(w))).html;
      expect(a).toContain("currency-card--inline");
      expect(b).toContain("currency-card--panel");
      expect(a.length, query).toBeGreaterThan(b.length);
      expect(b).not.toContain("currency-grid");
      expect(b).not.toContain("Swap");
      expect(b).toContain(query === "btc" ? "Coinbase" : "Exchange Rate API");
    }
    expect(inline.slotPositions).toBeUndefined();
  });

  test("the home currency, secondary currencies and decimals come from the settings", async () => {
    const { html } = await run("20 eur", { homeCurrency: "GBP", secondaryCurrencies: "JPY, CHF", decimals: "4" });
    expect(html).toContain("Currency · EUR → GBP");
    expect(html).toContain(">16.9536<");
    expect(html).toContain("20 EUR =");
    expect(html).toContain(">JPY<");
    expect(html).toContain(">CHF<");
    expect(html).not.toContain(">CAD<");
    const canadian = await run("100 dollars to eur", { dollarMeans: "CAD" });
    expect(canadian.html).toContain("CAD → EUR");
  });

  test("crypto can be turned off", async () => {
    const slot = makeSlot({ enableCrypto: "false" });
    expect(slot.trigger("btc")).toBe(false);
    expect(slot.trigger("100 usd to eur")).toBe(true);
  });

  test("an unknown coin from the live list works after the list was fetched", async () => {
    const w = world();
    const slot = makeSlot();
    expect(slot.trigger("zzzcoin price")).toBe(false);
    await slot.execute("btc", ctx(w));
    expect(slot.trigger("zzzcoin price")).toBe(true);
  });

  test("hostile text cannot reach the html", () => {
    const parsed = { amount: 1, from: { code: '<img src=x onerror="alert(1)">', kind: "fiat" }, to: { code: "EUR", kind: "fiat" }, kind: "fiat" };
    const result = buildResult({ parsed, rates: { USD: 1, EUR: 0.9, '<img src=x onerror="alert(1)">': 2 }, secondary: [] });
    const html = buildCard(result, { layout: "inline" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img");
  });

  test("every link in a card is one of ours", async () => {
    const { html } = await run("1 btc to eur");
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    for (const href of links) expect(/^(https:\/\/www\.(exchangerate-api|coinbase)\.com|search\?q=)/.test(href), href).toBe(true);
  });

  test("a request that is too slow for the slot gives up, and the reply is cached for the next search", async () => {
    const slot = makeSlot();
    slot.answerWindowMs = 120;
    const gate = Promise.withResolvers();
    const w = world({ er: async () => { await gate.promise; return null; } });
    const first = await slot.execute("100 usd to eur", ctx(w));
    expect(first).toEqual({ title: "", html: "" });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    slot.answerWindowMs = 5000;
    const second = await slot.execute("100 usd to eur", ctx(w));
    expect(second.html).toContain("91.32");
    expect(w.count("er")).toBe(1);
  });

  test("no request is started after 70 % of the slot time", async () => {
    const time = clock();
    const w = world();
    const slot = makeSlot({}, { time });
    slot.startWindowMs = -1;
    const result = await slot.execute("100 usd to eur", ctx(w));
    expect(result).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
  });

  test("never throws", async () => {
    const slot = makeSlot();
    for (const query of ["", "usd to", "100 usd to eur", null, undefined]) {
      await capture(async () => {
        expect(await slot.execute(query, { fetch: async () => { throw new Error("x"); } })).toBeDefined();
        expect(await slot.execute(query, undefined)).toBeDefined();
      });
      expect(() => slot.trigger(query)).not.toThrow();
    }
  });
});

describe("settings", () => {
  test("clamping and defaults", () => {
    expect(decimalsFrom("auto")).toBe("auto");
    expect(decimalsFrom("1")).toBe(2);
    expect(decimalsFrom("99")).toBe(8);
    expect(decimalsFrom("5")).toBe(5);
    expect(decimalsFrom(undefined)).toBe("auto");
    expect(layoutFrom("PANEL")).toBe("panel");
    expect(layoutFrom("x")).toBe("inline");
    expect(codeFrom("eur", "USD")).toBe("EUR");
    expect(codeFrom("nope", "USD")).toBe("USD");
    expect(codeFrom("btc", "USD")).toBe("USD");
    expect(codesFrom("eur, gbp;  jpy eur xxx", ["USD"])).toEqual(["EUR", "GBP", "JPY"]);
    expect(codesFrom("", ["USD"])).toEqual(["USD"]);
    expect(codesFrom("nonsense", ["USD"])).toEqual(["USD"]);
    expect(codesFrom(Array(20).fill("EUR").join(","), ["USD"])).toEqual(["EUR"]);
  });

  test("the schema", () => {
    expect(SETTINGS_SCHEMA.map((f) => f.key)).toEqual(["layout", "decimals", "homeCurrency", "secondaryCurrencies", "dollarMeans", "enableCrypto", "dailyRequestLimit", "debugMatching"]);
    const layout = SETTINGS_SCHEMA.find((f) => f.key === "layout");
    expect(layout).toMatchObject({ default: "inline", options: ["inline", "panel"] });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "dailyRequestLimit")).toMatchObject({ default: "24", advanced: true });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "debugMatching")).toMatchObject({ default: "false", advanced: true });
    expect(SETTINGS_SCHEMA.some((f) => f.required)).toBe(false);
    expect(SETTINGS_SCHEMA.every((f) => typeof f.fieldset === "string")).toBe(true);
  });

  test("the daily limit reaches the budget", () => {
    const slot = makeSlot({ dailyRequestLimit: "7" });
    expect(slot.fiat.budget.cap).toBe(7);
    slot.configure({ dailyRequestLimit: "abc" });
    expect(slot.fiat.budget.cap).toBe(24);
    slot.configure({ dailyRequestLimit: "0" });
    expect(slot.fiat.budget.cap).toBe(0);
  });
});

describe("debugMatching", () => {
  test("off by default: nothing is logged", async () => {
    const slot = makeSlot();
    const w = world();
    const lines = await capture(async () => {
      slot.trigger("20 pounds");
      await slot.execute("100 usd to eur", { fetch: w.fetch });
    });
    expect(lines).toEqual([]);
  });

  test("on: one block per decision, and the rejecting rule for currency-like queries", async () => {
    const slot = makeSlot({ debugMatching: "true" });
    const w = world();
    const rejected = await capture(async () => {
      expect(slot.trigger("20 pounds")).toBe(false);
      expect(slot.trigger("hello world")).toBe(false);
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("ordinary word");
    const accepted = await capture(async () => {
      await slot.execute("100 usd to eur", { fetch: w.fetch });
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toContain("fiat 100 USD -> EUR");
    expect(accepted[0]).toContain("verdict: card shown");
    expect(accepted[0]).toContain("rule: amount first");
    expect(accepted[0]).not.toContain("http");
  });
});

describe("one menu entry", () => {
  test("the module exports a slot and no bang command (a command would add a second entry to degoog's plugin list)", async () => {
    const mod = await import("../plugins/currency/index.js");
    expect(mod.slot).toBe(sharedSlot);
    expect("command" in mod).toBe(false);
    expect("default" in mod).toBe(false);
  });
});
