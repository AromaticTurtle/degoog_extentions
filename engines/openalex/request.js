export const DEFAULT_API_BASE = "https://api.openalex.org";

const SELECT = [
  "id",
  "doi",
  "title",
  "display_name",
  "publication_year",
  "publication_date",
  "cited_by_count",
  "authorships",
  "primary_location",
  "open_access",
  "abstract_inverted_index",
].join(",");

const DAY_MS = 86_400_000;
const MAX_QUERY_CHARS = 1000;
const WINDOW_DAYS = { hour: 1, day: 1, week: 7, month: 30, year: 365 };

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

export const dateFilters = (timeFilter, context, now = Date.now()) => {
  if (timeFilter === "custom") {
    const out = [];
    if (context?.dateFrom) out.push(`from_publication_date:${context.dateFrom}`);
    if (context?.dateTo) out.push(`to_publication_date:${context.dateTo}`);
    return out;
  }
  const days = WINDOW_DAYS[timeFilter];
  return days ? [`from_publication_date:${isoDate(now - days * DAY_MS)}`] : [];
};

export const buildSearchUrl = (query, page, options, base = DEFAULT_API_BASE) => {
  const params = new URLSearchParams({
    search: query.slice(0, MAX_QUERY_CHARS),
    per_page: String(options.perPage),
    select: SELECT,
  });
  if (page > 1) params.set("page", String(page));
  const filters = [];
  if (options.openAccessOnly) filters.push("is_oa:true");
  if (/^[a-z]{2}$/i.test(options.language ?? "")) filters.push(`language:${options.language.toLowerCase()}`);
  filters.push(...(options.dateFilters ?? []));
  if (filters.length > 0) params.set("filter", filters.join(","));
  return `${base.replace(/\/+$/, "")}/works?${params}`;
};

export const buildHeaders = (apiKey) => {
  const headers = {
    Accept: "application/json",
    "User-Agent": "degoog-openalex-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
};
