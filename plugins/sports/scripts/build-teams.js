// Rebuilds plugins/sports/teams.json from ESPN's public endpoints, one request per league (nine, a second and a half apart;
// college football uses the FBS standings endpoint because /teams lists every NCAA division).
//   bun plugins/sports/scripts/build-teams.js
// The snapshot holds only factual identifiers: ESPN's team id, display name, short name, location, nickname and abbreviation. No
// logos, no scores. Run it again when a league adds or renames a team (a few times a year at most), then check `git diff`.
import { writeFileSync } from "node:fs";
import { LEAGUES } from "../leagues.js";

const BASE = process.env.DEGOOG_SPORTS_API_BASE || "https://site.api.espn.com/apis/site/v2/sports";
const SITE = BASE.replace("/apis/site/v2/sports", "/apis/v2/sports");
const USER_AGENT = "degoog-sports-build/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// -> an array of ESPN team objects, or null when the request failed
const fetchTeams = async (league) => {
  const url = new URL(league.standings ? `${SITE}/${league.path}/standings` : `${BASE}/${league.path}/teams`);
  for (const [key, value] of Object.entries(league.standings ?? {})) url.searchParams.set(key, value);
  if (league.limit) url.searchParams.set("limit", league.limit);
  const response = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (!response.ok) {
    console.error(`${league.key}: HTTP ${response.status}, skipped`);
    return null;
  }
  const json = await response.json();
  if (!league.standings) return (json?.sports?.[0]?.leagues?.[0]?.teams ?? []).map((entry) => entry?.team);
  const teams = [];
  const walk = (node) => {
    for (const entry of node?.standings?.entries ?? []) teams.push(entry?.team);
    for (const child of node?.children ?? []) walk(child);
  };
  walk(json);
  return teams;
};

const out = { generated: new Date().toISOString().slice(0, 10), source: "ESPN public endpoints", fields: ["id", "displayName", "shortDisplayName", "location", "name", "abbreviation"], leagues: {} };
for (const league of LEAGUES) {
  const teams = await fetchTeams(league);
  if (!teams) continue;
  const rows = [];
  const seen = new Set();
  for (const t of teams) {
    if (!t?.id || !t.displayName || t.isActive === false || seen.has(t.id)) continue;
    seen.add(t.id);
    rows.push([clean(t.id), clean(t.displayName), clean(t.shortDisplayName), clean(t.location), clean(t.name), clean(t.abbreviation)]);
  }
  out.leagues[league.key] = rows;
  console.log(`${league.key}: ${rows.length} teams`);
  await sleep(1500);
}
writeFileSync(new URL("../teams.json", import.meta.url), `${JSON.stringify(out)}\n`);
console.log("written plugins/sports/teams.json");
