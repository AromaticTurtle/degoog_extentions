export const DEFAULT_API_BASE = "https://api.core.ac.uk/v3";

const MAX_QUERY_CHARS = 1000;

export const buildSearchUrl = (query, page, options, base = DEFAULT_API_BASE) => {
  const params = new URLSearchParams({
    q: query.slice(0, MAX_QUERY_CHARS),
    limit: String(options.perPage),
    sort: "relevance",
  });
  if (page > 1) params.set("offset", String((page - 1) * options.perPage));
  return `${base.replace(/\/+$/, "")}/search/works/?${params}`;
};

export const buildHeaders = (apiKey) => ({
  Accept: "application/json",
  Authorization: `Bearer ${apiKey}`,
  "User-Agent": "degoog-core-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
});
