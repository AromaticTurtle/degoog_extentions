# degoog_extentions

Personal [degoog](https://github.com/degoog-org/degoog) extensions by AromaticTurtle. MIT licensed: use them however you like.

## Install

In degoog: **Settings > Store > Add repository**, paste `https://github.com/AromaticTurtle/degoog_extentions`, then install what you want from the catalogue.

## What is here

| Extension | Type | What it does |
|---|---|---|
| [Marginalia](engines/marginalia/README.md) | engine | Marginalia Search through its API. Polite by design (rate limiting, cool-down). Needs a free API key. |
| [OpenAlex](engines/openalex/README.md) | engine | Scholarly works on a **Scholar** tab. Works without a key; stops when the daily budget is spent. |
| [CORE](engines/core/README.md) | engine | Open access papers on the same **Scholar** tab. Needs a free API key. |
| [Unsplash](engines/unsplash/README.md) | engine | Photos on the **Images** tab through the official API. Needs a free API key. |

## Planned

- **Scholar routing interceptor** (pinned until the engines are done): send scholarly-looking queries (a DOI, "meta-analysis", "et al") to the Scholar tab automatically. It could also carry **site lenses**, so `!unsplash lake` becomes `lake site:unsplash.com` on the Images tab for keyless use.
- **Brave hybrid engine**: official API up to a monthly cap counted on the data volume, then scraping.
- **selfh.st app library** engine.
- **Blocklist sync tool** for degoog's built-in domain block list.
- Forks of the community GitHub and DeviantArt engines, with changes.

## Policy

Engines use official APIs wherever one exists. Before any engine reads a website directly, its terms of service and
`robots.txt` are checked, and the engine's README says what they allow.

## Layout

```
package.json      store manifest: one entry per extension
engines/<name>/   one folder per engine
tests/            unit tests and fixtures
```

## Development

Tests use [Bun](https://bun.sh). Without Bun installed:

```
docker run --rm --network none -v "$PWD":/app -w /app oven/bun:1 bun test
```

Never commit API keys. Keys are entered in degoog's settings or passed as environment variables.
