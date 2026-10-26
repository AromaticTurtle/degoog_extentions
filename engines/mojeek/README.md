# Mojeek engine for degoog (no API key)

Searches [Mojeek](https://www.mojeek.com), an independent search engine with its own crawler and index, by reading its
normal results page, so no paid API key is needed. Results appear on degoog's web tab. Bang shortcut: `!mojeek`.

If you have a paid Mojeek API key, an API-based engine is a sturdier choice. This one reads a web page, so it depends on that
page keeping its layout.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Mojeek**.
2. Nothing else. Results show on the web tab alongside your other engines. Use **Safe search** in the engine's Configure
   dialog if you want Mojeek's filter.

## How it works
Mojeek protects its search with a small proof-of-work check (an "Altcha" challenge). The engine passes it the way a browser
does, with ordinary computation and no tricks:
1. It fetches `/captcha/challenge`, a short puzzle (PBKDF2, 8,000 rounds per attempt).
2. It solves the puzzle, which takes under a second, and posts the answer to `/captcha/verify`.
3. Mojeek replies with a `chllg` cookie that lasts about **30 days**.
4. Every search then sends that cookie, so a search is **one request** like any other engine.

The cookie is kept in `data/mojeek/session.json` (readable only by the degoog user), so restarts do not repeat the check, and it
is renewed a day before it expires. If Mojeek stops accepting the cookie, the engine passes the check again, but **at most once
every 10 minutes**: if the search is still refused, it stops and reports a bot-check error instead of looping.

## Politeness
- One request per page, no retries, at least 2 s between requests, and an honest `User-Agent` that names this project.
- After HTTP 403, 429 or 503, or a failed bot check, the engine pauses for 10 minutes (or `Retry-After`) and says so in the sidebar.
- The solver refuses puzzles that ask for unreasonable work (it only accepts PBKDF2 with SHA-256/384/512, up to 200,000
  rounds) and gives up after 8 seconds.
- Suggested in Settings > Server: keep "Max retries per engine" at 0 or 1.

## Options and filters
- **Safe search**: off or on.
- degoog's **time filter** maps to Mojeek's `since` date. This comes from SearXNG's engine and I have not tested it against
  the live site.
- Mojeek returns 10 results per page and up to 10 pages. It has no language filter here.

## Things that can break
- **A transport that hides `Set-Cookie`.** The default `fetch` transport works. If a transport drops the cookie the engine says
  "no cookie came back". Use `fetch` or `curl` for this engine.
- **Layout changes.** The page is read with a few fixed patterns. Unreadable pages give a "layout not recognised" error, not wrong results.
- **Stricter bot checks.** If Mojeek hardens the check beyond what this solver accepts, the engine will report it plainly.

## Notes
- `DEGOOG_MOJEEK_BASE` and `DEGOOG_MOJEEK_SESSION_FILE` override the site and the session file, for tests.
- `tests/fixtures/mojeek-search.html` is a trimmed real results page and `tests/fixtures/mojeek-challenge.json` is a real
  challenge. A test solves that challenge and checks the answer against the one found when it was captured.
