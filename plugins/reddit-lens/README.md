# Reddit lens for degoog

Turns a query that clearly wants Reddit into a `site:reddit.com` search for your ordinary web engines, so Startpage, Brave,
Google, Bing, DuckDuckGo and the like return Reddit pages with **their own titles, snippets and dates**. The plugin makes **no
request to Reddit and no request at all**: it only rewrites the query text before degoog hands it to the engines.

| You type | The engines get |
|---|---|
| `best homelab os reddit` | `best homelab os site:reddit.com` |
| `reddit best homelab os` | `best homelab os site:reddit.com` |
| `!reddit best homelab os`, `!rl best homelab os` | `best homelab os site:reddit.com` |
| `r/homelab best os` | `best os site:reddit.com/r/homelab` |
| `best os r/homelab reddit` | `best os site:reddit.com/r/homelab` |
| `what is reddit`, `reddit`, `my reddit account`, `is reddit down` | unchanged |
| `"best os reddit"`, `best os site:example.com reddit`, `https://reddit.com/r/x` | unchanged |

The search box keeps showing what you typed (degoog's page does not replace it), and a small note above the results says
`Showing web results from Reddit for best homelab os site:reddit.com`.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Reddit lens**. It shows up as one plugin, **Reddit lens**
   (settings, on/off), plus a small command of the same name for the `!reddit` bang.
2. Nothing else is needed. For richer results straight from Reddit's own feed, also install the
   [Reddit Search engine](../../engines/reddit-search/README.md); the two work together (see below).

## When it rewrites
All of these must hold:
- The query has **one of the trigger words** (default `reddit`) as its **first or last** word (setting: first, last or either), or
  starts with **`!reddit` / `!rl`**, or **names a subreddit** as its first or last word (`r/homelab`, `/r/homelab`).
- Something else is left to search for. Only the word, or only stop words (`what is reddit`, `the reddit`), or only a subreddit,
  stays as typed.
- It has no `site:`, `inurl:` or `url:` already, is not a URL or a domain, and is not only quoted phrases (quote the word to
  search for it literally: `"reddit"`).
- It is not a **short question about Reddit itself**: a question word first, `reddit` last and at most four other words
  (`who owns reddit`, `how do I use reddit`) stay as typed. Put the word first (`reddit how do I use proxmox`) or ask a longer
  question (`how to set up a tiny home server with proxmox reddit`) to get the lens. Setting: *Leave short questions about Reddit
  alone*.

## Settings
Settings > Plugins > Reddit lens > Configure.

| Setting | Default |
|---|---|
| Trigger words (comma separated, letters and digits) | `reddit` |
| Where the word may be: first or last, only first, only last | first or last |
| Also react to `!reddit` and `!rl` | on |
| Append `site:reddit.com` when the query names a subreddit like r/homelab | on |
| Leave short questions about Reddit alone | on |
| Show a notice when a query was rewritten | on |

## What degoog allows (what this was built against)
Read from degoog's own source (version 1.1.x image) and checked in a real degoog container:
- **Interceptors** run on the raw query for the search API, the streaming search and "I'm feeling lucky"; the rewritten text is
  what **every engine** receives, `site:` included, unchanged. An interceptor may also set the tab, the language and the time
  filter, but it is **not told which tab the search is on**, so this one cannot limit itself to the web tab: it applies on every
  tab. (The Reddit Search engine and the web engines get the rewritten query; on an Images tab `site:reddit.com` just narrows the
  image search.)
- **Bangs never reach interceptors in the web page.** The page sends any query that starts with `!` (or ends with ` !word`) to
  degoog's command handler, and an unknown bang there is "Unknown command". So `!reddit` and `!rl` are answered by a small
  **command** in this plugin: it returns a page that jumps to an ordinary search for the rewritten query (the interceptor then
  leaves that alone, it already has `site:`). In the page you therefore end up on `…search?q=best homelab os site:reddit.com`.
  Direct calls to the search API with `!reddit …` are rewritten by the interceptor itself, without the jump. The command can be
  switched off separately (Settings > Commands) or by turning off the *!reddit* setting.
- **Engine bangs** (`!sp best os reddit`, `!brave …`) work: degoog strips the bang and runs the interceptor on the rest.
  `!rd best os reddit` also works, but pointless: the Reddit Search engine ignores the `site:` filter (it only searches Reddit).
- The notice uses an `at-a-glance` slot, which degoog serves from its own route; it shows only when the query was rewritten.

## Which engines understand `site:`
This is not something the lens controls, and most of it could not be verified from here. Startpage, Brave, Google, Bing,
DuckDuckGo and Mojeek are generally known to support a `site:` operator (general knowledge, not checked against their
documentation or this repository's code). **This repository's Marginalia and Mwmbl engines send the query text on unchanged, and
nothing in their code or README says whether they understand `site:`; do not count on it there** (the Mwmbl engine's README says
it has no filters at all, and the Unsplash engine's README suggests `site:unsplash.com` only on Brave and Startpage image
searches). The Reddit Search engine understands `site:reddit.com[/r/<name>]` itself. An engine that does not support `site:`
simply searches for those words.

## Limitations
- Applies on every search tab (above).
- A query with a question first and a trailing `reddit` stays unchanged on purpose (see *When it rewrites*).
- `!reddit` in degoog's page goes through a jump, so the address bar shows the rewritten query.
- It works with whatever your engines return for `site:reddit.com`; engines that ignore the operator will not give Reddit pages.

## Development notes
- All behaviour is in the pure `rewriteQuery` in `rewrite.js` (tested against a table of inputs); `index.js` wires it to degoog:
  `export const plugin` (one settings entry), `interceptor`, `slot` (the notice) and `command` (`!reddit`, alias `!rl`). There is
  deliberately no default export: degoog's command loader would pick it up instead of the named `command`.
- The settings live on the interceptor, which degoog configures when it loads; the notice and the command read the same options.
