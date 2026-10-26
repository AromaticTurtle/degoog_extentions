import { truncate } from "./text.js";

export const decodeHtml = (value) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", raquo: "»", laquo: "«", rsaquo: "›", lsaquo: "‹", hellip: "…", ndash: "–", mdash: "—" };
      return named[body.toLowerCase()] ?? whole;
    });

const text = (html) => decodeHtml(html).replace(/\s+/g, " ").trim();

export const pageKind = (html) => {
  if (typeof html !== "string") return "unknown";
  if (/<title>\s*Captcha\s*<\/title>/i.test(html)) return "captcha";
  if (/<ul class="results-standard">/.test(html)) return "results";
  if (/No pages found matching/i.test(html)) return "empty";
  return "unknown";
};

const RESULT_ITEM = /<li class="r\d+(?:\s[^"]*)?">([\s\S]*?)<\/li>/g;
const LINK = /<a\b[^>]*\bclass="ob"[^>]*>/;
const HREF = /\bhref="([^"]*)"/;
const TITLE = /<h2>\s*<a\b[^>]*\bclass="title"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/;
const SNIPPET = /<p class="s">([\s\S]*?)<\/p>/;

export const parseResults = (html, source) => {
  const start = html.indexOf('<ul class="results-standard">');
  if (start === -1) return null;
  const end = html.indexOf("</ul>", start);
  const list = html.slice(start, end === -1 ? undefined : end);

  const seen = new Set();
  const out = [];
  for (const item of list.matchAll(RESULT_ITEM)) {
    const body = item[1];
    const link = LINK.exec(body)?.[0] ?? "";
    const url = decodeHtml(HREF.exec(link)?.[1] ?? "").trim();
    const title = truncate(text(TITLE.exec(body)?.[1]), 160);
    if (!/^https?:\/\/\S+$/i.test(url) || !title || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet: truncate(text(SNIPPET.exec(body)?.[1]), 320), source });
  }
  return out;
};

export const hasNextPage = (html) => /<li><a href="[^"]*[?&;]s=\d+[^"]*">Next<\/a><\/li>/.test(html);
