// Routing between the six core slot plugins (calculator, currency, dictionary, weather, stocks, sports): each query belongs to at
// most one of them, and this table says which. It is the single place where the plugins are checked against each other.
//   - the calculator never takes currency codes or names
//   - the currency plugin never takes pure math or non-currency units
//   - the dictionary only answers with an explicit dictionary word, never a bare word
//   - the weather plugin only answers with a weather word (weather, forecast, temperature in, is it raining in...)
//   - the stocks plugin never takes currency or crypto codes without a "$", "stock" in a non-financial sense, or pure math
//   - the sports plugin needs a team AND a score word: never a bare team name, never "credit score"
// Each plugin keeps its own copy of its gating code; changing one means updating this table.
import { describe, expect, test } from "bun:test";
import { CalculatorSlot } from "../plugins/calculator/index.js";
import { CurrencySlot } from "../plugins/currency/index.js";
import { DictionarySlot } from "../plugins/dictionary/index.js";
import { SportsSlot } from "../plugins/sports/index.js";
import { StocksSlot } from "../plugins/stocks/index.js";
import { WeatherSlot } from "../plugins/weather/index.js";

const calculator = new CalculatorSlot();
const currency = new CurrencySlot();
const dictionary = new DictionarySlot();
const weather = new WeatherSlot();
const stocks = new StocksSlot();
const sports = new SportsSlot();
for (const slot of [calculator, currency, dictionary, weather, sports]) slot.configure({});
// the stock plugin only triggers with a key; this one is never used for a request
stocks.store.file = "";
stocks.configure({ apiKey: "test-key-0123456789" });

const owners = (query) =>
  [calculator.trigger(query) && "calculator", currency.trigger(query) && "currency", dictionary.trigger(query) && "dictionary", weather.trigger(query) && "weather", stocks.trigger(query) && "stocks", sports.trigger(query) && "sports"].filter(Boolean);

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
  // sports: sports only (a team AND a score word)
  ["panthers score", ["sports"]],
  ["rams game score", ["sports"]],
  ["panthers score today", ["sports"]],
  ["carolina panthers score", ["sports"]],
  ["panthers game", ["sports"]],
  ["panthers game today", ["sports"]],
  ["did the panthers win", ["sports"]],
  ["panthers vs rams", ["sports"]],
  ["panthers vs rams score", ["sports"]],
  ["lakers score", ["sports"]],
  ["lakers game tonight", ["sports"]],
  ["how did the lakers do", ["sports"]],
  ["man utd score", ["sports"]],
  ["arsenal match", ["sports"]],
  ["nfl scores", ["sports"]],
  ["nba scores today", ["sports"]],
  ["mls scores", ["sports"]],
  ["who won the chiefs game", ["sports"]],
  ["lakers @ celtics", ["sports"]],
  ["yankees game yesterday", ["sports"]],
  ["premier league scores", ["sports"]],
  ["next lakers game", ["sports"]],
  // sports near misses: nobody
  ["panthers", []],
  ["rams", []],
  ["lakers", []],
  ["panther", []],
  ["panthers roster", []],
  ["panthers schedule", []],
  ["lakers news", []],
  ["ram trucks score", []],
  ["credit score", []],
  ["ielts score", []],
  ["high score", []],
  ["test score", []],
  ["score", []],
  ["fantasy football score", []],
  ["lions vs tigers", []],
  ["nfl", []],
  ["nba draft", []],
  ["game of thrones", []],
  ["chess match", []],
  ["bowling score", []],
  // sports words that belong to somebody else
  ["define score", ["dictionary"]],
  ["score meaning", ["dictionary"]],
  ["synonyms for game", ["dictionary"]],
  ["weather in charlotte", ["weather"]],
  ["charlotte weather", ["weather"]],
  ["weather for the panthers game", []],
  ["apple stock", ["stocks"]],
  ["rams stock", ["stocks"]],
  ["10 km to mi", ["calculator"]],
  ["100 usd", ["currency"]],
  ["usd to eur", ["currency"]],
  ["stock pot", []],
  ["chicken stock", []],
  ["2+2", ["calculator"]],
  ["lakers 2+2 score", []],
  ["panthers 5 km to miles", []],
  ["aapl score", []],
  ["btc score", []],
  ["usd game", []],
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

describe("one owner per query", () => {
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
  test("the sports plugin never takes a bare team, a calculation, a currency or a stock question", () => {
    for (const query of ["panthers", "lakers", "arsenal", "man utd", "nfl", "2+2", "100 usd to eur", "AAPL", "$AAPL", "AAPL stock", "weather in charlotte", "define score", "credit score", "score", "game", "match"]) {
      expect(sports.trigger(query), query).toBe(false);
    }
  });

  test("a switched-off league is not claimed", () => {
    const nbaOnly = new SportsSlot();
    nbaOnly.configure({ leagues: "nba" });
    expect(nbaOnly.trigger("lakers score")).toBe(true);
    expect(nbaOnly.trigger("panthers score")).toBe(false);
    expect(nbaOnly.trigger("nfl scores")).toBe(false);
  });

  test("every query in the table has one owner at most", () => {
    for (const [query, expected] of table) expect(expected.length, query).toBeLessThanOrEqual(1);
  });
});
