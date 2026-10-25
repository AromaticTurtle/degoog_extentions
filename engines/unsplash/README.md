# Unsplash engine for degoog

Searches [Unsplash](https://unsplash.com) photos on degoog's **Images** tab. Results show the photographer's credit
and link back to the photo page on Unsplash.

## Two modes
1. **Official API (with a key).** Register an application at https://unsplash.com/developers and paste its
   *access key* under Settings > Engines > Unsplash > Configure. The key is stored on the server and sent only as an
   `Authorization` header. `UNSPLASH_ACCESS_KEY` in the container environment also works; the UI value wins.
   Demo applications are limited to 50 requests an hour.
2. **Website fallback (no key, or quota used up).** Uses the JSON endpoint behind unsplash.com's own search page.
   It is undocumented, so Unsplash can change or block it without notice, and it sits outside the API's terms.
   Check Unsplash's terms and your own comfort level before relying on it. Turn it off with
   *Use the Unsplash website when the API is unavailable* to stay on the official API only.

With a key, the engine tries the API first. If Unsplash answers that the quota is spent (HTTP 429, or 403 "Rate Limit
Exceeded"), it falls back to the website within the same search and stays there for 10 minutes before trying the API again.
A rejected key (HTTP 401) is reported as an error rather than hidden by the fallback.

## Politeness
- One request per page, no retries. API requests are at least 1 s apart, website requests at least 2 s apart.
- Website requests stop for 10 minutes (or `Retry-After`) after a 403, 429 or 503.
- degoog solves Anubis bot checks for engines that declare them; this engine does.
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Filters
Layout (square, wide, tall), colour and safe mode map to Unsplash's `orientation`, `color` and `content_filter`.
Safe mode "on" asks for the stricter content filter.

## Notes
- Image URLs are used as Unsplash returns them, including the `ixid` parameter the API guidelines require.
  degoog serves thumbnails through its own image proxy.
- degoog strips tracking parameters from result links, so Unsplash's `utm_source` attribution parameters are not added.
  The photographer's name is always shown in the result text.
- Unsplash photos are free to use under the [Unsplash licence](https://unsplash.com/license).
- `DEGOOG_UNSPLASH_API_BASE` and `DEGOOG_UNSPLASH_WEB_BASE` override the hosts, for tests against a local mock.
- `tests/fixtures/unsplash-search.json` is hand-written from the documented response shape, not recorded.
