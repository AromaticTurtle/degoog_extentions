# Pixabay engine for degoog

Searches [Pixabay](https://pixabay.com) photos, illustrations and vector graphics on degoog's **Images** tab through
Pixabay's **official API**. A free API key is required. Without one the engine does nothing and makes no requests.

## Setup
1. Create a free Pixabay account and copy your key from https://pixabay.com/api/docs/ (it is shown in the docs once you
   are signed in).
2. In degoog: Settings > Store > add this repository, then install **Pixabay**.
3. Settings > Engines > Pixabay > Configure and paste the key. It is stored on the server and shown back only as "set".
   `PIXABAY_API_KEY` in the container environment also works; the UI value wins.
4. Use the Images tab, or the bang `!pixabay`.

Without a key the engine returns nothing and logs nothing. With `debugMatching` on it says "no API key" once per search.

## What the Pixabay terms say, and how this engine follows them
Read from https://pixabay.com/api/docs/ and the Pixabay terms of service when this engine was written.

| Rule | What the engine does |
| --- | --- |
| The key is passed as the `key` URL parameter (there is no header authentication) | The address with the key exists only for the request itself. Cache keys, debug lines and error messages are built **without** it, and anything that could mention the address is redacted. Tests assert that the key never appears in a log, an error, a result or a cache key. |
| Requests must be cached for 24 hours | Every search result list is cached in memory for 24 hours (per query, page and filters). The same search costs no request in that time. |
| Rate limit: 100 requests per 60 seconds per key | The engine keeps its own cap (80 a minute by default, setting `requestsPerMinute`), reads the `X-RateLimit-*` headers, and on HTTP 429 pauses until the reset time (at most 5 minutes). |
| Permanent hotlinking is not allowed; the returned URLs "may be used for temporarily displaying search results" | Results hold Pixabay's temporary preview URLs only for the 24-hour cache. degoog's image proxy fetches an image when somebody views it (temporary display of search results) and nothing is stored permanently by this engine. Images are not downloaded, mirrored or kept. See the note below. |
| Show where images come from whenever search results are shown | Every result is credited in its **title** and snippet: `<tags> — by <contributor> via Pixabay`, and links to the image's Pixabay page. degoog's image preview shows the title, the host of the page (pixabay.com) and an engine badge, but not the snippet, which is why the credit is in the title too. |
| Fields that need approved "full API access" | Not used: `fullHDURL`, `imageURL` and `vectorURL` are never read, and videos are not requested. The thumbnail is `webformatURL` (640 px, valid for 24 hours) and the full image is `largeImageURL` (1280 px), both standard fields. |
| At most 500 results per query | A page past that (or Pixabay's "out of valid range" reply) is an empty page, not an error. |

Note on the proxy: degoog serves thumbnails through its own image proxy, so the browser never loads the Pixabay CDN
directly. That is on-demand, temporary display of a search result, which is what the terms allow, but it is the
operator's job to judge the terms for their instance (for example a public one). Do not use this engine to build a
copy of Pixabay's library.

## Settings
- **Safe search** (default: always on): sends `safesearch=true`. "Follow degoog's safe mode" only sends it when degoog's
  own safe mode is on or moderate.
- **Image type** (all, photo, illustration, vector), **orientation**, **order** (popular, latest), **language**,
  **results per page** (3 to 100; each page is one request).
- degoog's own filters win when set: layout (wide, tall), colour, type (photo, clipart, lineart) and safe mode.
- **Requests per minute** (advanced): Pixabay's limit is 100; the default of 80 leaves room. It is kept in memory only
  (a one-minute window is not worth writing to disk).
- **debugMatching** (advanced): one line per search in the server log, never the key and never the query.

## Notes
- Engines in degoog get no `useCache` helper, so the 24-hour cache lives in memory and is lost on restart.
- `DEGOOG_PIXABAY_API_BASE` overrides the API address and `DEGOOG_PIXABAY_EXTRA_HOSTS` allows extra image hosts; both
  are for tests against a local mock.
- `tests/fixtures/pixabay-search.json` is hand-written from the documented response, with invented data.
- To check your key and the real response shape, run (fish):
  `cd ~/Documents/degoog_extentions; read -sx PIXABAY_API_KEY; bun ./tests/diagnose-pixabay.js; set -e PIXABAY_API_KEY`
  It makes at most 2 requests and never prints the key.
