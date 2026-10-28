export const DEFAULT_FEED_BASE = "https://www.reddit.com";
export const USER_AGENT = "degoog-reddit-search/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const SEARCH_LIMIT = 25;
export const MAX_PAGES = 3;
export const MAX_QUERY_CHARS = 300;
export const MAX_SUBREDDITS = 10;

export const SORTS = ["relevance", "hot", "top", "new", "comments"];
export const TIMES = ["all", "hour", "day", "week", "month", "year"];

export const sortOf = (value) => (SORTS.includes(value) ? value : "relevance");

// degoog's time filter wins when it names a window; "any" (and "custom", which Reddit cannot do) use the setting.
export const timeOf = (timeFilter, fallback = "all") => {
  if (["hour", "day", "week", "month", "year"].includes(timeFilter)) return timeFilter;
  return TIMES.includes(fallback) ? fallback : "all";
};

const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;

// "r/homelab, selfhosted +linux" -> ["homelab", "selfhosted", "linux"]. Anything that is not a subreddit name is dropped.
export const parseSubreddits = (text) => {
  const out = [];
  for (const part of String(text ?? "").split(/[\s,;+]+/)) {
    const name = part.replace(/^\/?r\//i, "").replace(/\/+$/, "");
    if (SUBREDDIT.test(name) && !out.some((seen) => seen.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= MAX_SUBREDDITS) break;
  }
  return out;
};

// "best os site:reddit.com/r/homelab" arrives when the Reddit lens plugin (or the user) aims a query at Reddit. This engine only
// searches Reddit, so the filter is removed from the text; the subreddit form becomes this engine's own subreddit restriction.
const SITE_FILTER = /(^|\s)site:(?:https?:\/\/)?(?:www\.|old\.|new\.|np\.)?reddit\.com(?:\/r\/([A-Za-z0-9_]{2,21}))?\/?(?=\s|$)/gi;

export const splitSiteFilters = (query) => {
  const subreddits = [];
  const text = String(query ?? "")
    .replace(SITE_FILTER, (whole, space, name) => {
      if (name && !subreddits.some((seen) => seen.toLowerCase() === name.toLowerCase())) subreddits.push(name);
      return space;
    })
    .replace(/\s+/g, " ")
    .trim();
  return { text, subreddits: subreddits.slice(0, MAX_SUBREDDITS) };
};

// The Atom search feed. With subreddits it is that subreddit's search (several: r/a+b), restricted to it.
// after is the full name (t3_xxxx) of the last post of the previous page.
export const buildFeedUrl = ({ query, sort, time, nsfw, subreddits = [], after = "" }, base = DEFAULT_FEED_BASE) => {
  const root = String(base || DEFAULT_FEED_BASE).replace(/\/+$/, "");
  const params = new URLSearchParams({
    q: String(query ?? "").slice(0, MAX_QUERY_CHARS),
    sort: sortOf(sort),
    t: timeOf(time),
    type: "link",
    include_over_18: nsfw ? "1" : "0",
    limit: String(SEARCH_LIMIT),
  });
  if (subreddits.length) params.set("restrict_sr", "1");
  if (/^t3_[a-z0-9]{1,12}$/.test(after)) params.set("after", after);
  const path = subreddits.length ? `/r/${subreddits.join("+")}/search.rss` : "/search.rss";
  return `${root}${path}?${params}`;
};

export const buildHeaders = (context) => ({
  "User-Agent": context?.userAgent?.() || USER_AGENT,
  Accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
  "Accept-Language": context?.buildAcceptLanguage?.() || "en-US,en;q=0.9",
});

// The same search without its page: the key of one result list, whose pages follow each other.
export const chainKey = ({ query, sort, time, nsfw, subreddits = [] }) =>
  JSON.stringify([String(query ?? "").toLowerCase().replace(/\s+/g, " ").trim(), sortOf(sort), timeOf(time), Boolean(nsfw), subreddits.map((name) => name.toLowerCase())]);

export const cacheKey = ({ query, sort, time, nsfw, subreddits = [], page = 1, after = "" }) =>
  JSON.stringify([String(query ?? "").toLowerCase().replace(/\s+/g, " ").trim(), sortOf(sort), timeOf(time), Boolean(nsfw), subreddits.map((name) => name.toLowerCase()), page, after]);
