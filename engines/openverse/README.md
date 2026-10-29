# Openverse engine for degoog

Searches [Openverse](https://openverse.org) on degoog's **Images** tab through the **official API**: a very large index of
openly licensed images (Creative Commons and public domain) from Flickr, Wikimedia Commons, museums and more. No key is
needed, but anonymous use is limited to a few requests an hour; registering an application (free) raises the limits.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Openverse**.
2. Use the Images tab, or the bang `!openverse`. That is all for anonymous use.
3. Optional, for higher limits: register an application, verify the e-mail address Openverse sends, and paste the client
   ID and secret in Settings > Engines > Openverse > Configure (or set `OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET`
   in the container environment; the UI values win). Registration is one request:

   ```
   curl -X POST https://api.openverse.org/v1/auth_tokens/register/ \
     -H "Content-Type: application/json" \
     -d '{"name": "my-degoog", "description": "Personal degoog instance", "email": "you@example.com"}'
   ```

   Until the e-mail is verified a registered application is limited like an anonymous one.

## Licences and attribution
Creative Commons licences require attribution, so **every result shows its licence and creator**, in the title and in
the snippet: `Quillfern at dawn — CC BY 4.0 · Jane Doe`, with the source (Flickr, Wikimedia Commons ...) and the size in
the snippet. degoog's image preview shows the title, the host of the source page and an engine badge, but not the
snippet, which is why the licence is in the title too. The result links to the **source page** (`foreign_landing_url`),
where the work is credited in full; the image itself is `url`, and the thumbnail is Openverse's own thumbnail address
(`api.openverse.org/v1/images/<id>/thumb/`), served through degoog's image proxy.

## Limits and politeness
Defaults taken from the Openverse source code (the headers `X-RateLimit-*` of the live API were not available when this
engine was written, so treat them as estimates and adjust in the advanced settings):

| | Anonymous | Registered |
| --- | --- | --- |
| Burst | 5 requests an hour | 100 a minute |
| Sustained | 100 a day | 10,000 a day |

- The counts are kept in `data/openverse/usage.json` (counts only; no secret, no token) and the engine stops at the cap
  with a message in the sidebar.
- HTTP 429 pauses the engine for `Retry-After` (10 minutes when it is missing, at most 6 hours); a 5xx pauses it for at
  least a minute and honours a longer `Retry-After`; a 401/403 pauses it for 10 minutes.
- Anonymous requests ask for at most 20 results per page; registered ones up to 50.
- Results are cached in memory for an hour. Engines in degoog get no `useCache` helper, so the cache is lost on restart.

## Access token (optional)
With credentials the engine uses the documented OAuth2 client-credentials flow (`POST /v1/auth_tokens/token/`), keeps the
token in memory, and renews it a minute before it expires. The token request gets at most 40 % of the slot time. If the
token cannot be had (wrong secret, Openverse down) the engine searches **anonymously** for 10 minutes and tries again
afterwards; it never stops searching because of it. The secret and the token are never logged and never put in an address.

## Settings
- **Licences**: all, Creative Commons only, free for commercial use, or free to modify and adapt (`license_type`).
- **Category**, **only these sources** (for example `flickr, wikimedia`), **only these file types**, **results per page**.
- **Include mature content**: off by default. The engine always sends `mature=false` and also drops anything Openverse
  flags as mature or sensitive. Turning the setting on only helps when degoog's own safe mode is off.
- degoog's own filters win when set: layout (aspect ratio), size, type (photo, clipart, lineart) and safe mode.
- **Limits** (advanced) and **debugMatching** (advanced: one line per search in the server log, never a secret or the query).

## Notes
- When this engine was written, two anonymous requests to the live API both ended in a Cloudflare "504 Gateway time-out"
  (with `Retry-After: 120`) after about 60 seconds, so the response field names in the parser come from the Openverse
  source code and documentation and are unconfirmed against the live API. The engine treats a 504 as a pause of at least
  the `Retry-After` time and keeps working afterwards. Run the diagnose script below to check the field names yourself.
- Audio and video are not searched: the engine is for the Images tab.
- `DEGOOG_OPENVERSE_API_BASE` overrides the API address and `DEGOOG_OPENVERSE_USAGE_FILE` moves the usage file; both are
  for tests against a local mock.
- `tests/fixtures/openverse-images.json` is hand-written from the documented response, with invented data.
- To see the real response shape and the rate-limit headers (at most 3 requests; please do not run it in a loop):
  `cd ~/Documents/degoog_extentions; bun ./tests/diagnose-openverse.js`. With credentials:
  `read -sx OPENVERSE_CLIENT_SECRET; set -x OPENVERSE_CLIENT_ID your-id; bun ./tests/diagnose-openverse.js; set -e OPENVERSE_CLIENT_SECRET OPENVERSE_CLIENT_ID`.
