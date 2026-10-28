// Explains what the weather card does for one query, against the REAL Open-Meteo services (no key).
//   bun ./tests/diagnose-weather.js "weather in paris texas"
// A card costs at most three requests: geocoding, forecast and (inline layout) air quality. debugMatching is forced on; nothing is
// written to disk. For every reply it prints the status, the size and the top-level keys of the JSON (never values).
import { WeatherSlot } from "../plugins/weather/index.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: bun ./tests/diagnose-weather.js "weather in paris texas"');
  process.exit(1);
}

const slot = new WeatherSlot();
slot.budget.file = "";
slot.budget.cap = 0;
slot.startWindowMs = 60_000;
slot.answerWindowMs = 60_000;
slot.configure({ debugMatching: "true" });

const seen = [];
const context = {
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.clone().text().catch(() => "");
    let keys = "(not JSON)";
    try {
      const json = JSON.parse(text);
      keys = `keys: ${Object.keys(json).join(",")}`;
      if (Array.isArray(json.results)) keys += ` | ${json.results.length} results, fields: ${Object.keys(json.results[0] ?? {}).join(",")}`;
      if (json.current) keys += ` | current: ${Object.keys(json.current).join(",")}`;
    } catch {
      /* keep the default */
    }
    const u = new URL(url);
    seen.push(`GET ${u.host}${u.pathname} -> ${response.status}, ${text.length} bytes, ${keys}`);
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
console.log([...lines, "", ...seen.map((line) => `  request: ${line}`), "", out?.html ? `Card shown: ${text.slice(0, 220)}` : "No card shown", `(${seen.length} upstream request${seen.length === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n"));
