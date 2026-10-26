# Board games panel for degoog (BoardGameGeek data, three sources)

When you search for a board game, this shows an information panel beside the results, the same way the sibling
[game info plugin](../game-info/README.md) does for video games: the box cover, the title, the BoardGameGeek (BGG)
**average rating**, **rank** and **weight** (each labelled with where it comes from), a short description, the number of
players (with "best with" and "recommended" counts), playing time, age, designers, publishers, categories, mechanics and the
number of expansions on BGG. It links to the game's BGG page and always credits where the data came from.

The data can come from **three sources**, each with its own on/off toggle, tried in a fixed order with an automatic
fallback. **You decide which sources to enable, and you are responsible for that choice**: read "Terms and risks" below.

## The sources

| # | Source | Needs a key? | What it gives | Cost per new game | Caveats |
|---|---|---|---|---|---|
| 1 | **BGG XML API** | Yes, a token (registration required) | Everything, with the rating, rank and weight | 2 requests (search + one details batch) | Licensed. Non-commercial, credit BGG. Approval for a token can take a while. |
| 2 | **recommend.games** | No | Everything except publishers and the expansion count | 1 request | Small third-party mirror of BGG data. No stated data licence or rate limits. |
| 3 | **BGG's own website API** (+ Wikidata for ids) | No | Everything | 2 requests to BGG, plus 2 to Wikidata unless an earlier source already found the id | **Off by default.** Unlicensed per BGG's terms, no name search, may break or be blocked any time. |

## The fallback chain

The order is fixed: **1) BGG XML API, 2) recommend.games, 3) BGG website API**. A source is *usable* when it is enabled,
not paused, not over its daily limit, and (for source 1) a token is set. The chain asks the usable sources in order:

- A source that **answers** ends the chain. If it finds a confident match, that game is shown. If it finds none, **no
  panel is shown**: a working source's "no match" is final, and it is cached.
- A source that is **unavailable** hands over to the next usable one. That means: disabled, no token, paused, over its
  daily limit, a network error, HTTP 401/403/429/5xx, a Cloudflare challenge page, or a reply that cannot be read.
- If no source is usable or all are unavailable, there is no panel.
- When source 1 found candidate ids but then failed (for example its search worked but the details request did not), the ids
  are handed on, so source 3 can fetch those games' details directly without asking Wikidata.
- The whole chain shares degoog's slot time (`DEGOOG_SLOT_TIMEOUT_MS`, 10 s by default): no request is started after 70 % of
  it has passed, and the panel is skipped rather than shown late.

So with everything default and a token, only the XML API is ever called. Without a token, or while the XML API is paused,
recommend.games is used, and so on. The panel's footer names the source in use: "Powered by BGG" (source 1),
"Data from recommend.games (originally from BoardGameGeek)" (source 2), "Data from BoardGameGeek" (source 3).
The rating, rank and weight badges are labelled "BGG rating", "BGG rank" and "Weight / 5" for every source, because the
numbers are BoardGameGeek's in every case.

## Setup
1. **For source 1: register an application with BGG and get an API token.** Since late 2025 BGG's XML API only answers
   registered applications: without a token every request gets `401 Unauthorized`.
   - Register at <https://boardgamegeek.com/applications> (or through the form linked from
     <https://boardgamegeek.com/using_the_xml_api>). Describe it honestly: a personal, non-commercial search page that
     shows BGG data to its own user with a credit to BGG. **Approval can take a while.** BGG then gives you a token.
   - Skip this and the plugin simply starts with source 2.
2. In degoog: Settings > Store > add this repository, then install **Board games (BoardGameGeek)** (Plugins).
3. Settings > Plugins > **Board games (BoardGameGeek)** > Configure. The page has three groups: **Sources** (the three
   toggles and the token), **Display**, and **Limits** (advanced). Paste the token, or set `BGG_API_TOKEN` in the container
   environment (a value saved in the UI wins). The token is saved on the server only, is sent in the `Authorization`
   header **to the BGG XML API only** (never to the other sources), and is never put in a request address, a log line or a
   page. **Never paste it in a chat or commit it.**
4. Search for a board game, for example `wingspan`.

By default the panel sits in the **side column** (`knowledge-panel`), under degoog's Wikipedia panel if there is one. The
same Configure page lets you move it to above or below the sidebar, or above the results.

## Toggles and limits

| Setting | Default | What it does |
|---|---|---|
| Use the BGG XML API | on | Source 1. Skipped silently without a token. |
| BGG API token | empty | `BGG_API_TOKEN` is used when empty. |
| Use recommend.games when the first source is unavailable | on | Source 2. |
| Use BGG's own website API as a last resort | **off** | Source 3. Opt-in, see the risks. |
| Only for queries that sound like board games | off | Needs a board game word in the query (saves requests). |
| Show a short description | on | |
| BGG API daily request limit | 300 | Per UTC day, kept in `data/bgg/usage.json`. |
| recommend.games daily request limit | 500 | Kept in `data/bgg/usage-recommend-games.json`. |
| BGG website API daily request limit | 100 | Also counts the Wikidata requests it makes. Kept in `data/bgg/usage-geekdo.json`. |

For every limit `0` means no cap. A source that reaches its limit is unavailable until the next UTC midnight (re-checked
every hour at most), and the chain moves on to the next one.

## When the panel appears (and what it costs)
The plugin checks, in this order, and stops at the first "no":
1. At least one enabled source is usable (see above).
2. The query is 2 to 80 characters and at most 8 words, and is not a question or how-to ("how to...", "what is..."), a web
   address, a calculation or similar.
3. The query has no **video game word** (`ps5`, `xbox`, `steam`, `pc`, `switch`, `dlc`, `walkthrough`, `speedrun`, `mods`,
   `gameplay`, `controller`...), unless it also says it is about a board game. So `skyrim walkthrough` never reaches BGG.
4. If **Only for queries that sound like board games** is on, it also contains a board game word (`board game`, `tabletop`,
   `bgg`, `meeple`, `rulebook`, `rules`, `setup`, `expansion`, `solo variant`, `worker placement`, `deck builder`,
   `card game`, `dice game`, `how to play`, `player count`...).
5. The first usable source is asked. Whichever source it is, a game is shown only for a **confident match**: the title
   matches (ignoring case, accents, punctuation, a leading "the" and a year in brackets; alternate names count) and the game
   has enough BGG ratings not to be an obscure game with the same name. A board game word in the query lowers the bar. A
   trailing number or numeral counts as a different game, so `azul 2` does not show Azul. A word that fits the subtitles of
   several series (`legacy`) shows nothing unless the query also says it is about a board game. Expansions are never shown.
   If several entries share the name, the closest title wins, then the one with the most ratings.

Board game words at the **end** of the query are dropped before searching (`wingspan board game` searches `wingspan`,
`catan rules` searches `catan`).

**Everything is cached, per source** (`ext:board-games:<source>:search|details`, so switching a source on or off takes effect
at once): the XML API's candidate ids for 24 hours and each game's details for 7 days; recommend.games' answer for 24 hours
(an empty answer too); the website API's name-to-id lookup and each game's details for 7 days. Identical simultaneous
searches share a request. Searching the same game again costs nothing.

## Being polite
- **At least 1 second between requests to the same source** (they queue up), and **no retries**.
- Per-source **daily limits**, see above. A pause on one source never stops another.
- On HTTP 429 a source is paused for the `Retry-After` time (10 minutes if none, at most an hour). On 401 or 403, or on an
  HTML page such as a Cloudflare challenge ("Just a moment"), it is paused 30 minutes. On a server error, a 202 ("try again
  later") or a network failure it is paused a minute. A pause logs **one short line** when it starts, without any address,
  id or token.
- **A Cloudflare challenge is never solved or bypassed.** If BGG's website API answers one, source 3 simply waits 30
  minutes. The plugin does not probe for other endpoints.
- Honest `User-Agent` on every request (and `Api-User-Agent` for Wikidata, as Wikimedia asks).
- The XML reader is small and has no dependencies. It never expands custom entities, skips DOCTYPEs, caps size and depth, and
  returns nothing for malformed input. recommend.games replies are read object by object, the first 30 results only.

## Terms and risks (please read)
**You are responsible for deciding which sources to enable.** The summaries below are mine, from the services' own pages and
third-party reports; check the current terms yourself.

- **BGG XML API (source 1): licensed, token required.** Non-commercial use. Credit BGG by name and show the "Powered by
  BGG" logo, linked to BGG, on public uses; no use of BGG data for AI/LLM training, no modifying the data, no relaying it to
  other apps. This plugin only shows the data, unchanged apart from tidying the description's formatting, to the person
  searching, from the server, cached.
- **recommend.games (source 2): a third-party mirror of BGG data.** The code is open source (MIT), but the site states no
  licence for its data and no rate limits. It is a small project: the plugin asks gently (1 request per new game, cached,
  capped), but it **could change or disappear**, and its data is BoardGameGeek's, so BGG's terms still apply to it in spirit.
- **BGG's own website API (source 3): off by default.** This is the JSON API that BGG's own website uses
  (`api.geekdo.com`). It needs no key, but BGG's XML API terms describe it as unlicensed, so it is **opt-in**, rate limited,
  and it **could break or be blocked at any time**. It has **no name search**: a name is turned into a BGG id with
  Wikidata, so only games that have a Wikidata item with a BoardGameGeek id are found that way, unless an earlier source
  already found the candidate id. It does not provide the extras the XML API does, and it makes 2 requests per game.
- **Wikidata** (used only by source 3, to find ids) is CC0 and free; the plugin identifies itself in its user agent as
  Wikimedia's policy asks.
- Cover images come from `cf.geekdo-images.com`, are only accepted from https URLs on that host, and are fetched through
  degoog's own image proxy.
- **The "Powered by BGG" logo.** The panel credits BGG as text. The official logo files are on a Google Drive linked from
  BGG's API page, so you have to download them yourself; to use one, put an `<img>` (served from your own server) inside the
  credit link in `render.js` (`attributionHtml`) and size `.board-games-credit img` in `style.css`. If your instance is
  public, do this.

## Limitations (honest)
- **The test data is invented.** BGG's XML API only answers registered applications, so its layout is written from
  documentation and third-party reports and is **unverified** until real fixtures are recorded. The recommend.games, BGG
  website API and Wikidata layouts were checked against the live services (field names and types only) while building this.
- recommend.games returns every fuzzy match for a search and its ordering is not assumed: the plugin reads the first 30
  results, drops expansions, and matches locally, so a game far down a very long list of matches can be missed.
- The matching constants were chosen without real data and will need tuning.
- If BGG or recommend.games change their formats, the affected source becomes "unavailable" and the chain moves on.

## Development notes
- **All fixtures are hand-written, with invented data** (the game "Starfall" and friends, ids from 900001, invented
  descriptions, numbers and Wikidata Q-ids): `bgg-search.xml`, `bgg-thing.xml`, `recommend-games-search.json`,
  `geekdo-geekitem.json`, `geekdo-dynamicinfo.json`, `wikidata-search.json`, `wikidata-entities.json`. None is a real
  recording.
- To record **real** XML API fixtures (2 requests, 1.5 s apart; your token stays on your machine):
  `BGG_API_TOKEN=your-token bun ./tests/record-bgg-fixtures.js "wingspan"`. The script refuses to save a file that contains
  the token. Anything recorded from BGG, recommend.games or BGG's website API is BGG-derived data: **keep it local, do not
  commit it**.
- `tests/mock-board-games-server.js` is one local stand-in for every upstream, path-routed from one base URL (token
  `test-token`): `DEGOOG_BGG_API_BASE=http://host:4469/xmlapi2`, `DEGOOG_RECOMMEND_GAMES_BASE=http://host:4469/recommend`,
  `DEGOOG_GEEKDO_BASE=http://host:4469/geekdo/api`, `DEGOOG_WIKIDATA_API=http://host:4469/wikidata/w/api.php`. A search term
  containing `apidown` makes the XML API answer 503, `recdown` does the same for recommend.games, and `cfblock` makes the
  website API answer a Cloudflare-style 403 page. `GET /__stats` counts requests per upstream.
- Layout: `index.js` (settings, gating, the chain), `sources/` (one module per source behind `usable()` and
  `lookup({term, intent, context, deadline, hints})`), `upstream.js` (pause, spacing, budget and status handling shared by
  all of them), `shape.js` (every source's normalised game), `match.js`, `render.js`, `xml.js`.
- The matching rules and their tuning constants (similarity values, rating-count thresholds, candidate limits, accepted item
  types, the board game and video game word lists) are at the top of `match.js`.
- The panel's settings are stored under the id `board-games-slot`.
