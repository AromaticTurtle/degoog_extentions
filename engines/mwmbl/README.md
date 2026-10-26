# Mwmbl engine for degoog

Searches [Mwmbl](https://mwmbl.org), a non-profit, open source web search engine with its own community-run index, on
degoog's normal web tab. It is small compared with commercial engines but surfaces independent sites, and it is a good
companion to Marginalia. Bang shortcut: `!mwmbl`.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Mwmbl**.
2. That's it: no key is needed. Results show up on the web tab alongside your other engines.

Optional: get an API key from your account on mwmbl.org and paste it under Settings > Engines > Mwmbl > Configure
(or set `MWMBL_API_KEY` in the container environment; the UI value wins). A key gives a free allowance of 2,000 searches a
month and counts your usage. It is sent only as an `X-API-Key` header.

## How it uses the API
The engine uses the `v2` search endpoint, `GET https://api.mwmbl.org/api/v2/search/?q=...`. Mwmbl has no paging parameter:
it answers each search with all its results (up to about 70) in one response. So:
- A search makes **one request**, and the response is kept in memory for **10 minutes**. Pages 2, 3 and so on, and repeats of
  the same query (ignoring case and spacing), cost no further requests. Up to 50 queries are kept.
- Identical simultaneous searches share one request.
- At least 1 s between requests, no retries.
- If Mwmbl rate limits you (HTTP 429) the engine pauses for a minute (or the `Retry-After` time). If a key's **monthly quota**
  is spent, the 429 says so, and the engine pauses for 6 hours and says so in the sidebar.
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Cleaning up results
Mwmbl's index is small and rough, so the engine tidies what it gets:
- Results without a title or a normal web link are dropped, and so are duplicates.
- About a third of Mwmbl's pages have no description. They are kept (the title and link are still useful), or hidden with
  **Hide results without a description**.
- Some descriptions contain text with the spaces stripped out, such as `productsLinearisapurpose-builttool...`. The description is
  cut off where that begins.

## Notes
- Mwmbl has no time or language filter and no safe-search setting, so degoog's filters are ignored by this engine. Mwmbl says it
  tries not to surface adult content but cannot guarantee it.
- Each result's `engine` field in Mwmbl's reply is `mwmbl`, `wikipedia`, `google` or `user` (where the page came from); the
  engine does not currently show it.
- Mwmbl changed its API since older integrations were written: SearXNG's engine still calls the v1 endpoint. This one uses
  v2, which returns plain titles and descriptions.
- `DEGOOG_MWMBL_API_BASE` overrides the API host, for tests against a local mock.
- `tests/fixtures/mwmbl-search.json` is a real excerpt of a Mwmbl response (six results chosen to include the awkward cases).
