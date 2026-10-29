# degoog_extentions

Personal [degoog](https://github.com/degoog-org/degoog) extensions by AromaticTurtle. MIT licensed: use them however you like.

## Install

In degoog: **Settings > Store > Add repository**, paste `https://github.com/AromaticTurtle/degoog_extentions`, then install what you want from the catalogue.

## What is here

| Extension | Type | What it does |
|---|---|---|
| [Marginalia](engines/marginalia/README.md) | engine | Marginalia Search through its API. Polite by design (rate limiting, cool-down). Needs a free API key. |
| [Mojeek](engines/mojeek/README.md) | engine | Mojeek web search without an API key. Passes its proof-of-work check once a month, then one request per search. |
| [Mwmbl](engines/mwmbl/README.md) | engine | The non-profit community search engine, on the web tab. Works without a key; one request per search, later pages from a short cache. |
| [OpenAlex](engines/openalex/README.md) | engine | Scholarly works on a **Scholar** tab. Works without a key; stops when the daily budget is spent. |
| [CORE](engines/core/README.md) | engine | Open access papers on the same **Scholar** tab. Needs a free API key. |
| [Unsplash](engines/unsplash/README.md) | engine | Photos on the **Images** tab through the official API. Needs a free API key. |
| [Reddit Search](engines/reddit-search/README.md) | engine | Reddit posts from Reddit's public Atom feed: relevance sort, subreddit, date, a real excerpt and a thumbnail, paging with `after`. Cached; pauses (never bypasses) when Reddit refuses. A better replacement for the official Reddit engine. |
| [selfh.st](engines/selfhst/README.md) | engine | The selfh.st self-hosted app directory on an **Apps** tab, with its alternative-to lists. Cached on disk, searched locally. |
| [selfh.st icons](favicon/selfhst/README.md) | favicon provider | Real app logos from selfh.st/icons for self-hosted software sites. Unknown hosts fall through to the next provider. |
| [Game info (IGDB + ProtonDB)](plugins/game-info/README.md) | slot plugin | A video game panel beside the results: IGDB scores, platforms, developer, time to beat, ProtonDB Linux compatibility and a Steam link. Needs free Twitch/IGDB credentials. Cached. |
| [Books (Hardcover)](plugins/books/README.md) | slot plugin | A book panel beside the results: cover, authors, series, Hardcover rating and readers, genres, pages, description. Needs a free Hardcover API token (create it with only the `read:catalog` permission). Cached and capped to a daily request limit. |
| [Board games (BoardGameGeek)](plugins/board-games/README.md) | slot plugin | A board game panel beside the results: BGG rating, rank, weight, players, playing time, designers, mechanics. Three optional sources with an automatic fallback: the BGG XML API (token needed), recommend.games (no key), and BGG's own website API (opt-in). Cached and capped by per-source daily limits. |
| [Calculator](plugins/calculator/README.md) | slot plugin | A calculator and unit converter card: arithmetic with exact big integers, percentages, functions, number bases, common units. No upstream. Inline (detailed, above the results) or panel (compact). Replaces the official math plugin. |
| [Currency converter](plugins/currency/README.md) | slot plugin | `usd to euro`, `1 usd to pound`, `5 quid in dollars`, `usd eur`, `20 bucks to yen`: fiat conversion from open.er-api.com (one cached request a day, cross rates computed locally) and crypto prices from Coinbase's public API with 24 h change and range. No keys. Inline or panel. |
| [Dictionary](plugins/dictionary/README.md) | slot plugin | `define X`, `X meaning`, `synonyms of X`, `how to pronounce X`, and a word typed on its own (`colloquial`; a setting, on by default) from the Free Dictionary API (Wiktionary, CC BY-SA): meanings, examples, synonyms, pronunciation audio. Inline or panel. Replaces the official define plugin. |
| [Reddit lens](plugins/reddit-lens/README.md) | interceptor | `best homelab os reddit`, `reddit best homelab os`, `!reddit ...` and `r/homelab ...` become a `site:reddit.com` search, so your normal web engines return Reddit pages with their own titles, snippets and dates. Makes no request itself. |
| [Stocks (Finnhub)](plugins/stocks/README.md) | slot plugin | A stock quote card for `AAPL stock`, `$AAPL`, `apple stock price` and (optionally) a bare ticker: price, change, market status, day and 52-week ranges, statistics, sparkline when available. Needs a free Finnhub API key (US stocks on the free plan), sent only in a header. Inline or panel. |
| [Weather](plugins/weather/README.md) | slot plugin | `weather in Paris`, `forecast`, `is it raining in Seattle`: current conditions, a 24-hour strip, a 7-day forecast and air quality from Open-Meteo (no key). Understands `paris texas`. A bare `weather` offers "Use my location" (https/localhost) or a typed city, remembered in your browser. Inline or panel. Replaces the official weather plugin. |
| [Sports scores (ESPN)](plugins/sports/README.md) | slot plugin | `panthers score`, `did the lakers win`, `arsenal match`, `nfl scores`: a live score card (clock, line score, venue, next and last game) or a league scoreboard from ESPN's public, **unofficial**, keyless scoreboard JSON. Never answers a bare team name. Refreshes by itself while a game is live. Inline or panel. |

## Core plugins

Six slot plugins answer the questions a search page used to send you elsewhere for. They share one look (a small uppercase kicker, a
large value, muted details, the same chips, bars and footer), one `Layout` setting (**inline**: the detailed card above the results,
or **panel**: the compact card in the side column), the same pause, cache and daily-limit habits, and a `debugMatching` setting that
explains in the log why a card did or did not show.

| Plugin | Triggers on | Data |
|---|---|---|
| Calculator | `2+2`, `15% of 80`, `5 km to miles`, `255 in hex` | none (own parser) |
| Currency | `100 usd to eur`, `bitcoin price` | open.er-api.com, Coinbase |
| Dictionary | `define serendipity`, `serendipity meaning` | Free Dictionary API |
| Weather | `weather in paris`, `is it raining in seattle` | Open-Meteo |
| Stocks | `AAPL stock`, `$AAPL`, `apple stock price` | Finnhub (free key) |
| Sports | `panthers score`, `nfl scores` | ESPN (unofficial) |

Each plugin is **one entry** in Settings > Plugins (there are no bang commands: a plugin file cannot be both a slot and a command, and degoog would list it twice). Each query belongs to at most one of them: `tests/domain-routing.test.js` holds a table of about 200 queries and the plugin that
should take each (`panthers score` is sports only, `lakers` nobody, `define score` the dictionary, `100 usd` currency and not the
calculator, `chicken stock` nobody...).

**Disable the official degoog weather, define and math plugins** (Settings > Plugins) when you install the matching ones here:
otherwise two cards answer the same query.

## Planned

- **Scholar routing interceptor** (pinned until the engines are done): send scholarly-looking queries (a DOI, "meta-analysis", "et al") to the Scholar tab automatically. It could also carry **site lenses**, so `!unsplash lake` becomes `lake site:unsplash.com` on the Images tab for keyless use.
- **Blocklist sync tool** for degoog's built-in domain block list.
- Forks of the community GitHub and DeviantArt engines, with changes.

## Layout

```
package.json      store manifest: one entry per extension
engines/<name>/   one folder per engine
favicon/<name>/   one folder per favicon provider
plugins/<name>/   one folder per plugin (slots, commands, interceptors)
tests/            unit tests and fixtures
```

## Development

Tests use [Bun](https://bun.sh). Without Bun installed:

```
docker run --rm --network none -v "$PWD":/app -w /app oven/bun:1 bun test
```

Never commit API keys. Keys are entered in degoog's settings or passed as environment variables.
