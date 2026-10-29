# Sports scores for degoog

A live score card for `panthers score`, `did the lakers win`, `arsenal match`, `nfl scores`: one game with both teams, the clock or
the final, the line score, venue, TV and the next and last game, or a league scoreboard. The data comes from **ESPN's public
scoreboard JSON. No key, no account**, but read the honest part first.

> **ESPN's endpoint is unofficial.** `site.api.espn.com/apis/site/v2/sports/...` is what ESPN's own website and apps use. It is not
> documented, not covered by a service agreement and may change or disappear without notice. This plugin reads it defensively (every
> field is optional, an unexpected reply is dropped, never shown half-parsed) and keeps its requests few, cached and polite, but if
> ESPN changes the layout the plugin will show nothing until it is updated. Use it for personal, non-commercial purposes and respect
> ESPN's terms. Cards say "Data from ESPN" and link to espn.com.

| You type | You get |
|---|---|
| `panthers score`, `panthers game`, `panthers game today`, `rams game score`, `lakers score`, `man utd score`, `arsenal match` | the card for that team's game |
| `carolina panthers score`, `florida panthers score`, `panthers hockey score` | the exact team (a location or a league word removes the ambiguity) |
| `did the panthers win`, `how did the lakers do`, `who won the chiefs game`, `panthers result`, `liverpool live` | the same card (the latest finished game when nothing is on) |
| `panthers vs rams`, `lakers @ celtics`, `arsenal v liverpool score` | the game between the two teams (both must be in the same league) |
| `next lakers game`, `when do the panthers play`, `cowboys game yesterday` | the next game, or the one on that day |
| `nfl scores`, `nba scores today`, `mls scores`, `premier league scores`, `football scores`, `college football scores` | a **league scoreboard** (live games first) |
| `panthers`, `rams`, `lakers`, `panthers roster`, `panthers schedule`, `panther`, `lakers news` | nothing: **a bare team name never triggers** |
| `score`, `credit score`, `ielts score`, `high score`, `test score`, `ram trucks score`, `fantasy football score`, `lions vs tigers` | nothing: no team, or not a game |

A query needs a **team** (from the bundled index) **and** a score-ish word (`score`, `game`, `match`, `vs`/`v`/`@`, `did the X win`,
`result`, `live`...). A phrase that is not a team in the index (`ram trucks`, `credit`, `high`) is not a sports query. Schools count by
their ESPN short name, so `duke score` and `texas game` work, while a bare city (`chicago score`) does not unless a league word is
there (`chicago bears score`).

## Setup
1. In degoog: Settings > Store > add this repository, then install **Sports scores (ESPN)** (one entry in Settings > Plugins).
2. Optional: Settings > Plugins > Sports scores > Configure: **Layout**, **Leagues**, **Time zone**, **auto refresh**.

There is no official degoog sports plugin, so there is nothing to disable.

## Layout: inline or panel
Setting **Layout**; the card moves as soon as you save, no restart.
- **Inline** (default): the detailed card **above the results**. One game: kicker `NFL · PANTHERS`; a status pill (`LIVE` with the
  period and clock, `Final`, `Final/OT`, the kick-off time, `Postponed`, `Delayed`...); both teams with logo, record and a large
  score (the winner is bold and marked with a small triangle, never colour alone); the line score; the game situation when ESPN gives
  one (down and distance, count and runners, last play); venue and TV; the top performer of each team; **Last** and **Next** lines
  from the team's schedule; **Also** chips for other teams with the same nickname (`Florida Panthers · NHL`), which are links to a
  more specific search. A league scoreboard lists every game (up to 30).
- **Panel**: the compact card in the **side column**: the two teams with scores, the status and the venue. A scoreboard lists up
  to 6 games.

Inline sits in *above results* rather than *at a glance* because degoog only fills the at-a-glance box when the search returned
results (see the [calculator README](../calculator/README.md)).

Team logos load through degoog's image proxy (`signProxyUrl`, which serves `a.espncdn.com`). When there is no proxy function, a logo
is missing or fails to load, a small script removes the broken image and the **abbreviation badge** under it (`CAR`, `GB`) shows.

## Which team? (ambiguous nicknames)
`panthers` is the Carolina Panthers (NFL), the Florida Panthers (NHL) and a dozen schools. The plugin:
1. uses a league word or a location when the query has one (`carolina panthers`, `panthers hockey`, `college football duke`);
2. otherwise asks the **scoreboards** of the candidate leagues (at most four, pro teams only: a nickname shared with a school means
   the pro team unless the query names the college sport) and ranks the candidates by game state: **live game > game today > the
   nearest game within a week**, then by league priority (NFL, NBA, MLB, NHL, MLS, Premier League, WNBA, then college);
3. when none of them plays today it looks at the **schedules** of the top three candidates instead;
4. shows the winner as the card and the others as **Also** chips (at most three, one of them a school).

Nicknames and short forms people type that ESPN does not use (`man utd`, `niners`, `pats`, `spurs`, `sixers`...) are in `aliases.js`.
`spurs` belongs to Tottenham and the San Antonio Spurs, `sox` to Boston and Chicago; the ranking decides.

## Leagues
Setting **Leagues**: a comma list of `nfl, nba, mlb, nhl, mls, epl, wnba, cfb, cbb` or `all` (default). A switched-off league is
neither triggered nor requested. The whole league table is one file, `leagues.js`; a league is one row there plus a team snapshot
rebuild.

| Key | League | ESPN path | Teams in the snapshot |
|---|---|---|---|
| nfl | NFL | football/nfl | 32 |
| nba | NBA | basketball/nba | 30 |
| mlb | MLB | baseball/mlb | 30 |
| nhl | NHL | hockey/nhl | 32 |
| mls | MLS | soccer/usa.1 | 30 |
| epl | Premier League | soccer/eng.1 | 20 |
| wnba | WNBA | basketball/wnba | 15 |
| cfb | NCAA football (FBS) | football/college-football | 138 |
| cbb | NCAA men's basketball (Division I) | basketball/mens-college-basketball | 362 |

The team index is a **bundled snapshot** (`teams.json`, about 50 KB: ESPN id, name, short name, location, nickname and abbreviation of
each team, nothing else), so a team resolves with no request and no cold start. Rebuild it when a season changes the teams (new
franchises, promoted and relegated clubs, schools changing divisions):

```
bun plugins/sports/scripts/build-teams.js
```

That makes about 9 requests to ESPN (one per league; college football uses the FBS standings list because `/teams` lists every NCAA
division) and rewrites `teams.json`. `DEGOOG_SPORTS_API_BASE` points it at a mock.

## Live games and auto refresh
Setting **Refresh live scores automatically** (on by default) with **Refresh interval** (30 seconds by default, 15 to 300). A card
that shows a game in progress carries `data-live="true"`; the plugin's `script.js` (degoog loads slot scripts) then asks for the card
again by repeating the page's own request (`POST /api/slots` with the original query) and swaps the new card in. Rules:
- one timer for the whole page; it stops when the game is no longer live, the card leaves the page, or after three failed
  refreshes in a row; a hidden tab pauses it and resumes when you come back;
- never two requests at once; a refresh that comes back without a card keeps what is shown;
- the server answers from its cache: a **live board is cached for 20 seconds**, so any number of open pages cost ESPN one request
  per league per 20 seconds, whatever the interval. A board with a game starting within 30 minutes is cached for 1 minute, any other
  board for 5 minutes, a finished past day for 6 hours, a team schedule for 1 hour;

Turn it off with the setting if you do not want the page to talk to the server by itself.

## What it asks, and how gently
One upstream (ESPN), with its own pause, spacing (400 ms between requests) and daily budget (**Daily request limit**, default 3,000,
0 = off, kept in `data/sports/usage.json`):
- the **scoreboard** of a league (`.../scoreboard`, college boards with the top-division filter),
- a **team schedule** (`.../teams/<id>/schedule`) for the Next and Last lines and when nothing is on today,
- a **dated scoreboard** (`?dates=YYYYMMDD`) for yesterday or to add the line score and top performers to a finished game found on
  the schedule.

A normal card costs 2 to 4 requests the first time and none while cached; identical concurrent lookups share them.
`User-Agent: degoog-sports/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)`. `429` pauses the plugin for `Retry-After`
(2 minutes by default, 15 at most), 403 for 30 minutes, 5xx or a network error for a minute, each with one short log line and no
address. No request is started after 70 % of `DEGOOG_SLOT_TIMEOUT_MS` (default 10 s) and a lookup still running at 95 % is given up;
its reply is cached for the next search.

## Times
Kick-off times and dates use the **Time zone** setting (an IANA name such as `America/New_York`) or, when empty, the server's zone:
`Today 8:15 PM EDT`, `Tomorrow ...`, `Sun 1:00 PM EST`, `Nov 8, 1:00 PM EST`.

## Limits and things not verified
- Off-season: an empty scoreboard gives no card for a league query; a team query shows the team's last finished game from the
  schedule (with its date) or nothing. A sport word (`football scores`) skips leagues with an empty board.
- College names collide (`Panthers`, `Tigers`, `Eagles`...). Pro teams win unless the query says college; for school-only
  nicknames the ranking looks at which sport has a game.
- The status and situation fields are read from what live NBA, NHL, soccer and finished games looked like. Football down and
  distance, baseball count and runners, overtime, shootout, suspended and forfeit texts follow ESPN's usual names but were not
  seen in a recording; unknown shapes are ignored, not shown.
- Odds, play by play, standings, player and roster queries are out of scope.


## Troubleshooting: why did (or didn't) a card show
Turn on **Explain matching in the log**. A near miss (`credit score`) writes one line with the reason; a lookup writes a block:

```
[sports] "panthers score" -> rule: <team> score, layout=inline, zone=America/New_York
  candidates: Carolina Panthers (NFL, nick); Florida Panthers (NHL, nick); Pittsburgh Panthers (NCAAF, nick); ... and 5 more
  ranking: NFL scoreboard 14 games (request)
  ranking: NHL scoreboard 4 games (request)
    rank: Carolina Panthers (NFL) tier 0 score 800
    rank: Florida Panthers (NHL) tier 0 score 0
  Carolina Panthers schedule: 17 games (request)
  game 4018...: live (Q3 · 4:12), Panthers 17 - Packers 24, from scoreboard
  verdict: card shown
```
`bun ./tests/diagnose-sports.js "panthers score"` runs one real lookup (a handful of requests) in your terminal and prints, for each
reply, the status, size and the **field names** present (never values), which shows at a glance whether ESPN changed its layout.

## Development notes
`match.js` (grammar), `teams.js` + `teams.json` + `aliases.js` (index), `leagues.js` (league table), `espn.js` (URLs and defensive
parsers, status texts per sport), `rank.js` (ranking, picking a game, cache lifetimes), `time.js`, `render.js`, `script.js` (logo
fallback and auto refresh), `upstream.js`, `budget.js`, `index.js`. Tests: `tests/sports.test.js` (replies are built by
`tests/fixtures/espn-builder.js` from invented scores in ESPN's layout; nothing is recorded), `tests/domain-routing.test.js` (all six
core plugins against each other), `tests/mock-sports-server.js` (set `DEGOOG_SPORTS_API_BASE` to its address;
`GET /__mode?nfl=live|final|scheduled|postponed|delayed|empty&nhl=...&status=429|500` switches behaviour, the live game's score goes
up every 10 seconds).

## Changelog
**Version 1.1.0:** the `!score` bang command was removed. degoog lists a plugin's slot and its command as two separate entries in Settings > Plugins, and a plugin file cannot be both, so every plugin showed twice. The plain queries cover everything the bang did. After updating, restart degoog (or reload extensions) so the old `sports-command` entry disappears; settings you saved on the slot entry are kept.
