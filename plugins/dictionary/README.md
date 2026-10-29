# Dictionary for degoog

A dictionary card for dictionary questions, and for a word typed on its own, from the [Free Dictionary API](https://dictionaryapi.dev) (English, content
from Wiktionary, CC BY-SA 3.0). It is a replacement for the official **define** plugin: **disable the official define plugin** in
Settings > Plugins so the two do not both answer.

| You type | You get |
|---|---|
| `define serendipity`, `definition of serendipity`, `serendipity definition`, `serendipity meaning`, `meaning of serendipity` | the card |
| `what does serendipity mean`, `what is the definition of serendipity`, `what's the meaning of life` | the card |
| `synonyms for happy`, `happy synonym`, `antonyms of happy`, `opposite of happy` | the card with the synonym / antonym chips first |
| `how to pronounce quinoa`, `quinoa pronunciation`, `pronounce quinoa` | the card with the play buttons |
| `colloquial`, `ephemeral`, `Serendipity`, `well-known`, `colloquialisms` (the plural falls back to `colloquialism`) | the card (the **bare word** trigger, on by default) |
| `what is serendipity`, `define 2+2`, `define c++`, `weather`, `google`, `AAPL`, `12345`, `x.com`, `a` | nothing: not a word to look up (see below) |

The word is one word (letters, apostrophe, hyphen, up to 40 characters) or a short phrase of at most three words (`define ice cream`).
`the word love` and `the term love` are reduced to `love`. A phrase the dictionary does not know (for example `meaning of life`)
simply shows no card.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Dictionary** (one entry in Settings > Plugins).
2. Disable the official **define** plugin. There is no key and no account.

## A word typed on its own
Setting **Define a word typed on its own** (`triggerOnBareWord`, **on by default**). A search that is just one word shows its
definition above the web results. **The trade-off:** a word with a second life (`python`, `apple`, `mercury`, `rust`) shows the
dictionary card above the web results too. Turn the setting off and only the explicit forms (`define X`, `X meaning`, `synonyms of X`,
`how to pronounce X`...) trigger, as in version 1.0.

A bare word must be **one token of letters** (an inner hyphen or apostrophe is fine), **3 to 30 characters**, lower case or
Capitalised. Shorter words work through the explicit forms (`define go`). It is **skipped without any request** when:
- it is not a plain word: digits, a dot, slash, `@`, `:` or other symbols (`12345`, `x.com`, `a/b`, `c++`), several words, ALL CAPS
  (`NASA`, `AAPL`: a ticker or an acronym) or mixed capitals (`iPhone`);
- another core plugin answers it: `weather`, `forecast` (weather), `score`, `scores` and the league names (sports), constants and
  function names such as `tau`, `sqrt` (calculator), `bitcoin`, `btc`, `ethereum`, `doge` (currency), and the well-known tickers
  such as `msft`, `meta` (stocks). A currency code (`usd`, `eur`) is not a word either; codes that are English words (`top`, `pen`,
  `try`) can still be defined;
- it is on the **stoplist** of popular sites and brands (`google`, `youtube`, `facebook`, `reddit`, `amazon`, `gmail`, `login`...:
  `bare-lists.js`, a modest list), or is a stop word (`the`, `meaning`, `define`).

An unknown word costs one request, is remembered as unknown for 24 hours (on disk), and the daily limit still applies. The lemma
fallback works for bare words too: `colloquialisms` shows `colloquialism` ("Showing the entry for ..."). Each plugin keeps its own
gating; `tests/dictionary.test.js` checks the deferral lists against the plugins that own those words, and
`tests/domain-routing.test.js` holds the table of who answers what. With **Explain matching in the log** on, a one-word search writes
`"colloquial" -> bare word: lookup` or `"google" -> bare word: skipped (a popular site or brand (stoplist))`.

## Layout: inline or panel
Setting **Layout**; the card moves as soon as you save.
- **Inline** (default): the detailed card **above the results**: the word large, the phonetic text and one small round play button per
  accent (US, UK, AU, whichever the dictionary has), meanings grouped by part of speech (up to *Parts of speech to show*, each with up to
  three numbered definitions and the example sentence in muted italics), synonym and antonym chips (each links to the search
  `define <word>`), and the source line.
- **Panel**: the compact card in the **side column**: the word, the phonetic text, one play button, the top two meanings as one-line
  definitions and a tiny source line.

Inline sits in *above results* rather than *at a glance* because degoog only fills the at-a-glance box when the search returned
results (see the [calculator README](../calculator/README.md)).

## Settings
| Setting | Default |
|---|---|
| Layout | inline |
| Parts of speech to show (1 to 6) | 3 |
| Show example sentences | on |
| Show synonyms and antonyms | on |
| Pronunciation audio: through this server / straight from dictionaryapi.dev / off | through this server |
| Daily request limit (advanced, 0 = off) | 500 |
| Explain matching in the log (advanced) | off |

## Pronunciation audio
degoog's own proxy (`/api/proxy/image`) only passes images, so it cannot serve audio. This plugin therefore has a **small route of
its own**, `/api/plugin/dictionary/audio?w=<word>&n=<clip>`, served by degoog from the plugin's `routes` export:
- The address of the clip is **never taken from the request**. It is looked up in the replies this server has already received
  (so it is not an open proxy), must be `https` on `api.dictionaryapi.dev` or `upload.wikimedia.org`, must answer an audio content
  type, at most 2 MB, with a timeout of 8 seconds; the last 24 clips are kept in memory and browsers cache them for a week.
- A clip is only requested when somebody presses a play button. A failure pauses the route for a minute.
- The browser only ever talks to your degoog, so degoog's *block client leaks* setting (which only allows media from the same
  origin) does not get in the way.

The alternative setting, **straight from dictionaryapi.dev**, puts the media address in the button, so each visitor's browser contacts that
site and shares its IP address with it, and *block client leaks* will block it. **Off** shows no buttons. The play buttons use
`script.js` (loaded by degoog on every page, listening on the document because slot html is injected later).

## What it asks, and how gently
`GET https://api.dictionaryapi.dev/api/v2/entries/en/<word>` with `User-Agent: degoog-dictionary/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)`:
- an entry is cached for **7 days**, an unknown word for **24 hours**; identical concurrent lookups share one request;
- at least one second between requests; a daily limit (default 500) kept in `data/dictionary/usage.json`;
- a `429` pauses for `Retry-After` (a minute by default, an hour at most); the service's `x-ratelimit-remaining: 0` pauses for a minute;
  a 5xx or a network error pauses for a minute; each pause logs one short line;
- when a word is unknown, **one** fallback form is tried (`stories` to `story`, `boxes` to `box`, `running` to `run`, `making` to
  `make`, `walked` to `walk`) and the card says "Showing the entry for “story” (no entry for “stories”)";
- no request is started after 70 % of `DEGOOG_SLOT_TIMEOUT_MS` (default 10 s) and a lookup still running at 95 % is given up; its
  reply is cached for the next search.

## Source and licence
Definitions come from **Wiktionary**, shared under **CC BY-SA 3.0**, through the Free Dictionary API. Every card carries the line
"Source: Wiktionary via Free Dictionary API (CC BY-SA 3.0)" with links to the word's Wiktionary page, dictionaryapi.dev and the licence.
The audio comes with its own licences (mostly Wikimedia Commons recordings).


## Troubleshooting: why did (or didn't) a card show
Turn on **Explain matching in the log**. A near miss (`define the`) writes one line with the reason; a lookup writes a block:

```
[dictionary] "define florbits" -> word "florbits" intent=define layout=inline audio=proxy
  florbits: missing (request)
  florbit: found (request) [fallback form]
  verdict: card shown
```
`bun ./tests/diagnose-dictionary.js "define serendipity"` runs one real lookup in your terminal and prints the reply's status, size and
JSON keys (never the text).

## Development notes
`match.js` (question grammar, fallback form), `shape.js` (reply normaliser with URL allow-lists), `render.js`, `audio.js` (route),
`upstream.js`, `budget.js`, `index.js`. Tests: `tests/dictionary.test.js`, `tests/mock-dictionary-server.js` (set
`DEGOOG_DICTIONARY_API_BASE` and `DEGOOG_DICTIONARY_MEDIA_BASE` to its address; only for tests). Fixtures use invented words
(`florbit`, `quillfern`) in the API's layout.

## Changelog
**Version 1.1.0:** a word typed on its own is defined (setting `triggerOnBareWord`, on by default, with the guards above). Also: the `!define` bang command was removed. degoog lists a plugin's slot and its command as two separate entries in Settings > Plugins, and a plugin file cannot be both, so every plugin showed twice. The plain queries above cover everything the bang did. After updating, restart degoog (or reload extensions) so the old `dictionary-command` entry disappears; settings you saved on the slot entry are kept.
