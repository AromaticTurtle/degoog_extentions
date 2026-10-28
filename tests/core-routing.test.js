// Routing between the core slot plugins (calculator, currency, dictionary): each query belongs to at most one of them.
//   - the calculator never takes currency codes or names
//   - the currency plugin never takes pure math or non-currency units
//   - the dictionary only answers with an explicit dictionary word, never a bare word
// Each plugin keeps its own copy of its gating code; this table checks them against each other. (When the weather, stocks and
// sports plugins exist, the last batch adds them to the same table.)
import { describe, expect, test } from "bun:test";
import { CalculatorSlot } from "../plugins/calculator/index.js";
import { CurrencySlot } from "../plugins/currency/index.js";
import { DictionarySlot } from "../plugins/dictionary/index.js";

const calculator = new CalculatorSlot();
const currency = new CurrencySlot();
const dictionary = new DictionarySlot();
for (const slot of [calculator, currency, dictionary]) slot.configure({});

const owners = (query) => [calculator.trigger(query) && "calculator", currency.trigger(query) && "currency", dictionary.trigger(query) && "dictionary"].filter(Boolean);

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
    // nobody
    ["", []],
    ["serendipity", []],
    ["dollar", []],
    ["pound", []],
    ["bitcoin news", []],
    ["weather paris", []],
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

  test("the dictionary never takes a bare word, a calculation or a currency question", () => {
    for (const query of ["serendipity", "happy", "dog", "dollar", "2+2", "100 usd to eur", "btc", "5 km to miles", "what is serendipity", "define", "meaning"]) {
      expect(dictionary.trigger(query), query).toBe(false);
    }
  });
});
