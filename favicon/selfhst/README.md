# selfh.st icons favicon provider for degoog

Gives results from self-hosted software sites the app's real logo from [selfh.st/icons](https://selfh.st/icons) instead of a
generic site icon. For example `n8n.io`, `jellyfin.org` and `home-assistant.io` show their own logos. Hosts it does not know
are passed to the next favicon provider (Google, DuckDuckGo and so on), so it works best as an addition, not a replacement.

## Setup
1. In degoog: Settings > Store > add this repository, then install **selfh.st icons** from the Favicon filter.
2. **Settings > Favicons: drag the provider above Google and DuckDuckGo.** degoog asks providers in order and stops at the
   first icon, and a newly installed provider goes to the back of the line until you move it.
3. Icons degoog already cached for a domain stay until they expire. To change one now, use **Refresh favicon** in the
   result's three-dots menu (it needs the settings password).

## How it works
- selfh.st publishes icons by **app name** (`n8n`, `jellyfin`), but degoog asks for a **domain**. The provider bridges
  the two using selfh.st's app directory, which lists each app's website and icon name.
- The directory file (`software.json` from the MIT-licensed [selfhst/cdn](https://github.com/selfhst/cdn) repo, about
  350 KB) is downloaded once, turned into a table of about 830 domains, and saved on disk in `data/selfhst-icons/`.
  It survives restarts and refreshes weekly with an `ETag` check, so an unchanged file costs a tiny "not modified" reply.
  If a refresh fails the old table keeps working and the provider waits 15 minutes before trying again.
- Looking up a host makes **no network request**. A match returns the icon's URL and degoog fetches, checks and caches it.
  An unknown host returns nothing immediately.
- Matching is by exact host first, then parent domains, so `docs.n8n.io` gets n8n's icon. `www.` is ignored.
- Only apps whose website is a bare domain are used. Apps whose "website" is a repository path such as
  `github.com/user/repo` are skipped, otherwise every GitHub link would get that one app's icon.
- When several apps share a domain, the one named after the domain wins (`coder.com` is Coder, not code-server), then the
  most starred.

## Options
- **Icon base URL**: where the WebP files come from. The default is
  `https://cdn.jsdelivr.net/gh/selfhst/icons@main/webp`, the CDN selfh.st recommends. A mirror must be reachable on a
  public address, because degoog refuses private addresses for icon URLs.
- **Also match subdomains** and **Refresh the app list every (hours)** (24 to 2160).

## Notes
- WebP is used because it is the smallest format (2 to 8 KB); degoog accepts WebP and rejects SVG and files over 64 KB.
- Icons are licensed [CC BY 4.0](https://github.com/selfhst/icons/blob/main/LICENSE) by selfh.st.
- A few apps point at an icon name that selfh.st has no WebP for; those fall through to the next provider.
- `DEGOOG_SELFHST_FAVICON_DATA_URL` and `DEGOOG_SELFHST_FAVICON_CACHE_DIR` override the data source and cache folder, for tests.
- `tests/fixtures/selfhst-favicon/n8n.webp` is a real icon downloaded from the CDN; the directory fixture is a real excerpt.
