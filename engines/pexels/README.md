# Pexels engine for degoog

Searches [Pexels](https://www.pexels.com) photos on degoog's **Images** tab through Pexels' **official API**. A free API
key is required. Without one the engine does nothing and makes no requests.

## Setup
1. Get a free key at https://www.pexels.com/api/ (a Pexels account, then "Your API Key"; it is issued instantly).
2. In degoog: Settings > Store > add this repository, then install **Pexels**.
3. Settings > Engines > Pexels > Configure and paste the key. It is stored on the server and shown back only as "set".
   `PEXELS_API_KEY` in the container environment also works; the UI value wins.
4. Use the Images tab, or the bang `!pexels`.

Without a key the engine returns nothing and logs nothing. With `debugMatching` on it says "no API key" once per search.

## The Pexels terms, and how this engine follows them
Read from https://www.pexels.com/api/documentation/ when this engine was written.

| Rule | What the engine does |
| --- | --- |
| The key goes in the `Authorization` header | It does: the bare key, exactly as documented, and never in an address, a log, a cache key or a result. |
| Default limits: 200 requests an hour and 20,000 a month | Both are counted and kept on disk in `data/pexels/usage.json` (counts only, no key). The engine stops asking at the cap and says so in the sidebar. The monthly count is aligned with the `X-Ratelimit-*` headers Pexels sends on successful replies; when they report nothing left the engine waits until the reset time. Do not try to get around the limit; ask Pexels for a higher one if you need it. |
| HTTP 429 | The engine pauses for `Retry-After` (15 minutes when it is missing, at most an hour) and says so once. |
| A prominent link back to Pexels and credit to the photographer | Every result links to the photo's **Pexels page** and is credited as `Photo by <photographer> on Pexels`, in the title (degoog's image preview shows the title, the page host and the engine badge, but not the snippet) and in the snippet, which also gives the photographer's profile address. |
| Do not hotlink-abuse, copy the library or imply endorsement | Nothing is downloaded or stored. degoog's image proxy fetches an image when somebody views it. |

Pexels asks that the credit is a link. degoog renders result titles as plain text and its preview links to the result
page (the Pexels photo page), so the link back to Pexels is the "Visit page" button and the source host shown with each
image. If you want a stricter reading of the guidelines for a public instance, check them yourself first.

## Settings
- **Orientation**, **size**, **language** (Pexels locale) and **results per page** (10 to 80; each page is one request).
- **Full-size image**: which size the preview uses: `large2x` (1880 px, default), `large` or `original`. The thumbnail is
  always `medium`.
- degoog's own filters win when set: layout, colour and size.
- **Requests per hour** / **per month** (advanced): the caps above; 0 turns one off.
- **debugMatching** (advanced): one line per search in the server log, never the key and never the query.

## Notes
- Results are cached in memory for an hour. Engines in degoog get no `useCache` helper, so the cache is lost on restart.
  The request budgets are what survives a restart.
- Videos (`/v1/videos/search`) are not searched: degoog's Images tab is for pictures.
- `DEGOOG_PEXELS_API_BASE` overrides the API address and `DEGOOG_PEXELS_EXTRA_HOSTS` allows extra image hosts; both are
  for tests against a local mock. `DEGOOG_PEXELS_USAGE_FILE` moves the usage file.
- `tests/fixtures/pexels-search.json` is hand-written from the documented response, with invented data.
- To check your key and the real response shape, run (fish):
  `cd ~/Documents/degoog_extentions; read -sx PEXELS_API_KEY; bun ./tests/diagnose-pexels.js; set -e PEXELS_API_KEY`
  It makes at most 2 requests and never prints the key.
