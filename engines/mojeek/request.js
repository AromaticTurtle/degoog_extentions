export const DEFAULT_BASE = "https://www.mojeek.com";
export const MAX_PAGE = 10;

const USER_AGENT = "degoog-mojeek-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
const DAY_MS = 86_400_000;
const WINDOW_DAYS = { hour: 1, day: 1, week: 7, month: 30, year: 365 };

const compactDate = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, "");

export const sinceParam = (timeFilter, context, now = Date.now()) => {
  if (timeFilter === "custom") {
    return /^\d{4}-\d{2}-\d{2}$/.test(context?.dateFrom ?? "") ? context.dateFrom.replace(/-/g, "") : "";
  }
  const days = WINDOW_DAYS[timeFilter];
  return days ? compactDate(now - days * DAY_MS) : "";
};

export const buildSearchUrl = (query, page, options = {}, base = DEFAULT_BASE) => {
  const params = new URLSearchParams({ q: query.slice(0, 500), safe: options.safeSearch ? "1" : "0" });
  if (page > 1) params.set("s", String((page - 1) * 10 + 1));
  if (options.since) params.set("since", options.since);
  return `${base.replace(/\/+$/, "")}/search?${params}`;
};

export const buildHeaders = (cookie) => {
  const headers = { Accept: "text/html", "User-Agent": USER_AGENT };
  if (cookie) headers.Cookie = cookie;
  return headers;
};

export const sessionHeaders = (extra = {}) => ({ "User-Agent": USER_AGENT, ...extra });
