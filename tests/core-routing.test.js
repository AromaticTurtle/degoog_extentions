// Routing between the core slot plugins (calculator, currency, dictionary, weather, stocks): each query belongs to at most one of
// them.
//   - the calculator never takes currency codes or names
//   - the currency plugin never takes pure math or non-currency units
//   - the dictionary only answers with an explicit dictionary word, never a bare word
//   - the weather plugin only answers with a weather word (weather, forecast, temperature in, is it raining in...)
//   - the stocks plugin never takes currency or crypto codes without a "$", "stock" in a non-financial sense, or pure math
// Each plugin keeps its own copy of its gating code; this table checks them against each other. (When the sports plugin exists, the
// last batch adds it to the same table.)
import { describe, expect, test } from "bun:test";
import { CalculatorSlot } from "../plugins/calculator/index.js";
import { CurrencySlot } from "../plugins/currency/index.js";
import { DictionarySlot } from "../plugins/dictionary/index.js";
import { StocksSlot } from "../plugins/stocks/index.js";
import { WeatherSlot } from "../plugins/weather/index.js";

const calculator = new CalculatorSlot();
const currency = new CurrencySlot();
const dictionary = new DictionarySlot();
const weather = new WeatherSlot();
const stocks = new StocksSlot();
for (const slot of [calculator, currency, dictionary, weather]) slot.configure({});
// the stock plugin only triggers with a key; this one is never used for a request
stocks.store.file = "";
stocks.configure({ apiKey: "test-key-0123456789" });

const owners = (query) =>
  [calculator.trigger(query) && "calculator", currency.trigger(query) && "currency", dictionary.trigger(query) && "dictionary", weather.trigger(query) && "weather", stocks.trigger(query) && "stocks"].filter(Boolean);

describe("one owner per query", () => {
  const table = [
    // math and units: calculator only
    ["2+2", ["calculator"]],
    ["15% of 80", ["calculator"]],
    ["what is 24/7", ["calculator"]],
    ["sqrt(16)", ["calculator"]],
    ["5 km to miles", ["calculator"]],
    ["100 f to c", ["calculator"]],
    ["255 in hex", ["calculator"]],
    ["5 pounds to kg", ["calculator"]],
    ["10 kg in lb", ["calculator"]],
    // currency: currency only
    ["100 usd to eur", ["currency"]],
    ["usd to eur", ["currency"]],
    ["eur/usd", ["currency"]],
    ["convert 50 gbp to yen", ["currency"]],
    ["how much is 20 euros", ["currency"]],
    ["100 dollars in euros", ["currency"]],
    ["20 pounds to usd", ["currency"]],
    ["1 btc to usd", ["currency"]],
    ["bitcoin price", ["currency"]],
    ["$100 to eur", ["currency"]],
    ["5 gbp", ["currency"]],
    // dictionary: dictionary only
    ["define serendipity", ["dictionary"]],
    ["serendipity meaning", ["dictionary"]],
    ["what does serendipity mean", ["dictionary"]],
    ["synonyms for happy", ["dictionary"]],
    ["how to pronounce quinoa", ["dictionary"]],
    ["meaning of life", ["dictionary"]],
    // words that are also units, codes or crypto names: still one owner, or none
    ["define dollar", ["dictionary"]],
    ["define pound", ["dictionary"]],
    ["pound meaning", ["dictionary"]],
    ["bitcoin definition", ["dictionary"]],
    ["define 2+2", []],
    // weather: weather only
    ["weather in paris", ["weather"]],
    ["weather", ["weather"]],
    ["forecast seattle", ["weather"]],
    ["seattle weather today", ["weather"]],
    ["paris texas weather", ["weather"]],
    ["is it raining in seattle", ["weather"]],
    ["will it snow tomorrow", ["weather"]],
    ["temperature in oslo", ["weather"]],
    // stocks: stocks only
    ["AAPL stock", ["stocks"]],
    ["aapl stock price", ["stocks"]],
    ["$AAPL", ["stocks"]],
    ["$ALL", ["stocks"]],
    ["$BTC", ["stocks"]],
    ["apple stock", ["stocks"]],
    ["tesla stock price today", ["stocks"]],
    ["stock AAPL", ["stocks"]],
    ["AAPL", ["stocks"]],
    ["aapl", ["stocks"]],
    ["QFRN", ["stocks"]],
    // currency and crypto codes are not tickers without a dollar sign
    ["USD", []],
    ["usd", []],
    ["EUR", []],
    ["BTC", ["currency"]],
    ["ETH", ["currency"]],
    ["NOW", []],
    ["ALL", []],
    ["usd stock", []],
    ["btc stock", []],
    ["define stock", ["dictionary"]],
    ["stock market", []],
    ["chicken stock", []],
    ["stock photo", []],
    ["define weather", ["dictionary"]],
    ["weather meaning", ["dictionary"]],
    ["weather app", []],
    ["sales forecast", []],
    ["2+2 stock", []],
    // nobody
    ["", []],
    ["serendipity", []],
    ["dollar", []],
    ["pound", []],
    ["bitcoin news", []],
    ["weather paris", ["weather"]],
    ["iphone 15 pro", []],
    ["2026-10-28", []],
    ["1920x1080", []],
    ["euro truck simulator", []],
    ["50 km to usd", []],
    ["100 usd to kg", []],
    ["try", []],
    ["20 pounds", []],
  ];
  for (const [query, expected] of table) test(`${JSON.stringify(query)} -> ${expected.join(", ") || "nobody"}`, () => expect(owners(query)).toEqual(expected));

  test("the calculator never takes a currency code or name", () => {
    for (const query of ["100 usd to eur", "5 dollars to euros", "1 btc to usd", "20 eur in gbp", "50 pounds sterling to usd", "usd to eur", "100 yen", "$5", "€5 + 3 usd"]) {
      expect(calculator.trigger(query), query).toBe(false);
    }
  });

  test("the currency plugin never takes pure math or non-currency units", () => {
    for (const query of ["2+2", "5!", "2^10", "15% of 80", "sqrt(2)", "1,000 * 3", "5 km to miles", "12 cups in ml", "3 days in hours", "255 in hex", "100 f to c", "5 gb to mb", "10 kg to lb"]) {
      expect(currency.trigger(query), query).toBe(false);
    }
  });

  test("the weather plugin needs a weather word; the stocks plugin never takes currency, crypto or math", () => {
    for (const query of ["paris", "seattle", "rain", "2+2", "100 usd to eur", "define weather", "sales forecast", "weather app", "AAPL", "btc", "serendipity"]) {
      expect(weather.trigger(query), query).toBe(false);
    }
    for (const query of ["2+2", "15% of 80", "100 usd to eur", "usd", "eur", "btc", "BTC", "1 btc to usd", "bitcoin price", "weather in paris", "define stock", "5 km to miles", "NOW", "ALL"]) {
      expect(stocks.trigger(query), query).toBe(false);
    }
    for (const query of ["AAPL stock", "weather in paris", "AAPL", "$AAPL", "apple stock", "100 usd to eur", "2+2", "define stock"]) {
      const takers = owners(query);
      expect(takers.length, `${query} -> ${takers.join(",")}`).toBeLessThanOrEqual(1);
    }
  });

  test("the stocks plugin without a key takes nothing", () => {
    const keyless = new StocksSlot();
    keyless.store.file = "";
    const previous = process.env.FINNHUB_API_KEY;
    delete process.env.FINNHUB_API_KEY;
    try {
      keyless.configure({});
      for (const query of ["AAPL", "AAPL stock", "$AAPL", "apple stock"]) expect(keyless.trigger(query), query).toBe(false);
    } finally {
      if (previous !== undefined) process.env.FINNHUB_API_KEY = previous;
    }
  });

  test("a bare ticker only triggers with the setting on", () => {
    const off = new StocksSlot();
    off.store.file = "";
    off.configure({ apiKey: "test-key-0123456789", triggerOnBareTicker: "false" });
    expect(off.trigger("AAPL")).toBe(false);
    expect(off.trigger("AAPL stock")).toBe(true);
  });

  test("the dictionary never takes a bare word, a calculation or a currency question", () => {
    for (const query of ["serendipity", "happy", "dog", "dollar", "2+2", "100 usd to eur", "btc", "5 km to miles", "what is serendipity", "define", "meaning"]) {
      expect(dictionary.trigger(query), query).toBe(false);
    }
  });
});
