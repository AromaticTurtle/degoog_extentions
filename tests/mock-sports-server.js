// Local stand-in for ESPN's scoreboard API, used only for integration checks. Games are built from INVENTED numbers
// (tests/fixtures/espn-builder.js) relative to the real clock, so they are always "today".
//   GET /<sport>/<league>/scoreboard[?dates=YYYYMMDD]   nfl, nba, nhl, epl have games; every other league is an empty board
//   GET /<sport>/<league>/teams/<id>/schedule            a last game 3 days ago and a next game in 4 days for any team
// Modes (GET /__mode?nfl=live|final|scheduled|postponed|delayed|empty  &nhl=live|scheduled|final|empty  &status=ok|429|500):
//   nfl=live (default): Panthers @ Packers in the 3rd quarter, the Panthers score goes up every 10 seconds and the clock runs down,
//                       so a page that refreshes can be seen changing.
//   GET /__reset restarts the live clock; GET /__delay?ms=2000 slows every reply; GET /__stats reports request counts.
// Usage: bun tests/mock-sports-server.js [port]. Point the plugin at it with DEGOOG_SPORTS_API_BASE=http://host:4600
import { STATUS, T as TEAMS, iso, schedule, scheduleEvent, scoreboard, scoreboardEvent } from "./fixtures/espn-builder.js";

// Logos of the pro teams point at ESPN's static image host (so the plugin's image proxy can be checked for real); the soccer and
// college teams keep the builder's placeholder address, which does not exist, so the badge fallback shows for them.
const FOLDERS = { panthers: "nfl", rams: "nfl", packers: "nfl", chiefs: "nfl", flaPanthers: "nhl", bruins: "nhl", lakers: "nba", celtics: "nba", braves: "mlb", yankees: "mlb" };
const T = Object.fromEntries(Object.entries(TEAMS).map(([key, team]) => [key, FOLDERS[key] ? { ...team, logo: `https://a.espncdn.com/i/teamlogos/${FOLDERS[key]}/500/scoreboard/${team.abbr.toLowerCase()}.png` } : team]));

const port = Number(process.argv[2] || 4600);
const mode = { nfl: "live", nhl: "scheduled", nba: "live", epl: "final", status: "ok" };
const stats = { board: 0, schedule: 0, throttled: 0, errors: 0, last: [] };
let startedAt = Date.now();
let delay = 0;

const HOUR = 3_600_000;
const venue = { name: "Example Field", city: "Springfield", state: "NC" };
const side = (team, score, extra = {}) => ({ team, score, ...extra });
const clockText = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

const nflGame = () => {
  const now = Date.now();
  const elapsed = Math.floor((now - startedAt) / 1000);
  const base = { id: "4001", venue, tv: ["FOX", "NFL+"], notes: ["Week 9"] };
  const records = { away: { record: "5-2" }, home: { record: "6-1" } };
  switch (mode.nfl) {
    case "final":
      return scoreboardEvent({ ...base, date: iso(now - 3 * HOUR), away: side(T.panthers, 27, { ...records.away, lines: [7, 10, 3, 7], leaders: [["PYDS", "J. Example", "245 YDS"]] }), home: side(T.packers, 24, { ...records.home, lines: [3, 7, 7, 7], leaders: [["PYDS", "R. Sample", "301 YDS"]] }), status: STATUS.final() });
    case "scheduled":
      return scoreboardEvent({ ...base, date: iso(now + 5 * HOUR), away: side(T.panthers, 0, records.away), home: side(T.packers, 0, records.home), status: STATUS.pre("10/28 - 8:15 PM EDT") });
    case "postponed":
      return scoreboardEvent({ ...base, date: iso(now + 5 * HOUR), away: side(T.panthers, 0, records.away), home: side(T.packers, 0, records.home), status: STATUS.postponed() });
    case "delayed":
      return scoreboardEvent({ ...base, date: iso(now - HOUR), away: side(T.panthers, 10, records.away), home: side(T.packers, 7, records.home), status: STATUS.delayed("Delayed - Weather") });
    default: {
      const left = Math.max(0, 15 * 60 - elapsed);
      const away = 17 + Math.floor(elapsed / 10);
      return scoreboardEvent({
        ...base,
        date: iso(now - 2 * HOUR),
        away: side(T.panthers, away, { ...records.away, lines: [7, 3, away - 10, 0], leaders: [["PYDS", "J. Example", "212 YDS"]] }),
        home: side(T.packers, 24, { ...records.home, lines: [10, 7, 7, 0], leaders: [["PYDS", "R. Sample", "188 YDS"]] }),
        status: STATUS.live({ period: 3, clock: clockText(left) }),
        situation: { shortDownDistanceText: "2nd & 7", downDistanceText: "2nd & 7 at GB 35" },
      });
    }
  }
};

const board = (league, dates) => {
  const now = Date.now();
  if (dates) {
    // a day in the past: one final game with a line score
    return scoreboard([scoreboardEvent({ id: "3001", date: iso(now - 3 * 24 * HOUR), venue, tv: ["CBS"], away: side(T.rams, 10, { record: "3-4", lines: [3, 0, 7, 0] }), home: side(T.panthers, 20, { record: "4-3", winner: true, lines: [7, 6, 0, 7] }), status: STATUS.final() })]);
  }
  if (league === "football/nfl") {
    if (mode.nfl === "empty") return scoreboard([]);
    return scoreboard(
      [nflGame(), scoreboardEvent({ id: "4002", date: iso(now - 5 * HOUR), venue: { name: "Arrowhead Example", city: "Kansas City", state: "MO" }, tv: ["CBS"], away: side(T.rams, 13, { record: "4-3" }), home: side(T.chiefs, 20, { record: "6-1" }), status: STATUS.final("Final/OT") }), scoreboardEvent({ id: "4003", date: iso(now + 8 * HOUR), venue, away: side(T.chiefs, 0), home: side(T.rams, 0), status: STATUS.pre("10/28 - 11:00 PM EDT") })],
      { week: 9 },
    );
  }
  if (league === "hockey/nhl") {
    if (mode.nhl === "empty") return scoreboard([]);
    const status = mode.nhl === "live" ? STATUS.live({ period: 2, clock: "7:00" }) : mode.nhl === "final" ? STATUS.final() : STATUS.pre("10/28 - 7:00 PM EDT");
    const score = mode.nhl === "scheduled" ? 0 : 2;
    return scoreboard([scoreboardEvent({ id: "5001", date: iso(now + (mode.nhl === "scheduled" ? 2 * HOUR : -HOUR)), venue: { name: "Example Arena", city: "Sunrise", state: "FL" }, tv: ["ESPN+"], away: side(T.bruins, score, { record: "4-2-0" }), home: side(T.flaPanthers, mode.nhl === "scheduled" ? 0 : 3, { record: "5-1-0" }), status })]);
  }
  if (league === "basketball/nba") {
    if (mode.nba === "empty") return scoreboard([]);
    return scoreboard([scoreboardEvent({ id: "6001", date: iso(now - HOUR), venue: { name: "Example Center", city: "Los Angeles", state: "CA" }, tv: ["ESPN"], away: side(T.celtics, 58, { record: "3-0", lines: [30, 28] }), home: side(T.lakers, 61, { record: "2-1", lines: [28, 33] }), status: STATUS.live({ period: 3, clock: "6:11" }), situation: { lastPlay: { text: "Example Player makes a layup" } } })]);
  }
  if (league === "soccer/eng.1") {
    return scoreboard([scoreboardEvent({ id: "7001", date: iso(now - 3 * HOUR), venue: { name: "Example Park", city: "London" }, tv: ["Peacock"], away: side(T.liverpool, 1, { record: "5-2-1" }), home: side(T.arsenal, 2, { record: "6-1-1" }), status: STATUS.final("FT") })]);
  }
  return scoreboard([]);
};

const teamSchedule = (id) => {
  const now = Date.now();
  const mine = Object.values(T).find((team) => team.id === id) ?? T.panthers;
  return schedule([
    scheduleEvent({ id: "3001", date: iso(now - 3 * 24 * HOUR), venue, tv: ["CBS"], away: side(T.rams, 10), home: side(mine, 20, { winner: true, record: "4-3" }), status: STATUS.final() }),
    scheduleEvent({ id: "3002", date: iso(now + 4 * 24 * HOUR), venue: { name: "Lambeau Example", city: "Green Bay", state: "WI" }, tv: ["NBC"], away: side(mine, 0), home: side(T.packers, 0), status: STATUS.pre() }),
  ]);
};

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    if (url.pathname === "/__mode") {
      for (const key of Object.keys(mode)) if (url.searchParams.has(key)) mode[key] = url.searchParams.get(key);
      return Response.json(mode);
    }
    if (url.pathname === "/__reset") {
      startedAt = Date.now();
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__delay") {
      delay = Number(url.searchParams.get("ms") || 0);
      return Response.json({ delay });
    }
    // Only the method and path are logged.
    console.log(`MOCK ${request.method} ${url.pathname}${url.searchParams.has("dates") ? " (dated)" : ""}`);
    if (delay) await Bun.sleep(delay);
    const scoreboardMatch = /^\/(.+)\/scoreboard$/.exec(url.pathname);
    const scheduleMatch = /^\/(.+)\/teams\/(\d+)\/schedule$/.exec(url.pathname);
    if (!scoreboardMatch && !scheduleMatch) return new Response("not found", { status: 404 });
    if (scoreboardMatch) stats.board += 1;
    else stats.schedule += 1;
    stats.last = [url.pathname + url.search, ...stats.last].slice(0, 10);
    if (mode.status === "429") {
      stats.throttled += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    }
    if (mode.status === "500") {
      stats.errors += 1;
      return new Response("error", { status: 500 });
    }
    if (scoreboardMatch) return Response.json(board(scoreboardMatch[1], url.searchParams.get("dates")));
    return Response.json(teamSchedule(scheduleMatch[2]));
  },
});
console.log(`mock sports listening on ${port}`);
