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
| How long to wait for the video game answer (seconds, advanced) | 3 | 1 to 8. See "Board game or video game?" (what happens when both match is set in the Game info plugin). |
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
   matches (ignoring case, accents, punctuation, a leading "the", a year in brackets and edition marks such as "(Second
   Edition)"; alternate names in Latin letters count) and the game has enough BGG ratings not to be an obscure game with the
   same name (see "How the match is decided"). A board game word in the query lowers the bar. A trailing number or numeral
   counts as a different game, so `azul 2` does not show Azul. A word that fits the subtitles of several series (`legacy`)
   shows nothing unless the query also says it is about a board game. Expansions are never shown. If several entries share the
   name, the closest title wins, then the one with the most ratings.

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

## Board game or video game?
Some titles are both: a board game with a digital version (Wingspan), a video game with a board game adaptation (Stardew
Valley). When **both** this plugin and the **Game info** plugin match the same title, **the one that came first wins**, by
release year:

- Wingspan: board game 2019, video game 2020 -> this **board game** panel shows. Likewise Gloomhaven (board 2017, video 2019) and
  Dune (board 1979, video 1992).
- Stardew Valley: video game 2016, board game adaptation 2023 -> the **video game** panel shows and this one stays empty.
- **Tie-breaker:** on the same year, or when either year is unknown or invalid, the **board game** wins.
- Titles that exist only as a board game (`catan`) or only as a video game (`skyrim`) behave as before.

**The setting is in the Game info plugin** (**When a board game and a video game match the same title**: whichever came
first (default), always the board game, always the video game, or show both panels). This plugin has no such setting; it is
told the value whenever it asks Game info, so the two can never disagree. The old Game info toggle "Prefer the board game
panel" is gone and its default (always the board game) changed. This plugin has one related setting, **How long to wait for
the video game answer (seconds)** (advanced, default 3, 1 to 8, never past 70 % of the slot time).

- **Explicit words win.** A word that can only mean a video game (`wingspan ps5`, `skyrim walkthrough`, `elden ring steam`,
  `remake`, `rpg`...) never reaches this plugin; a board game word (`wingspan board game`, `catan rules`, `tabletop`) always does,
  keeps the video game panel away, and nothing is asked. Bare `game`, `guide`, `review`, `wiki`, `trailer`, `co-op` and
  `multiplayer` decide nothing: `wingspan game` is searched as `wingspan`. Both plugins keep the same word lists (a test checks
  they agree).
- **Without the Game info plugin** (not installed, disabled, no credentials, IGDB paused, or its answer is "unknown" or too
  slow) the board game shows.
- **The contract** (two optional functions on `globalThis`, nothing is imported across plugins; neither ever calls the other
  plugin): in `init()` this plugin registers `lookupTitle({ term, deadlineMs, context })` under
  `Symbol.for("degoog-extentions.board-games.lookup")` (replaced on every init, removed when the module is reloaded, so a
  disabled plugin is never registered). It answers `{ status: "match", name, id, year }` (year as an integer, 0 when unknown)
  for a confident board game, `{ status: "none" }` when a working source found no confident match, and `{ status: "unknown" }`
  when no source is usable (disabled, no token, paused, over its limit, or **Only for queries that sound like board games** is
  on, which a plain title does not satisfy), when it was too slow, or on any failure. It uses the same sources, caches, pauses,
  limits and single-flight as a search, so asking and searching for the same title cost one request together. It never
  throws, makes no request without a usable source, and waits at most `deadlineMs`; a slower reply keeps running and fills the
  cache. The mirror function is `Symbol.for("degoog-extentions.game-info.lookup")`.
- **Order does not matter.** Degoog runs slot plugins one after the other (by `priority`, then folder name, so this plugin first
  by default). Each plugin asks the other after its own confident pick; both get the same answers from the shared cache, so
  both orders give the same panels.
- **A cold first search** that is too slow for the other plugin to wait for (recommend.games needs 1 to 5 s with its vote
  ordering, see "Performance") makes the plugin that waited show itself; the lookup of a plugin that has already given up on
  the search says `unknown`. The reply is cached, so later searches are consistent. Remaining limitation: on a very slow cold
  search both panels can show once.
- With **Explain matching in the log** on, a both-match decision is one line:
  `[board-games] "wingspan" both match: board "Wingspan" 2019 vs video "Wingspan" 2020, mode=oldest -> showing board`; the
  cases where nothing was decided (`board game shown: the game info plugin is not available`, `... video game lookup unknown or
  too slow`) and each question from Game info (`[board-games] "wingspan" asked about by game-info: match "Wingspan" 2019`) are
  logged too.

## How the match is decided
A game with the right title is shown when it has **enough BGG ratings for how specific your query is**: a long, distinctive title
(three or more words, or 14+ letters) needs few ratings, a two-word or long single-word title (`wingspan`, `catan`) a moderate
number, and a short single word (`risk`, `root`) many, since many games share it. When recommend.games lists the game as its
**first result** and the title matches closely, half is enough (BGG's own search order is not assumed, so the XML API does not
get this bonus). Edition marks and brackets are ignored on both sides, and a game's alternate names count, but only the ones in
Latin letters: a name in another script would lose its letters and could look identical to a different game. The numbers are
the constants at the top of `match.js` (`BARS`, the intent thresholds) and were chosen without real data.

## Performance: why recommend.games is asked for an ordering
Measured against the live service (a handful of requests, spaced out, nothing stored): `GET /api/games/?search=wingspan`
takes **15 to 20 seconds** (17 s, 17 s and 19 s in three tries), while the same search with `&ordering=-num_votes` takes
**1 to 5 seconds** (2.2 s, 5.0 s for wingspan, 1.0 s for catan, 0.6 s for gloomhaven; 6 to 78 matches, the same games). The
server's default ordering is its own recommendation rating, which is expensive to sort. The plugin therefore always sends
`ordering=-num_votes`; as a bonus the best known games are on the first page, which is the one that is read.

Other things that were checked and do **not** help: `limit`, `page_size` and `fields` are ignored by the API (it is a
plain Django REST Framework list: 25 per page, a name `icontains` search, no dynamic fields), and `bgg_id` and `name` are
not filters. The detail route `/api/games/<bgg id>/` answers in about 0.35 s with everything the panel needs, but there is no
way to ask for a game by name there, so it would need a name-to-id step first (Wikidata, about 0.4 s per call, 2 calls);
that is not needed while the ordered search stays fast, and it only covers games that have a Wikidata item with a BGG id
(for example "Catan" is labelled "The Settlers of Catan" there). BGG's website API answers in 0.1 to 0.2 s but cannot search
by name and stays opt-in. If recommend.games ever becomes slow again, the late reply is still cached and the next search for
the title is instant (see Troubleshooting).

## Troubleshooting: why did (or didn't) a panel show
- **The first search for a game shows nothing, the second one works.** This happens when a source needs more than the 10
  seconds degoog gives a slot (recommend.games did without the ordering above; it now needs 1 to 5 seconds). The plugin gives
  up on that search just before degoog's limit, but the request keeps running and its answer is **cached**, so searching
  again a moment later shows the panel at once (and costs no request). A second search while the first is still running
  shares it. The BGG XML API with a token typically answers in a couple of seconds.
- Turn on **Explain matching in the log** (Settings > Plugins > Board games > Configure, under Troubleshooting; off by default,
  no cost when off). Every lookup then writes one block to the server log: which source answered, the candidates (up to six),
  how well each title fits, the rating counts and the rule that accepted a game or what it was missing, for example
  `rejected: needs pop>=1000, has 85`. A title-like query that never reached a source gets one line saying why (a video game
  word, no usable source...), and a lookup that is still running when the time is up says so. Only the query and game names are
  logged, never the token or an address.
- From your own terminal, one lookup chain with the real services (a single recommend.games request, slow as above, unless you
  set `BGG_API_TOKEN`; add `--internal` to allow BGG's website API too; nothing is saved; the output is refused if it contains
  the token): `bun ./tests/diagnose-board-games.js "wingspan"`.

## Limitations (honest)
- **The test data is invented.** BGG's XML API only answers registered applications, so its layout is written from
  documentation and third-party reports and is **unverified** until real fixtures are recorded. The recommend.games, BGG
  website API and Wikidata layouts were checked against the live services (field names and types only) while building this.
- recommend.games returns every fuzzy match for a search and its ordering is not verified: the plugin reads the first 30
  results, drops expansions, and matches locally, so a game far down a very long list of matches can be missed. Only the "first
  result needs half the ratings" bonus relies on the order, and only for a close title match.
- recommend.games answers in 1 to 5 seconds with the vote ordering (15 to 20 without it), see "Performance" above. It is a small
  third-party service: if it slows down again, the first search of a new title shows nothing and the next one works.
- A game that is not on the first page of matches (25, best known first) is not seen, which only matters for obscure games with a
  very common word in their name.
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
  website API answer a Cloudflare-style 403 page. `moonharvest` (board 2023), `tiebreak` (2020) and `driftwood` (2018) are also board games here, to match the invented video
  games of the game-info mock. `MOCK_DELAY_MS=5000` in its environment makes every answer wait that long
  (to try a slow upstream). `GET /__stats` counts requests per upstream.
- Layout: `index.js` (settings, gating, the chain), `sources/` (one module per source behind `usable()` and
  `lookup({term, intent, context, deadline, hints})`), `upstream.js` (pause, spacing, budget and status handling shared by
  all of them), `shape.js` (every source's normalised game), `match.js`, `render.js`, `xml.js`.
- `tests/diagnose-board-games.js` runs one real lookup chain and prints the explain block (see "Troubleshooting").
- The matching rules and their tuning constants (similarity values, rating-count thresholds, candidate limits, accepted item
  types, the board game and video game word lists) are at the top of `match.js`.
- The panel's settings are stored under the id `board-games-slot`.
