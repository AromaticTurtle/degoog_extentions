// Explains why the board game panel does (or does not) show for one query, with the real upstreams.
// Run it in your own terminal:
//   bun ./tests/diagnose-board-games.js "wingspan"
// Works without any key through recommend.games. With BGG_API_TOKEN set, the BGG XML API is tried first (as in the
// plugin). Add --internal to also allow BGG's website JSON API (opt-in in the plugin too).
// It makes ONE lookup chain (a single recommend.games request when nothing else is enabled; that site can take 15 s or
// more) with debugMatching forced on and prints the explain block: which source answered, the candidates, how well each
// title fits, the rating counts, and the rule that accepted or rejected them. Nothing is written to disk, and the
// output is refused if it contains the token.
import { BoardGamesSlot } from "../plugins/board-games/index.js";
import { Budget } from "../plugins/board-games/budget.js";

const args = process.argv.slice(2);
const internal = args.includes("--internal");
const query = args.filter((arg) => arg !== "--internal").join(" ").trim();
if (!query) {
  console.error('Usage: [BGG_API_TOKEN=...] bun ./tests/diagnose-board-games.js "wingspan" [--internal]');
  process.exit(1);
}
const secrets = () => [(process.env.BGG_API_TOKEN ?? "").trim().replace(/^bearer\s+/i, "")].filter((value) => value.length >= 4);

const slot = new BoardGamesSlot();
for (const source of Object.values(slot.sources)) source.budget = new Budget({ file: "", cap: 0 });
// the slot's own time limits would cut off a slow site, which is exactly what this script is meant to look at
slot.startWindowMs = 120_000;
slot.answerWindowMs = 120_000;
slot.configure({
  debugMatching: "true",
  enableApi: process.env.BGG_API_TOKEN ? "true" : "false",
  enableRecommendGames: "true",
  enableBggInternal: internal ? "true" : "false",
});
const context = {
  signProxyUrl: (url) => url,
  fetch: (url, init) => {
    requests += 1;
    return fetch(url, init);
  },
};

const lines = [];
const originals = {};
for (const method of ["info", "warn"]) {
  originals[method] = console[method];
  console[method] = (...args) => lines.push(args.join(" "));
}
let requests = 0;
const started = performance.now();
let out;
try {
  out = await slot.execute(query, context);
} finally {
  Object.assign(console, originals);
}
const elapsed = Math.round(performance.now() - started);

const verdict = out?.html ? `Panel shown: "${out.title}"` : "No panel shown";
const report = [...lines, "", `${verdict} (${requests} upstream request${requests === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n");
if (secrets().some((secret) => report.includes(secret))) {
  console.error("Refusing to print: the output contains a credential. Nothing was printed.");
  process.exit(1);
}
console.log(report);
