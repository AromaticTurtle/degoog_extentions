export const DEFAULT_BASE = "https://api.rawg.io/api";
export const SEARCH_PAGE_SIZE = 5;
export const USER_AGENT = "degoog-rawg-slot/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";

const trimBase = (base) => String(base || DEFAULT_BASE).replace(/\/+$/, "");

// RAWG only accepts the key as a query parameter, so these URLs are secrets.
// Callers must never log them or put them in an error message.
export const buildSearchUrl = (term, key, base = DEFAULT_BASE) => {
  const params = new URLSearchParams({
    key,
    search: String(term).slice(0, 120),
    search_precise: "true",
    page_size: String(SEARCH_PAGE_SIZE),
  });
  return `${trimBase(base)}/games?${params}`;
};

export const buildDetailUrl = (id, key, base = DEFAULT_BASE) => {
  const safeId = encodeURIComponent(String(id));
  return `${trimBase(base)}/games/${safeId}?${new URLSearchParams({ key })}`;
};

export const buildHeaders = () => ({ Accept: "application/json", "User-Agent": USER_AGENT });

export const rawgGamePage = (slug) => (slug ? `https://rawg.io/games/${encodeURIComponent(slug)}` : "");

// media.rawg.io serves originals of about 400 KB. Its crop path returns a 600x400 version of about 55 KB.
export const resizedImage = (url, width = 600, height = 400) => {
  if (typeof url !== "string") return "";
  const match = /^(https:\/\/media\.rawg\.io\/media\/)(games\/.+)$/.exec(url);
  return match ? `${match[1]}crop/${width}/${height}/${match[2]}` : url;
};

export const retryAfterMs = (header, fallbackMs = 600_000, maxMs = 3_600_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};
