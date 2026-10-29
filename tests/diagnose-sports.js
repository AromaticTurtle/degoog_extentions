// Explains what the sports card does for one query, against the REAL ESPN scoreboard API (no key).
//   bun ./tests/diagnose-sports.js "panthers score"
// A card costs about 3 requests (scoreboards of the candidate leagues, the team schedule, maybe a dated scoreboard). debugMatching is
// forced on; nothing is written to disk. For every reply it prints the status, the size and the FIELD NAMES present (never values),
// so you can see whether ESPN's layout still matches what the parser expects.
import { SportsSlot } from "../plugins/sports/index.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: bun ./tests/diagnose-sports.js "panthers score"');
  process.exit(1);
}

const slot = new SportsSlot();
slot.budget.file = "";
slot.budget.cap = 6;
slot.startWindowMs = 60_000;
slot.answerWindowMs = 60_000;
slot.configure({ debugMatching: "true" });

const keys = (value) => (value && typeof value === "object" ? Object.keys(value).join(",") : "-");
const seen = [];
const context = {
  fetch: async (url, init) => {
    const response = await fetch(url, init);
    const text = await response.clone().text().catch(() => "");
    let shape = "(not JSON)";
    try {
      const json = JSON.parse(text);
      const event = json.events?.[0];
      const competition = event?.competitions?.[0];
      const competitor = competition?.competitors?.[0];
      shape = `top: ${keys(json)} | events: ${Array.isArray(json.events) ? json.events.length : "none"}`;
      if (event) shape += ` | event: ${keys(event)} | competition: ${keys(competition)} | competitor: ${keys(competitor)} | status.type: ${keys(competition?.status?.type)} | score is ${typeof competitor?.score}`;
    } catch {
      /* keep the default */
    }
    const u = new URL(url);
    seen.push(`GET ${u.host}${u.pathname}${u.search ? "?…" : ""} -> ${response.status}, ${text.length} bytes, ${shape}`);
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
console.log([...lines, "", ...seen.map((line) => `  request: ${line}`), "", out?.html ? `Card shown: ${text.slice(0, 260)}` : "No card shown", `(${seen.length} upstream request${seen.length === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n"));
