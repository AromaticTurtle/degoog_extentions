// Tests for the sports slot plugin: query grammar, team index, ESPN parsing for every game state and sport, ranking, cards, the slot's
// flows with a fake ESPN, caching, pauses, budget, time rules, settings, layout, bang command and the page script.
//
// NOTE: every ESPN reply here is built by tests/fixtures/espn-builder.js from INVENTED scores, times and venues in the layout of
// ESPN's scoreboard and schedule JSON. Team names and ids come from the bundled snapshot (facts). Nothing here is a recording.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { LOGO, STATUS, T, iso, schedule, scheduleEvent, scoreboard, scoreboardEvent } from "./fixtures/espn-builder.js";
import { Budget } from "../plugins/sports/budget.js";
import { DEFAULT_BASE, baseFrom, finalLabel, liveLabel, ordinal, parseEvent, parseSchedule, parseScoreboard, safeLogo, scheduleUrl, scoreboardUrl } from "../plugins/sports/espn.js";
import { LEAGUES, leagueByKey } from "../plugins/sports/leagues.js";
import { leagueWords, parseQuery } from "../plugins/sports/match.js";
import { NEAR_MS, bestGame, boardTtl, gameScore, involves, orderBoard, pickScheduled, rankTeams, surrounding } from "../plugins/sports/rank.js";
import { INLINE_LIST_MAX, PANEL_LIST_MAX, buildGameCard, buildLeagueCard, searchHref } from "../plugins/sports/render.js";
import { SETTINGS_SCHEMA } from "../plugins/sports/settings.js";
import { buildIndex, index, norm, resolveTeams, teamById, teamsOfLeague } from "../plugins/sports/teams.js";
import { dayDiff, dayKey, espnDate, kickoffLabel, serverZone, shortDate, validZone, whenToDate } from "../plugins/sports/time.js";
import { INLINE_POSITION, PANEL_POSITION, SportsSlot, USER_AGENT, command, layoutFrom, leaguesFrom, refreshFrom, slot as sharedSlot } from "../plugins/sports/index.js";

const NOW = Date.parse("2026-10-28T23:00:00Z"); // Wednesday evening in New York
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = "America/New_York";

const leagueOfPath = (path) => LEAGUES.find((league) => path.endsWith(`/${league.path}/scoreboard`) || path.includes(`/${league.path}/teams/`));

// A fake ESPN. boards: { nfl: object | (params) => object, "nfl:20261027": ... }, schedules: { "nfl:29": object }
const world = ({ boards = {}, schedules = {}, status = {} } = {}) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, params: u.searchParams, headers: init.headers ?? {} });
    const league = leagueOfPath(u.pathname);
    const scoreboardCall = u.pathname.endsWith("/scoreboard");
    const scheduleCall = /\/teams\/\d+\/schedule$/.test(u.pathname);
    const key = scoreboardCall ? `${league?.key}${u.searchParams.get("dates") ? `:${u.searchParams.get("dates")}` : ""}` : scheduleCall ? `${league?.key}:${/teams\/(\d+)/.exec(u.pathname)[1]}` : "";
    const code = status[key] ?? status[league?.key] ?? status["*"];
    if (code) return new Response(code === 200 ? "{}" : "nope", { status: code, headers: code === 429 ? { "retry-after": "120" } : {} });
    const table = scoreboardCall ? boards : scheduleCall ? schedules : {};
    let body = table[key] ?? (scoreboardCall ? table[league?.key] : undefined);
    if (typeof body === "function") body = body(u.searchParams);
    if (body === undefined) body = scoreboardCall ? scoreboard([]) : null;
    if (body === null) return new Response("nope", { status: 404 });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200 });
  };
  const count = (kind) => calls.filter((c) => (kind === "board" ? c.path.endsWith("/scoreboard") : kind === "schedule" ? c.path.endsWith("/schedule") : true)).length;
  return { fetch, calls, count };
};

const clock = (start = NOW) => {
  const state = { t: start };
  return { state, now: () => state.t, sleep: async (ms) => { state.t += ms; } };
};

const makeSlot = (settings = {}, { time } = {}) => {
  const slot = new SportsSlot();
  slot.spacingMs = 0;
  slot.budget.file = "";
  slot.now = time ? time.now : () => NOW;
  if (time) slot.sleep = time.sleep;
  slot.configure({ timezone: ZONE, ...settings });
  return slot;
};

const capture = async (work) => {
  const lines = [];
  const original = { info: console.info, warn: console.warn, log: console.log, error: console.error };
  for (const level of ["info", "warn", "log", "error"]) console[level] = (...args) => lines.push(args.join(" "));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const side = (team, score, extra = {}) => ({ team, score, ...extra });
const game = (o) => scoreboardEvent({ id: "401", date: iso(NOW - HOUR), venue: { name: "Test Field", city: "Springfield", state: "NC" }, tv: ["ESPN"], ...o });
const run = async (slot, query, ctx = {}) => (await slot.execute(query, { fetch: ctx.fetch, ...ctx })).html;

// ------------------------------------------------------------------------------------------------------------------------
describe("which queries are sports questions", () => {
  const yes = [
    "panthers score", "rams game score", "panthers score today", "carolina panthers score", "panthers game", "panthers game today",
    "did the panthers win", "panthers vs rams", "panthers vs rams score", "lakers score", "lakers game tonight", "how did the lakers do",
    "man utd score", "arsenal match", "nfl scores", "nba scores today", "mls scores", "who won the lakers game", "panthers result",
    "when do the panthers play", "florida panthers score", "duke basketball score", "college football scores", "premier league scores",
    "lakers @ celtics", "lakers v celtics", "lakers vs. celtics", "did the chiefs win last night", "cowboys game yesterday", "liverpool live",
    "spurs score", "LAKERS SCORE", "  lakers   score  ", "lakers score?", "next lakers game", "lakers next game", "score of the lakers game",
    "what's the score of the lakers game", "who won the chiefs game", "are the lakers winning", "did the yankees win today",
    "yankees game tonight", "braves score", "red sox score", "49ers score", "niners score", "man city score", "mls scoreboard", "nhl scores today",
    "today's nfl scores", "mlb scores", "wnba scores", "scores for the nba", "nba games today", "epl scores", "soccer scores", "football scores",
    "live nba scores", "nfl results", "arsenal v liverpool", "arsenal vs liverpool score", "carolina panthers vs los angeles rams", "bruins score",
    "nfl panthers score", "panthers hockey score", "panthers football score",
  ];
  test.each(yes)("%s triggers", (query) => {
    const r = parseQuery(query);
    expect(r.parsed).not.toBeNull();
  });

  const no = [
    "panthers", "rams", "lakers", "panthers roster", "panthers schedule", "panther", "ram trucks score", "score", "credit score", "ielts score",
    "high score", "test score", "lakers news", "fantasy football score", "define score", "the score", "score card", "game", "game score", "match",
    "lakers", "the lakers", "lakers tickets", "lakers jersey", "lakers vs", "vs lakers", "nfl", "nba", "nba draft", "nfl schedule", "football",
    "what is a good credit score", "sat score", "gpa score", "apgar score", "bowling score", "golf score", "chess match", "tennis match", "soccer",
    "ps5 game", "game of thrones", "video game score", "lakers score card tickets please buy now cheap seats", "https://espn.com/nba/scoreboard",
    "2+2 score", "weather in charlotte", "usd to eur", "AAPL", "tesla stock", "", "   ", "a", "football game rules", "tennis score",
  ];
  test.each(no)("%j does not trigger", (query) => {
    expect(parseQuery(query).parsed).toBeNull();
  });

  test("never throws on odd input", () => {
    for (const q of [null, undefined, 42, {}, [], "x".repeat(5000), "\u0000\u0001", "💥 score", "score ".repeat(60)]) {
      expect(() => parseQuery(q)).not.toThrow();
    }
  });

  test("a bare city or school only counts when the query names a league", () => {
    expect(parseQuery("duke score").parsed?.kind).toBe("team"); // ESPN's short name for the school
    expect(parseQuery("chicago score").parsed).toBeNull();
    expect(parseQuery("chicago bears score").parsed?.kind).toBe("team");
  });

  test("parsed shapes", () => {
    expect(parseQuery("nfl scores today").parsed).toMatchObject({ kind: "league", leagueKeys: ["nfl"] });
    expect(parseQuery("football scores").parsed.leagueKeys).toEqual(expect.arrayContaining(["nfl", "epl", "cfb"]));
    expect(parseQuery("panthers vs rams").parsed).toMatchObject({ kind: "vs" });
    expect(parseQuery("panthers game yesterday").parsed).toMatchObject({ kind: "team", when: "yesterday" });
    expect(parseQuery("did the panthers win last night").parsed.when).toBe("yesterday");
    expect(parseQuery("next panthers game").parsed.next).toBe(true);
    expect(parseQuery("panthers score").parsed.next).toBe(false);
    expect(parseQuery("panthers hockey score").parsed.team.leagueKeys).toEqual(["nhl"]);
    expect(parseQuery("lakers vs celtics").parsed.a.candidates[0].team.displayName).toBe("Los Angeles Lakers");
  });

  test("league words are exposed longest first", () => {
    const words = leagueWords();
    expect(words.indexOf("college football")).toBeLessThan(words.indexOf("football"));
  });

  test("a URL or a calculation is rejected with a reason", () => {
    expect(parseQuery("2+2 score").reason).toMatch(/calculation|URL/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("the team index", () => {
  test("covers every league with the snapshot's counts", () => {
    const counts = Object.fromEntries(LEAGUES.map((league) => [league.key, teamsOfLeague(league.key).length]));
    expect(counts).toMatchObject({ nfl: 32, nba: 30, mlb: 30, nhl: 32, mls: 30, epl: 20, wnba: 15 });
    expect(counts.cfb).toBeGreaterThan(100);
    expect(counts.cbb).toBeGreaterThan(300);
  });

  test("teamById finds teams", () => {
    expect(teamById("nfl", "29").displayName).toBe("Carolina Panthers");
    expect(teamById("nfl", 29).abbr).toBe("CAR");
    expect(teamById("nfl", "99999")).toBeNull();
  });

  test("norm folds case, accents, punctuation", () => {
    expect(norm("  Atlético  Madrid!! ")).toBe("atletico madrid");
    expect(norm("St. Louis Cardinals")).toBe("st louis cardinals");
    expect(norm("A&M")).toBe("a and m");
    expect(norm(null)).toBe("");
  });

  const names = (text, opts) => resolveTeams(text, opts).candidates.map((c) => `${c.league.key}:${c.team.displayName}`);

  test("a nickname belongs to several leagues", () => {
    const list = names("panthers");
    expect(list).toEqual(expect.arrayContaining(["nfl:Carolina Panthers", "nhl:Florida Panthers", "cfb:Pittsburgh Panthers"]));
  });

  test("location plus nickname is exact", () => {
    expect(names("carolina panthers")).toEqual(["nfl:Carolina Panthers"]);
    expect(names("florida panthers")).toEqual(["nhl:Florida Panthers"]);
    expect(names("the carolina panthers")).toEqual(["nfl:Carolina Panthers"]);
  });

  test("a league filter narrows softly", () => {
    expect(names("panthers", { leagueKeys: ["nhl"] })).toEqual(["nhl:Florida Panthers"]);
    expect(resolveTeams("panthers", { leagueKeys: ["nhl"] }).filtered).toBe(true);
    // no such team in that league: the filter is ignored
    expect(names("lakers", { leagueKeys: ["nhl"] })).toContain("nba:Los Angeles Lakers");
    expect(resolveTeams("lakers", { leagueKeys: ["nhl"] }).filtered).toBe(false);
  });

  test("aliases", () => {
    expect(names("man utd")).toEqual(["epl:Manchester United"]);
    expect(names("niners")).toEqual(["nfl:San Francisco 49ers"]);
    expect(names("man city")).toEqual(["epl:Manchester City"]);
    expect(names("spurs")).toEqual(expect.arrayContaining(["nba:San Antonio Spurs", "epl:Tottenham Hotspur"]));
    expect(names("la lakers")).toEqual(["nba:Los Angeles Lakers"]);
    expect(names("ny yankees")).toEqual(["mlb:New York Yankees"]);
  });

  test("club words are optional", () => {
    expect(names("inter miami")).toEqual(["mls:Inter Miami CF"]);
    expect(names("atlanta united")).toEqual(["mls:Atlanta United FC"]);
  });

  test("a bare city only resolves when allowed", () => {
    expect(names("carolina")).toEqual([]);
    expect(names("carolina", { allowLocation: true }).length).toBeGreaterThan(0);
    expect(names("atlanta")).toEqual([]);
  });

  test("garbage resolves to nothing", () => {
    expect(names("")).toEqual([]);
    expect(names("ram trucks")).toEqual([]);
    expect(names("🙂")).toEqual([]);
  });

  test("an empty snapshot gives an empty index", () => {
    expect(buildIndex({ leagues: {} }).teams).toEqual([]);
    expect(index().teams.length).toBeGreaterThan(600);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("ESPN parsing", () => {
  const nfl = leagueByKey("nfl");
  const nba = leagueByKey("nba");
  const mlb = leagueByKey("mlb");
  const nhl = leagueByKey("nhl");
  const epl = leagueByKey("epl");
  const cbb = leagueByKey("cbb");
  const ev = (status, extra = {}) => parseEvent(game({ away: side(T.panthers, 17, { record: "5-2" }), home: side(T.packers, 24, { record: "6-1" }), status, ...extra }), nfl);

  test("a scoreboard game: away team first, even though the feed lists home first", () => {
    const g = ev(STATUS.live({ period: 3, clock: "4:12" }));
    expect(g.teams.map((t) => t.short)).toEqual(["Panthers", "Packers"]);
    expect(g.teams.map((t) => t.score)).toEqual(["17", "24"]);
    expect(g.teams.map((t) => t.record)).toEqual(["5-2", "6-1"]);
    expect(g.teams[0].logo).toBe(LOGO("CAR"));
    expect(g.venue).toEqual({ name: "Test Field", place: "Springfield, NC" });
    expect(g.tv).toEqual(["ESPN"]);
  });

  describe("football", () => {
    test("in progress", () => expect(ev(STATUS.live({ period: 3, clock: "4:12" }))).toMatchObject({ state: "in", phase: "live", label: "Q3 · 4:12" }));
    test("overtime", () => expect(ev(STATUS.live({ period: 5, clock: "6:30" })).label).toBe("OT · 6:30"));
    test("second overtime", () => expect(ev(STATUS.live({ period: 6, clock: "6:30" })).label).toBe("2OT · 6:30"));
    test("halftime", () => expect(ev(STATUS.halftime())).toMatchObject({ phase: "halftime", label: "Halftime" }));
    test("end of a quarter", () => expect(ev(STATUS.endPeriod(1))).toMatchObject({ phase: "break", label: "End of Q1" }));
    test("final", () => expect(ev(STATUS.final())).toMatchObject({ state: "post", phase: "final", label: "Final" }));
    test("final/OT", () => expect(ev(STATUS.final("Final/OT")).label).toBe("Final/OT"));
    test("F/OT is spelled out", () => expect(ev(STATUS.final("F/OT")).label).toBe("Final/OT"));
    test("scheduled", () => expect(ev(STATUS.pre())).toMatchObject({ state: "pre", phase: "scheduled", label: "" }));
    test("postponed", () => expect(ev(STATUS.postponed())).toMatchObject({ phase: "postponed", label: "Postponed" }));
    test("canceled", () => expect(ev(STATUS.canceled())).toMatchObject({ phase: "canceled", label: "Canceled" }));
    test("delayed", () => expect(ev(STATUS.delayed("Delayed - Weather"))).toMatchObject({ phase: "delayed", label: "Delayed - Weather" }));
    test("suspended", () => expect(ev(STATUS.suspended())).toMatchObject({ phase: "suspended", label: "Suspended" }));
    test("down and distance from the situation", () => {
      const g = ev(STATUS.live({ period: 2, clock: "9:00" }), { situation: { shortDownDistanceText: "2nd & 7", downDistanceText: "2nd & 7 at GB 35", lastPlay: { text: "pass" } } });
      expect(g.situation).toBe("2nd & 7");
    });
    test("an unknown situation shape is ignored", () => {
      expect(ev(STATUS.live({ period: 2 }), { situation: { weird: true } }).situation).toBe("");
      expect(ev(STATUS.live({ period: 2 }), { situation: "text" }).situation).toBe("");
    });
    test("no situation on a finished game", () => {
      expect(ev(STATUS.final(), { situation: { shortDownDistanceText: "1st & 10" } }).situation).toBe("");
    });
  });

  describe("basketball", () => {
    const b = (status) => parseEvent(game({ away: side(T.celtics, 50), home: side(T.lakers, 52), status }), nba);
    test("in progress", () => expect(b(STATUS.live({ period: 2, clock: "6:11" })).label).toBe("Q2 · 6:11"));
    test("fourth quarter", () => expect(b(STATUS.live({ period: 4, clock: "0:42" })).label).toBe("Q4 · 0:42"));
    test("overtime", () => expect(b(STATUS.live({ period: 5, clock: "3:00" })).label).toBe("OT · 3:00"));
    test("halftime", () => expect(b(STATUS.halftime()).label).toBe("Halftime"));
    test("last play when nothing else is known", () => {
      const g = parseEvent(game({ away: side(T.celtics, 50), home: side(T.lakers, 52), status: STATUS.live({ period: 2 }), situation: { lastPlay: { text: "Layup made" } } }), nba);
      expect(g.situation).toBe("Last play: Layup made");
    });
    test("college basketball is played in halves", () => {
      const c = (period, clock = "12:00") => parseEvent(game({ away: side(T.duke, 30), home: side(T.tarHeels, 28), status: STATUS.live({ period, clock }) }), cbb).label;
      expect(c(1)).toBe("1st half · 12:00");
      expect(c(2, "3:21")).toBe("2nd half · 3:21");
      expect(c(3, "4:00")).toBe("OT · 4:00");
      expect(c(4, "4:00")).toBe("2OT · 4:00");
    });
    test("a clock at zero is left out", () => expect(b(STATUS.live({ period: 3, clock: "0:00" })).label).toBe("Q3"));
  });

  describe("baseball", () => {
    const m = (detail, period = 6) => parseEvent(game({ away: side(T.yankees, 3), home: side(T.braves, 2), status: STATUS.live({ period, clock: "0:00", detail, short: detail }) }), mlb).label;
    test("top of an inning", () => expect(m("Top 6th")).toBe("Top 6th"));
    test("bottom of an inning", () => expect(m("Bot 9th", 9)).toBe("Bottom 9th"));
    test("middle", () => expect(m("Mid 3rd", 3)).toBe("Middle 3rd"));
    test("end", () => expect(m("End 1st", 1)).toBe("End 1st"));
    test("extra innings", () => expect(m("Top 11th", 11)).toBe("Top 11th"));
    test("an odd detail falls back to the period", () => expect(m("In Progress", 7)).toBe("7th inning"));
    test("count, outs and runners", () => {
      const g = parseEvent(game({ away: side(T.yankees, 3), home: side(T.braves, 2), status: STATUS.live({ period: 6, detail: "Top 6th", short: "Top 6th" }), situation: { balls: 2, strikes: 1, outs: 1, onFirst: true, onThird: true } }), mlb);
      expect(g.situation).toBe("2-1 count · 1 out · runners on 1st, 3rd");
    });
    test("final in extra innings", () => expect(parseEvent(game({ away: side(T.yankees, 3), home: side(T.braves, 4), status: STATUS.final("Final/11") }), mlb).label).toBe("Final/11"));
    test("line score keeps X for an unplayed bottom of the 9th", () => {
      const g = parseEvent(game({ away: side(T.yankees, 3, { lines: [0, 0, 1, 0, 0, 2, 0, 0, 0] }), home: side(T.braves, 2), status: STATUS.final() }), mlb);
      expect(g.teams[0].lines).toHaveLength(9);
    });
  });

  describe("hockey", () => {
    const h = (status) => parseEvent(game({ away: side(T.flaPanthers, 2), home: side(T.bruins, 2), status }), nhl);
    test("in progress", () => expect(h(STATUS.live({ period: 1, clock: "12:02" })).label).toBe("P1 · 12:02"));
    test("third period", () => expect(h(STATUS.live({ period: 3, clock: "0:31" })).label).toBe("P3 · 0:31"));
    test("overtime", () => expect(h(STATUS.live({ period: 4, clock: "2:11" })).label).toBe("OT · 2:11"));
    test("intermission", () => expect(h(STATUS.endPeriod(2))).toMatchObject({ phase: "break", label: "End of P2" }));
    test("shootout", () => expect(h(STATUS.live({ period: 5, clock: "0:00", name: "STATUS_SHOOTOUT" })).label).toBe("Shootout"));
    test("final/SO", () => expect(h(STATUS.final("Final/SO")).label).toBe("Final/SO"));
  });

  describe("soccer", () => {
    const s = (status) => parseEvent(game({ away: side(T.arsenal, 1), home: side(T.liverpool, 0), status }), epl);
    test("first half", () => expect(s(STATUS.live({ period: 1, clock: "13'", name: "STATUS_FIRST_HALF" })).label).toBe("1st Half 13'"));
    test("second half", () => expect(s(STATUS.live({ period: 2, clock: "67'", name: "STATUS_SECOND_HALF" })).label).toBe("2nd Half 67'"));
    test("stoppage time", () => expect(s(STATUS.live({ period: 2, clock: "90'+4'" })).label).toBe("2nd Half 90'+4'"));
    test("halftime", () => expect(s(STATUS.halftime()).label).toBe("Halftime"));
    test("full time is Final", () => expect(s(STATUS.final("FT")).label).toBe("Final"));
    test("after extra time", () => expect(s(STATUS.final("AET")).label).toBe("Final/AET"));
    test("scheduled", () => expect(s(STATUS.pre()).state).toBe("pre"));
  });

  test("a status without a state is inferred from its name", () => {
    const raw = game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: { type: { name: "STATUS_FINAL" } } });
    expect(parseEvent(raw, nfl)).toMatchObject({ state: "post", phase: "final" });
    const live = game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: { period: 2, displayClock: "1:00", type: { name: "STATUS_IN_PROGRESS" } } });
    expect(parseEvent(live, nfl)).toMatchObject({ state: "in", label: "Q2 · 1:00" });
  });

  test("a halftime flag on a game that is not in progress is ignored", () => {
    const raw = game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: { type: { name: "STATUS_HALFTIME", state: "post", completed: true, shortDetail: "Final" } } });
    expect(parseEvent(raw, nfl)).toMatchObject({ state: "post", phase: "final", label: "Final" });
  });

  test("scores only show for games that started", () => {
    const pre = ev(STATUS.pre());
    expect(pre.teams.map((t) => t.score)).toEqual(["", ""]);
    const ppd = ev(STATUS.postponed());
    expect(ppd.teams.map((t) => t.score)).toEqual(["", ""]);
  });

  test("the winner is the flagged team, or the higher score when the flag is missing", () => {
    const flagged = parseEvent(game({ away: side(T.panthers, 17, { winner: false }), home: side(T.packers, 24, { winner: true }), status: STATUS.final() }), nfl);
    expect(flagged.teams.map((t) => t.winner)).toEqual([false, true]);
    const inferred = parseEvent(game({ away: side(T.panthers, 27), home: side(T.packers, 24), status: STATUS.final() }), nfl);
    expect(inferred.teams.map((t) => t.winner)).toEqual([true, false]);
    const tied = parseEvent(game({ away: side(T.panthers, 24), home: side(T.packers, 24), status: STATUS.final() }), nfl);
    expect(tied.teams.map((t) => t.winner)).toEqual([false, false]);
    const live = parseEvent(game({ away: side(T.panthers, 27, { winner: true }), home: side(T.packers, 24), status: STATUS.live({ period: 2 }) }), nfl);
    expect(live.teams.map((t) => t.winner)).toEqual([false, false]);
  });

  test("line scores, records, ranks, leaders", () => {
    const g = parseEvent(
      game({
        away: side(T.duke, 80, { lines: [38, 42], leaders: [["PTS", "A. Example", "24"]], rank: 5, record: "2-0" }),
        home: side(T.tarHeels, 74, { lines: [30, 44], leaders: [["PTS", "B. Sample", "19"]], rank: 99 }),
        status: STATUS.final(),
      }),
      cbb,
    );
    expect(g.teams[0].lines).toEqual(["38", "42"]);
    expect(g.teams[0].rank).toBe(5);
    expect(g.teams[1].rank).toBe(0);
    expect(g.leaders).toEqual([
      { abbr: "DUKE", text: "A. Example 24 PTS" },
      { abbr: "UNC", text: "B. Sample 19 PTS" },
    ]);
  });

  test("leaders are left out before the game starts", () => {
    const g = parseEvent(game({ away: side(T.panthers, 0, { leaders: [["PYDS", "A. Example", "300"]] }), home: side(T.packers, 0), status: STATUS.pre() }), nfl);
    expect(g.leaders).toEqual([]);
  });

  test("a schedule game has object scores and no line scores", () => {
    const raw = scheduleEvent({ id: "77", date: iso(NOW - 2 * DAY), away: side(T.panthers, 20, { winner: true, record: "4-3" }), home: side(T.rams, 17), status: STATUS.final(), tv: ["CBS"], venue: { name: "Some Stadium", city: "Los Angeles", state: "CA" } });
    const g = parseEvent(raw, nfl, "schedule");
    expect(g.teams.map((t) => t.score)).toEqual(["20", "17"]);
    expect(g.teams[0]).toMatchObject({ winner: true, record: "4-3", lines: [], logo: LOGO("CAR") });
    expect(g.tv).toEqual(["CBS"]);
    expect(g.source).toBe("schedule");
  });

  test("a scoreboard parse and a schedule parse", () => {
    const board = parseScoreboard(JSON.stringify(scoreboard([game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: STATUS.final() })], { week: 9 })), nfl);
    expect(board.games).toHaveLength(1);
    expect(board.week).toBe(9);
    const sched = parseSchedule(JSON.stringify(schedule([scheduleEvent({ id: "1", date: iso(NOW), away: side(T.panthers, 1), home: side(T.packers, 0), status: STATUS.final() })])), nfl);
    expect(sched.games).toHaveLength(1);
  });

  test("an empty scoreboard (off-season) is an empty list, not an error", () => {
    expect(parseScoreboard(JSON.stringify(scoreboard([])), nfl)).toEqual({ games: [], week: 0 });
  });

  test("unreadable replies give null", () => {
    expect(parseScoreboard("not json", nfl)).toBeNull();
    expect(parseScoreboard("[]", nfl)).toBeNull();
    expect(parseScoreboard("{}", nfl)).toBeNull();
    expect(parseScoreboard(JSON.stringify({ events: "nope" }), nfl)).toBeNull();
    expect(parseSchedule("", nfl)).toBeNull();
  });

  test("broken events are dropped one by one", () => {
    const good = game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: STATUS.final() });
    const raw = JSON.stringify({ events: [null, 5, {}, { id: "1", date: "x", competitions: [] }, { id: "2", date: "not a date", competitions: [{ competitors: [] }] }, good] });
    expect(parseScoreboard(raw, nfl).games).toHaveLength(1);
  });

  test("an event with one competitor or a bad date is dropped", () => {
    const one = game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: STATUS.final() });
    one.competitions[0].competitors.pop();
    expect(parseEvent(one, nfl)).toBeNull();
    const bad = game({ away: side(T.panthers, 1), home: side(T.packers, 0), status: STATUS.final(), date: "soon" });
    expect(parseEvent(bad, nfl)).toBeNull();
  });

  test("hostile text is trimmed and stripped of control characters", () => {
    const raw = game({ away: side({ ...T.panthers, displayName: `Evil\u0000 <img src=x onerror=alert(1)> ${"x".repeat(200)}` }, 1), home: side(T.packers, 0), status: STATUS.final() });
    const g = parseEvent(raw, nfl);
    expect(g.teams[0].name.length).toBeLessThanOrEqual(60);
    expect(g.teams[0].name).not.toContain("\u0000");
  });

  test("scores that are not whole numbers are dropped", () => {
    const raw = game({ away: side(T.panthers, "<b>9</b>"), home: side(T.packers, -4), status: STATUS.final() });
    expect(parseEvent(raw, nfl).teams.map((t) => t.score)).toEqual(["", ""]);
  });

  test("logos: only https espncdn.com", () => {
    expect(safeLogo("https://a.espncdn.com/i/teamlogos/nfl/500/car.png")).toBe("https://a.espncdn.com/i/teamlogos/nfl/500/car.png");
    expect(safeLogo("https://espncdn.com/x.png")).toContain("espncdn.com");
    for (const bad of ["http://a.espncdn.com/x.png", "https://evil.example/x.png", "https://espncdn.com.evil.example/x.png", "javascript:alert(1)", "", null, undefined, "//a.espncdn.com/x.png"]) expect(safeLogo(bad)).toBe("");
  });

  test("helpers", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]);
    expect(finalLabel({ type: { shortDetail: "Final/OT" } })).toBe("Final/OT");
    expect(finalLabel({ type: { shortDetail: "FT-Pens" } })).toBe("Final/Pens");
    expect(finalLabel({})).toBe("Final");
    expect(liveLabel(null, "live", { period: 2, displayClock: "1:00" })).toBe("");
  });

  test("urls", () => {
    expect(scoreboardUrl(DEFAULT_BASE, nfl)).toBe("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
    expect(scoreboardUrl(DEFAULT_BASE, nfl, { dates: "20261027" })).toBe("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=20261027");
    expect(scoreboardUrl(DEFAULT_BASE, nfl, { dates: "yesterday" })).not.toContain("dates");
    expect(scoreboardUrl(DEFAULT_BASE, leagueByKey("cfb"))).toContain("groups=80");
    expect(scheduleUrl(DEFAULT_BASE, nfl, "29")).toBe("https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams/29/schedule");
    expect(scheduleUrl(DEFAULT_BASE, nfl, "29/../../x")).toBe("");
    expect(baseFrom("http://localhost:9/apis/x/")).toBe("http://localhost:9/apis/x");
    expect(baseFrom("ftp://x")).toBe(DEFAULT_BASE);
    expect(baseFrom("not a url")).toBe(DEFAULT_BASE);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("time", () => {
  test("zones", () => {
    expect(validZone("America/New_York")).toBe("America/New_York");
    expect(validZone("Europe/London")).toBe("Europe/London");
    for (const bad of ["", "Mars/Olympus", "<script>", "x".repeat(100), null, undefined, "America/New York"]) expect(validZone(bad)).toBe("");
    expect(validZone(serverZone())).not.toBe("");
  });

  test("day keys and differences", () => {
    expect(dayKey(Date.parse("2026-10-29T03:00:00Z"), ZONE)).toBe("2026-10-28");
    expect(dayKey(Date.parse("2026-10-29T03:00:00Z"), "Asia/Tokyo")).toBe("2026-10-29");
    expect(dayDiff(NOW + DAY, NOW, ZONE)).toBe(1);
    expect(dayDiff(NOW - DAY, NOW, ZONE)).toBe(-1);
    expect(dayDiff(NOW + HOUR, NOW, ZONE)).toBe(0);
    // 23:00Z is 19:00 in New York: +6 h crosses midnight there
    expect(dayDiff(NOW + 6 * HOUR, NOW, ZONE)).toBe(1);
  });

  test("ESPN's date parameter is the Eastern date", () => {
    expect(espnDate(Date.parse("2026-10-29T03:00:00Z"))).toBe("20261028");
    expect(whenToDate("yesterday", NOW)).toBe("20261027");
    expect(whenToDate("tomorrow", NOW)).toBe("20261029");
    expect(whenToDate("", NOW)).toBe("");
  });

  test("kick-off labels", () => {
    expect(kickoffLabel(NOW + HOUR, NOW, ZONE)).toBe("Today 8:00 PM EDT");
    expect(kickoffLabel(NOW + DAY, NOW, ZONE)).toBe("Tomorrow 7:00 PM EDT");
    expect(kickoffLabel(Date.parse("2026-11-01T18:00:00Z"), NOW, ZONE)).toBe("Sun 1:00 PM EST");
    expect(kickoffLabel(Date.parse("2026-11-20T18:00:00Z"), NOW, ZONE)).toBe("Nov 20, 1:00 PM EST");
    expect(kickoffLabel(NOW - DAY, NOW, ZONE)).toContain("Yesterday");
    expect(kickoffLabel(Date.parse("2026-11-01T18:00:00Z"), NOW, "Europe/London")).toBe("Sun 6:00 PM GMT");
    expect(kickoffLabel(NaN, NOW, ZONE)).toBe("");
  });

  test("short dates", () => {
    expect(shortDate(Date.parse("2026-10-26T20:00:00Z"), ZONE)).toBe("Oct 26");
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("ranking and choosing games", () => {
  const nfl = leagueByKey("nfl");
  const g = (id, ts, state, phase, away = T.panthers, home = T.packers) => ({ id, ts, state, phase, teams: [{ id: away.id }, { id: home.id }] });

  test("game scores: live, today, near, far", () => {
    expect(gameScore(g("1", NOW, "in", "live"), NOW, ZONE)).toBe(1000);
    expect(gameScore(g("1", NOW + HOUR, "pre", "scheduled"), NOW, ZONE)).toBe(800);
    expect(gameScore(g("1", NOW - 3 * DAY, "post", "final"), NOW, ZONE)).toBeGreaterThan(400);
    expect(gameScore(g("1", NOW - 3 * DAY, "post", "final"), NOW, ZONE)).toBeLessThan(600);
    expect(gameScore(g("1", NOW - NEAR_MS - DAY, "post", "final"), NOW, ZONE)).toBe(0);
    expect(gameScore(g("1", NOW + HOUR, "post", "postponed"), NOW, ZONE)).toBe(0);
    expect(gameScore(null, NOW, ZONE)).toBe(0);
    expect(gameScore(g("1", NOW - HOUR, "in", "suspended"), NOW, ZONE)).toBe(800);
  });

  test("closer games rank higher", () => {
    expect(gameScore(g("1", NOW + 2 * DAY, "pre", "scheduled"), NOW, ZONE)).toBeGreaterThan(gameScore(g("2", NOW + 5 * DAY, "pre", "scheduled"), NOW, ZONE));
  });

  test("bestGame picks live before a later game", () => {
    const best = bestGame([g("a", NOW + 3 * DAY, "pre", "scheduled"), g("b", NOW, "in", "live"), g("c", NOW - 3 * DAY, "post", "final")], T.panthers.id, NOW, ZONE);
    expect(best.game.id).toBe("b");
    expect(bestGame([g("a", NOW, "in", "live")], "999", NOW, ZONE)).toBeNull();
    expect(involves(g("a", NOW, "in", "live"), 29)).toBe(true);
  });

  const cand = (team, league) => ({ team: { ...team, league }, league: leagueByKey(league), kind: "nick" });
  test("ranking: a live game beats league priority; pro beats college", () => {
    const nflPanthers = cand({ id: "29" }, "nfl");
    const nhlPanthers = cand({ id: "26" }, "nhl");
    const pitt = cand({ id: "221" }, "cfb");
    const facts = new Map([
      ["nfl:29", { score: 800, game: {} }],
      ["nhl:26", { score: 1000, game: {} }],
      ["cfb:221", { score: 1000, game: {} }],
    ]);
    expect(rankTeams([nflPanthers, nhlPanthers, pitt], facts).map((c) => c.team.id)).toEqual(["26", "29", "221"]);
    // nothing on: league priority
    expect(rankTeams([nhlPanthers, nflPanthers], new Map()).map((c) => c.team.id)).toEqual(["29", "26"]);
    // only college candidates: no tier penalty
    expect(rankTeams([pitt], new Map())[0].tier).toBe(0);
  });

  test("pickScheduled", () => {
    const games = [g("old", NOW - 9 * DAY, "post", "final"), g("last", NOW - 3 * DAY, "post", "final"), g("next", NOW + 4 * DAY, "pre", "scheduled"), g("later", NOW + 11 * DAY, "pre", "scheduled")];
    expect(pickScheduled(games, "", NOW, ZONE).id).toBe("last");
    expect(pickScheduled(games, "next", NOW, ZONE).id).toBe("next");
    expect(pickScheduled(games, "past", NOW, ZONE).id).toBe("last");
    expect(pickScheduled([...games, g("live", NOW, "in", "live")], "", NOW, ZONE).id).toBe("live");
    expect(pickScheduled([...games, g("live", NOW, "in", "live")], "next", NOW, ZONE).id).toBe("next");
    expect(pickScheduled([...games, g("y", NOW - DAY, "post", "final")], "yesterday", NOW, ZONE).id).toBe("y");
    expect(pickScheduled(games, "yesterday", NOW, ZONE)).toBeNull();
    expect(pickScheduled([...games, g("t", NOW + DAY, "pre", "scheduled")], "tomorrow", NOW, ZONE).id).toBe("t");
    expect(pickScheduled([], "", NOW, ZONE)).toBeNull();
    expect(pickScheduled([g("c", NOW, "post", "canceled")], "", NOW, ZONE)).toBeNull();
    // the closer one wins when a past and a coming game are both near
    expect(pickScheduled([g("l", NOW - 5 * DAY, "post", "final"), g("n", NOW + 1.5 * DAY, "pre", "scheduled")], "", NOW, ZONE).id).toBe("n");
    // a game today wins over the nearest
    expect(pickScheduled([g("l", NOW - 3 * HOUR, "post", "final"), g("n", NOW + 2 * DAY, "pre", "scheduled")], "", NOW, ZONE).id).toBe("l");
    // "did they win" skips a game that has not started
    expect(pickScheduled([g("l", NOW - 5 * DAY, "post", "final"), g("n", NOW + HOUR, "pre", "scheduled")], "past", NOW, ZONE).id).toBe("l");
  });

  test("surrounding: the next and last other game", () => {
    const games = [g("a", NOW - 9 * DAY, "post", "final"), g("b", NOW - 2 * DAY, "post", "final"), g("c", NOW + HOUR, "pre", "scheduled"), g("d", NOW + 5 * DAY, "pre", "scheduled")];
    expect(surrounding(games, games[2], NOW)).toMatchObject({ next: { id: "d" }, last: { id: "b" } });
    expect(surrounding(games, games[1], NOW)).toMatchObject({ next: { id: "c" }, last: { id: "a" } });
    expect(surrounding(games, null, NOW).next.id).toBe("c");
    expect(surrounding([], games[0], NOW)).toEqual({ next: null, last: null });
  });

  test("board order and cache lifetime", () => {
    const list = [g("f", NOW - 3 * HOUR, "post", "final"), g("p", NOW + 3 * HOUR, "pre", "scheduled"), g("l", NOW - HOUR, "in", "live"), g("p2", NOW + HOUR, "pre", "scheduled")];
    expect(orderBoard(list).map((x) => x.id)).toEqual(["l", "p2", "p", "f"]);
    expect(boardTtl(list, NOW)).toBe(20_000);
    expect(boardTtl([g("p", NOW + 20 * 60_000, "pre", "scheduled")], NOW)).toBe(60_000);
    expect(boardTtl([g("p", NOW + 5 * HOUR, "pre", "scheduled"), g("f", NOW - 3 * HOUR, "post", "final")], NOW)).toBe(300_000);
    expect(boardTtl([], NOW)).toBe(300_000);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("cards", () => {
  const nfl = leagueByKey("nfl");
  const nba = leagueByKey("nba");
  const ctx = (extra = {}) => ({ layout: "inline", zone: ZONE, now: NOW, logo: (url) => `/proxy?u=${encodeURIComponent(url)}`, refresh: null, ...extra });
  const live = parseEvent(game({ away: side(T.panthers, 17, { record: "5-2", lines: [7, 3, 7, 0], leaders: [["PYDS", "A. Example", "212 YDS"]] }), home: side(T.packers, 24, { record: "6-1", lines: [10, 7, 0, 7], leaders: [["PYDS", "B. Sample", "188 YDS"]] }), status: STATUS.live({ period: 3, clock: "4:12" }), notes: ["Week 9"], situation: { shortDownDistanceText: "3rd & 4" } }), nfl);
  const final = parseEvent(game({ away: side(T.panthers, 17, { record: "5-2" }), home: side(T.packers, 24, { record: "6-1" }), status: STATUS.final("Final/OT"), date: iso(NOW - 3 * HOUR) }), nfl);
  const pre = parseEvent(game({ away: side(T.panthers, 0, { record: "5-2" }), home: side(T.packers, 0, { record: "6-1" }), status: STATUS.pre(), date: iso(NOW + DAY) }), nfl);

  test("an inline live card", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [], next: null, last: null }, ctx({ refresh: { query: "panthers score", seconds: 30 } }));
    expect(html).toContain("sports-card--inline");
    expect(html).toContain('data-live="true"');
    expect(html).toContain('data-query="panthers score"');
    expect(html).toContain('data-refresh="30"');
    expect(html).toContain("NFL · Panthers");
    expect(html).toContain("sports-pill--live");
    expect(html).toContain("Q3 · 4:12");
    expect(html).toContain("Week 9");
    expect(html).toContain("3rd &amp; 4");
    expect(html).toContain("Test Field");
    expect(html).toContain("ESPN");
    expect(html).toContain("sports-lines");
    expect(html).toContain("A. Example 212 YDS");
    expect(html).toContain("Data from");
    // away team first
    expect(html.indexOf("Carolina Panthers")).toBeLessThan(html.indexOf("Green Bay Packers"));
    expect(html).toContain('<img class="sports-logo"');
  });

  test("a live card without autoRefresh carries no refresh attributes", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [] }, ctx());
    expect(html).toContain('data-live="true"');
    expect(html).not.toContain("data-query");
    expect(html).not.toContain("data-refresh");
  });

  test("a final card marks the winner without relying on colour", () => {
    const html = buildGameCard({ game: final, league: nfl, focusId: "29", chips: [] }, ctx({ refresh: { query: "q", seconds: 30 } }));
    expect(html).toContain('data-live="false"');
    expect(html).not.toContain("data-query");
    expect(html).toContain("sports-team--winner");
    expect(html).toContain("sports-team--loser");
    expect(html).toContain("Winner");
    expect(html).toContain("<svg");
    expect(html).toContain("Final/OT");
    expect(html).toContain("Oct 28");
    expect(html.match(/sports-team--winner/g)).toHaveLength(1);
  });

  test("a scheduled card has the kick-off time and no scores", () => {
    const html = buildGameCard({ game: pre, league: nfl, focusId: "29", chips: [] }, ctx());
    expect(html).toContain("sports-pill--pre");
    expect(html).toContain("Tomorrow 7:00 PM EDT");
    expect(html).not.toContain("sports-score");
    expect(html).not.toContain("sports-lines");
    expect(html).toContain("5-2");
  });

  test("postponed and canceled", () => {
    for (const status of [STATUS.postponed(), STATUS.canceled()]) {
      const g = parseEvent(game({ away: side(T.panthers, 0), home: side(T.packers, 0), status, date: iso(NOW + DAY) }), nfl);
      const html = buildGameCard({ game: g, league: nfl, focusId: "29", chips: [] }, ctx());
      expect(html).toContain(g.label);
      expect(html).toContain("was Tomorrow");
      expect(html).not.toContain("sports-score");
    }
  });

  test("delayed", () => {
    const g = parseEvent(game({ away: side(T.panthers, 3), home: side(T.packers, 0), status: STATUS.delayed("Delayed - Weather") }), nfl);
    const html = buildGameCard({ game: g, league: nfl, focusId: "29", chips: [] }, ctx({ refresh: { query: "q", seconds: 30 } }));
    expect(html).toContain("sports-pill--warn");
    expect(html).toContain("Delayed - Weather");
    expect(html).toContain('data-live="true"');
  });

  test("the compact panel card", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [{ label: "x", href: "search?q=x" }], next: pre, last: final }, ctx({ layout: "panel" }));
    expect(html).toContain("sports-card--panel");
    expect(html).toContain("Panthers");
    expect(html).not.toContain("Carolina Panthers");
    expect(html).not.toContain("sports-lines");
    expect(html).not.toContain("sports-leaders");
    expect(html).not.toContain("sports-around");
    expect(html).not.toContain("sports-chip");
    expect(html).toContain("Test Field");
    expect(html.length).toBeLessThan(buildGameCard({ game: live, league: nfl, focusId: "29", chips: [] }, ctx()).length);
  });

  test("next and last lines", () => {
    const last = parseEvent(game({ id: "900", date: iso(NOW - 3 * DAY), away: side(T.rams, 10), home: side(T.panthers, 20), status: STATUS.final() }), nfl);
    const next = parseEvent(game({ id: "901", date: iso(NOW + 4 * DAY), away: side(T.panthers, 0), home: side(T.chiefs, 0), status: STATUS.pre() }), nfl);
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [], next, last }, ctx());
    expect(html).toContain("W 20–10 vs Rams · Oct 25");
    expect(html).toContain("Sun 6:00 PM EST at Chiefs");
  });

  test("a loss is an L", () => {
    const last = parseEvent(game({ id: "900", date: iso(NOW - 3 * DAY), away: side(T.rams, 30), home: side(T.panthers, 20), status: STATUS.final() }), nfl);
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [], next: null, last }, ctx());
    expect(html).toContain("L 20–30 vs Rams");
  });

  test("chips are relative search links", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [{ label: "Florida Panthers · NHL", href: searchHref("florida panthers score") }] }, ctx());
    expect(html).toContain('<a class="sports-chip sports-link" href="search?q=florida%20panthers%20score">Florida Panthers · NHL</a>');
    expect(html).toContain("Also");
  });

  test("logo: no proxy, no image, only the badge", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [] }, ctx({ logo: null }));
    expect(html).not.toContain("<img");
    expect(html).toContain('class="sports-badge">CAR<');
  });

  test("logo: a proxy that fails leaves the badge", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [] }, ctx({ logo: () => "" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("sports-badge");
  });

  test("logos only through the proxy function", () => {
    const html = buildGameCard({ game: live, league: nfl, focusId: "29", chips: [] }, ctx({ logo: () => "/proxy?token=abc" }));
    expect(html).not.toContain("espncdn.com");
    expect(html).toContain("/proxy?token=abc");
  });

  test("everything is escaped and nothing is styled inline", () => {
    const evil = parseEvent(game({ away: side({ ...T.panthers, displayName: '<script>alert("x")</script>', short: '"><img src=x onerror=alert(1)>', abbr: "<b>" }, 1, { record: "<i>1</i>" }), home: side(T.packers, 2), status: STATUS.final(), notes: ["<u>note</u>"], venue: { name: "<svg onload=1>", city: "</div>", state: "&" } }), nfl);
    const html = buildGameCard({ game: evil, league: nfl, focusId: evil.teams[0].id, chips: [{ label: "<x>", href: 'search?q="><x>' }] }, ctx({ refresh: { query: '"><script>', seconds: 30 } }));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toMatch(/\sstyle=/i);
    for (const tag of html.match(/<img[^>]*>/g) ?? []) expect(tag).toContain('class="sports-logo"');
    expect(html).toContain("&lt;script&gt;");
  });

  test("a league card, inline and panel", () => {
    const games = [live, final, pre];
    const inline = buildLeagueCard({ league: nfl, games, week: 9 }, ctx({ refresh: { query: "nfl scores", seconds: 30 } }));
    expect(inline).toContain("NFL · Scores");
    expect(inline).toContain("Week 9");
    expect(inline).toContain('data-live="true"');
    expect(inline).toContain('data-query="nfl scores"');
    expect(inline.match(/class="sports-game"/g)).toHaveLength(3);
    expect(inline).toContain("Final/OT");
    const panel = buildLeagueCard({ league: nfl, games: Array.from({ length: 10 }, () => final), week: 0 }, ctx({ layout: "panel" }));
    expect(panel.match(/class="sports-game"/g)).toHaveLength(PANEL_LIST_MAX);
    expect(panel).toContain("and 4 more");
    const big = buildLeagueCard({ league: nfl, games: Array.from({ length: 40 }, () => final), week: 0 }, ctx());
    expect(big.match(/class="sports-game"/g)).toHaveLength(INLINE_LIST_MAX);
    expect(buildLeagueCard({ league: nba, games: [], week: 0 }, ctx())).toContain("No games");
  });

  test("a league card without a live game has no refresh", () => {
    const html = buildLeagueCard({ league: nfl, games: [final], week: 0 }, ctx({ refresh: { query: "q", seconds: 30 } }));
    expect(html).toContain('data-live="false"');
    expect(html).not.toContain("data-query");
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("the slot", () => {
  const liveNfl = () => game({ id: "401", away: side(T.panthers, 17, { record: "5-2", lines: [7, 3, 7, 0], leaders: [["PYDS", "A. Example", "212 YDS"]] }), home: side(T.packers, 24, { record: "6-1", lines: [10, 7, 7, 0] }), status: STATUS.live({ period: 3, clock: "4:12" }) });
  const finalNfl = (id, ts, away, home, extra = {}) => game({ id, date: iso(ts), away, home, status: STATUS.final(), ...extra });
  const panthersSchedule = () =>
    schedule([
      scheduleEvent({ id: "300", date: iso(NOW - 3 * DAY), away: side(T.rams, 10), home: side(T.panthers, 20, { winner: true }), status: STATUS.final(), tv: ["FOX"] }),
      scheduleEvent({ id: "401", date: iso(NOW - HOUR), away: side(T.panthers, 17), home: side(T.packers, 24), status: STATUS.live({ period: 3 }) }),
      scheduleEvent({ id: "402", date: iso(NOW + 4 * DAY), away: side(T.panthers, 0), home: side(T.chiefs, 0), status: STATUS.pre() }),
    ]);

  const nflLive = () => world({ boards: { nfl: scoreboard([liveNfl()], { week: 9 }) }, schedules: { "nfl:29": panthersSchedule() } });
  const html = async (slot, query, w) => run(slot, query, { fetch: w.fetch });

  test("is a slot with the expected identity and position", () => {
    const slot = makeSlot();
    expect(slot.id).toBe("sports");
    expect(slot.position).toBe(INLINE_POSITION);
    expect(INLINE_POSITION).toBe("above-results");
    expect(PANEL_POSITION).toBe("knowledge-panel");
    expect("slotPositions" in slot).toBe(false);
    expect(slot.isClientExposed).toBe(false);
    expect(typeof slot.trigger).toBe("function");
  });

  test("an ambiguous nickname: the team with a live game wins, the others are chips", async () => {
    const w = nflLive();
    const out = await html(makeSlot(), "panthers score", w);
    expect(out).toContain("command-result sports-result");
    expect(out).toContain("NFL · Panthers");
    expect(out).toContain("Q3 · 4:12");
    expect(out).toContain("Carolina Panthers");
    expect(out).toContain("Florida Panthers · NHL");
    expect(out).toContain("Last");
    expect(out).toContain("W 20–10 vs Rams");
    expect(out).toContain("Sun 6:00 PM EST at Chiefs");
    expect(w.count("board")).toBe(2); // nfl + nhl, the other ranking candidates are college teams
    expect(w.count("schedule")).toBe(1);
  });

  test("a repeat search is served from the cache; a live board expires after 20 seconds", async () => {
    const w = nflLive();
    const time = clock();
    const slot = makeSlot({}, { time });
    await html(slot, "panthers score", w);
    const first = w.calls.length;
    await html(slot, "panthers score", w);
    expect(w.calls.length).toBe(first);
    time.state.t += 25_000;
    await html(slot, "panthers score", w);
    expect(w.calls.length).toBe(first + 1);
    expect(w.calls.at(-1).path).toContain("/nfl/scoreboard");
  });

  test("a quiet board is cached for five minutes", async () => {
    const w = world({ boards: { nfl: scoreboard([finalNfl("1", NOW - 2 * HOUR, side(T.panthers, 1), side(T.packers, 2))]) }, schedules: { "nfl:29": panthersSchedule() } });
    const time = clock();
    const slot = makeSlot({}, { time });
    await html(slot, "carolina panthers score", w);
    const first = w.calls.length;
    time.state.t += 4 * 60_000;
    await html(slot, "carolina panthers score", w);
    expect(w.calls.length).toBe(first);
    time.state.t += 2 * 60_000;
    await html(slot, "carolina panthers score", w);
    expect(w.calls.length).toBe(first + 1);
  });

  test("concurrent searches share one request", async () => {
    const w = nflLive();
    const slot = makeSlot();
    await Promise.all([html(slot, "carolina panthers score", w), html(slot, "carolina panthers score", w), html(slot, "carolina panthers game", w)]);
    expect(w.count("board")).toBe(1);
    expect(w.count("schedule")).toBe(1);
  });

  test("location plus nickname asks only that team's league", async () => {
    const w = nflLive();
    await html(makeSlot(), "carolina panthers score", w);
    expect(w.calls.map((c) => c.path).filter((p) => p.includes("/hockey/"))).toEqual([]);
    expect(w.count("board")).toBe(1);
  });

  test("the other league can win when its game is live", async () => {
    const nhlLive = game({ id: "9", away: side(T.flaPanthers, 2, { record: "4-1-0" }), home: side(T.bruins, 1), status: STATUS.live({ period: 2, clock: "7:00" }) });
    const w = world({ boards: { nhl: scoreboard([nhlLive]), nfl: scoreboard([finalNfl("1", NOW - 5 * DAY, side(T.panthers, 1), side(T.packers, 2))]) } });
    const out = await html(makeSlot(), "panthers score", w);
    expect(out).toContain("NHL · Panthers");
    expect(out).toContain("Florida Panthers");
    expect(out).toContain("P2 · 7:00");
    expect(out).toContain("Carolina Panthers · NFL");
  });

  test("a league word picks the league", async () => {
    const w = world({ boards: { nhl: scoreboard([game({ id: "9", away: side(T.flaPanthers, 2), home: side(T.bruins, 1), status: STATUS.live({ period: 2, clock: "7:00" }) })]) } });
    const out = await html(makeSlot(), "panthers hockey score", w);
    expect(out).toContain("NHL · Panthers");
    expect(w.calls.filter((c) => c.path.includes("/football/"))).toEqual([]);
  });

  test("nothing on today: the schedule decides, and the dated scoreboard adds the line score", async () => {
    const dated = scoreboard([finalNfl("300", NOW - 3 * DAY, side(T.rams, 10, { lines: [3, 0, 7, 0] }), side(T.panthers, 20, { lines: [7, 6, 0, 7], winner: true }))]);
    const w = world({ boards: { nfl: scoreboard([]), "nfl:20261025": dated }, schedules: { "nfl:29": panthersSchedule() } });
    const sched = panthersSchedule();
    sched.events.splice(1, 1); // no live game
    w.calls.length = 0;
    const w2 = world({ boards: { nfl: scoreboard([]), "nfl:20261025": dated }, schedules: { "nfl:29": sched } });
    const out = await html(makeSlot(), "carolina panthers score", w2);
    expect(out).toContain("Final");
    expect(out).toContain("sports-lines");
    expect(out).toContain("Oct 25");
    expect(out).toContain("Sun 6:00 PM EST at Chiefs");
    expect(w2.calls.some((c) => c.url.includes("dates=20261025"))).toBe(true);
  });

  test("the schedule game is used as it is when the dated scoreboard fails", async () => {
    const sched = panthersSchedule();
    sched.events.splice(1, 1);
    const w = world({ boards: { nfl: scoreboard([]) }, schedules: { "nfl:29": sched }, status: { "nfl:20261025": 500 } });
    let out = "";
    await capture(async () => {
      out = await html(makeSlot(), "carolina panthers score", w);
    });
    expect(out).toContain("Final");
    expect(out).not.toContain("sports-lines");
  });

  test("next game: schedule only", async () => {
    const w = world({ boards: { nfl: scoreboard([liveNfl()]) }, schedules: { "nfl:29": panthersSchedule() } });
    const out = await html(makeSlot(), "next carolina panthers game", w);
    expect(out).toContain("sports-pill--pre");
    expect(out).toContain("Chiefs");
    expect(w.count("board")).toBe(0);
    expect(w.count("schedule")).toBe(1);
  });

  test("yesterday: the dated scoreboard", async () => {
    const dated = scoreboard([finalNfl("200", NOW - DAY, side(T.panthers, 13), side(T.rams, 9))]);
    const w = world({ boards: { "nfl:20261027": dated }, schedules: { "nfl:29": panthersSchedule() } });
    const out = await html(makeSlot(), "did the carolina panthers win yesterday", w);
    expect(out).toContain("Final");
    expect(out).toContain("Los Angeles Rams");
    expect(w.calls.some((c) => c.url.includes("dates=20261027"))).toBe(true);
  });

  test("a team with no game anywhere: no card", async () => {
    const w = world({ boards: { nfl: scoreboard([]) }, schedules: { "nfl:29": schedule([]) } });
    let out = "unset";
    const lines = await capture(async () => {
      out = await html(makeSlot({ debugMatching: "true" }), "carolina panthers score", w);
    });
    expect(out).toBe("");
    expect(lines.join("\n")).toContain("no card (no game found)");
  });

  test("two teams: the game between them", async () => {
    const w = world({ boards: { nfl: scoreboard([liveNfl(), finalNfl("5", NOW - 2 * HOUR, side(T.rams, 3), side(T.chiefs, 6))]) }, schedules: { "nfl:29": panthersSchedule() } });
    const out = await html(makeSlot(), "panthers vs packers", w);
    expect(out).toContain("Green Bay Packers");
    expect(out).toContain("Q3 · 4:12");
    expect(out).toContain("NFL · Panthers");
  });

  test("two teams that do not play today: the schedule of the first", async () => {
    const sched = schedule([scheduleEvent({ id: "888", date: iso(NOW + 3 * DAY), away: side(T.panthers, 0), home: side(T.rams, 0), status: STATUS.pre() })]);
    const w = world({ boards: { nfl: scoreboard([]) }, schedules: { "nfl:29": sched } });
    const out = await html(makeSlot(), "carolina panthers vs los angeles rams", w);
    expect(out).toContain("Los Angeles Rams");
    expect(out).toContain("sports-pill--pre");
  });

  test("two teams from different leagues are not a game", async () => {
    expect(parseQuery("carolina panthers vs lakers").parsed).toBeNull();
    expect(parseQuery("lions vs tigers").parsed).toBeNull();
    expect(parseQuery("lions vs tigers score").parsed).toBeNull();
    expect(parseQuery("carolina panthers vs lakers").reason).toContain("not in the same league");
  });

  test("two teams of one league that do not meet: the first team's card, the second as a chip", async () => {
    const w = world({ boards: { nfl: scoreboard([]) }, schedules: { "nfl:29": panthersSchedule() } });
    const out = await html(makeSlot(), "carolina panthers vs tampa bay buccaneers", w);
    expect(out).toContain("NFL · Panthers");
    expect(out).toContain("Tampa Bay Buccaneers · NFL");
  });

  test("a league scoreboard: live games first", async () => {
    const board = scoreboard([finalNfl("1", NOW - 5 * HOUR, side(T.rams, 3), side(T.chiefs, 6)), game({ id: "2", date: iso(NOW + 3 * HOUR), away: side(T.bruins, 0), home: side(T.panthers, 0), status: STATUS.pre() }), liveNfl()], { week: 9 });
    const w = world({ boards: { nfl: board } });
    const out = await html(makeSlot(), "nfl scores", w);
    expect(out).toContain("NFL · Scores");
    expect(out).toContain("Week 9");
    expect(out.indexOf("Q3 · 4:12")).toBeLessThan(out.indexOf("Final"));
    expect(out.match(/class="sports-game"/g)).toHaveLength(3);
    expect(w.calls).toHaveLength(1);
  });

  test("a league scoreboard in the panel layout is shorter", async () => {
    const events = Array.from({ length: 12 }, (_, i) => finalNfl(String(i), NOW - (i + 1) * HOUR, side(T.rams, i), side(T.chiefs, 3)));
    const w = world({ boards: { nfl: scoreboard(events) } });
    const out = await html(makeSlot({ layout: "panel" }), "nfl scores", w);
    expect(out.match(/class="sports-game"/g)).toHaveLength(PANEL_LIST_MAX);
  });

  test("a sport word tries the leagues in priority order and skips an empty one (off-season)", async () => {
    const w = world({ boards: { nfl: scoreboard([]), epl: scoreboard([game({ id: "7", away: side(T.arsenal, 1), home: side(T.liverpool, 1), status: STATUS.final("FT") })]) } });
    const out = await html(makeSlot(), "football scores", w);
    expect(out).toContain("Premier League · Scores");
  });

  test("an empty scoreboard: no card", async () => {
    const w = world({ boards: { nfl: scoreboard([]) } });
    expect(await html(makeSlot(), "nfl scores", w)).toBe("");
  });

  test("yesterday's league scoreboard uses the date parameter and says so", async () => {
    const w = world({ boards: { "nfl:20261027": scoreboard([finalNfl("1", NOW - DAY, side(T.rams, 3), side(T.chiefs, 6))]) } });
    const out = await html(makeSlot(), "nfl scores yesterday", w);
    expect(out).toContain("Yesterday");
    expect(w.calls[0].url).toContain("dates=20261027");
  });

  test("a postponed game is shown as postponed", async () => {
    const ppd = game({ id: "3", date: iso(NOW + DAY), away: side(T.panthers, 0), home: side(T.packers, 0), status: STATUS.postponed() });
    const w = world({ boards: { nfl: scoreboard([ppd]) }, schedules: { "nfl:29": schedule([]) } });
    const out = await html(makeSlot(), "carolina panthers game", w);
    expect(out).toContain("Postponed");
    expect(out).not.toContain("sports-score");
  });

  test("college: two sports, the one in season wins, the other is a chip with a league word", async () => {
    const cbbGame = game({ id: "55", away: side(T.duke, 40, { lines: [20, 20] }), home: side(T.tarHeels, 38, { lines: [18, 20] }), status: STATUS.live({ period: 2, clock: "8:00" }) });
    const w = world({ boards: { cbb: scoreboard([cbbGame]), cfb: scoreboard([]) } });
    const out = await html(makeSlot(), "duke score", w);
    expect(out).toContain("NCAAB · Duke");
    expect(out).toContain("2nd half · 8:00");
    expect(out).toContain("Duke Blue Devils · NCAAF");
    expect(out).toContain("college%20football%20score");
  });

  test("a pro team's chips show at most one school", async () => {
    const w = nflLive();
    const out = await html(makeSlot(), "panthers score", w);
    expect(out.match(/NCAA[FB]\b/g) ?? []).toHaveLength(1);
    expect(out).toContain("Florida Panthers · NHL");
  });

  test("pro teams outrank a college team of the same nickname", async () => {
    const w = world({ boards: { nfl: scoreboard([finalNfl("1", NOW - 6 * DAY, side(T.panthers, 1), side(T.packers, 2))]), nhl: scoreboard([]) }, schedules: { "nfl:29": panthersSchedule() } });
    const out = await html(makeSlot(), "panthers score", w);
    expect(out).not.toContain("NCAAF · Pitt");
    expect(w.calls.filter((c) => c.path.includes("college-football")).length).toBe(0);
  });

  test("a bare nickname gives no card and no request", async () => {
    const w = world();
    expect(await html(makeSlot(), "panthers", w)).toBe("");
    expect(await html(makeSlot(), "credit score", w)).toBe("");
    expect(w.calls).toEqual([]);
  });

  test("sends an honest User-Agent and nothing else custom", async () => {
    const w = nflLive();
    await html(makeSlot(), "carolina panthers score", w);
    for (const call of w.calls) {
      expect(call.headers["User-Agent"]).toBe(USER_AGENT);
      expect(Object.keys(call.headers).sort()).toEqual(["Accept", "User-Agent"]);
    }
    expect(USER_AGENT).toMatch(/^degoog-sports\/1\.0 \(\+https:\/\/github\.com\//);
  });

  test("the card carries the refresh attributes only while live and only when enabled", async () => {
    const w = nflLive();
    const on = await html(makeSlot({ refreshSeconds: "45" }), "  carolina panthers score ", w);
    expect(on).toContain('data-live="true"');
    expect(on).toContain('data-query="carolina panthers score"');
    expect(on).toContain('data-refresh="45"');
    const off = await html(makeSlot({ autoRefresh: "false" }), "carolina panthers score", nflLive());
    expect(off).toContain('data-live="true"');
    expect(off).not.toContain("data-query");
    const finished = world({ boards: { nfl: scoreboard([finalNfl("1", NOW - 3 * HOUR, side(T.panthers, 1), side(T.packers, 2))]) }, schedules: { "nfl:29": panthersSchedule() } });
    expect(await html(makeSlot(), "carolina panthers score", finished)).toContain('data-live="false"');
  });

  describe("failures and limits", () => {
    test("HTTP 429 pauses ESPN for the Retry-After time", async () => {
      const w = world({ status: { "*": 429 } });
      const time = clock();
      const slot = makeSlot({}, { time });
      const lines = await capture(async () => {
        expect(await html(slot, "nfl scores", w)).toBe("");
        expect(await html(slot, "nba scores", w)).toBe("");
      });
      expect(w.calls).toHaveLength(1);
      expect(lines.filter((l) => l.includes("paused for"))).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("http");
      time.state.t += 121_000;
      w.calls.length = 0;
      await capture(() => html(slot, "nfl scores", w));
      expect(w.calls).toHaveLength(1);
    });

    test("a long Retry-After is capped at 15 minutes", async () => {
      const slot = makeSlot();
      const fetch = async () => new Response("x", { status: 429, headers: { "retry-after": "99999" } });
      await capture(() => run(slot, "nfl scores", { fetch }));
      expect(slot.upstream.pausedUntil - NOW).toBe(15 * 60_000);
    });

    test("HTTP 500 pauses for a minute", async () => {
      const w = world({ status: { "*": 500 } });
      const time = clock();
      const slot = makeSlot({}, { time });
      await capture(() => html(slot, "nfl scores", w));
      await capture(() => html(slot, "nfl scores", w));
      expect(w.calls).toHaveLength(1);
      time.state.t += 61_000;
      await capture(() => html(slot, "nfl scores", w));
      expect(w.calls).toHaveLength(2);
    });

    test("HTTP 403 pauses for half an hour", async () => {
      const w = world({ status: { "*": 403 } });
      const slot = makeSlot();
      await capture(() => html(slot, "nfl scores", w));
      expect(slot.upstream.pausedUntil - NOW).toBe(30 * 60_000);
    });

    test("a network error gives no card and pauses", async () => {
      const slot = makeSlot();
      let calls = 0;
      const fetch = async () => {
        calls += 1;
        throw new Error("boom");
      };
      await capture(async () => {
        expect(await run(slot, "nfl scores", { fetch })).toBe("");
        expect(await run(slot, "nfl scores", { fetch })).toBe("");
      });
      expect(calls).toBe(1);
    });

    test("an unreadable reply gives no card and pauses a minute", async () => {
      const slot = makeSlot();
      const fetch = async () => new Response("<html>nope</html>", { status: 200 });
      await capture(async () => expect(await run(slot, "nfl scores", { fetch })).toBe(""));
      expect(slot.upstream.paused).toBe(true);
    });

    test("the daily budget stops requests and keeps the cache working", async () => {
      const w = nflLive();
      const slot = makeSlot({ dailyRequestLimit: "2" });
      await capture(async () => {
        await html(slot, "carolina panthers score", w); // board + schedule = 2
        expect(w.calls).toHaveLength(2);
        expect(await html(slot, "nba scores", w)).toBe("");
      });
      expect(w.calls).toHaveLength(2);
      // the cached team still answers
      expect(await html(slot, "carolina panthers score", w)).toContain("Carolina Panthers");
    });

    test("the budget is persisted per UTC day", () => {
      const state = { t: Date.parse("2026-10-28T23:59:00Z") };
      const budget = new Budget({ file: "", cap: 2, now: () => state.t });
      expect(budget.spend()).toBe(true);
      expect(budget.spend()).toBe(true);
      expect(budget.spend()).toBe(false);
      state.t += 2 * 60_000;
      expect(budget.spend()).toBe(true);
    });

    test("no request starts after 70 % of the slot time", async () => {
      const w = nflLive();
      const time = clock();
      const slot = makeSlot({}, { time });
      slot.spacingMs = 2000;
      slot.startWindowMs = 500;
      await html(slot, "panthers score", w);
      expect(w.calls).toHaveLength(1);
    });

    test("a slow ESPN: the slot gives up at 95 %, and the late reply fills the cache", async () => {
      const w = nflLive();
      const slow = async (url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return w.fetch(url, init);
      };
      const slot = makeSlot();
      slot.answerWindowMs = 30;
      const started = Date.now();
      expect(await run(slot, "carolina panthers score", { fetch: slow })).toBe("");
      expect(Date.now() - started).toBeLessThan(110);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const before = w.calls.length;
      slot.answerWindowMs = 5000;
      expect(await run(slot, "carolina panthers score", { fetch: slow })).toContain("Carolina Panthers");
      expect(w.calls.length).toBe(before);
    });

    test("never throws", async () => {
      const slot = makeSlot();
      await capture(async () => {
        expect(await slot.execute("nfl scores", { fetch: () => { throw new Error("sync boom"); } })).toEqual({ title: "", html: "" });
        expect(await slot.execute(null, {})).toEqual({ title: "", html: "" });
        expect(slot.trigger(undefined)).toBe(false);
        const other = makeSlot();
        expect(await other.execute("nfl scores", { fetch: async () => ({ status: 200, text: async () => { throw new Error("x"); } }) })).toEqual({ title: "", html: "" });
      });
    });
  });

  describe("layout", () => {
    test("inline is the default and sits above the results", async () => {
      const slot = makeSlot();
      expect(slot.layout).toBe("inline");
      expect(slot.position).toBe("above-results");
      expect(await html(slot, "carolina panthers score", nflLive())).toContain("sports-card--inline");
    });

    test("panel is compact and sits in the side column; flipping the setting moves it", async () => {
      const slot = makeSlot({ layout: "panel" });
      expect(slot.position).toBe("knowledge-panel");
      const panel = await html(slot, "carolina panthers score", nflLive());
      expect(panel).toContain("sports-card--panel");
      slot.configure({ layout: "inline", timezone: ZONE });
      expect(slot.position).toBe("above-results");
      const inline = await html(slot, "carolina panthers score", nflLive());
      expect(inline).toContain("sports-card--inline");
      expect(inline.length).toBeGreaterThan(panel.length);
    });

    test("anything but panel means inline", () => {
      expect(layoutFrom("panel")).toBe("panel");
      expect(layoutFrom(" PANEL ")).toBe("panel");
      for (const v of ["inline", "", undefined, "sideways", null]) expect(layoutFrom(v)).toBe("inline");
    });
  });

  describe("settings", () => {
    test("refresh seconds are clamped to 15..300", () => {
      expect(refreshFrom("5")).toBe(15);
      expect(refreshFrom("0")).toBe(15);
      expect(refreshFrom("-9")).toBe(15);
      expect(refreshFrom("45")).toBe(45);
      expect(refreshFrom("1000")).toBe(300);
      expect(refreshFrom("abc")).toBe(30);
      expect(refreshFrom(undefined)).toBe(30);
      expect(refreshFrom("")).toBe(30);
    });

    test("the league list", () => {
      const all = LEAGUES.map((l) => l.key);
      expect(leaguesFrom("all")).toEqual(all);
      expect(leaguesFrom("")).toEqual(all);
      expect(leaguesFrom(undefined)).toEqual(all);
      expect(leaguesFrom("nfl, NBA ; mlb")).toEqual(["nfl", "nba", "mlb"]);
      expect(leaguesFrom("bogus")).toEqual(all);
      expect(leaguesFrom("nfl bogus")).toEqual(["nfl"]);
    });

    test("a switched-off league means no trigger and no request", async () => {
      const slot = makeSlot({ leagues: "nba" });
      expect(slot.trigger("lakers score")).toBe(true);
      expect(slot.trigger("carolina panthers score")).toBe(false);
      expect(slot.trigger("nfl scores")).toBe(false);
      const w = world();
      expect(await html(slot, "nfl scores", w)).toBe("");
      expect(w.calls).toEqual([]);
    });

    test("candidates in switched-off leagues are dropped from the ranking", async () => {
      const w = world({ boards: { nfl: scoreboard([liveNfl()]) }, schedules: { "nfl:29": panthersSchedule() } });
      await html(makeSlot({ leagues: "nfl" }), "panthers score", w);
      expect(w.calls.filter((c) => c.path.includes("hockey"))).toEqual([]);
    });

    test("the time zone setting", async () => {
      const pre = game({ id: "8", date: iso(NOW + 2 * DAY), away: side(T.panthers, 0), home: side(T.packers, 0), status: STATUS.pre() });
      const make = () => world({ boards: { nfl: scoreboard([pre]) }, schedules: { "nfl:29": schedule([]) } });
      expect(await html(makeSlot({ timezone: "Europe/London" }), "carolina panthers game", make())).toContain("GMT");
      expect(await html(makeSlot({ timezone: ZONE }), "carolina panthers game", make())).toContain("EDT");
      const bad = makeSlot({ timezone: "Mars/Phobos" });
      expect(bad.zone).toBe(serverZone());
    });

    test("daily limit", () => {
      expect(makeSlot({ dailyRequestLimit: "50" }).budget.cap).toBe(50);
      expect(makeSlot({ dailyRequestLimit: "0" }).budget.cap).toBe(0);
      expect(makeSlot({ dailyRequestLimit: "x" }).budget.cap).toBe(3000);
      expect(makeSlot({ dailyRequestLimit: "-4" }).budget.cap).toBe(3000);
    });

    test("the schema", () => {
      const keys = SETTINGS_SCHEMA.map((s) => s.key);
      expect(keys).toEqual(["layout", "leagues", "timezone", "autoRefresh", "refreshSeconds", "dailyRequestLimit", "debugMatching"]);
      expect(SETTINGS_SCHEMA.some((s) => s.required)).toBe(false);
      const layout = SETTINGS_SCHEMA.find((s) => s.key === "layout");
      expect(layout.default).toBe("inline");
      expect(layout.options).toEqual(["inline", "panel"]);
      expect(layout.optionLabels[0]).toMatch(/^Inline: detailed/);
      expect(layout.optionLabels[1]).toMatch(/^Panel: compact/);
      expect(SETTINGS_SCHEMA.find((s) => s.key === "debugMatching").default).toBe("false");
      expect(SETTINGS_SCHEMA.find((s) => s.key === "autoRefresh").default).toBe("true");
      expect(SETTINGS_SCHEMA.find((s) => s.key === "refreshSeconds").default).toBe("30");
      for (const s of SETTINGS_SCHEMA) expect(s.description.length).toBeGreaterThan(20);
    });
  });

  describe("logos", () => {
    test("the image proxy comes from init() or the context", async () => {
      const slot = makeSlot();
      slot.init({ template: '<div class="command-result sports-result">{{content}}</div>', signProxyUrl: (url) => `/signed?u=${encodeURIComponent(url)}` });
      const out = await html(slot, "carolina panthers score", nflLive());
      expect(out).toContain("/signed?u=https%3A%2F%2Fa.espncdn.com");
      const other = await run(slot, "carolina panthers score", { fetch: nflLive().fetch, signProxyUrl: () => "/ctx-proxy" });
      expect(other).toContain("/ctx-proxy");
    });

    test("without a proxy there are badges and no image", async () => {
      const out = await html(makeSlot(), "carolina panthers score", nflLive());
      expect(out).not.toContain("<img");
      expect(out).toContain("sports-badge");
    });

    test("a throwing proxy is survived", async () => {
      const out = await run(makeSlot(), "carolina panthers score", { fetch: nflLive().fetch, signProxyUrl: () => { throw new Error("x"); } });
      expect(out).toContain("Carolina Panthers");
      expect(out).not.toContain("<img");
    });
  });

  describe("debugMatching", () => {
    test("off: silent", async () => {
      const lines = await capture(() => html(makeSlot(), "panthers score", nflLive()));
      expect(lines).toEqual([]);
    });

    test("on: one block with the rule, candidates, ranking and verdict; no addresses", async () => {
      const lines = await capture(() => html(makeSlot({ debugMatching: "true" }), "panthers score", nflLive()));
      expect(lines).toHaveLength(1);
      const text = lines[0];
      expect(text).toContain('[sports] "panthers score"');
      expect(text).toContain("rule: <team> score");
      expect(text).toContain("candidates:");
      expect(text).toContain("rank:");
      expect(text).toContain("verdict: card shown");
      expect(text).not.toMatch(/https?:/);
    });

    test("on: a near miss is explained, a plain query is not", async () => {
      const lines = await capture(async () => {
        const slot = makeSlot({ debugMatching: "true" });
        slot.trigger("credit score");
        slot.trigger("pasta recipes");
        slot.trigger("lakers vs");
      });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("not a sports question");
    });

    test("on: a timeout is reported", async () => {
      const slot = makeSlot({ debugMatching: "true" });
      slot.answerWindowMs = 10;
      const lines = await capture(() => run(slot, "nfl scores", { fetch: () => new Promise((resolve) => setTimeout(() => resolve(new Response("{}")), 100)) }));
      expect(lines.join("\n")).toContain("too slow for the slot");
    });
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("the bang command", () => {
  const ctxWith = (w) => ({ fetch: w.fetch });
  test("named exports only", async () => {
    const mod = await import("../plugins/sports/index.js");
    expect("default" in mod).toBe(false);
    expect(mod.slot).toBe(sharedSlot);
    expect(command.trigger).toBe("score");
    expect(command.aliases).toEqual(expect.arrayContaining(["scores", "sports"]));
    expect(command.isClientExposed).toBe(false);
  });

  test("!score panthers renders the card without refresh attributes", async () => {
    sharedSlot.budget.file = "";
    sharedSlot.spacingMs = 0;
    sharedSlot.now = () => NOW;
    sharedSlot.configure({ timezone: ZONE });
    const w = world({ boards: { nfl: scoreboard([game({ id: "1", away: side(T.panthers, 3), home: side(T.packers, 0), status: STATUS.live({ period: 1, clock: "9:00" }) })]) }, schedules: { "nfl:29": schedule([]) } });
    const out = await command.execute(["carolina", "panthers"], ctxWith(w));
    expect(out.title).toBe("");
    expect(out.html).toContain("sports-card");
    expect(out.html).not.toContain("data-query");
    sharedSlot.now = Date.now;
    sharedSlot.spacingMs = undefined;
  });

  test("!score nfl falls back to the scoreboard; no card gives a hint", async () => {
    sharedSlot.budget.file = "";
    sharedSlot.spacingMs = 0;
    sharedSlot.now = () => NOW;
    const w = world({ boards: { nfl: scoreboard([game({ id: "1", away: side(T.panthers, 3), home: side(T.packers, 0), status: STATUS.final() })]) } });
    expect((await command.execute("nfl", ctxWith(w))).html).toContain("NFL · Scores");
    expect((await command.execute("", ctxWith(w))).html).toContain("Try");
    expect((await command.execute(["zzzz"], ctxWith(w))).html).toContain("Try");
    sharedSlot.now = Date.now;
    sharedSlot.spacingMs = undefined;
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("package files", () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("template, author, manifest", () => {
    expect(read("../plugins/sports/template.html")).toContain('class="command-result sports-result"');
    expect(read("../plugins/sports/template.html")).toContain("{{content}}");
    expect(JSON.parse(read("../plugins/sports/author.json")).name).toBe("AromaticTurtle");
    const manifest = JSON.parse(read("../package.json"));
    const entry = manifest.plugins.find((p) => p.path === "plugins/sports");
    expect(entry).toMatchObject({ type: "slot", version: "1.0.0", minDegoogVersion: "1.1.0" });
  });

  test("the css is scoped and has no external resources", () => {
    const css = read("../plugins/sports/style.css");
    expect(css).not.toMatch(/url\(|@import|@font-face/);
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain("var(--border)");
    expect(css).toContain(".sports-card .sports-chip");
    for (const selector of css.match(/^\.[a-z][\w-]*/gm) ?? []) expect(selector.startsWith(".sports-") || selector === ".command-result").toBe(true);
  });

  test("the page script", () => {
    const js = read("../plugins/sports/script.js");
    expect(js).toContain("visibilitychange");
    expect(js).toContain("AbortController");
    expect(js).toContain("MAX_FAILURES");
    expect(js).toContain("api/slots");
    expect(js).toContain("sports-slot");
    expect(js).toContain("x-search-nonce");
    expect(js).not.toMatch(/eval\(|new Function|document\.write/);
    expect(js.match(/setTimeout\(/g)).toHaveLength(1);
    expect(js.match(/new MutationObserver/g)).toHaveLength(1);
  });

  test("the team snapshot has only identifiers and names", () => {
    const data = JSON.parse(read("../plugins/sports/teams.json"));
    expect(Object.keys(data.leagues).sort()).toEqual(LEAGUES.map((l) => l.key).sort());
    for (const rows of Object.values(data.leagues)) for (const row of rows) expect(row).toHaveLength(6);
    expect(read("../plugins/sports/teams.json")).not.toMatch(/https?:/);
    expect(read("../plugins/sports/teams.json").length).toBeLessThan(80_000);
  });

  test("no secrets or addresses in the plugin's logging code", () => {
    for (const file of ["index.js", "upstream.js"]) expect(read(`../plugins/sports/${file}`)).not.toMatch(/console\.\w+\([^)]*(url|headers|token)/i);
  });
});
