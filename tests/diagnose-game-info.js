// Explains why the game panel does (or does not) show for one query, using your real IGDB (Twitch) credentials.
// Run it in your own terminal so the credentials never leave your machine:
//   IGDB_CLIENT_ID=your-id IGDB_CLIENT_SECRET=your-secret bun ./tests/diagnose-game-info.js "wingspan"
// It makes one lookup (a token request, the IGDB search, and the time to beat / ProtonDB requests of a confident
// match) with debugMatching forced on and prints the explain block: the candidates, how well each name fits, the
// rating counts, and the rule that accepted or rejected them. Nothing is written to disk, and the output is refused
// if it contains the client id, the secret or the access token.
import { GameInfoSlot } from "../plugins/game-info/index.js";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('Usage: IGDB_CLIENT_ID=... IGDB_CLIENT_SECRET=... bun ./tests/diagnose-game-info.js "wingspan"');
  process.exit(1);
}
if (!process.env.IGDB_CLIENT_ID || !process.env.IGDB_CLIENT_SECRET) {
  console.error("Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET in the environment first.");
  process.exit(1);
}
const accessTokens = [];
const secrets = () => [process.env.IGDB_CLIENT_ID.trim(), process.env.IGDB_CLIENT_SECRET.trim(), ...accessTokens].filter((value) => value.length >= 4);

const slot = new GameInfoSlot();
slot.tokens.file = "";
slot.configure({ debugMatching: "true" });
const context = {
  signProxyUrl: (url) => url,
  fetch: async (url, init) => {
    requests += 1;
    const response = await fetch(url, init);
    if (/\/oauth2\/token/.test(String(url))) {
      try {
        const token = (await response.clone().json()).access_token;
        if (typeof token === "string") accessTokens.push(token);
      } catch {
        /* not JSON */
      }
    }
    return response;
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
