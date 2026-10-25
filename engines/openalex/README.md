# OpenAlex engine for degoog

Searches [OpenAlex](https://openalex.org), an open index of scholarly works, and shows the results on a **Scholar** tab.

## Setup
1. In degoog: Settings > Store > add this repository, then install **OpenAlex**.
2. Optional: Settings > Engines > OpenAlex > Configure and paste an API key. Without a key it works on a small
   daily budget; a free key (openalex.org, Settings, API key) raises that tenfold. The key is stored on the server
   and sent only as an `Authorization` header. `OPENALEX_API_KEY` in the container environment also works; the UI value wins.
3. Search from the **Scholar** tab, or use the bang `!oa`.

## Scholar tab
The engine declares the search type `scholar`, so degoog adds a Scholar tab by itself. Engines of this type
(OpenAlex, CORE) run only on that tab, never on normal web searches, so they cost nothing until you open it.

## Politeness and cost
OpenAlex bills search requests (about $1 per 1,000) against a daily budget (free keys get $1 a day).
- One request per page; at least 1 s between requests; no retries.
- Asks only for the fields it shows (`select=`), 10 results per page by default.
- Reads `X-RateLimit-Remaining`: when the budget hits zero the engine stops until the reset time (up to 6 h).
- After HTTP 429 or 503 it pauses for the `Retry-After` time (default 10 s).
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Options
- **Results per page** (1 to 50) and **Open access only**.
- degoog's time filter maps to a publication-date filter, and the language filter to OpenAlex's `language` filter.

## Notes
- OpenAlex data is CC0.
- `DEGOOG_OPENALEX_API_BASE` overrides the API host, for tests against a local mock.
- `tests/fixtures/openalex-search.json` is hand-written from the documented response shape, not recorded.
