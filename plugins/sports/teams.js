import { readFileSync } from "node:fs";
import { ALIASES } from "./aliases.js";
import { LEAGUES, leagueByKey } from "./leagues.js";

// The bundled team snapshot (teams.json, rebuilt with scripts/build-teams.js) as a name index. Nothing here touches the network.

export const norm = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const CLUB_WORDS = new Set(["fc", "afc", "sc", "cf"]);
const withoutClubWords = (text) => text.split(" ").filter((word) => !CLUB_WORDS.has(word)).join(" ");

const loadSnapshot = () => {
  try {
    const data = JSON.parse(readFileSync(new URL("./teams.json", import.meta.url), "utf8"));
    return data && typeof data === "object" && data.leagues ? data : { generated: "", leagues: {} };
  } catch {
    return { generated: "", leagues: {} };
  }
};

// team: { league, id, displayName, shortName, location, name, abbr }
export const buildIndex = (snapshot) => {
  const teams = [];
  const byKey = new Map(); // normalised name -> [{ team, kind }]
  const byLocation = new Map();
  const add = (map, key, team, kind) => {
    if (!key) return;
    const list = map.get(key) ?? [];
    if (!list.some((entry) => entry.team === team && entry.kind === kind)) list.push({ team, kind });
    map.set(key, list);
  };
  for (const league of LEAGUES) {
    for (const row of snapshot.leagues?.[league.key] ?? []) {
      const [id, displayName, shortName, location, name, abbr] = row;
      if (!id || !displayName) continue;
      const team = { league: league.key, id: String(id), displayName, shortName: shortName || displayName, location: location || "", name: name || "", abbr: abbr || "" };
      teams.push(team);
      const full = norm(displayName);
      add(byKey, full, team, "full");
      add(byKey, withoutClubWords(full), team, "full");
      const nick = norm(name);
      if (nick && nick !== full) add(byKey, nick, team, "nick");
      const short = norm(team.shortName);
      // a short name that is only the city ("Atlanta") says nothing about the club
      if (short && short !== full && short !== nick && league.shortNames !== false) add(byKey, short, team, "nick");
      const place = norm(location);
      if (place && place !== full) add(byLocation, place, team, "location");
    }
  }
  const byDisplay = new Map(teams.map((team) => [`${team.league}:${norm(team.displayName)}`, team]));
  for (const [alias, targets] of Object.entries(ALIASES)) {
    for (const target of targets) {
      const [leagueKey, ...rest] = target.split(":");
      const team = byDisplay.get(`${leagueKey}:${norm(rest.join(":"))}`);
      if (team) add(byKey, norm(alias), team, "alias");
    }
  }
  return { teams, byKey, byLocation, byDisplay, generated: snapshot.generated };
};

let cached = null;
export const index = () => (cached ??= buildIndex(loadSnapshot()));
export const resetIndex = () => {
  cached = null;
};

const REWRITES = [
  [/^la /, "los angeles "],
  [/^ny /, "new york "],
];

// Text -> candidate teams: [{ team, kind, league }], strongest evidence first.
//   leagueKeys: a league filter from words in the query (soft: ignored when nothing matches)
//   allowLocation: a bare city or school ("duke") counts, because the query said which sport
export const resolveTeams = (text, { leagueKeys = [], allowLocation = false } = {}) => {
  const ix = index();
  let key = norm(text).replace(/^the /, "");
  if (!key) return { candidates: [], key, filtered: false };
  for (const [pattern, replacement] of REWRITES) key = key.replace(pattern, replacement);
  let entries = ix.byKey.get(key) ?? ix.byKey.get(withoutClubWords(key)) ?? [];
  if (!entries.length && allowLocation) entries = ix.byLocation.get(key) ?? [];
  if (!entries.length) return { candidates: [], key, filtered: false };
  // the most specific evidence only: a full name or an alias beats a nickname
  const strong = entries.filter((entry) => entry.kind === "full" || entry.kind === "alias");
  let pool = strong.length ? strong : entries;
  let filtered = false;
  if (leagueKeys.length) {
    const matching = pool.filter((entry) => leagueKeys.includes(entry.team.league));
    if (matching.length) {
      pool = matching;
      filtered = true;
    }
  }
  const rank = { full: 0, alias: 1, nick: 2, location: 3 };
  const best = new Map();
  for (const entry of pool) {
    const known = best.get(entry.team);
    if (!known || rank[entry.kind] < rank[known.kind]) best.set(entry.team, entry);
  }
  const candidates = [...best.values()].map((entry) => ({ team: entry.team, kind: entry.kind, league: leagueByKey(entry.team.league) }));
  return { candidates, key, filtered };
};

export const teamsOfLeague = (leagueKey) => index().teams.filter((team) => team.league === leagueKey);
export const teamById = (leagueKey, id) => index().teams.find((team) => team.league === leagueKey && team.id === String(id)) ?? null;
