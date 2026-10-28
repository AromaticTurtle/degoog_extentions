// Explains what the dictionary card does for one query, against the REAL Free Dictionary API (no key).
//   bun ./tests/diagnose-dictionary.js "define serendipity"
// It makes the requests the query needs (one, or two when the word is unknown and a base form is tried), with
// debugMatching forced on. Nothing is written to disk. For every reply it prints the status, the size and the top-level keys
// of the first entry (never the text), and which audio hosts the pronunciations point to.
import { DictionarySlot } from "../plugins/dictionary/index.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: bun ./tests/diagnose-dictionary.js "define serendipity"');
  process.exit(1);
}

const slot = new DictionarySlot();
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
      const first = Array.isArray(json) ? json[0] : json;
      const hosts = new Set();
      for (const p of first?.phonetics ?? []) if (p?.audio) hosts.add(new URL(p.audio).host);
      keys = `${Array.isArray(json) ? `array of ${json.length}` : "object"}; keys: ${Object.keys(first ?? {}).join(",")}; audio hosts: ${[...hosts].join(",") || "none"}`;
    } catch {
      /* keep the default */
    }
    seen.push(`GET ${new URL(url).host}${new URL(url).pathname} -> ${response.status}, ${text.length} bytes, ${keys}; rate-limit headers: ${["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"].map((h) => `${h.slice(12)}=${response.headers.get(h) ?? "-"}`).join(" ")}`);
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
console.log([...lines, "", ...seen.map((line) => `  request: ${line}`), "", out?.html ? `Card shown: ${text.slice(0, 200)}` : "No card shown", `(${seen.length} upstream request${seen.length === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n"));
