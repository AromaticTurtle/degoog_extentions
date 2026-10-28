import { collapse, cutText, dayLabel, decodeEntities, stripTags } from "./text.js";

// Reddit's public Atom search feed, read with small bounded regex passes: no DOM, no entity expansion beyond a short list
// (see text.js), nothing is ever fetched or executed from what the feed says.
export const MAX_FEED_CHARS = 2_000_000;
export const MAX_ENTRIES = 100;
const MAX_CONTENT_CHARS = 100_000;

const REDDIT_HOST = /^(?:(?:www|old|new|np|m|i|amp|beta|sh)\.)?reddit\.com$/i;
const THUMB_HOST = /(?:^|\.)(?:redd\.it|redditmedia\.com|reddit\.com)$/i;

const CDATA = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/;

// The inside of <name>...</name> exactly as it is written.
const tag = (block, name) => {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return match ? match[1] : "";
};

// The text of an element: a CDATA section is literal, anything else is entity-escaped.
const plain = (raw) => {
  const cdata = CDATA.exec(raw);
  return cdata ? cdata[1] : decodeEntities(raw);
};

const attrs = (source) => {
  const out = {};
  for (const match of String(source).matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  return out;
};

const firstTag = (block, name) => {
  const match = new RegExp(`<${name}(\\s[^>]*)?/?>`, "i").exec(block);
  return match ? attrs(match[1] ?? "") : null;
};

// A post link on any of Reddit's hosts, as the clean canonical address: https://www.reddit.com/r/<sub>/comments/<id>/<slug>/.
// Query strings, fragments and tracking parameters go. Anything that is not a Reddit post is "".
export const normalizeUrl = (value) => {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    return "";
  }
  if (!/^https?:$/.test(url.protocol)) return "";
  if (/^redd\.it$/i.test(url.hostname)) {
    const id = /^\/([a-z0-9]{3,12})\/?$/i.exec(url.pathname)?.[1];
    return id ? `https://www.reddit.com/comments/${id.toLowerCase()}/` : "";
  }
  if (!REDDIT_HOST.test(url.hostname)) return "";
  const match = /^\/((?:r|u|user)\/[A-Za-z0-9_-]{2,21}\/)?comments\/([a-z0-9]{3,12})(?:\/([^/?#]*))?/i.exec(url.pathname);
  if (!match) return "";
  const scope = match[1] ? match[1].replace(/^u\//i, "user/") : "";
  const slug = match[3] ? `${match[3].replace(/[^A-Za-z0-9_%.-]/g, "")}/` : "";
  return `https://www.reddit.com/${scope}comments/${match[2].toLowerCase()}/${slug}`;
};

export const subredditOf = (url) => /^https:\/\/www\.reddit\.com\/r\/([A-Za-z0-9_]+)\//.exec(url)?.[1] ?? "";

export const thumbnailOf = (value) => {
  try {
    const url = new URL(decodeEntities(String(value ?? "")).trim());
    return url.protocol === "https:" && !url.username && !url.password && THUMB_HOST.test(url.hostname) ? url.href : "";
  } catch {
    return "";
  }
};

// The ISO day of an Atom timestamp ("2024-06-22T08:10:20+00:00"), in UTC. "" when it is not one.
export const isoDay = (value) => {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]|$)/.test(text)) return "";
  const when = new Date(/[T ]/.test(text) ? text.replace(" ", "T") : `${text}T00:00:00Z`);
  if (Number.isNaN(when.getTime())) return "";
  const day = when.toISOString().slice(0, 10);
  return day >= "2005-01-01" && day <= new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10) ? day : "";
};

const DELETED = /^\[?\s*(?:removed|deleted)(?:\s+by\s+\w+)?\s*\]?(?:\s*\[?\s*(?:removed|deleted)\s*\]?)?$/i;

// Text of the post body: the markdown part between Reddit's SC_OFF/SC_ON markers when it is there, else the content
// without its "submitted by ... [link] [comments]" tail. "" for link-only bodies and for removed or deleted ones.
export const bodyText = (contentHtml) => {
  let html = String(contentHtml ?? "").slice(0, MAX_CONTENT_CHARS);
  const marked = /<!--\s*SC_OFF\s*-->([\s\S]*?)<!--\s*SC_ON\s*-->/i.exec(html);
  if (marked) html = marked[1];
  else {
    html = html.replace(/<!--[\s\S]*?-->/g, " ");
    const tail = html.search(/\bsubmitted\s+by\b/i);
    if (tail >= 0) html = html.slice(0, tail);
  }
  html = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<\s*(?:script|style)[^>]*>[\s\S]*?<\/\s*(?:script|style)\s*>/gi, " ");
  html = html.replace(/<\s*br\s*\/?>|<\/\s*(?:p|div|li|h[1-6]|blockquote|tr|pre)\s*>/gi, " ");
  let text = collapse(decodeEntities(stripTags(html)));
  text = text.replace(/\s*\[(?:link|comments)\]\s*/gi, " ").replace(/\bsubmitted by\b.*$/i, "").trim();
  text = collapse(text);
  if (!text || DELETED.test(text)) return "";
  if (/^(?:https?:\/\/\S+\s*)+$/i.test(text)) return "";
  return text;
};

// What a post without a body points at: "example.org" for a link post, "image", "video" or "gallery" for Reddit's own media,
// "" for a text post (its [link] is the post itself). The address behind "[link]" is the outbound page of a link post.
const outboundHost = (contentHtml) => {
  const match = /<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>\s*\[link\]\s*<\/a>/i.exec(String(contentHtml ?? "").slice(0, MAX_CONTENT_CHARS));
  if (!match) return "";
  try {
    const url = new URL(decodeEntities(match[1]));
    if (!/^https?:$/.test(url.protocol)) return "";
    if (/^i\.redd\.it$/i.test(url.hostname)) return "image";
    if (/^v\.redd\.it$/i.test(url.hostname)) return "video";
    if (REDDIT_HOST.test(url.hostname) && /^\/gallery\//i.test(url.pathname)) return "gallery";
    if (REDDIT_HOST.test(url.hostname) || /(?:^|\.)redd\.it$|(?:^|\.)redditmedia\.com$|(?:^|\.)redditstatic\.com$/i.test(url.hostname)) return "";
    return url.hostname.replace(/^www\./i, "").slice(0, 80);
  } catch {
    return "";
  }
};

const imageIn = (contentHtml) => /<img\s[^>]*\bsrc\s*=\s*"([^"]*)"/i.exec(String(contentHtml ?? "").slice(0, MAX_CONTENT_CHARS))?.[1] ?? "";

// -> { entries, last } or null when the text is not an Atom feed.
//   entries: [{ fullname, title, url, subreddit, author, iso, thumbnail, body, outbound }] for posts only
//   last: the fullname (t3_...) of the last post in the feed, before any filtering (the cursor for the next page)
export const parseFeed = (xml) => {
  const text = String(xml ?? "");
  if (text.length > MAX_FEED_CHARS || !/<feed[\s>]/i.test(text)) return null;
  const entries = [];
  let last = "";
  let seen = 0;
  for (const match of text.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)) {
    if (seen >= MAX_ENTRIES) break;
    seen += 1;
    const block = match[1];
    const id = collapse(plain(tag(block, "id")));
    // t3_ posts only: the feed also lists subreddits (t5_) and users (t2_)
    if (id && !/^t3_[a-z0-9]+$/i.test(id)) continue;
    const href = firstTag(block, "link")?.href ?? "";
    const url = normalizeUrl(href);
    const title = collapse(stripTags(plain(tag(block, "title"))));
    if (!url || !title) continue;
    const fullname = /^t3_[a-z0-9]+$/i.test(id) ? id.toLowerCase() : `t3_${/comments\/([a-z0-9]+)/.exec(url)?.[1] ?? ""}`;
    if (/^t3_[a-z0-9]+$/.test(fullname)) last = fullname;
    const content = plain(tag(block, "content"));
    const label = firstTag(block, "category")?.label ?? "";
    const subreddit = /^r\/([A-Za-z0-9_]+)$/.exec(collapse(label))?.[1] ?? firstTag(block, "category")?.term?.replace(/^r\//, "") ?? subredditOf(url);
    const author = /^\/?(?:u|user)\/([A-Za-z0-9_-]{1,40})$/.exec(collapse(plain(tag(tag(block, "author"), "name"))))?.[1] ?? "";
    entries.push({
      fullname,
      title,
      url,
      subreddit: /^[A-Za-z0-9_]{2,21}$/.test(subreddit ?? "") ? subreddit : subredditOf(url),
      author,
      iso: isoDay(plain(tag(block, "published"))) || isoDay(plain(tag(block, "updated"))),
      thumbnail: thumbnailOf(firstTag(block, "media:thumbnail")?.url ?? imageIn(content)),
      body: bodyText(content),
      outbound: outboundHost(content),
    });
  }
  return { entries, last };
};

// -> the engine results. options: { snippetLength, dateInSnippet, showThumbnails, excludeSubreddits: [names] }
export const shapeResults = (entries, options, source) => {
  const exclude = new Set((options.excludeSubreddits ?? []).map((name) => name.toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.url) || (entry.subreddit && exclude.has(entry.subreddit.toLowerCase()))) continue;
    seen.add(entry.url);
    const suffix = entry.subreddit ? ` : r/${entry.subreddit}` : "";
    const title = entry.title.slice(0, 300);
    const media = { image: "Image post", video: "Video post", gallery: "Gallery post" }[entry.outbound];
    const excerpt = entry.body ? cutText(entry.body, options.snippetLength) : media ?? (entry.outbound ? `Link post to ${entry.outbound}` : "");
    const meta = [options.dateInSnippet ? dayLabel(entry.iso) : "", entry.subreddit ? `r/${entry.subreddit}` : "", entry.author ? `u/${entry.author}` : ""].filter(Boolean).join(" · ");
    const snippet = meta && excerpt ? `${meta} — ${excerpt}` : meta || excerpt;
    out.push({
      title: title.endsWith(suffix) ? title : `${title}${suffix}`,
      url: entry.url,
      snippet,
      source,
      ...(options.showThumbnails && entry.thumbnail ? { thumbnail: entry.thumbnail } : {}),
      ...(!options.dateInSnippet && entry.iso ? { publishedAt: entry.iso } : {}),
    });
  }
  return out;
};
