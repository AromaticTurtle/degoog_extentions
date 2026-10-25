# CORE engine for degoog

Searches [CORE](https://core.ac.uk), the world's largest collection of open access research papers, and shows the
results on a **Scholar** tab.

## Setup
1. Get a free API key at https://core.ac.uk/services/api.
2. In degoog: Settings > Store > add this repository, then install **CORE**.
3. Settings > Engines > CORE > Configure and paste the key. It is stored on the server and sent only as an
   `Authorization` header. `CORE_API_KEY` in the container environment also works; the UI value wins.
   Without a key the engine does nothing and makes no requests.
4. Search from the **Scholar** tab, or use the bang `!core`.

## Scholar tab
The engine declares the search type `scholar`, so degoog adds a Scholar tab by itself. Engines of this type
(OpenAlex, CORE) run only on that tab, never on normal web searches.

## Politeness
CORE's quota is small (about one search every two seconds, plus a daily allowance).
- One request per page; at least 2.5 s between requests; a request that would wait over 6 s is skipped; no retries.
- After HTTP 429 or 503 it pauses for the `Retry-After` time (default 60 s).
- Never reads the `fullText` field of a result, only the abstract and metadata.
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Notes
- Links go to the DOI when there is one, otherwise to the CORE work page.
- CORE has no time or language filter in this engine; degoog's filters are ignored.
- Please cite CORE if you use it in your work (see https://core.ac.uk/services/api).
- `DEGOOG_CORE_API_BASE` overrides the API host, for tests against a local mock.
- `tests/fixtures/core-search.json` is hand-written from the documented response shape, not recorded.
