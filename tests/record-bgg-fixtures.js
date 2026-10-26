// Saves a real BGG search and a real thing (details) reply as test fixtures. Two requests in total, 1.5 s apart.
// Run it in your own terminal so the token never leaves your machine:
//   BGG_API_TOKEN=your-token bun ./tests/record-bgg-fixtures.js "wingspan"
// The token is read from the environment and sent only in a header. A file is refused if its content contains the token.
// Note: the replies are BoardGameGeek's data. Keep recorded files for local testing; do not publish them
// (BGG's terms do not allow redistributing its data), and run `git status` before committing.
// The same goes for anything recorded from recommend.games or BGG's website API (api.geekdo.com): that data is
// BGG-derived too, so those fixtures (tests/fixtures/recommend-games-*.json, geekdo-*.json) must not be committed either.
import { writeFileSync } from "node:fs";
import { DEFAULT_API_BASE, buildHeaders, buildSearchUrl, buildThingUrl, normalizeToken } from "../plugins/board-games/request.js";
import { rankCandidates } from "../plugins/board-games/match.js";
import { scanSearch } from "../plugins/board-games/shape.js";

const token = normalizeToken(process.env.BGG_API_TOKEN);
const term = process.argv[2] || "wingspan";
if (!token) {
  console.error("Set BGG_API_TOKEN in the environment first.");
  process.exit(1);
}

const get = async (url) => {
  const response = await fetch(url, { headers: buildHeaders(token) });
  if (!response.ok) throw new Error(`BGG answered HTTP ${response.status}`);
  return response.text();
};

const search = await get(buildSearchUrl(term, DEFAULT_API_BASE));
const { items, valid } = scanSearch(search);
if (!valid) throw new Error("The search reply was not an <items> document");
const candidates = rankCandidates(term, items);
const ids = candidates.length ? candidates : items.slice(0, 8).map((item) => item.id);
if (!ids.length) throw new Error("No results for that search");
await new Promise((resolve) => setTimeout(resolve, 1500));
const thing = await get(buildThingUrl(ids, DEFAULT_API_BASE));

// A short query can match thousands of items. Keep the first 40 so the fixture stays small and still well formed.
const trimSearch = (xml) => {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/g) ?? [];
  const head = /^[\s\S]*?<items\b[^>]*>/.exec(xml)?.[0] ?? "<items>";
  return `${head}\n${blocks.slice(0, 40).join("\n")}\n</items>\n`;
};

const save = (name, text) => {
  if (text.includes(token)) throw new Error(`Refusing to save ${name}: it contains the token`);
  writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), text);
  console.log(`saved ${name}`);
};
save("bgg-search.xml", trimSearch(search));
save("bgg-thing.xml", thing.endsWith("\n") ? thing : `${thing}\n`);
console.log(`Candidate ids: ${ids.join(", ")}. These files are BGG's data: keep them local. Some tests expect the hand-written Starfall data and will fail until adapted.`);
