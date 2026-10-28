# Game info panel for degoog (IGDB + ProtonDB)

When you search for a video game, this shows an information panel beside the results, the same way degoog's built-in
movie panel shows a film: a portrait cover, the title, the critic and player scores from [IGDB](https://www.igdb.com)
(each labelled with where it comes from), the Linux / Steam Deck compatibility tier from [ProtonDB](https://www.protondb.com),
the age rating, a short description, release date, platforms, genres, developer, publisher, game modes and the time to
beat. Below that are links to the game's **Steam store page** (whenever one exists), its official site and its IGDB page.

## Setup
1. Get free IGDB credentials. IGDB is run by Twitch, so you need a Twitch developer application:
   - Go to <https://dev.twitch.tv/console> and sign in (the Twitch account needs two-factor authentication turned on).
   - **Register Your Application**: any name, OAuth redirect URL `http://localhost`, category **Other**, client type
     **Confidential**.
   - Open the application, copy the **Client ID**, and press **New Secret** to get the **Client Secret**.
2. In degoog: Settings > Store > add this repository, then install **Game info (IGDB + ProtonDB)** (Plugins).
3. Settings > Plugins > **Game info (IGDB + ProtonDB)** > Configure: paste the client ID and the client secret.
   Or set `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` in the container environment (a value saved in the UI wins).
   The secret is saved on the server only and is never shown in a page, written to a log or put in a request address.
   **Never paste it in a chat or commit it.**
4. Search for a game, for example `skyrim`.

By default the panel sits in the **side column** (`knowledge-panel`), under degoog's Wikipedia panel if there is one. The
same Configure page lets you move it to above or below the sidebar, or above the results.

## When the panel appears (and what it costs)
The plugin checks, in this order, and stops at the first "no":
1. Both credentials are set, and IGDB has not recently said "slow down" or refused the credentials.
2. The query is 2 to 80 characters and at most 8 words, and is not a question or how-to ("how to...", "what is..."), a web
   address, a calculation or similar.
3. If **Only for queries that sound like games** is on, it also contains a game word (`game`, `steam`, `ps5`, `xbox`,
   `walkthrough`, `review`, `dlc`, `mods`, `rpg`...).
4. IGDB is asked for the 8 best matches (**1 request**). Entries that are not the game itself (DLC, expansions, bundles,
   mods, episodes...) are ignored. The panel shows only if one is a confident match (see "How the match is decided" below):
   the title matches (ignoring case, accents, punctuation, a leading "the", a year such as "(2016)" and edition marks such as
   "Special Edition") and the game has enough ratings not to be a fan project with the same name. A single word may match a
   subtitle, so `skyrim` finds *The Elder Scrolls V: Skyrim*, but a word that fits several series (`origins`) shows nothing
   unless the query also says it is about a game (`origins game`). A trailing number or numeral counts as a different game, so
   `hades 2` does not show the first Hades. If several entries share the name, the closest title wins, then the one with the
   most ratings.
5. For a match, in parallel: the **time to beat** (**1 request**), and, only when IGDB lists no Steam page for a PC game
   and the Steam lookup is on, a **Steam store search** (0 or 1 request, an exact name match only).
6. If there is a Steam app id and ProtonDB is on, **1 request** to ProtonDB.

Game words at the **end** of the query are dropped before searching (`skyrim game` searches `skyrim`). Words at the start
are kept, so `game dev tycoon` still finds Game Dev Tycoon.

So a new game costs at most: 1 token request (only when no valid token is saved) + 1 IGDB search + 1 time to beat + 0 or 1
Steam lookup + 0 or 1 ProtonDB request. A query that is not a game costs 0 or 1. **Everything is cached**: IGDB searches
for 24 hours (including "no match"), time to beat for 7 days, ProtonDB for 24 hours (including "no reports"), Steam lookups
for 7 days (including "none"). Identical simultaneous searches share a request. Searching the same game again costs nothing.

## Being polite
- The Twitch access token lasts about 60 days. It is saved in `data/igdb/token.json` (file mode 600, never the secret), so a
  restart does not ask for a new one. It is replaced when it would expire within a day or when the client ID changes.
- IGDB allows 4 requests a second; this plugin keeps its requests at least 300 ms apart.
- On HTTP 429 an upstream is paused for its `Retry-After` time (10 minutes if none, at most an hour). A server error or a
  network failure pauses it for a minute. If IGDB answers 401 the token is replaced and that one request is retried once;
  if it is still refused, or Twitch refuses the credentials, or IGDB answers 403, IGDB is paused for 30 minutes. IGDB,
  ProtonDB and Steam are paused independently: ProtonDB being down only removes the ProtonDB badge. While IGDB is paused the
  plugin makes no requests and shows no panel. One short line is logged when a pause starts, without any address, id or secret.
- No retries other than the single token refresh above.

## Options
- **Twitch client ID** and **Twitch client secret**: see Setup.
- **Only for queries that sound like games**: off by default. Turn it on to save requests, at the cost of missing plain
  title searches such as `hades`.
- **Show ProtonDB compatibility**: on by default. Off makes no ProtonDB requests at all.
- **Look up the Steam page when IGDB has none**: on by default. Off makes no Steam store requests; the Steam link then only
  appears when IGDB knows the Steam page.
- **Show a short description**: on by default.

## The sources, and their terms (please read)
- **IGDB** is free for **non-commercial** use under the [Twitch Developer Service Agreement](https://www.twitch.tv/p/legal/developer-agreement/),
  and caching responses is allowed. A commercial site needs an IGDB partnership with visible attribution. The panel always
  ends with "Data from IGDB", linked to igdb.com, and the title, cover and "IGDB page" link to the game's IGDB page.
- **ProtonDB** and the **Steam store** search have **no official public API**. This plugin uses the same unofficial
  endpoints the websites use, queries them sparingly (cached, paused on any sign of trouble, one request per new game at
  most), identifies itself with an honest user agent, and they could change or disappear without notice. Both are fully
  optional: ProtonDB can be turned off, and so can the Steam lookup. The Steam link itself is built from a numeric app id,
  never from text in an API reply.
- Covers are fetched through degoog's own image proxy.

## How the match is decided
A game with the right title is shown when it has **enough ratings for how specific your query is**: a long, distinctive title
(three or more words, or 14+ letters) needs very few ratings, a two-word or long single-word title (`elden ring`, `wingspan`)
a few, and a short single word (`hades`, `root`, `risk`) many, because many games share it. "Ratings" is the strongest of
IGDB's counts (total, players, critics, players plus critics), so one missing number never hides a game. When IGDB lists the
game as its **first result** and the title matches closely, half is enough. Edition marks (`Special Edition`, `Deluxe Edition`,
`Remastered`...) are ignored on both sides, and alternative names count (names in other scripts are not compared). A game word
(`game`, `steam`, `ps5`, `walkthrough`...) lowers the bar. The numbers are the constants at the top of `match.js` (`BARS`) and
were chosen without real data.

## Troubleshooting: why did (or didn't) a panel show
Turn on **Explain matching in the log** (Settings > Plugins > Game info > Configure, under Troubleshooting; off by default, no
cost when off). Every lookup then writes one block to the server log: the candidates IGDB returned (up to six, in IGDB's order),
how well each name fits, the rating counts, and the rule that accepted a game or what it was missing, for example
`rejected: needs pop>=20, has 6`, `rejected: game type "DLC" is not a game of its own`. A title-like query that never reached
IGDB gets one line saying why. Only the query and game names are logged, never the credentials or an address.

To try a query from your own terminal with your real credentials (a token request, one search, and the follow-up requests of a
confident match; nothing saved; output refused if it contains a credential):
`IGDB_CLIENT_ID=your-id IGDB_CLIENT_SECRET=your-secret bun ./tests/diagnose-game-info.js "wingspan"`.

## Development notes
- **The IGDB fixtures are hand-written**, to IGDB's documented layout. `tests/fixtures/igdb-games.json` and
  `igdb-time-to-beat.json` are **not real recordings** (the games, ratings and image ids are made up for the tests).
  `protondb-summary.json` is a real ProtonDB reply, and `steam-storesearch.json` is shaped after a real Steam store search
  reply, then trimmed and extended by hand.
- To record **real** IGDB fixtures (3 requests, your credentials stay on your machine):
  `IGDB_CLIENT_ID=your-id IGDB_CLIENT_SECRET=your-secret bun ./tests/record-igdb-fixtures.js "skyrim"`.
  The script refuses to save a file that contains the secret, the client ID or the access token. After recording, run the
  tests: some expectations assume the hand-written Skyrim data, and the differences show where real IGDB answers differ.
- `tests/mock-game-info-server.js` is one local stand-in for all four upstreams (token, IGDB, ProtonDB, Steam), used for
  checking the plugin inside a real degoog container. Give the same base URL to the four overrides:
  `DEGOOG_IGDB_API_BASE` (`.../v4`), `DEGOOG_IGDB_TOKEN_URL` (`.../oauth2/token`), `DEGOOG_PROTONDB_BASE` and
  `DEGOOG_STEAM_BASE`. It accepts client ID `test-id`, secret `test-secret` and token `test-token`.
- `tests/diagnose-game-info.js` runs one real lookup with your credentials and prints the explain block (see "Troubleshooting").
- The matching rules and their tuning constants (similarity values, popularity thresholds, accepted IGDB game types) are at
  the top of `match.js`.
- The panel's settings are stored under the id `game-info-slot`.
