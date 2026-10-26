# RAWG video games panel for degoog

When you search for a video game, this shows an information panel beside the results, the same way degoog's built-in
movie panel shows a film: cover image, Metacritic score, user rating, ESRB rating, release date, platforms, genres,
developer, publisher, average playtime, stores, a short description (with "Read more"), and links to the game's official
site, its Reddit and its RAWG page. Data comes from [RAWG](https://rawg.io).

## Setup
1. Get a free API key at <https://rawg.io/apidocs>. RAWG answers nothing without one.
2. In degoog: Settings > Store > add this repository, then install **RAWG video games** (Plugins).
3. Settings > Plugins > **RAWG video games** > Configure: paste the key. (Or set `RAWG_API_KEY` in the container
   environment; the UI value wins.) The key is saved on the server only and is never shown in a page.
4. Search for a game, for example `elden ring`.

By default the panel sits in the **side column** (`knowledge-panel`), under degoog's Wikipedia panel if there is one. The
same Configure page lets you move it to above or below the sidebar, or above the results.

## RAWG's terms (please read)
- The free plan is **for non-commercial use** and allows 20,000 requests a month. A commercial site needs a paid plan.
- RAWG requires an **active link back to RAWG on every page that shows its data**. The panel always ends with
  "Game data from RAWG", linked to rawg.io, and you cannot turn that off. The title, cover and "RAWG page" also link to the
  game's page on RAWG.
- RAWG's data and images must not be redistributed. This plugin only shows them to the person searching, and the covers
  are fetched through degoog's own image proxy.

## When the panel appears (and what it costs)
RAWG is only called for queries that look like a game title. The plugin checks, in this order, and stops at the first "no":
1. A key is set, and RAWG has not recently said "slow down".
2. The query is 2 to 80 characters and at most 8 words, and is not a question or how-to ("how to...", "what is..."), a web
   address, a calculation or similar.
3. If **Only for queries that sound like games** is on, it also contains a game word (`game`, `steam`, `ps5`, `xbox`,
   `walkthrough`, `review`, `dlc`, `mods`, `rpg`...).
4. RAWG is asked for the 5 best matches (**1 request**), and the panel shows only if one is a confident match: the title
   matches (ignoring case, accents, punctuation, a leading "the" and a year such as "(2016)") and the game is popular enough
   not to be a fan project with the same name. A game word in the query (`hades game`) relaxes the popularity bar a little.
   A trailing number or numeral counts as a different game, so `hades 2` does not show the first Hades.
   If several RAWG entries share the name, the closest title wins, then the one most players have added.
5. For a match, **1 more request** fetches the full details (description, developer, publisher, website).

Game words at the **end** of the query are dropped before searching (`elden ring ps5 review` searches `elden ring`).
Words at the start are kept, so `game dev tycoon` still finds Game Dev Tycoon.

So a new game costs at most 2 requests, a query that is not a game costs 0 or 1, and **everything is cached**: searches for
24 hours (including "no match"), game details for 7 days. Identical simultaneous searches share a request. Searching the
same game again costs nothing.

## Staying under the limit
- **Monthly request limit** (default 15,000): the plugin counts its requests per calendar month in `data/rawg/usage.json`
  and stops calling RAWG when it is reached, so the free 20,000 is never exceeded. `0` turns the guard off.
- On HTTP 429 it pauses for the `Retry-After` time (10 minutes if none, at most an hour). On 401 or 403 (bad key, or quota
  spent) it pauses 30 minutes. On a server error or a network failure it pauses a minute. While paused it makes no requests
  and shows no panel; it logs one short line when a pause starts, without any address or key.
- No retries.
- RAWG only accepts the key as a URL parameter, so the plugin never logs or prints request addresses.

## Options
- **RAWG API key**: see Setup.
- **Only for queries that sound like games**: off by default. Turn it on to save requests, at the cost of missing plain
  title searches such as `hades`.
- **Fetch full details**: on by default. Off keeps it to 1 request per new game and drops description, developer,
  publisher and the official site.
- **Monthly request limit**: see above.

## Development notes
- `tests/fixtures/rawg-search.json` and `rawg-detail.json` are **real RAWG responses** for "elden ring" (a search trimmed to
  5 results, and one game detail). RAWG's `next` link in a search reply contains the API key, so it is removed. To re-record
  them (2 requests, key stays on your machine): `RAWG_API_KEY=your-key bun ./tests/record-rawg-fixtures.js "elden ring"`.
  The script refuses to save a file that still contains a key.
- `tests/mock-rawg-server.js` is a small local stand-in for the API, used for checking the plugin inside a real degoog
  container (`DEGOOG_RAWG_API_BASE` points the plugin at it).
- The panel's settings are stored under the id `rawg-slot`.
