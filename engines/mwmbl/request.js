export const DEFAULT_API_BASE = "https://api.mwmbl.org";

const MAX_QUERY_CHARS = 500;

export const buildSearchUrl = (query, base = DEFAULT_API_BASE) =>
  `${base.replace(/\/+$/, "")}/api/v2/search/?${new URLSearchParams({ q: query.slice(0, MAX_QUERY_CHARS) })}`;

export const buildHeaders = (apiKey) => {
  const headers = {
    Accept: "application/json",
    "User-Agent": "degoog-mwmbl-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
  };
  if (apiKey) headers["X-API-Key"] = apiKey;
  return headers;
};

export const cacheKey = (query) => query.toLowerCase().replace(/\s+/g, " ").trim();
