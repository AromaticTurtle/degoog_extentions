export const DEFAULT_API_URL = "https://api.hardcover.app/v1/graphql";
export const USER_AGENT = "degoog-books/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const MAX_TERM_LENGTH = 100;
export const PER_PAGE = 8;

// One top-level field, so one request against Hardcover's limits. Nested selections are free.
export const SEARCH_QUERY = `query ($q: String!) { search(query: $q, query_type: "Book", per_page: ${PER_PAGE}, page: 1) { results } }`;

export const sanitizeTerm = (term) =>
  String(term ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM_LENGTH)
    .trim();

// The token page shows a value that may already start with "Bearer ". Either way only the bare token is kept.
export const normalizeToken = (value) => {
  const token = String(value ?? "").trim().replace(/^bearer\s+/i, "");
  return /^[\x21-\x7e]+$/.test(token) && !/^bearer$/i.test(token) ? token : "";
};

// The term travels as a GraphQL variable, never spliced into the query text.
export const buildRequestBody = (term) => JSON.stringify({ query: SEARCH_QUERY, variables: { q: sanitizeTerm(term) } });

// The token is a credential. It only ever goes into this header.
export const buildHeaders = (token) => ({
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": USER_AGENT,
  authorization: `Bearer ${token}`,
});

export const isSlug = (value) => typeof value === "string" && /^[a-z0-9-]{1,200}$/.test(value);
export const bookPage = (slug) => (isSlug(slug) ? `https://hardcover.app/books/${slug}` : "");

// Covers are user uploads on Hardcover's own hosts. Anything else is dropped.
export const imageUrl = (value) => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    const onHardcover = host === "hardcover.app" || host.endsWith(".hardcover.app");
    return url.protocol === "https:" && onHardcover && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
};

export const retryAfterMs = (header, fallbackMs = 60_000, maxMs = 3_600_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};

// RateLimit: "Free";r=8;t=0, "daily";r=4231;t=51234  ->  { free: { r: 8, t: 0 }, daily: { r: 4231, t: 51234 } }
// r is what is left, t the seconds until that bucket refills. Anything else in the header is ignored.
export const parseRateLimit = (header) => {
  const buckets = {};
  for (const match of String(header ?? "").matchAll(/"([^"]{1,40})"\s*;\s*r=(\d{1,12})\s*;\s*t=(\d{1,12})/g)) {
    buckets[match[1].toLowerCase()] = { r: Number(match[2]), t: Number(match[3]) };
  }
  return buckets;
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
