// Explains why the books panel does (or does not) show for one query, using your real Hardcover token.
// Run it in your own terminal so the token never leaves your machine:
//   HARDCOVER_API_TOKEN=your-token bun ./tests/diagnose-books.js "dungeon crawler carl"
// It makes ONE lookup (one Hardcover request) with debugMatching forced on and prints the explain block: the
// candidates, how well each title fits, the popularity numbers, and the rule that accepted or rejected them.
// Nothing is written to disk, and the output is refused if it contains the token.
import { BooksSlot } from "../plugins/books/index.js";
import { Budget } from "../plugins/books/budget.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: HARDCOVER_API_TOKEN=... bun ./tests/diagnose-books.js "dungeon crawler carl"');
  process.exit(1);
}
if (!process.env.HARDCOVER_API_TOKEN) {
  console.error("Set HARDCOVER_API_TOKEN in the environment first (a token with only the read:catalog permission).");
  process.exit(1);
}
const secrets = () => [process.env.HARDCOVER_API_TOKEN.trim().replace(/^bearer\s+/i, "")].filter((value) => value.length >= 4);

const slot = new BooksSlot();
slot.budget = new Budget({ file: "", cap: 0 });
slot.spacingMs = 0;
slot.startWindowMs = 60_000;
slot.configure({ debugMatching: "true" });
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
