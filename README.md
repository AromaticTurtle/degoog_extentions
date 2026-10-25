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
