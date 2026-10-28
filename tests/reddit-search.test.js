// Tests for the Reddit Search engine.
//
// NOTE: tests/fixtures/reddit-search.atom.xml is HAND-WRITTEN to the layout of Reddit's public Atom search feed. Every post,
// author, subreddit and id in it is INVENTED, and none of it is a real recording. Reddit's feed itself was only looked at
// twice while building (one answer, then HTTP 429, so the research stopped); see the README for what that did and did not show.
import { describe, expect, test } from "bun:test";
import { DEFAULT_FEED_BASE, MAX_PAGES, SORTS, USER_AGENT, buildFeedUrl, buildHeaders, cacheKey, parseSubreddits, sortOf, splitSiteFilters, timeOf } from "../engines/reddit-search/request.js";
import { MAX_ENTRIES, bodyText, isoDay, normalizeUrl, parseFeed, shapeResults, subredditOf, thumbnailOf } from "../engines/reddit-search/parse.js";
import { clampInt, cutText, dayLabel, decodeEntities, stripTags, truthy } from "../engines/reddit-search/text.js";
import { SETTINGS_SCHEMA } from "../engines/reddit-search/settings.js";
import { Limiter } from "../engines/reddit-search/limiter.js";
import RedditSearchEngine from "../engines/reddit-search/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const atom = await read("./fixtures/reddit-search.atom.xml").text();
const BASE = "https://feed.test";
const OPTIONS = { snippetLength: 350, dateInSnippet: true, showThumbnails: true, excludeSubreddits: [] };

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });

// A fake degoog context. makeResponse(url) answers each request. Like degoog, it hands later pages only what the FIRST page
// carried: the first carry() call is kept as `carried`, later ones are not.
const makeContext = (makeResponse, { carried = {} } = {}) => {
  const calls = [];
  const carries = [];
  const ctx = {
    calls,
    carries,
    carried: { ...carried },
    fetch: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(url);
    },
    carry: (data) => {
      carries.push(data);
      if (Object.keys(ctx.carried).length === 0) Object.assign(ctx.carried, data);
    },
    sentinel: (res, name) => {
      if (!res.ok) throw breach(res.status === 429 ? "rate_limited" : "blocked", `${name} ${res.status}`);
    },
    engineError: (status, message) => breach(status, message),
  };
  return ctx;
};

const ok = () => new Response(atom, { status: 200, headers: { "content-type": "application/atom+xml" } });
const make = (settings = {}) => {
  const engine = new RedditSearchEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
  engine.feedBase = BASE;
  engine.configure(settings);
  return engine;
};
const capture = async (work) => {
  const lines = [];
  const original = { warn: console.warn, log: console.log, info: console.info, error: console.error };
  for (const method of Object.keys(original)) console[method] = (...args) => lines.push(args.join(" "));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};
const withEnv = async (name, value, fn) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

describe("shared copies stay identical", () => {
  test("limiter.js and author.json match the Mwmbl copies", async () => {
    for (const file of ["limiter.js", "author.json"]) {
      const [a, b] = await Promise.all(["mwmbl", "reddit-search"].map((name) => read(`../engines/${name}/${file}`).text()));
      expect(b).toBe(a);
    }
  });
});

describe("request building", () => {
  const params = (overrides = {}) => new URL(buildFeedUrl({ query: "best homelab os", sort: "relevance", time: "all", nsfw: false, subreddits: [], after: "", ...overrides }, BASE));

  test("the default is the public Atom search feed, posts only, sorted by relevance, 25 a page, NSFW off", () => {
    const url = params();
    expect(url.origin + url.pathname).toBe("https://feed.test/search.rss");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "best homelab os", sort: "relevance", t: "all", type: "link", include_over_18: "0", limit: "25" });
    expect(DEFAULT_FEED_BASE).toBe("https://www.reddit.com");
    expect(buildFeedUrl({ query: "x" }).startsWith("https://www.reddit.com/search.rss?")).toBe(true);
  });

  test("sorts and time windows are mapped, anything else is the default", () => {
    for (const sort of SORTS) expect(params({ sort }).searchParams.get("sort")).toBe(sort);
    for (const sort of ["", "random", undefined, null, "TOP", "top;rm"]) expect(params({ sort }).searchParams.get("sort")).toBe("relevance");
    for (const time of ["hour", "day", "week", "month", "year", "all"]) expect(params({ time }).searchParams.get("t")).toBe(time);
    for (const time of ["", "any", "custom", undefined, "forever"]) expect(params({ time }).searchParams.get("t")).toBe("all");
    expect(sortOf("hot")).toBe("hot");
    expect(timeOf("week", "month")).toBe("week"); // degoog's filter wins
    expect(timeOf("any", "month")).toBe("month"); // the setting is the fallback
    expect(timeOf("custom", "year")).toBe("year");
    expect(timeOf("any", "nonsense")).toBe("all");
  });

  test("nsfw, the query encoding and its length cap", () => {
    expect(params({ nsfw: true }).searchParams.get("include_over_18")).toBe("1");
    expect(params({ nsfw: false }).searchParams.get("include_over_18")).toBe("0");
    expect(params({ query: "a&b=c d#e" }).searchParams.get("q")).toBe("a&b=c d#e");
    expect([...params({ query: "a&b=c" }).searchParams.keys()]).not.toContain("b");
    expect(params({ query: "x".repeat(2000) }).searchParams.get("q")).toHaveLength(300);
  });

  test("subreddits restrict the search to them through the subreddit's own search feed", () => {
    const one = params({ subreddits: ["homelab"] });
    expect(one.pathname).toBe("/r/homelab/search.rss");
    expect(one.searchParams.get("restrict_sr")).toBe("1");
    expect(params({ subreddits: ["homelab", "selfhosted"] }).pathname).toBe("/r/homelab+selfhosted/search.rss");
    expect(params().searchParams.has("restrict_sr")).toBe(false);
  });

  test("paging uses after (the full name of the last post), only when it is one", () => {
    expect(params({ after: "t3_1abcd01" }).searchParams.get("after")).toBe("t3_1abcd01");
    for (const after of ["", "1abcd01", "t5_abc", "t3_", "t3_ABC", "t3_a b", "t3_abc&x=1", "t3_" + "a".repeat(40), undefined, null]) {
      expect(params({ after }).searchParams.has("after")).toBe(false);
    }
    expect([...params({ after: "t3_abc" }).searchParams.keys()].sort()).toEqual(["after", "include_over_18", "limit", "q", "sort", "t", "type"]);
    expect(MAX_PAGES).toBe(3);
  });

  test("subreddit lists: names only, r/ prefixes and separators accepted, duplicates and junk dropped, at most 10", () => {
    expect(parseSubreddits("r/homelab, /r/selfhosted +linux;Linux")).toEqual(["homelab", "selfhosted", "linux"]);
    expect(parseSubreddits("homelab/")).toEqual(["homelab"]);
    for (const junk of ["", null, undefined, "a", "x".repeat(30), "bad name!", "../etc", "r/", "a b&c"]) expect(parseSubreddits(junk).every((name) => /^[A-Za-z0-9_]{2,21}$/.test(name))).toBe(true);
    expect(parseSubreddits("a/b, ..")).toEqual([]);
    expect(parseSubreddits(Array.from({ length: 30 }, (_, i) => `sub${i}`).join(","))).toHaveLength(10);
  });

  test("headers: degoog's user agent when it has one, an honest one otherwise; nothing faked", () => {
    const fallback = buildHeaders();
    expect(fallback["User-Agent"]).toBe(USER_AGENT);
    expect(USER_AGENT).toBe("degoog-reddit-search/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)");
    expect(buildHeaders({ userAgent: () => "Custom/1" })["User-Agent"]).toBe("Custom/1");
    expect(buildHeaders({ userAgent: () => "" })["User-Agent"]).toBe(USER_AGENT);
    expect(buildHeaders({ buildAcceptLanguage: () => "de-DE,de;q=0.9" })["Accept-Language"]).toBe("de-DE,de;q=0.9");
    expect(fallback["Accept-Language"]).toBe("en-US,en;q=0.9");
    expect(fallback.Accept).toContain("application/atom+xml");
    expect(Object.keys(fallback).sort()).toEqual(["Accept", "Accept-Language", "User-Agent"]);
  });

  test("the cache key ignores case and spacing but not sort, time, nsfw, subreddits, page or after", () => {
    const base = { query: "Best  Homelab OS", sort: "relevance", time: "all", nsfw: false, subreddits: [], page: 1, after: "" };
    const key = cacheKey(base);
    expect(cacheKey({ ...base, query: " best homelab os " })).toBe(key);
    for (const change of [{ sort: "top" }, { time: "week" }, { nsfw: true }, { subreddits: ["homelab"] }, { page: 2 }, { after: "t3_abc" }, { query: "other" }]) expect(cacheKey({ ...base, ...change })).not.toBe(key);
  });
});

describe("site filters sent by the Reddit lens", () => {
  test("site:reddit.com is removed from the text; the subreddit form becomes a restriction", () => {
    expect(splitSiteFilters("best homelab os site:reddit.com")).toEqual({ text: "best homelab os", subreddits: [] });
    expect(splitSiteFilters("site:reddit.com best os")).toEqual({ text: "best os", subreddits: [] });
    expect(splitSiteFilters("best os site:reddit.com/r/homelab")).toEqual({ text: "best os", subreddits: ["homelab"] });
    expect(splitSiteFilters("best os SITE:Reddit.com/r/HomeLab")).toEqual({ text: "best os", subreddits: ["HomeLab"] });
    expect(splitSiteFilters("best os site:www.reddit.com/r/homelab/ site:old.reddit.com/r/selfhosted")).toEqual({ text: "best os", subreddits: ["homelab", "selfhosted"] });
    expect(splitSiteFilters("best os site:https://reddit.com/r/homelab")).toEqual({ text: "best os", subreddits: ["homelab"] });
  });

  test("other filters and look-alike domains are left alone", () => {
    for (const query of ["best os site:example.com", "best os site:notreddit.com", "best os site:reddit.com.evil.example", "best os mysite:reddit.com", "reddit.com best os", "best os -site:reddit.com"]) {
      expect(splitSiteFilters(query).text).toBe(query.replace(/\s+/g, " ").trim());
    }
    expect(splitSiteFilters("best os -site:reddit.com").subreddits).toEqual([]);
    expect(splitSiteFilters(undefined)).toEqual({ text: "", subreddits: [] });
    expect(splitSiteFilters("site:reddit.com")).toEqual({ text: "", subreddits: [] });
  });

  test("the engine searches the cleaned text, restricted to the subreddit, and an empty rest makes no request", async () => {
    const ctx = makeContext(ok);
    await make({ onlySubreddits: "linux" }).executeSearch("best os site:reddit.com/r/homelab", 1, "any", ctx);
    const url = new URL(ctx.calls[0].url);
    expect(url.pathname).toBe("/r/homelab/search.rss");
    expect(url.searchParams.get("q")).toBe("best os");
    const plain = makeContext(ok);
    await make({ onlySubreddits: "linux" }).executeSearch("best os site:reddit.com", 1, "any", plain);
    expect(new URL(plain.calls[0].url).pathname).toBe("/r/linux/search.rss"); // the setting applies when the query names none
    expect(new URL(plain.calls[0].url).searchParams.get("q")).toBe("best os");
    const empty = makeContext(ok);
    expect(await make().executeSearch("site:reddit.com/r/homelab", 1, "any", empty)).toEqual([]);
    expect(empty.calls).toHaveLength(0);
    // the same search with and without the filter shares one cache entry
    const shared = makeContext(ok);
    const engine = make();
    await engine.executeSearch("best homelab os", 1, "any", shared);
    await engine.executeSearch("best homelab os site:reddit.com", 1, "any", shared);
    expect(shared.calls).toHaveLength(1);
  });
});

describe("text helpers", () => {
  test("entities: the usual named ones and numeric ones are decoded, nothing else is expanded", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x27;f&#x27; &nbsp;g &mdash; h&hellip;")).toBe("a & b <c> \"d\" 'e' 'f'  g — h…");
    expect(decodeEntities("&#32;x&#x20;")).toBe(" x ");
    expect(decodeEntities("&custom; &unknownentity; &#0; &#xD800; &#99999999; &#x110000; &amp")).toBe("&custom; &unknownentity; &#0; &#xD800; &#99999999; &#x110000; &amp");
    // a billion-laughs style text is only decoded once, never expanded
    const laughs = '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]>&lol2;';
    expect(decodeEntities(laughs)).toBe(laughs);
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
    expect(decodeEntities(null)).toBe("");
  });

  test("tags go, and so does the inside of script and style", () => {
    expect(stripTags("a <b>bold</b> <i>word</i>")).toContain("bold");
    expect(stripTags("a <b>bold</b>").replace(/\s+/g, " ")).toBe("a bold ");
    expect(stripTags("x<script>alert(1)</script>y<style>p{}</style>z").replace(/\s+/g, "")).toBe("xyz");
    expect(stripTags("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(stripTags(undefined)).toBe("");
  });

  test("cutText ends at a sentence after 40 %, else at a word after 50 % with an ellipsis, else hard", () => {
    expect(cutText("short text", 100)).toBe("short text");
    const sentence = `${"A".repeat(150)}. ${"B".repeat(300)}`;
    expect(cutText(sentence, 350)).toBe(`${"A".repeat(150)}.`);
    const words = Array.from({ length: 80 }, () => "word").join(" ");
    const cut = cutText(words, 100);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(101);
    expect(cut.slice(0, -1).endsWith(" ")).toBe(false);
    expect(cutText("x".repeat(500), 100)).toBe(`${"x".repeat(100)}…`);
    expect(cutText("Early. " + "y".repeat(300), 100)).toBe(`${"Early. " + "y".repeat(93)}…`);
    expect(cutText("  spaced   out  ", 100)).toBe("spaced out");
  });

  test("clampInt, truthy, dayLabel", () => {
    expect([clampInt("500", 150, 800, 350), clampInt("1", 150, 800, 350), clampInt("900", 150, 800, 350), clampInt("x", 150, 800, 350), clampInt(undefined, 150, 800, 350)]).toEqual([500, 150, 800, 350, 350]);
    expect([truthy("true"), truthy(true), truthy("false"), truthy(false), truthy(undefined, true), truthy("", true), truthy(null, false)]).toEqual([true, true, false, false, true, true, false]);
    expect(dayLabel("2024-06-22")).toBe("Jun 22, 2024");
    expect(dayLabel("2024-01-01")).toBe("Jan 1, 2024");
    for (const bad of ["", "soon", "2024-13-45", undefined, null, "2024-6-2"]) expect(dayLabel(bad)).toBe("");
  });
});

describe("addresses, dates, thumbnails", () => {
  test("post links become the clean canonical address on www.reddit.com", () => {
    const canonical = "https://www.reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box/";
    for (const input of [
      canonical,
      "http://www.reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box",
      "https://old.reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box/?utm_source=share&utm_medium=web2x&context=3",
      "https://np.reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box/#comment",
      "https://new.reddit.com/r/homelab/comments/1ABCD01/which_os_for_a_tiny_home_server_box/",
      "https://m.reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box/",
      "https://reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box/?rdt=1234",
    ]) expect(normalizeUrl(input)).toBe(canonical);
    expect(normalizeUrl("https://www.reddit.com/r/homelab/comments/1abcd01/")).toBe("https://www.reddit.com/r/homelab/comments/1abcd01/");
    expect(normalizeUrl("https://www.reddit.com/r/homelab/comments/1abcd01")).toBe("https://www.reddit.com/r/homelab/comments/1abcd01/");
    expect(normalizeUrl("https://redd.it/1abcd01")).toBe("https://www.reddit.com/comments/1abcd01/");
    expect(normalizeUrl("https://www.reddit.com/comments/1abcd01/slug/")).toBe("https://www.reddit.com/comments/1abcd01/slug/");
    expect(normalizeUrl("https://www.reddit.com/u/someone/comments/1abcd01/a_post/")).toBe("https://www.reddit.com/user/someone/comments/1abcd01/a_post/");
    expect(normalizeUrl("https://www.reddit.com/user/someone/comments/1abcd01/a_post/")).toBe("https://www.reddit.com/user/someone/comments/1abcd01/a_post/");
  });

  test("anything that is not a Reddit post is refused", () => {
    for (const bad of [
      "", null, undefined, 5, "not a url", "javascript:alert(1)", "data:text/html,x", "ftp://www.reddit.com/r/a/comments/abc123/",
      "https://evil.example/r/homelab/comments/1abcd01/x/",
      "https://www.reddit.com.evil.example/r/homelab/comments/1abcd01/x/",
      "https://evilreddit.com/r/homelab/comments/1abcd01/x/",
      "https://www.reddit.com/r/homelab/",
      "https://www.reddit.com/r/homelab/wiki/index",
      "https://www.reddit.com/user/someone/",
      "https://www.reddit.com/search?q=x",
      "https://redd.it/",
      "https://redd.it/a/b",
      "https://i.redd.it/photo.jpeg",
    ]) expect(normalizeUrl(bad)).toBe("");
    // slugs lose odd characters
    expect(normalizeUrl("https://www.reddit.com/r/homelab/comments/1abcd01/a%20b<script>/")).not.toContain("<");
    expect(subredditOf("https://www.reddit.com/r/homelab/comments/1abcd01/x/")).toBe("homelab");
    expect(subredditOf("https://www.reddit.com/comments/1abcd01/")).toBe("");
  });

  test("dates: the ISO day in UTC, never an impossible or far-future one", () => {
    expect(isoDay("2024-06-22T08:10:20+00:00")).toBe("2024-06-22");
    expect(isoDay("2024-06-22T23:30:00-05:00")).toBe("2024-06-23"); // UTC
    expect(isoDay("2024-06-22")).toBe("2024-06-22");
    expect(isoDay("2024-06-22 08:10:20")).toBe("2024-06-22");
    for (const bad of ["", "yesterday", "2024-13-40T00:00:00Z", "1999-01-01T00:00:00Z", "2999-01-01T00:00:00Z", undefined, null, "22/06/2024"]) expect(isoDay(bad)).toBe("");
  });

  test("thumbnails: https pictures from Reddit's own hosts only", () => {
    for (const good of ["https://b.thumbs.redditmedia.com/x.jpg", "https://external-preview.redd.it/x.jpg?width=640&s=abc", "https://preview.redd.it/x.png", "https://i.redd.it/x.jpg", "https://www.reddit.com/x.png", "https://styles.redditmedia.com/t5/x.png"]) expect(thumbnailOf(good)).toBe(good);
    expect(thumbnailOf("https://external-preview.redd.it/x.jpg?width=640&amp;s=abc")).toBe("https://external-preview.redd.it/x.jpg?width=640&s=abc");
    for (const bad of ["http://i.redd.it/x.jpg", "https://evil.example/x.png", "https://redd.it.evil.example/x.png", "https://evilredd.it/x.png", "https://user:pw@i.redd.it/x.jpg", "javascript:alert(1)", "//i.redd.it/x.jpg", "", null, undefined, "self", "default", "nsfw"]) expect(thumbnailOf(bad)).toBe("");
  });
});

describe("post bodies", () => {
  test("the markdown part between Reddit's markers, tags removed, entities decoded, paragraphs joined", () => {
    const html = '<table> <tr><td> <!-- SC_OFF --><div class="md"><p>First &amp; <b>second</b></p>\n\n<p>Third&#39;s line</p><ul><li>one</li><li>two</li></ul></div><!-- SC_ON --> &#32; submitted by &#32; <a href="https://www.reddit.com/user/x"> /u/x </a> <br/> <span><a href="https://x">[link]</a></span> <span><a href="https://y">[comments]</a></span> </td></tr></table>';
    expect(bodyText(html)).toBe("First & second Third's line one two");
  });

  test("without markers the 'submitted by' tail and the [link] [comments] buttons go", () => {
    expect(bodyText('<p>Plain body text.</p> &#32; submitted by &#32; <a href="u"> /u/x </a> <br/> <span><a href="l">[link]</a></span> <span><a href="c">[comments]</a></span>')).toBe("Plain body text.");
    expect(bodyText("<p>Only buttons</p> [link] [comments]")).toBe("Only buttons");
  });

  test("link-only, removed, deleted and empty bodies are empty", () => {
    for (const html of [
      '<!-- SC_OFF --><div class="md"><p><a href="https://example.org/a">https://example.org/a</a></p></div><!-- SC_ON -->',
      '<!-- SC_OFF --><div class="md"><p>https://example.org/a https://example.org/b</p></div><!-- SC_ON -->',
      '<!-- SC_OFF --><div class="md"><p>[removed]</p></div><!-- SC_ON -->',
      '<!-- SC_OFF --><div class="md"><p>[deleted]</p></div><!-- SC_ON -->',
      '<!-- SC_OFF --><div class="md"><p>[ Removed by Reddit ]</p></div><!-- SC_ON -->',
      '<!-- SC_OFF --><div class="md"><p>[removed by moderator]</p></div><!-- SC_ON -->',
      '<!-- SC_OFF --><div class="md"><p>  </p></div><!-- SC_ON -->',
      "", null, undefined, "<table><tr><td> submitted by /u/x </td></tr></table>",
    ]) expect(bodyText(html)).toBe("");
    expect(bodyText('<!-- SC_OFF --><div class="md"><p>I removed the old drive.</p></div><!-- SC_ON -->')).toBe("I removed the old drive.");
  });

  test("scripts, styles and comments never reach the text, and a huge body is bounded", () => {
    expect(bodyText('<div class="md"><p>Hi<script>alert(1)</script> there<style>x{}</style><!-- hidden --></p></div>').replace(/\s+/g, " ")).toBe("Hi there");
    const huge = `<!-- SC_OFF --><div class="md"><p>${"word ".repeat(200_000)}</p></div><!-- SC_ON -->`;
    expect(bodyText(huge).length).toBeLessThan(110_000);
  });
});

describe("parsing the Atom feed", () => {
  const feed = parseFeed(atom);
  const byId = (id) => feed.entries.find((entry) => entry.fullname === id);

  test("only posts are kept: the subreddit and user entries of the feed are dropped; the cursor is the last post", () => {
    expect(feed.entries.map((entry) => entry.fullname)).toEqual(["t3_1abcd01", "t3_1abcd02", "t3_1abcd03", "t3_1abcd04", "t3_1abcd05", "t3_1abcd06", "t3_1abcd07", "t3_1abcd08"]);
    expect(feed.last).toBe("t3_1abcd08");
  });

  test("a text post: title, canonical link, subreddit, author, UTC date, body without the boilerplate", () => {
    expect(byId("t3_1abcd01")).toEqual({
      fullname: "t3_1abcd01",
      title: "Which OS for a tiny home server box?",
      url: "https://www.reddit.com/r/homelab/comments/1abcd01/which_os_for_a_tiny_home_server_box/",
      subreddit: "homelab",
      author: "quietfrog",
      iso: "2024-06-22",
      thumbnail: "",
      body: expect.stringContaining("I'm setting up a small box (4 cores, 16 GB) for files, a media server & a few containers."),
      outbound: "",
    });
    const body = byId("t3_1abcd01").body;
    expect(body).not.toContain("submitted by");
    expect(body).not.toContain("[link]");
    expect(body).not.toContain("SC_OFF");
    expect(body).not.toContain("<");
    expect(body).not.toContain("&amp;");
    expect(body).not.toContain("\n");
  });

  test("a link post has no body but names the outbound site", () => {
    expect(byId("t3_1abcd02")).toMatchObject({ body: "", outbound: "example.org", subreddit: "selfhosted", author: "bluepine", iso: "2024-07-02" });
  });

  test("a removed post has an empty body", () => {
    expect(byId("t3_1abcd03")).toMatchObject({ body: "", outbound: "" });
  });

  test("an image post: the thumbnail is the media:thumbnail, and the outbound kind is 'image'", () => {
    expect(byId("t3_1abcd05")).toMatchObject({ thumbnail: "https://b.thumbs.redditmedia.com/abcd05thumb.jpg", outbound: "image", body: "" });
  });

  test("CDATA content and an old.reddit.com link with tracking parameters", () => {
    expect(byId("t3_1abcd06")).toMatchObject({
      url: "https://www.reddit.com/r/selfhosted/comments/1abcd06/is_a_nas_box_overkill_for_two_users/",
      body: expect.stringContaining("Short answer first: probably not."),
    });
  });

  test("a short redd.it link, no author and no <published> (the <updated> date is used)", () => {
    expect(byId("t3_1abcd07")).toMatchObject({ url: "https://www.reddit.com/comments/1abcd07/", author: "", iso: "2022-02-20", subreddit: "linux", outbound: "example.net", body: "" });
  });

  test("hostile input: tags in the title, a script in the body, a picture from a foreign host", () => {
    const hostile = byId("t3_1abcd08");
    expect(hostile.title).not.toContain("<");
    expect(hostile.title).not.toContain("alert(1)");
    expect(hostile.title).toContain("Proxmox worth it?");
    expect(hostile.body).not.toContain("<");
    expect(hostile.body).not.toContain("alert");
    expect(hostile.body).not.toContain("onerror");
    expect(hostile.thumbnail).toBe("");
    expect(hostile.url.startsWith("https://www.reddit.com/")).toBe(true);
  });

  test("not a feed is null, an empty feed is an empty list", () => {
    for (const bad of ["", "<html><body>hi</body></html>", "plain text", '{"json": true}', null, undefined, "<entry><title>x</title></entry>"]) expect(parseFeed(bad)).toBeNull();
    expect(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"></feed>')).toEqual({ entries: [], last: "" });
  });

  test("garbage never throws: unterminated tags, broken entries, entries without a link or a title", () => {
    const pieces = [
      '<feed><entry><title>Lonely</title></entry></feed>',
      '<feed><entry><link href="https://www.reddit.com/r/a/comments/abc123/x/"/></entry></feed>',
      '<feed><entry><id>t3_abc123</id><title>No link</title></entry></feed>',
      '<feed><entry><id>t3_abc123</id><title>Unterminated <link href="https://www.reddit.com/r/ab/comments/abc123/x/"',
      '<feed><entry><id>t3_abc123</id><title>x</title><link href="https://evil.example/r/ab/comments/abc123/x/"/></entry></feed>',
      "<feed>" + "<entry>".repeat(500),
      "<feed>" + "<a>".repeat(50_000) + "</feed>",
    ];
    for (const piece of pieces) {
      const parsed = parseFeed(piece);
      expect(parsed === null || Array.isArray(parsed.entries)).toBe(true);
      expect(parsed?.entries ?? []).toEqual([]);
    }
  });

  test("a billion-laughs DOCTYPE is ignored and entities are never expanded", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lollollollollol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;">]><feed><entry><id>t3_abc123</id><title>&lol2;</title><link href="https://www.reddit.com/r/ab/comments/abc123/x/"/></entry></feed>`;
    const parsed = parseFeed(xml);
    expect(parsed.entries[0].title).toBe("&lol2;");
    expect(parsed.entries[0].title.length).toBeLessThan(20);
  });

  test("size and entry limits", () => {
    expect(parseFeed(`<feed>${"x".repeat(2_000_001)}</feed>`)).toBeNull();
    const one = (n) => `<entry><id>t3_abc${n}</id><title>T${n}</title><link href="https://www.reddit.com/r/ab/comments/abc${n}/x/"/></entry>`;
    const many = `<feed>${Array.from({ length: 300 }, (_, i) => one(i)).join("")}</feed>`;
    expect(parseFeed(many).entries).toHaveLength(MAX_ENTRIES);
  });

  test("a deleted-author entry (/u/[deleted]) and odd author names are handled", () => {
    const xml = (author) => `<feed><entry><author><name>${author}</name></author><id>t3_abc123</id><title>T</title><link href="https://www.reddit.com/r/ab/comments/abc123/x/"/></entry></feed>`;
    expect(parseFeed(xml("/u/someone")).entries[0].author).toBe("someone");
    for (const odd of ["[deleted]", "/u/<script>", "x".repeat(100), ""]) expect(parseFeed(xml(odd)).entries[0].author).toBe("");
  });
});

describe("shaping the results", () => {
  const feed = parseFeed(atom);
  const shaped = (options = {}) => shapeResults(feed.entries, { ...OPTIONS, ...options }, "Reddit Search");
  const first = () => shaped()[0];

  test("title: the post title with Reddit's ' : r/<sub>' suffix, once", () => {
    expect(first().title).toBe("Which OS for a tiny home server box? : r/homelab");
    const again = shapeResults([{ ...feed.entries[0], title: "Already there : r/homelab" }], OPTIONS, "x");
    expect(again[0].title).toBe("Already there : r/homelab");
    const noSub = shapeResults([{ ...feed.entries[0], subreddit: "" }], OPTIONS, "x");
    expect(noSub[0].title).toBe("Which OS for a tiny home server box?");
  });

  test("snippet: 'date · r/sub · u/author — excerpt', the date first like other search engines", () => {
    expect(first().snippet).toStartWith("Jun 22, 2024 · r/homelab · u/quietfrog — I'm setting up a small box");
    expect(first().publishedAt).toBeUndefined();
  });

  test("with the date in the snippet turned off, the date is a separate field", () => {
    const result = shaped({ dateInSnippet: false })[0];
    expect(result.snippet).toStartWith("r/homelab · u/quietfrog — I'm setting up");
    expect(result.snippet).not.toContain("2024");
    expect(result.publishedAt).toBe("2024-06-22");
  });

  test("no body: the outbound site, 'Image post', or just the meta line; no author: no u/ part; no date: no date part", () => {
    const results = shaped();
    expect(results[1].snippet).toBe("Jul 2, 2024 · r/selfhosted · u/bluepine — Link post to example.org");
    expect(results[2].snippet).toBe("Nov 5, 2023 · r/linux4noobs · u/ghosted");
    expect(results[4].snippet).toBe("Jan 15, 2025 · r/homelabsetups · u/rackfan — Image post");
    expect(results[6].snippet).toBe("Feb 20, 2022 · r/linux — Link post to example.net");
    const noDate = shapeResults([{ ...feed.entries[0], iso: "", author: "" }], OPTIONS, "x")[0];
    expect(noDate.snippet).toStartWith("r/homelab — I'm setting up");
    const bare = shapeResults([{ ...feed.entries[0], iso: "", author: "", subreddit: "", body: "" }], OPTIONS, "x")[0];
    expect(bare.snippet).toBe("");
  });

  test("the excerpt is cut at the configured length on a boundary, with an ellipsis", () => {
    const long = shaped({ snippetLength: 150 })[0].snippet;
    const excerpt = long.split(" — ")[1];
    expect(excerpt.length).toBeLessThanOrEqual(151);
    expect(excerpt.endsWith("…") || excerpt.endsWith(".") || excerpt.endsWith("?")).toBe(true);
    expect(shaped({ snippetLength: 800 })[0].snippet).toContain("Thanks in advance for the advice!");
  });

  test("thumbnails only when asked, source is the engine name, results carry only known fields", () => {
    expect(shaped()[4].thumbnail).toBe("https://b.thumbs.redditmedia.com/abcd05thumb.jpg");
    expect(shaped({ showThumbnails: false })[4].thumbnail).toBeUndefined();
    expect(first().source).toBe("Reddit Search");
    for (const result of shaped()) expect(Object.keys(result).every((key) => ["title", "url", "snippet", "source", "thumbnail", "publishedAt"].includes(key))).toBe(true);
  });

  test("excluded subreddits (any case) are removed, duplicates by address are dropped", () => {
    const results = shaped({ excludeSubreddits: ["SelfHosted", "testnsfw"] });
    expect(results.some((r) => r.title.endsWith("r/selfhosted"))).toBe(false);
    expect(results.some((r) => r.title.endsWith("r/testnsfw"))).toBe(false);
    expect(results.some((r) => r.title.endsWith("r/homelab"))).toBe(true);
    expect(shapeResults([feed.entries[0], feed.entries[0]], OPTIONS, "x")).toHaveLength(1);
  });

  test("every url is a clean Reddit address and nothing in a result carries markup", () => {
    for (const result of shaped()) {
      expect(result.url).toMatch(/^https:\/\/www\.reddit\.com\//);
      expect(result.url).not.toContain("?");
      expect(result.title).not.toContain("<");
      expect(result.snippet).not.toContain("<");
    }
  });
});

describe("settings", () => {
  test("the schema: sort defaults to relevance, NSFW is off, nothing is required, groups and options are there", () => {
    const field = (key) => SETTINGS_SCHEMA.find((entry) => entry.key === key);
    expect(field("sortBy")).toMatchObject({ type: "select", default: "relevance", options: SORTS });
    expect(field("sortBy").optionLabels).toHaveLength(SORTS.length);
    expect(field("includeNsfw")).toMatchObject({ type: "toggle", default: "false" });
    expect(field("snippetLength")).toMatchObject({ type: "number", default: "350" });
    expect(field("defaultTime")).toMatchObject({ type: "select", default: "all" });
    expect(field("dateInSnippet")).toMatchObject({ type: "toggle", default: "true" });
    for (const entry of SETTINGS_SCHEMA) {
      expect(entry.required).toBeUndefined();
      expect(entry.fieldset).toBeTruthy();
      expect(entry.label).toBeTruthy();
      expect(entry.description).toBeTruthy();
    }
  });

  test("configure: defaults, clamping, strings and booleans", () => {
    const defaults = make();
    expect(defaults).toMatchObject({ sortBy: "relevance", defaultTime: "all", includeNsfw: false, onlySubreddits: [], excludeSubreddits: [], snippetLength: 350, dateInSnippet: true, showThumbnails: true });
    const engine = make({ sortBy: "top", defaultTime: "year", includeNsfw: "true", onlySubreddits: "r/homelab, selfhosted", excludeSubreddits: "memes", snippetLength: "9999", dateInSnippet: "false", showThumbnails: false });
    expect(engine).toMatchObject({ sortBy: "top", defaultTime: "year", includeNsfw: true, onlySubreddits: ["homelab", "selfhosted"], excludeSubreddits: ["memes"], snippetLength: 800, dateInSnippet: false, showThumbnails: false });
    expect(make({ snippetLength: "3" }).snippetLength).toBe(150);
    expect(make({ snippetLength: "junk" }).snippetLength).toBe(350);
    expect(make({ sortBy: "bogus", defaultTime: "bogus" })).toMatchObject({ sortBy: "relevance", defaultTime: "all" });
    expect(new RedditSearchEngine().configure({})).toBeUndefined();
  });

  test("the engine identifies itself: name, bang, no client exposure", () => {
    const engine = new RedditSearchEngine();
    expect(engine).toMatchObject({ name: "Reddit Search", bangShortcut: "rd", isClientExposed: false });
    expect(engine.settingsSchema).toBe(SETTINGS_SCHEMA);
  });

  test("DEGOOG_REDDIT_FEED_BASE overrides the feed address", async () => {
    await withEnv("DEGOOG_REDDIT_FEED_BASE", "http://mock.test:4472/", async () => {
      expect(new RedditSearchEngine().feedBase).toBe("http://mock.test:4472/");
      const engine = new RedditSearchEngine();
      engine.limiter = new Limiter({ minIntervalMs: 0 });
      const ctx = makeContext(ok);
      await engine.executeSearch("x", 1, "any", ctx);
      expect(ctx.calls[0].url.startsWith("http://mock.test:4472/search.rss?")).toBe(true);
    });
  });
});

describe("RedditSearchEngine: one request per page", () => {
  test("a search is one request with relevance, posts only and the user agent; results are rich", async () => {
    const ctx = makeContext(ok);
    const results = await make().executeSearch("best homelab os", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(1);
    const url = new URL(ctx.calls[0].url);
    expect(url.origin + url.pathname).toBe("https://feed.test/search.rss");
    expect(url.searchParams.get("sort")).toBe("relevance");
    expect(url.searchParams.get("type")).toBe("link");
    expect(url.searchParams.has("after")).toBe(false);
    expect(ctx.calls[0].init.headers["User-Agent"]).toBe(USER_AGENT);
    expect(results).toHaveLength(8);
    expect(results[0]).toMatchObject({ title: "Which OS for a tiny home server box? : r/homelab", source: "Reddit Search" });
    expect(results[0].snippet).toStartWith("Jun 22, 2024 · r/homelab · u/quietfrog — ");
  });

  test("degoog's time filter and the settings reach the request", async () => {
    const ctx = makeContext(ok);
    await make({ sortBy: "top", includeNsfw: "true", defaultTime: "year", onlySubreddits: "homelab" }).executeSearch("q", 1, "week", ctx);
    const url = new URL(ctx.calls[0].url);
    expect(url.pathname).toBe("/r/homelab/search.rss");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ sort: "top", t: "week", include_over_18: "1", restrict_sr: "1" });
    const other = makeContext(ok);
    await make({ defaultTime: "month" }).executeSearch("q", 1, "any", other);
    expect(new URL(other.calls[0].url).searchParams.get("t")).toBe("month");
  });

  test("an empty query makes no request; a feed with no posts is an empty list, not an error", async () => {
    const ctx = makeContext(ok);
    expect(await make().executeSearch("   ", 1, "any", ctx)).toEqual([]);
    expect(await make().executeSearch(undefined, 1, "any", ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(0);
    const empty = makeContext(() => new Response('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>none</title></feed>', { status: 200 }));
    expect(await make().executeSearch("nothing", 1, "any", empty)).toEqual([]);
    expect(empty.carries).toEqual([]);
  });

  test("it also works without degoog's context helpers", async () => {
    const calls = [];
    const context = { fetch: async (url) => (calls.push(url), ok()) };
    expect(await make().executeSearch("x", 1, "any", context)).toHaveLength(8);
    const failing = { fetch: async () => new Response("no", { status: 418 }) };
    await expect(make().executeSearch("x", 1, "any", failing)).rejects.toThrow(/HTTP 418/);
  });
});

describe("RedditSearchEngine: paging with after", () => {
  const post = (n) => `<entry><id>t3_pg${n}</id><title>Post ${n}</title><link href="https://www.reddit.com/r/ab/comments/pg${n}/post_${n}/"/><updated>2024-01-01T00:00:00+00:00</updated></entry>`;
  const page = (from, to) => `<feed xmlns="http://www.w3.org/2005/Atom">${Array.from({ length: to - from + 1 }, (_, i) => post(from + i)).join("")}</feed>`;
  const pager = () =>
    makeContext((url) => {
      const after = new URL(url).searchParams.get("after");
      if (!after) return new Response(page(1, 3));
      if (after === "t3_pg3") return new Response(page(4, 6));
      if (after === "t3_pg6") return new Response(page(7, 9));
      return new Response(page(10, 12));
    });

  test("page 1 carries the last post, page 2 continues after it, page 3 after page 2's last post, there is no page 4", async () => {
    const ctx = pager();
    const engine = make();
    const one = await engine.executeSearch("q", 1, "any", ctx);
    expect(ctx.carries).toEqual([{ after: "t3_pg3" }]);
    expect(new URL(ctx.calls[0].url).searchParams.has("after")).toBe(false);
    const two = await engine.executeSearch("q", 2, "any", ctx);
    expect(new URL(ctx.calls[1].url).searchParams.get("after")).toBe("t3_pg3");
    // degoog only ever hands over what page 1 carried, so page 3's cursor is the engine's own memory of page 2
    expect(ctx.carried).toEqual({ after: "t3_pg3" });
    const three = await engine.executeSearch("q", 3, "any", ctx);
    expect(new URL(ctx.calls[2].url).searchParams.get("after")).toBe("t3_pg6");
    expect(await engine.executeSearch("q", 4, "any", ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(3);
    expect([one, two, three].map((list) => list.map((r) => r.title.replace(/ : r\/ab$/, "")))).toEqual([
      ["Post 1", "Post 2", "Post 3"],
      ["Post 4", "Post 5", "Post 6"],
      ["Post 7", "Post 8", "Post 9"],
    ]);
  });

  test("the cursor is the last post of the feed, even when filters remove it from the results", async () => {
    const ctx = pager();
    const results = await make({ excludeSubreddits: "ab" }).executeSearch("q", 1, "any", ctx);
    expect(results).toEqual([]);
    expect(ctx.carries).toEqual([{ after: "t3_pg3" }]);
  });

  test("page 2 without a carried cursor (or with a bad one) makes no request and returns nothing", async () => {
    for (const carried of [{}, { after: "" }, { after: "t5_abc" }, { after: "t3_a b" }, { after: "../x" }, { sc: "other engine's data" }]) {
      const ctx = pager();
      ctx.carried = { ...carried };
      expect(await make().executeSearch("q", 2, "any", ctx)).toEqual([]);
      expect(ctx.calls).toHaveLength(0);
    }
    const bare = { fetch: async () => ok() };
    expect(await make().executeSearch("q", 2, "any", bare)).toEqual([]);
  });

  test("cached pages still hand over their cursor, so paging works from the cache", async () => {
    const ctx = pager();
    const engine = make();
    await engine.executeSearch("q", 1, "any", ctx);
    await engine.executeSearch("q", 2, "any", ctx);
    await engine.executeSearch("q", 3, "any", ctx);
    const again = pager();
    await engine.executeSearch("q", 1, "any", again);
    expect(again.carries).toEqual([{ after: "t3_pg3" }]);
    expect(await engine.executeSearch("q", 2, "any", again)).toHaveLength(3);
    expect(await engine.executeSearch("q", 3, "any", again)).toHaveLength(3);
    expect(again.calls).toHaveLength(0);
  });

  test("page 3 needs page 2 to have been fetched: without it there is no cursor and no request", async () => {
    const engine = make();
    const ctx = pager();
    await engine.executeSearch("q", 1, "any", ctx); // page 1 carried a cursor for page 2 only
    expect(await engine.executeSearch("q", 3, "any", ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(1);
    const cold = pager();
    cold.carried = { after: "t3_pg3" };
    expect(await make().executeSearch("q", 3, "any", cold)).toEqual([]);
    expect(cold.calls).toHaveLength(0);
  });

  test("a cursor is only used for the same search (query, sort, time, nsfw, subreddits)", async () => {
    const engine = make();
    const ctx = pager();
    await engine.executeSearch("q", 1, "any", ctx);
    await engine.executeSearch("q", 2, "any", ctx);
    expect(await engine.executeSearch("another query", 3, "any", ctx)).toEqual([]);
    expect(await engine.executeSearch("q", 3, "week", ctx)).toEqual([]); // another time window: another list
    expect(ctx.calls).toHaveLength(2);
  });

  test("page numbers that are odd are treated as page 1", async () => {
    for (const odd of [0, -3, undefined, null, "x", NaN]) {
      const ctx = pager();
      await make().executeSearch(`q${String(odd)}`, odd, "any", ctx);
      expect(new URL(ctx.calls[0].url).searchParams.has("after")).toBe(false);
    }
  });
});

describe("RedditSearchEngine: caching", () => {
  test("a repeated search costs no request, ignoring case and spacing; a different setting or query does", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    await engine.executeSearch("best homelab os", 1, "any", ctx);
    expect(await engine.executeSearch("  Best   Homelab OS ", 1, "any", ctx)).toHaveLength(8);
    expect(ctx.calls).toHaveLength(1);
    await engine.executeSearch("best homelab os", 1, "week", ctx);
    await engine.executeSearch("another one", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(3);
  });

  test("the cache lives ten minutes and stays bounded", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    let t = 1_000_000;
    engine.now = () => t;
    await engine.executeSearch("one", 1, "any", ctx);
    t += 9 * 60_000;
    await engine.executeSearch("one", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(1);
    t += 2 * 60_000;
    await engine.executeSearch("one", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(2);
    for (let i = 0; i < 60; i += 1) await engine.executeSearch(`query ${i}`, 1, "any", ctx);
    expect(engine._cache.size).toBeLessThanOrEqual(50);
  });

  test("a changed setting drops the cache, so shaping follows the new setting", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    expect((await engine.executeSearch("q", 1, "any", ctx))[0].snippet).toContain("Jun 22, 2024");
    engine.configure({ dateInSnippet: "false" });
    const again = await engine.executeSearch("q", 1, "any", ctx);
    expect(again[0].snippet).not.toContain("2024");
    expect(ctx.calls).toHaveLength(2);
  });

  test("identical simultaneous searches share one request", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    await Promise.all([1, 2, 3, 4].map(() => engine.executeSearch("best homelab os", 1, "any", ctx)));
    expect(ctx.calls).toHaveLength(1);
  });

  test("a failed search is not cached, and the next one tries again", async () => {
    const bad = makeContext(() => new Response("<html>nope</html>", { status: 200 }));
    const engine = make();
    await expect(engine.executeSearch("q", 1, "any", bad)).rejects.toMatchObject({ status: "parse_error" });
    const good = makeContext(ok);
    expect(await engine.executeSearch("q", 1, "any", good)).toHaveLength(8);
  });
});

describe("RedditSearchEngine: politeness", () => {
  test("requests are at least 2 seconds apart; a wait that is too long is skipped, not queued", async () => {
    let t = 0;
    const waits = [];
    const engine = make();
    engine.limiter = new Limiter({ minIntervalMs: 2000, maxWaitMs: 6000, now: () => t, wait: async (ms) => { waits.push(ms); t += ms; } });
    const ctx = makeContext(ok);
    await engine.executeSearch("one", 1, "any", ctx);
    await engine.executeSearch("two", 1, "any", ctx);
    expect(waits).toEqual([2000]);
    expect(new RedditSearchEngine().limiter.minIntervalMs).toBe(2000);
    engine.limiter.nextSlot = t + 10_000; // a queue that is already 10 s long
    await expect(engine.executeSearch("three", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
  });

  test("no retries: a failing request is made once", async () => {
    const ctx = makeContext(() => new Response("oops", { status: 502 }));
    await capture(async () => {
      await expect(make().executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "network" });
    });
    expect(ctx.calls).toHaveLength(1);
  });
});

describe("RedditSearchEngine: pauses when Reddit says no", () => {
  const messages = (lines) => lines.join("\n");

  test("429 pauses for the Retry-After time (2 min by default, 15 min at most) and makes no request meanwhile", async () => {
    const make429 = (headers) => makeContext(() => new Response("Too Many Requests", { status: 429, headers }));
    await capture(async () => {
      const def = make();
      const ctx = make429({});
      await expect(def.executeSearch("one", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
      expect(def.limiter.blockedFor()).toBeGreaterThan(119_000);
      expect(def.limiter.blockedFor()).toBeLessThanOrEqual(120_000);
      await expect(def.executeSearch("two", 1, "any", ctx)).rejects.toThrow(/paused for 2 min/);
      expect(ctx.calls).toHaveLength(1);

      const given = make();
      await expect(given.executeSearch("x", 1, "any", make429({ "retry-after": "300" }))).rejects.toMatchObject({ status: "rate_limited" });
      expect(given.limiter.blockedFor()).toBeGreaterThan(299_000);
      expect(given.limiter.blockedFor()).toBeLessThanOrEqual(300_000);

      const capped = make();
      await expect(capped.executeSearch("x", 1, "any", make429({ "retry-after": "86400" }))).rejects.toMatchObject({ status: "rate_limited" });
      expect(capped.limiter.blockedFor()).toBeLessThanOrEqual(900_000);
      expect(capped.limiter.blockedFor()).toBeGreaterThan(899_000);

      const junk = make();
      await expect(junk.executeSearch("x", 1, "any", make429({ "retry-after": "soon" }))).rejects.toMatchObject({ status: "rate_limited" });
      expect(junk.limiter.blockedFor()).toBeLessThanOrEqual(120_000);
    });
  });

  test("403 (blocked) pauses for 30 minutes with one short warning that gives no advice to get around it and no address", async () => {
    const ctx = makeContext(() => new Response("Forbidden", { status: 403 }));
    const engine = make();
    const lines = await capture(async () => {
      await expect(engine.executeSearch("secret query words", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
      await expect(engine.executeSearch("again", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
      await expect(engine.executeSearch("and again", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    });
    expect(ctx.calls).toHaveLength(1);
    expect(engine.limiter.blockedFor()).toBeGreaterThan(29 * 60_000);
    expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(30 * 60_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("refusing requests from this server's address");
    expect(lines[0]).toContain("30 min");
    expect(lines[0]).toContain("does not try to get around");
    for (const bad of ["http", "reddit.com", "secret query", "proxy", "VPN", "user agent", "stealth"]) expect(lines[0].toLowerCase()).not.toContain(bad.toLowerCase());
  });

  test("the 'blocked by network security' page, whatever the status, is a block, never a parse failure or an evasion", async () => {
    const page = "<!doctype html><html><body><h1>Whoa there, pardner!</h1><p>You've been blocked by network security.</p></body></html>";
    for (const status of [200, 403, 429, 503]) {
      const ctx = makeContext(() => new Response(page, { status }));
      const engine = make();
      const lines = await capture(async () => {
        await expect(engine.executeSearch(`q${status}`, 1, "any", ctx)).rejects.toBeDefined();
      });
      expect(ctx.calls).toHaveLength(1);
      expect(engine.limiter.blockedFor()).toBeGreaterThan(0);
      expect(lines.length).toBeLessThanOrEqual(1);
    }
    const ctx = makeContext(() => new Response(page, { status: 200 }));
    const engine = make();
    await capture(async () => {
      await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
    });
    expect(engine.limiter.blockedFor()).toBeGreaterThan(29 * 60_000);
  });

  test("the phrase inside a real feed does not count as a block", async () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>t3_abc123</id><title>You've been blocked by network security?</title><link href="https://www.reddit.com/r/ab/comments/abc123/x/"/></entry></feed>`;
    const results = await make().executeSearch("q", 1, "any", makeContext(() => new Response(feed)));
    expect(results).toHaveLength(1);
  });

  test("5xx and network errors pause for a minute, with one warning each, no address in it", async () => {
    const ctx = makeContext(() => new Response("bad gateway", { status: 502 }));
    const engine = make();
    const lines = await capture(async () => {
      await expect(engine.executeSearch("one", 1, "any", ctx)).rejects.toMatchObject({ status: "network" });
      await expect(engine.executeSearch("two", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    });
    expect(ctx.calls).toHaveLength(1);
    expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(60_000);
    expect(engine.limiter.blockedFor()).toBeGreaterThan(59_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("http");

    const down = { fetch: async () => { throw new Error("connect ECONNREFUSED https://feed.test/secret"); }, engineError: (s, m) => breach(s, m) };
    const other = make();
    const logged = await capture(async () => {
      await expect(other.executeSearch("one", 1, "any", down)).rejects.toMatchObject({ status: "network" });
    });
    expect(other.limiter.blockedFor()).toBeGreaterThan(59_000);
    expect(messages(logged)).not.toContain("ECONNREFUSED");
    expect(messages(logged)).not.toContain("feed.test");
  });

  test("a pause is logged once, even for many failing searches", async () => {
    const ctx = makeContext(() => new Response("slow down", { status: 429 }));
    const engine = make();
    const lines = await capture(async () => {
      for (let i = 0; i < 5; i += 1) await engine.executeSearch(`q${i}`, 1, "any", ctx).catch(() => {});
    });
    expect(lines).toHaveLength(1);
    expect(ctx.calls).toHaveLength(1);
  });

  test("the engine works again once the pause is over", async () => {
    let t = 1_000_000;
    const engine = make();
    engine.limiter = new Limiter({ minIntervalMs: 0, now: () => t });
    let answer = () => new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
    const ctx = makeContext(() => answer());
    await capture(async () => {
      await expect(engine.executeSearch("one", 1, "any", ctx)).rejects.toBeDefined();
    });
    t += 61_000;
    answer = ok;
    expect(await engine.executeSearch("one", 1, "any", ctx)).toHaveLength(8);
    expect(ctx.calls).toHaveLength(2);
  });

  test("errors name the engine, go through degoog's engineError, and contain no query, address or header", async () => {
    const ctx = makeContext(() => new Response("Forbidden", { status: 403 }));
    let message = "";
    await capture(async () => {
      try {
        await make().executeSearch("my private query", 1, "any", ctx);
      } catch (error) {
        message = error.message;
      }
    });
    expect(message).toContain("Reddit Search");
    for (const bad of ["private", "http", "User-Agent"]) expect(message).not.toContain(bad);
    let plain;
    await capture(async () => {
      plain = await make().executeSearch("x", 1, "any", { fetch: async () => new Response("x", { status: 403 }) }).catch((error) => error);
    });
    expect(plain).toBeInstanceOf(Error);
  });

  test("an unreadable body is a parse error, and an over-large one is refused", async () => {
    const broken = makeContext(() => ({ status: 200, ok: true, headers: new Headers(), text: async () => { throw new Error("stream"); } }));
    await expect(make().executeSearch("q", 1, "any", broken)).rejects.toMatchObject({ status: "parse_error" });
    const huge = makeContext(() => new Response(`<feed>${"x".repeat(2_100_000)}</feed>`));
    await expect(make().executeSearch("q2", 1, "any", huge)).rejects.toMatchObject({ status: "parse_error" });
  });

  test("the engine never sets extra headers: only the user agent, the accept headers and the language", async () => {
    const ctx = makeContext(ok);
    await make().executeSearch("q", 1, "any", ctx);
    expect(Object.keys(ctx.calls[0].init.headers).sort()).toEqual(["Accept", "Accept-Language", "User-Agent"]);
    expect(Object.keys(ctx.calls[0].init).sort()).toEqual(["headers"]);
  });
});
