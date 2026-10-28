// Explains what the currency card does for one query, against the REAL services (open.er-api.com and Coinbase's public APIs).
//   bun ./tests/diagnose-currency.js "100 usd to eur"
//   bun ./tests/diagnose-currency.js "btc"
// No keys are involved. It makes only the requests the query needs (one for a fiat conversion; a price and the 24 hour
// statistics for a crypto one: the currency list is not fetched, the built-in starter list is used), with debugMatching
// forced on. Nothing is written to disk. For every reply it prints the status, the size and the top-level KEYS of the JSON
// (never the values), which is what to paste when a field layout changed.
import { CurrencySlot } from "../plugins/currency/index.js";
import { STARTER_CRYPTO } from "../plugins/currency/currencies.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: bun ./tests/diagnose-currency.js "100 usd to eur"');
  process.exit(1);
}

const slot = new CurrencySlot();
slot.fiat.file = "";
slot.fiat.budget.file = "";
slot.fiat.budget.cap = 0;
slot.startWindowMs = 60_000;
slot.answerWindowMs = 60_000;
slot.configure({ debugMatching: "true" });
slot.coinbase.known = new Map(STARTER_CRYPTO);
slot.coinbase.knownAt = Date.now();

const seen = [];
const context = {
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    const copy = response.clone();
    const text = await copy.text().catch(() => "");
    let keys = "";
    try {
      const json = JSON.parse(text);
      const top = Array.isArray(json) ? `[array of ${json.length}]` : Object.keys(json).join(",");
      keys = `keys: ${top.slice(0, 200)}`;
      if (json && typeof json === "object" && json.rates) keys += ` | rates: ${Object.keys(json.rates).length} codes`;
      if (json && json.data && !Array.isArray(json.data)) keys += ` | data keys: ${Object.keys(json.data).join(",")}`;
    } catch {
      keys = "(not JSON)";
    }
    seen.push(`${init?.method ?? "GET"} ${new URL(url).host}${new URL(url).pathname} -> ${response.status}, ${text.length} bytes, ${keys}`);
    return response;
  },
};

const lines = [];
const originals = {};
for (const method of ["info", "warn"]) {
  originals[method] = console[method];
  console[method] = (...args) => lines.push(args.join(" "));
}
const started = performance.now();
let out;
try {
  out = await slot.execute(query, context);
} finally {
  Object.assign(console, originals);
}
const elapsed = Math.round(performance.now() - started);
const text = (out?.html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
console.log([...lines, "", ...seen.map((line) => `  request: ${line}`), "", out?.html ? `Card shown: ${text.slice(0, 160)}` : "No card shown", `(${seen.length} upstream request${seen.length === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n"));
