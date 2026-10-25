# Marginalia engine for degoog

Searches [Marginalia](https://marginalia-search.com), an index of the small, non-commercial web, through its API.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Marginalia**.
2. Settings > Engines > Marginalia > Configure, and paste your API key. It is stored on the server
   (`data/plugin-settings.json`) and never sent back to the browser.
   Alternatively set `MARGINALIA_API_KEY` in the container environment; the UI value wins when both are set.
3. Bang shortcut: `!marg`.

Keys are free for non-commercial use: email contact@marginalia-search.com.

## Politeness
- One API request per page, no retries inside the engine.
- At least 1 s between requests; a request that would wait more than 5 s is skipped.
- After HTTP 429 or 503 the engine sends nothing for 60 s (or the `Retry-After` value, up to 10 min).
- Asks Marginalia for at most 2 results per domain (configurable) instead of filtering locally.
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Notes
- Results are licensed CC-BY-NC-SA 4.0 and the key is for non-commercial use.
- The API has no time or language filter; degoog's filters are ignored by this engine.
- `DEGOOG_MARGINALIA_API_BASE` overrides the API host. It exists for tests against a local mock.
- `tests/fixtures/marginalia-search.json` is hand-written from the documented response shape, not recorded.
