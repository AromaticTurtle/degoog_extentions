# Unsplash engine for degoog

Searches [Unsplash](https://unsplash.com) photos on degoog's **Images** tab through Unsplash's **official API**.
A free API key is required. Without one the engine does nothing and makes no requests.

## Setup
1. Register an application at https://unsplash.com/developers and copy its *access key*.
2. In degoog: Settings > Store > add this repository, then install **Unsplash**.
3. Settings > Engines > Unsplash > Configure and paste the key. It is stored on the server and sent only as an
   `Authorization` header. `UNSPLASH_ACCESS_KEY` in the container environment also works; the UI value wins.
4. Use the Images tab, or the bang `!unsplash`.

Demo applications get 50 API requests an hour, which is plenty for personal use.

## Why there is no keyless mode
Earlier versions (1.0.x) could fall back to Unsplash's website when there was no key or the quota was spent. That was
removed in 1.1.0. Unsplash's Terms of Service (section 8) prohibit accessing the service with bots, scripts or other
automated tools outside the API, and prohibit circumventing access controls; the website sits behind an Anubis
proof-of-work check for that reason. Falling back to the website after the API quota is spent would also circumvent the
quota, which the API Terms (section 12) forbid. Please do not work around this with browser transports or a higher
`DEGOOG_ANUBIS_MAX_DIFFICULTY`.

For keyless Unsplash photos, search the Images tab for `your query site:unsplash.com`; Brave Images, Startpage Images and
DuckDuckGo Images index them.

## Politeness
- One request per page, no retries, at least 1 s between requests.
- When Unsplash says the quota is spent (HTTP 429, or 403 "Rate Limit Exceeded") or the response reports no requests left,
  the engine sends nothing for 10 minutes and says so in the sidebar.
- A rejected key (HTTP 401) is shown as a blocked error.
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Filters
Layout (square, wide, tall), colour and safe mode map to Unsplash's `orientation`, `color` and `content_filter`.
Safe mode "on" asks for the stricter content filter.

## Attribution and the API Terms
Each result names the photographer and shows their Unsplash profile address, for example
`Photo by Jane Doe (unsplash.com/@janedoe) on Unsplash`. Image URLs are used as returned, including `ixid`.
Known gaps against the API Terms, which matter if you ever apply for production access:
- degoog serves thumbnails through its own image proxy instead of the browser loading them from Unsplash (section 6, hotlinking).
- degoog's Download button does not call Unsplash's download-tracking endpoint (section 6).
- The photographer's profile is shown as text, not a clickable link (section 9), because degoog strips link parameters and
  result snippets are plain text.

## Notes
- Unsplash photos are free to use under the [Unsplash licence](https://unsplash.com/license).
- `DEGOOG_UNSPLASH_API_BASE` overrides the API host, for tests against a local mock.
- `tests/fixtures/unsplash-search.json` is hand-written from the documented response shape, not recorded.
