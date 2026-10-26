# selfh.st app library engine for degoog

Searches the [selfh.st](https://selfh.st/apps/) self-hosted app directory (about 1,300 apps) on its own **Apps** tab.
Each result shows the app's icon, a description, language, licence, GitHub stars, last update, selfh.st's tags and the
commercial services it is an alternative to.

## Setup
1. In degoog: Settings > Store > add this repository, then install **selfh.st**.
2. Open the **Apps** tab and search, or use the bang `!selfhst`. No account or key is needed.

## What you can search
- Names, tags, descriptions and links: `home automation`, `reverse proxy`, `self-hosted media`.
- Alternatives, using selfh.st's own "alternative to" lists: `alternative to netflix`, `zapier alternatives`,
  `replace dropbox`, `best self-hosted google photos alternative`.
- Every word must match. Filler words such as "self-hosted", "open source" and "app" are ignored.

Results link to each app's website, or its repository when it has no website.

## How it gets its data
The directory is published as plain JSON files in the MIT-licensed [selfhst/cdn](https://github.com/selfhst/cdn) repository.
The engine downloads five small files (about 370 KB in total) **once**, keeps them on disk in `data/selfhst/`, and searches
them locally. So:
- Searches make **no network requests** once the list is loaded, and the list survives restarts.
- It refreshes every 24 hours (setting: 6 to 720 hours). A refresh sends the stored `ETag` for each file, so unchanged
  files cost a tiny "not modified" reply.
- If a refresh fails, the old list keeps working and the engine waits 15 minutes before trying again.
- A replacement list that is less than half the size of the old one is rejected as suspicious.
- Everything goes through degoog's `context.fetch`, so your proxy and transport settings apply.

## Options
- **Refresh the app list every (hours)**, **Results per page** (5 to 50).
- **Hide apps with no update in over a year**: uses selfh.st's inactive marker.
- **Hide closed-source apps**.

## Data format
`software.json` is a list of fixed-position arrays (id, name, slug, website, repository, description, platform, licence
index, language index, icon flag, icon name, stars, forks, last update, activity marker, tag ids, alternative ids, ...).
The other four files are lookup tables. `tests/fixtures/selfhst/` holds a real excerpt, so the tests check the genuine
layout. If selfh.st changes the layout, the engine skips rows it cannot read and reports a parse error rather than
showing wrong data.

selfh.st's own tagging is shown as published; for example it lists many developer tools as Firebase alternatives.

## Credits and licences
- App data: [selfh.st](https://selfh.st) directory, from the MIT-licensed `selfhst/cdn` repository.
- Icons: [selfh.st/icons](https://selfh.st/icons), licensed CC BY 4.0. degoog serves them through its image proxy.
- `DEGOOG_SELFHST_DATA_BASE` and `DEGOOG_SELFHST_CACHE_DIR` override the data source and cache folder, for tests.
