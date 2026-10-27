# Books panel for degoog (Hardcover)

When you search for a book, this shows an information panel beside the results, the same way the sibling
[game info](../game-info/README.md) and [board games](../board-games/README.md) plugins do for games: the cover, the title, the
authors, the series and its position ("Orchard Cycle #2"), Hardcover's **average rating** and the number of Hardcover
**readers** (each labelled with where it comes from), a short description, the number of pages, the publication year, genres,
moods, the formats known to exist (audiobook with its length, e-book) and the ISBN. It links to the book's page on
[Hardcover](https://hardcover.app) and always credits it.

## Setup
1. **Create a Hardcover API token with only the `read:catalog` permission.**
   - In Hardcover open your account settings > **Hardcover API** > **New API Key**.
   - Give it a name, set an **expiry**, and choose **only `read:catalog`** (public catalog data and search). **Never choose
     `all`**: a token with it can modify or delete your account, and it must be kept private like a password.
   - Copy the token. It may already start with `Bearer `; paste it either way.
2. In degoog: Settings > Store > add this repository, then install **Books (Hardcover)** (Plugins).
3. Settings > Plugins > **Books (Hardcover)** > Configure: paste the token. Or set `HARDCOVER_API_TOKEN` in the container
   environment (a value saved in the UI wins). The token is saved on the server only and is sent only in the `authorization`
   request header. It is never put in a request address, a log line or a page. **Never paste it in a chat or commit it.**
4. Search for a book, for example `project hail mary`.

Tokens expire when you said they would, and Hardcover may reset tokens without notice while the API is in beta. If the panel
stops appearing, check the server log for the one line `[books] Hardcover rejected the token`, and make a new token.

By default the panel sits in the **side column** (`knowledge-panel`), under degoog's Wikipedia panel if there is one. The same
Configure page lets you move it to above or below the sidebar, or above the results.

## When the panel appears (and what it costs)
The plugin checks, in this order, and stops at the first "no":
1. A token is set, Hardcover has not recently said "slow down" or refused the token, and today's request limit is not used up.
2. The query is 2 to 80 characters and at most 8 words, and is not a question or how-to ("how to...", "what is..."), a web
   address, a calculation or similar.
3. The query has no **video game or board game word** (`ps5`, `steam`, `walkthrough`, `dlc`, `board game`, `tabletop`...),
   unless it also says it is about a book.
4. If **Only for queries that sound like books** is on, it also contains a book word (`book`, `novel`, `author`, `paperback`,
   `hardcover`, `audiobook`, `ebook`, `isbn`, `series`, `trilogy`, `sequel`, `prequel`, `summary`, `synopsis`, `chapters`,
   `reading order`, `read`) or says `by <author>`.
5. Hardcover is searched (**1 request**; the reply carries the full details, so there is no second request). The panel shows
   only for a **confident match**: the title matches (ignoring case, accents, punctuation, a leading "the" and a year in
   brackets; alternative titles and the title without its subtitle count) and enough Hardcover readers saved the book not to
   be an obscure entry with the same name. A book word, or `by <author>`, lowers the bar. A trailing number or numeral counts
   as a different book, so `dune 2` does not show Dune. A word that fits the subtitles of several series (`legacy`) shows
   nothing unless the query also says it is about a book. Compilations ("Complete Collection") are only shown when nothing
   else fits. If several entries share the name, the closest title wins, then one with a release year, then the most saved.

Authors are understood in two forms: `<title> by <author>` (split on the last "by") and `<title> <author>`. Hardcover's search
matches author names too, and the plugin takes the author's name out of the query before comparing titles. A query that is
**only an author** (`frank herbert`) shows no panel in this version.

Book words at the **end** of the query are dropped before searching (`dune novel` searches `dune`, `project hail mary book`
searches `project hail mary`).

So a new title costs **1 request**, a query that is not a book title costs 0 or 1, and **everything is cached**: a search is kept
for 24 hours per title (including "no match"). Searching the same book again costs nothing. Identical simultaneous searches
share a request. A title-like query that is not a book (`starfall`) costs one Hardcover search the first time and is then
remembered for a day.

## Being polite, and Hardcover's limits
- Hardcover's **free plan** allows **5,000 requests a day**, bursts of 10 and **60 a minute**. Each top-level GraphQL field
  counts as one request; this plugin sends one. The plugin keeps its own **daily request limit** (default **1500**, kept in
  `data/hardcover/usage.json`, per UTC day, `0` turns it off) and keeps **at least 1 second** between requests. No retries.
- On HTTP 429 it pauses for the `Retry-After` time (a minute if none, at most an hour); if the `RateLimit` header says the
  **daily** bucket is empty it waits for the reset (UTC midnight), looking again at least every hour. On 401 (invalid or
  expired token) it pauses 30 minutes. On 403 `insufficient_scope` (the token lacks `read:catalog`) it pauses 30 minutes and
  the log line says so. Other 403s pause 10 minutes. On 400, 408, a server error, a network failure, or a GraphQL `errors`
  reply it pauses a minute. While paused it makes no requests and shows no panel; it logs **one short line** when a pause
  starts, without any address or token.
- Hardcover's search has a **2 second** server-side timeout, and degoog gives a slot 10 seconds (`DEGOOG_SLOT_TIMEOUT_MS`):
  no request is started after 70 % of that.

## Options
- **Hardcover API token**: see Setup.
- **Only for queries that sound like books**: off by default. Turn it on to save requests, at the cost of missing plain
  title searches such as `dune`.
- **Show a short description**: on by default.
- **Daily request limit** (advanced): see above.

## Terms and what the panel shows
- **No user-owned data.** Hardcover's API terms forbid using data owned by users on a public site: libraries and stats, user
  reviews, ratings and dates read, journals, lists, prompts, vibes, goals, the network. The panel shows only **catalog fields**
  (title, authors, series, pages, year, description, genres, moods, ISBN, formats) and **aggregate numbers**, always labelled
  as Hardcover's: the average Hardcover rating, its number of ratings, and the number of Hardcover readers. It never shows
  review text, list names or user names, even if a search document carried them.
- **Personal token.** Tokens are personal and must not be shared. The plugin runs server-side only; the browser never sees it.
- **No LLM training.** By using the API you agree not to use it to train large language models that are made publicly
  available or used commercially.
- **Images are user uploads.** Covers on Hardcover are uploaded by users. If your instance is **open to the public**, make sure
  you have a **DMCA takedown policy** listed on your site (Hardcover's own guidance), or take the cover out of the panel
  (the `image` block in `render.js`). Covers are fetched through degoog's own image proxy, and only https images on `hardcover.app` hosts
  are accepted.
- **Beta API.** It can change, and Hardcover may reset tokens without notice.

## Limitations (honest)
- **The test data is invented.** The fixture is written from Hardcover's documentation (the book document fields it lists).
  Some things were not verifiable without a token: the **cover** field is not in the documented list, so the plugin reads
  `image.url`, a plain `image` string and `cached_image` and hopes one is there; the exact shape of `results` (a Typesense
  response) and of `featured_series`, and the type of `id`, are handled defensively rather than known.
- Author-only queries show nothing, and the matching constants (the readers thresholds and similarity values at the top of
  `match.js`) were chosen without real data and will need tuning.
- The `RateLimit` header format is taken from the docs and not verified against a live reply.

## Development notes
- **The fixture is hand-written**: `tests/fixtures/hardcover-search.json` uses invented books ("The Glass Orchard", the Orchard
  Cycle, ids from 9001001), invented authors, texts and numbers, with the field types varied the way the docs suggest (numbers
  as strings, single values, lists). It is **not a real recording**.
- To record a **real** fixture (exactly 1 request; your token stays on your machine):
  `HARDCOVER_API_TOKEN=your-token bun ./tests/record-hardcover-fixtures.js "dune"`. The script refuses to save a file that
  contains the token. The recorded file is real catalog data with user-uploaded image URLs: **keep it local, do not commit
  it**. Some tests expect the Orchard Cycle data and will point out where real replies differ.
- `tests/mock-books-server.js` is a local stand-in for the API (token `test-token`), used for checking the plugin inside a
  real degoog container: `DEGOOG_HARDCOVER_API_URL=http://host:4470/v1/graphql`. A search term containing `quota` makes it
  answer 429, `scope` a 403 `insufficient_scope`, `gqlerror` an HTTP 200 with an `errors` list, `slow` waits 3 seconds, and
  `zzz` finds nothing. `GET /__stats` counts requests.
- The matching rules and their tuning constants are at the top of `match.js`; the panel's settings are stored under the id
  `books-slot`.
