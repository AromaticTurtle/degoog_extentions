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
| [selfh.st](engines/selfhst/README.md) | engine | The selfh.st self-hosted app directory on an **Apps** tab, with its alternative-to lists. Cached on disk, searched locally. |
| [selfh.st icons](favicon/selfhst/README.md) | favicon provider | Real app logos from selfh.st/icons for self-hosted software sites. Unknown hosts fall through to the next provider. |
| [Game info (IGDB + ProtonDB)](plugins/game-info/README.md) | slot plugin | A video game panel beside the results: IGDB scores, platforms, developer, time to beat, ProtonDB Linux compatibility and a Steam link. Needs free Twitch/IGDB credentials. Cached. |
| [Board games (BoardGameGeek)](plugins/board-games/README.md) | slot plugin | A board game panel beside the results: BGG rating, rank, weight, players, playing time, designers, mechanics. Needs a BGG API token (registration required). Cached and capped to a daily request limit. |

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
