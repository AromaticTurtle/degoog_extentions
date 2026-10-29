// The leagues the plugin knows, in one table. Adding a league is: add a row here, run `bun plugins/sports/scripts/build-teams.js` to
// refresh the team snapshot, and add a nickname or two to aliases.js if people use short forms.
//
//   key       short id used in the snapshot, the settings and the debug log
//   path      ESPN's <sport>/<league> path: site.api.espn.com/apis/site/v2/sports/<path>/scoreboard
//   name      what the card shows ("NFL")
//   sport     football | basketball | baseball | hockey | soccer: decides how a live game's period and clock are written
//   kind      "pro" or "college". College leagues are ranked below the pro ones for ambiguous nicknames
//   priority  tie-breaker when nothing else separates two candidates (lower is first)
//   words     phrases in a query that name the league ("nfl scores", "premier league score")
//   standings take the team list from the standings endpoint instead of /teams (college football: /teams lists every NCAA division,
//             the FBS standings list only the 138 top-division teams)
//   shortNames false: ESPN's short names for these clubs are bare city names ("Atlanta"), which are not used as team names
//   board     extra scoreboard parameters (college: every game of the top division, not only the featured ones)
//   periods   regulation periods, for "Q4" / "OT" labels (college basketball is played in halves)
export const LEAGUES = [
  { key: "nfl", path: "football/nfl", name: "NFL", full: "National Football League", sport: "football", kind: "pro", priority: 1, words: ["nfl", "football"], periods: 4 },
  { key: "nba", path: "basketball/nba", name: "NBA", full: "National Basketball Association", sport: "basketball", kind: "pro", priority: 2, words: ["nba", "basketball"], periods: 4 },
  { key: "mlb", path: "baseball/mlb", name: "MLB", full: "Major League Baseball", sport: "baseball", kind: "pro", priority: 3, words: ["mlb", "baseball"], periods: 9 },
  { key: "nhl", path: "hockey/nhl", name: "NHL", full: "National Hockey League", sport: "hockey", kind: "pro", priority: 4, words: ["nhl", "hockey"], periods: 3 },
  { key: "mls", path: "soccer/usa.1", name: "MLS", full: "Major League Soccer", sport: "soccer", kind: "pro", priority: 5, words: ["mls", "soccer"], periods: 2, shortNames: false },
  { key: "epl", path: "soccer/eng.1", name: "Premier League", full: "English Premier League", sport: "soccer", kind: "pro", priority: 6, words: ["epl", "premier league", "prem", "soccer", "football"], periods: 2 },
  { key: "wnba", path: "basketball/wnba", name: "WNBA", full: "Women's National Basketball Association", sport: "basketball", kind: "pro", priority: 7, words: ["wnba", "basketball"], periods: 4 },
  { key: "cfb", path: "football/college-football", name: "NCAAF", full: "NCAA college football", sport: "football", kind: "college", priority: 8, words: ["college football", "ncaa football", "ncaaf", "cfb", "football"], periods: 4, standings: { group: "80", level: "3" }, board: { groups: "80", limit: "300" } },
  { key: "cbb", path: "basketball/mens-college-basketball", name: "NCAAB", full: "NCAA men's college basketball", sport: "basketball", kind: "college", priority: 9, words: ["college basketball", "ncaa basketball", "ncaab", "cbb", "march madness", "basketball"], periods: 2, limit: "500", board: { groups: "50", limit: "400" } },
];

export const leagueByKey = (key) => LEAGUES.find((league) => league.key === key) ?? null;
