# Board games panel for degoog (BoardGameGeek)

When you search for a board game, this shows an information panel beside the results, the same way the sibling
[game info plugin](../game-info/README.md) does for video games: the box cover, the title, the BoardGameGeek (BGG)
**average rating**, **rank** and **weight** (each labelled with where it comes from), a short description, the number of
players (with "best with" and "recommended" counts), playing time, age, designers, publishers, categories, mechanics and the
number of expansions on BGG. It links to the game's BGG page and always credits BGG.

## Setup
1. **Register an application with BGG and get an API token.** Since late 2025 BGG's XML API only answers registered
   applications: without a token every request gets `401 Unauthorized`.
   - Register at <https://boardgamegeek.com/applications> (or through the form linked from
     <https://boardgamegeek.com/using_the_xml_api>). Describe it honestly: a personal, non-commercial search page that
     shows BGG data to its own user with a credit to BGG.
   - **Approval can take a while.** BGG then gives you a token.
2. In degoog: Settings > Store > add this repository, then install **Board games (BoardGameGeek)** (Plugins).
3. Settings > Plugins > **Board games (BoardGameGeek)** > Configure: paste the token. Or set `BGG_API_TOKEN` in the
   container environment (a value saved in the UI wins). The token is saved on the server only. It is sent in the
   `Authorization` request header and never in a request address, a log line or a page. **Never paste it in a chat or commit it.**
4. Search for a board game, for example `wingspan`.

By default the panel sits in the **side column** (`knowledge-panel`), under degoog's Wikipedia panel if there is one. The
same Configure page lets you move it to above or below the sidebar, or above the results.

## When the panel appears (and what it costs)
The plugin checks, in this order, and stops at the first "no":
1. A token is set, BGG has not recently said "slow down" or refused the token, and today's request limit is not used up.
2. The query is 2 to 80 characters and at most 8 words, and is not a question or how-to ("how to...", "what is..."), a web
   address, a calculation or similar.
3. The query has no **video game word** (`ps5`, `xbox`, `steam`, `pc`, `switch`, `dlc`, `walkthrough`, `speedrun`, `mods`,
   `gameplay`, `controller`...), unless it also says it is about a board game. So `skyrim walkthrough` never reaches BGG.
4. If **Only for queries that sound like board games** is on, it also contains a board game word (`board game`, `tabletop`,
   `bgg`, `meeple`, `rulebook`, `rules`, `setup`, `expansion`, `solo variant`, `worker placement`, `deck builder`,
   `card game`, `dice game`, `how to play`, `player count`...).
5. BGG is searched for board games (**1 request**). Every result is scored locally by title (the primary and the alternate
   names), and the closest (at most 8, similarity of at least 0.8) become candidates. No candidate: nothing more is
   requested, and "no candidates" is remembered.
6. The candidates' details and statistics are fetched in **one batch request**. The panel shows only if one is a confident
   match: the title matches (ignoring case, accents, punctuation, a leading "the" and a year in brackets) and the game has
   enough BGG ratings not to be an obscure game with the same name. A board game word in the query lowers the bar.
   A trailing number or numeral counts as a different game, so `azul 2` does not show Azul. A word that fits the subtitles
   of several series (`legacy`) shows nothing unless the query also says it is about a board game. Expansions are never shown.
   If several entries share the name, the closest title wins, then the one with the most ratings.

Board game words at the **end** of the query are dropped before searching (`wingspan board game` searches `wingspan`,
`catan rules` searches `catan`). Words at the start are kept.

So a new board game costs **2 requests** (1 search + 1 details batch), and a query that is not a game costs 0 or 1.
**Everything is cached**: a search's candidate ids for 24 hours (including "no candidates"), each game's details for 7 days.
Searching the same game again, or a neighbouring title whose details are already cached, costs nothing more than the
search. Identical simultaneous searches share a request. A title-like query that is not a board game, such as `skyrim`, costs
one BGG search the first time and is then remembered for a day.

## Being polite
- **At least 1 second between BGG requests** (they queue up), and **no retries**. BGG publishes no numeric rate limit.
- **Daily request limit** (default 300): the plugin counts its requests per UTC day in `data/bgg/usage.json` and stops
  calling BGG when it is reached, until the next UTC midnight. `0` turns the guard off.
- On HTTP 429 it pauses for the `Retry-After` time (10 minutes if none, at most an hour). If BGG answers 401 or 403, or
  sends an HTML page such as a Cloudflare challenge ("Just a moment"), it pauses 30 minutes. On a server error, a 202
  ("try again later") or a network failure it pauses a minute. While paused it makes no requests and shows no panel; it logs
  one short line when a pause starts, without any address or token.
- degoog gives a slot 10 seconds (`DEGOOG_SLOT_TIMEOUT_MS`). A request only starts if there is still time for it to finish;
  when the spacing wait would not fit, the panel is skipped for that search (the search result is cached, so the next
  attempt only needs the details request).
- The XML reader is small and has no dependencies. It never expands custom entities, skips DOCTYPEs, caps size and depth, and
  returns nothing for malformed input.

## Options
- **BGG API token**: see Setup.
- **Only for queries that sound like board games**: off by default. Turn it on to save requests, at the cost of missing plain
  title searches such as `wingspan`.
- **Show a short description**: on by default.
- **Daily request limit**: see above.

## BGG's terms (please read)
The terms below are from third-party summaries of BGG's API terms, so check the current text when you register.
- BGG's data is for **non-commercial** use. A commercial site needs an agreement with BGG.
- **Credit BGG by name and show the "Powered by BGG" logo**, linked to BGG, on public uses. The panel always ends with
  "Powered by BGG" as a text link to boardgamegeek.com, and the title, cover and "BGG page" link to the game's page. The
  official logo files are on a Google Drive linked from BGG's API page, so you have to download them yourself; to use one,
  put an `<img>` (served from your own server) inside the credit link in `render.js` and size `.board-games-credit img` in
  `style.css`. If your instance is public, do this.
- No use of BGG data for AI/LLM training, no modifying the data, and no relaying it to other apps. This plugin only shows
  the data, unchanged apart from tidying the description's formatting, to the person searching. Requests are made on the
  server and cached, never from the browser.
- Cover images come from `cf.geekdo-images.com` and are fetched through degoog's own image proxy. Only https images on
  `geekdo-images.com` are accepted.

## Limitations (honest)
- **The test data is invented.** BGG only answers registered applications, so the XML layout (element and attribute names,
  the polls, the rank representation) is written from documentation and third-party reports and is **unverified** until
  real fixtures are recorded. The matching constants were chosen without real data and will need tuning.
- Search results are matched by title only; BGG's search ordering is not assumed, and ties keep its order.
- The panel shows the game BGG itself ranks as a board game. Expansions, accessories and other item types are ignored, and
  it is assumed `type=boardgame` in the search already leaves most of them out.
- If BGG's pages and API are behind a Cloudflare challenge for your server's address, the plugin stops for 30 minutes at a
  time and shows nothing.

## Development notes
- **The fixtures are hand-written**, to BGG's documented layout: `tests/fixtures/bgg-search.xml` and `bgg-thing.xml` use an
  invented game ("Starfall", ids from 900001, invented descriptions and numbers). They are **not real recordings**.
- To record **real** fixtures (2 requests, 1.5 s apart; your token stays on your machine):
  `BGG_API_TOKEN=your-token bun ./tests/record-bgg-fixtures.js "wingspan"`. The script refuses to save a file that contains
  the token. The recorded files are BGG's data, which BGG's terms do not let you redistribute: **keep them local, do not
  commit them**. Some tests expect the Starfall data and will point out where real replies differ.
- `tests/mock-board-games-server.js` is a local stand-in for the API (token `test-token`), used for checking the plugin
  inside a real degoog container: `DEGOOG_BGG_API_BASE=http://host:4469/xmlapi2`.
- The matching rules and their tuning constants (similarity values, rating-count thresholds, candidate limits, accepted item
  types, the board game and video game word lists) are at the top of `match.js`.
- The panel's settings are stored under the id `board-games-slot`.
