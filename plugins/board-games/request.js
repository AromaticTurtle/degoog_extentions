export const DEFAULT_API_BASE = "https://boardgamegeek.com/xmlapi2";
export const USER_AGENT = "degoog-board-games/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const MAX_THING_IDS = 8;
export const MAX_TERM_LENGTH = 100;

const trimBase = (base) => String(base || DEFAULT_API_BASE).replace(/\/+$/, "");

export const sanitizeTerm = (term) =>
  String(term ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM_LENGTH)
    .trim();

export const isId = (value) => /^\d{1,9}$/.test(String(value ?? ""));

// The token is a credential for the API. It only ever goes into the Authorization header.
export const normalizeToken = (value) => {
  const token = String(value ?? "").trim().replace(/^bearer\s+/i, "");
  return /^[\x21-\x7e]+$/.test(token) ? token : "";
};

export const buildHeaders = (token) => ({
  Accept: "application/xml",
  "User-Agent": USER_AGENT,
  Authorization: `Bearer ${token}`,
});

export const buildSearchUrl = (term, base = DEFAULT_API_BASE) =>
  `${trimBase(base)}/search?${new URLSearchParams({ query: sanitizeTerm(term), type: "boardgame" })}`;

// Digits only, unique, at most MAX_THING_IDS. Empty string when no valid id is left.
export const buildThingUrl = (ids, base = DEFAULT_API_BASE) => {
  const valid = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(isId))].slice(0, MAX_THING_IDS);
  return valid.length ? `${trimBase(base)}/thing?id=${valid.join(",")}&stats=1` : "";
};

export const bggPage = (id) => (isId(id) ? `https://boardgamegeek.com/boardgame/${id}` : "");

// Cover images live on geekdo-images.com. Anything else is dropped.
export const imageUrl = (value) => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const onGeekdo = host === "geekdo-images.com" || host.endsWith(".geekdo-images.com");
    return url.protocol === "https:" && onGeekdo && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
};

export const retryAfterMs = (header, fallbackMs = 600_000, maxMs = 3_600_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};

// Reads at most maxChars (plus one, so a longer reply can be told apart) and stops downloading after that.
export const readText = async (response, maxChars) => {
  try {
    const body = response.body;
    if (!body || typeof body.getReader !== "function") return (await response.text()).slice(0, maxChars + 1);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let out = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > maxChars) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    return out.slice(0, maxChars + 1);
  } catch {
    return "";
  }
};

// A Cloudflare challenge or any other HTML page where XML was expected.
export const looksBlocked = (text) => /^\s*<!doctype html|^\s*<html[\s>]/i.test(text) || /just a moment/i.test(text.slice(0, 3000));
