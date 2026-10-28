# Reddit Search engine for degoog

Searches Reddit's **public Atom (RSS) search feed** and turns what is in it into proper search results: sorted by relevance, with
the subreddit, the date, an excerpt of the post and a thumbnail. Bang shortcut: `!rd`. It is meant as a better replacement for
the official Reddit engine, and it pairs with the [Reddit lens](../../plugins/reddit-lens/README.md) plugin, which gets
Startpage-quality Reddit results from your ordinary web engines.

## Setup
1. In degoog: Settings > Store > add this repository, then install **Reddit Search**.
2. **Disable the official Reddit engine** (Settings > Engines), otherwise every Reddit post appears twice and Reddit gets twice
   the requests. This engine does not touch the official one.
3. No key is needed.

## What it improves over the official engine
The official engine asks the same feed, but sorts by *hot* (what is popular right now, not what matches), reads only 200
characters of each post, and throws the rest of the feed away. This one:

| | official Reddit engine | Reddit Search |
|---|---|---|
| order | hot | **relevance** (setting) |
| title | `Which OS for a tiny home server box?` | `Which OS for a tiny home server box? : r/homelab` |
| snippet | the entry's HTML turned into text, boilerplate included, cut to 200 characters | `Jun 22, 2024 · r/homelab · u/quietfrog — I'm setting up a small box (4 cores, 16 GB) for files, a media server & a few containers. Is Debian with Docker enough, or should I look at a hypervisor first? I don't need clustering.` |
| date, subreddit, author | dropped | shown |
| subreddits and users in the feed | mixed in with the posts | removed (posts only) |
| removed / deleted / link-only bodies | shown as text | skipped; a link post says `Link post to example.org`, an image post `Image post` |
| thumbnail | none | the post's preview picture (Reddit's own picture hosts only) |
| address | whatever the feed said | the clean canonical `https://www.reddit.com/r/<sub>/comments/<id>/<slug>/` (old.reddit.com, tracking parameters and `redd.it` short links are normalised) |
| paging | `count` offset | Reddit's `after` cursor, up to 3 pages |
| repeats | every time | 10 minute cache, shared between identical simultaneous searches |
| when Reddit refuses | keeps asking | pauses, with a clear message |

(The example texts above are invented.)

## Settings
Settings > Engines > Reddit Search > Configure.

| Setting | Default | What it does |
|---|---|---|
| Sort by | relevance | relevance, hot, top, new or most comments |
| Time window when degoog's filter is off | all time | degoog's own time filter (hour, day, week, month, year) always wins |
| Include NSFW posts | off | asks Reddit to leave out 18+ posts |
| Only these subreddits | empty | comma separated, up to 10: Reddit's per-subreddit search, restricted to them |
| Hide these subreddits | empty | removed from the results after they arrive |
| Excerpt length | 350 | 150 to 800 characters, cut at a sentence or a word |
| Put the date at the start of the snippet | on | see below |
| Show thumbnails | on | through degoog's image proxy |

**The date.** With the date at the start of the snippet (like other search engines), degoog turns it into its own date label
(and hides it if you switched result dates off in degoog). Off sends the date as a separate field instead. Either way you get one
date, never two.

**site: filters.** When a query reaches this engine with `site:reddit.com` (the lens adds it to every engine), the filter is
removed, because this engine only searches Reddit anyway, and `site:reddit.com/r/homelab` becomes a restriction to that
subreddit. So `best homelab os reddit`, `reddit best homelab os` and `best homelab os` share one cache entry.

## Paging
Page 1 has no cursor. Reddit's feed continues with `after=<full name of the last post>`, so the engine remembers the last post of
every page it fetched and asks for the next page after it. degoog only hands a later page what the *first* page carried
(`context.carry`), so page 2 uses that and pages 3 and 4 use the engine's own memory (10 minutes). At most **3 pages**. A page
that was never fetched cannot be skipped to: asking for page 3 without page 2 returns nothing instead of guessing.

## Being polite
- One request per page, **no retries**, at least **2 s** between requests, every search cached for **10 minutes** (50 searches
  and 150 page cursors kept), identical simultaneous searches share one request.
- The user agent is degoog's (`context.userAgent`), as with the official engine, and no extra headers are added.
- HTTP **429**: pause for `Retry-After` (2 minutes if none, 15 at most). HTTP **403**, or the "You've been blocked by network
  security" page: pause **30 minutes** and log **one** short line (no address, no query). HTTP 5xx or a network error: pause a
  minute. While paused, no request is made and the sidebar says why. An empty feed is an empty list, not an error; a reply that is
  not an Atom feed is a `parse_error`.

## Reddit's rules, and why there is no browser mode
Reddit's Responsible Builder Policy requires approval for API access and forbids masking how data is accessed, and Reddit answers
unapproved traffic with "You've been blocked by network security". This engine reads the public syndication feed for **personal,
non-commercial** use, does not use Reddit's JSON endpoints or `oauth.reddit.com`, and **does not use stealth browsers,
challenge solvers or any other way around a block**. If Reddit blocks the requests of your server the engine pauses and says so;
that is where it stops. Do not use Reddit data to train AI models.

If it is blocked for you, nothing evasive will help here. Your options: wait (the pause ends by itself and the engine tries once
again), choose a different network egress for degoog **in degoog's own proxy settings** (your decision, not this engine's), or use
the **Reddit lens**, which makes no request to Reddit at all: your web engines return Reddit pages with their own titles, snippets
and dates.

## What was checked against the real feed (honest)
While building this, Reddit's feed was requested **twice** (`best homelab os`, from `https://www.reddit.com/search.rss`, with a
research user agent, 4 seconds apart). The first answered HTTP 200 in about 0.6 s: `Content-Type: application/atom+xml`,
67 KB, 25 entries, `sort=relevance&limit=25` accepted. Things that showed: the feed lists subreddits (`<id>t5_...`) among the
posts, post entries carry the subreddit as `<category label="r/...">`, the last entry's `<id>` is the `t3_...` full name that
`after` needs, and the post "What OS should I use for a simple home server?" was **not** among the first 25 for that query. The
second request (adding `type=link`) was answered with **HTTP 429**, so the research stopped there, as agreed.

**Not verified** against Reddit: that `type=link`, `restrict_sr` with `/r/<sub>/search.rss`, `t` and `after` behave as documented
for the feed; which of the optional parts (author, `<published>`, `<media:thumbnail>`, the `SC_OFF`/`SC_ON` markers and the
`[link] [comments]` buttons in the HTML content) every entry has. The parser follows Reddit's well-known Atom layout and treats
every one of them as optional, and the test data is hand-written. Because the engine also drops everything that is not a `t3_`
post, a feed that ignores `type=link` still gives clean results. Also worth knowing: the first (200) answer already reported
`x-ratelimit-remaining: 0.0`, and the next request was refused, so Reddit's allowance for this unauthenticated feed looks very
small. Expect the engine to pause often on busy instances; the cache and the pauses exist for that.

## Development notes
- `tests/fixtures/reddit-search.atom.xml` is **hand-written** in the layout of Reddit's Atom feed with **invented** posts, authors
  and ids (a text post, a link post, a removed post, an NSFW-flagged post, an image post, CDATA content, an `old.reddit.com` link
  with tracking parameters, a short `redd.it` link, hostile HTML, plus subreddit and user entries). It is not a recording; do not
  commit real Reddit content.
- `tests/mock-reddit-server.js` serves it: `bun tests/mock-reddit-server.js 4472`, then `DEGOOG_REDDIT_FEED_BASE=http://host:4472`.
  A query containing `rate` answers 429 (Retry-After 120), `blocked` answers 403 with the block page, `zzz` an empty feed;
  `MOCK_PAGE_SIZE=3` makes small pages for `after` paging; `/__stats` and `/__last` show what was asked.
- `limiter.js` and `author.json` are copies of the Mwmbl engine's. Everything else (feed URL builder, Atom parser, result shaping,
  pauses) is in `request.js`, `parse.js` and `index.js`.
