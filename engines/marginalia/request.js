export const DEFAULT_API_BASE = "https://api2.marginalia-search.com";

export const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const buildSearchUrl = (query, page, options, base = DEFAULT_API_BASE) => {
  const params = new URLSearchParams({
    query,
    count: String(options.count),
  });
  if (page > 1) params.set("page", String(page));
  if (options.maxPerDomain > 0) params.set("dc", String(options.maxPerDomain));
  if (options.reduceExplicit) params.set("nsfw", "1");
  return `${base.replace(/\/+$/, "")}/search?${params}`;
};

export const buildHeaders = (apiKey) => ({
  Accept: "application/json",
  "API-Key": apiKey,
  "User-Agent": "degoog-marginalia-engine/1.0",
});
