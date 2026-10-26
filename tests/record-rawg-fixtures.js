// Saves one real RAWG search and one real game detail as test fixtures. Two requests in total.
// Run it in your own terminal so the key never leaves your machine:
//   RAWG_API_KEY=your-key bun tests/record-rawg-fixtures.js "elden ring"
// The key is read from the environment and is not written to the fixtures.
import { writeFileSync } from "node:fs";
import { buildDetailUrl, buildHeaders, buildSearchUrl } from "../plugins/rawg/request.js";

const key = process.env.RAWG_API_KEY;
const term = process.argv[2] || "elden ring";
if (!key) {
  console.error("Set RAWG_API_KEY in the environment first.");
  process.exit(1);
}

const get = async (url) => {
  const response = await fetch(url, { headers: buildHeaders() });
  if (!response.ok) throw new Error(`RAWG answered HTTP ${response.status}`);
  return response.json();
};

const search = await get(buildSearchUrl(term, key));
const first = search.results?.[0];
if (!first) throw new Error("No results for that search");
const detail = await get(buildDetailUrl(first.id, key));

// RAWG's "next" and "previous" fields are full URLs that contain the API key, so they are removed,
// and nothing is written if the key still appears anywhere in the output.
const save = (name, data) => {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (text.includes(key) || /[?&]key=/.test(text)) throw new Error(`Refusing to save ${name}: it still contains an API key`);
  writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), text);
  console.log(`saved ${name}`);
};
save("rawg-search.json", { ...search, next: null, previous: null, results: search.results.slice(0, 5) });
save("rawg-detail.json", detail);
console.log(`Top result: ${first.name} (id ${first.id}). Run the tests; some expectations assume Elden Ring.`);
