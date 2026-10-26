// Saves real IGDB responses (a game search and the time to beat of the first result) as test fixtures.
// Run it in your own terminal so the credentials never leave your machine:
//   IGDB_CLIENT_ID=your-id IGDB_CLIENT_SECRET=your-secret bun ./tests/record-igdb-fixtures.js "skyrim"
// Three requests in total (token, search, time to beat). The secret and the access token are never written:
// a file is refused if the secret, the client id or the access token appear anywhere in its content.
import { writeFileSync } from "node:fs";
import { buildIgdbHeaders, buildSearchQuery, buildTimeToBeatQuery, buildTokenRequest, igdbUrl, DEFAULT_API_BASE, DEFAULT_TOKEN_URL } from "../plugins/game-info/request.js";

const clientId = process.env.IGDB_CLIENT_ID;
const clientSecret = process.env.IGDB_CLIENT_SECRET;
const term = process.argv[2] || "skyrim";
if (!clientId || !clientSecret) {
  console.error("Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET in the environment first.");
  process.exit(1);
}

const tokenRequest = buildTokenRequest(clientId, clientSecret, DEFAULT_TOKEN_URL);
const tokenResponse = await fetch(tokenRequest.url, tokenRequest.init);
if (!tokenResponse.ok) throw new Error(`Twitch answered HTTP ${tokenResponse.status} to the token request`);
const token = (await tokenResponse.json()).access_token;
if (!token) throw new Error("Twitch did not return an access token");

const query = async (endpoint, body) => {
  const response = await fetch(igdbUrl(DEFAULT_API_BASE, endpoint), { method: "POST", headers: buildIgdbHeaders(clientId, token), body });
  if (!response.ok) throw new Error(`IGDB answered HTTP ${response.status} to /${endpoint}`);
  return response.json();
};

const games = await query("games", buildSearchQuery(term));
if (!Array.isArray(games) || !games.length) throw new Error("No results for that search");
await new Promise((resolve) => setTimeout(resolve, 300));
const times = await query("game_time_to_beats", buildTimeToBeatQuery(games[0].id));

const save = (name, data) => {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  for (const secret of [clientSecret, clientId, token]) {
    if (text.includes(secret)) throw new Error(`Refusing to save ${name}: it contains a credential`);
  }
  writeFileSync(new URL(`./fixtures/${name}`, import.meta.url), text);
  console.log(`saved ${name}`);
};
save("igdb-games.json", games);
save("igdb-time-to-beat.json", times);
console.log(`Top result: ${games[0].name} (id ${games[0].id}). Run the tests: some expectations assume the hand-written Skyrim data.`);
