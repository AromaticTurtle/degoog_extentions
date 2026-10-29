export const API_BASE = "https://api.openverse.org/v1";

// Filters degoog's Images tab can offer for this engine, and how they map to Openverse's parameters.
export const filters = {
  layout: ["square", "wide", "tall"],
  size: ["large", "medium", "small"],
  type: ["photo", "clipart", "lineart"],
  nsfw: ["on", "moderate", "off"],
};

const ASPECT_RATIO = { square: "square", wide: "wide", tall: "tall" };
const SIZE = { large: "large", medium: "medium", small: "small" };
const CATEGORY = { photo: "photograph", clipart: "illustration", lineart: "illustration" };

export const LICENSE_TYPES = ["all", "all-cc", "commercial", "modification"];
export const CATEGORIES = ["any", "photograph", "illustration", "digitized_artwork"];
export const MAX_QUERY_CHARS = 200; // Openverse's limit

// a comma list of short lower-case words (extensions, sources): "jpg, PNG,, " -> "jpg,png"
export const listOf = (value, max = 10) => {
  const words = String(value ?? "")
    .toLowerCase()
    .split(/[\s,;]+/)
    .filter((word) => /^[a-z0-9_.-]{1,40}$/.test(word));
  return [...new Set(words)].slice(0, max).join(",");
};

// -> { url, cacheKey }. Mature results are never asked for unless the includeMature setting is on AND degoog's safe mode is off.
export const buildRequest = (query, page, options, base = API_BASE) => {
  const filter = options.imageFilter ?? {};
  const strict = ["on", "moderate"].includes(filter.nsfw);
  const params = {
    q: Array.from(String(query)).slice(0, MAX_QUERY_CHARS).join(""),
    page_size: String(options.pageSize),
    mature: options.includeMature && !strict ? "true" : "false",
  };
  if (page > 1) params.page = String(page);
  if (LICENSE_TYPES.includes(options.licenseType) && options.licenseType !== "all") params.license_type = options.licenseType;
  const category = CATEGORY[filter.type] ?? (CATEGORIES.includes(options.category) && options.category !== "any" ? options.category : "");
  if (category) params.category = category;
  if (ASPECT_RATIO[filter.layout]) params.aspect_ratio = ASPECT_RATIO[filter.layout];
  if (SIZE[filter.size]) params.size = SIZE[filter.size];
  const extension = listOf(options.extension);
  if (extension) params.extension = extension;
  const source = listOf(options.source);
  if (source) params.source = source;
  const sorted = Object.keys(params).sort();
  const queryString = new URLSearchParams(sorted.map((name) => [name, params[name]])).toString();
  const root = `${base.replace(/\/+$/, "")}/images/`;
  return { url: `${root}?${queryString}`, cacheKey: `${root}?${queryString}` };
};

export const buildHeaders = (token = "") => ({
  Accept: "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  "User-Agent": "degoog-openverse-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
});

export const tokenUrl = (base = API_BASE) => `${base.replace(/\/+$/, "")}/auth_tokens/token/`;

// The documented OAuth2 client-credentials request body
export const tokenBody = (clientId, clientSecret) => new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }).toString();

export const tokenHeaders = () => ({
  Accept: "application/json",
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "degoog-openverse-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
});

// Removes credentials from text that may mention them
export const redact = (text, secrets) => {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (!secret) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join("***");
  }
  return out.replace(/(client_secret=|access_token=|Bearer\s+)[^&\s"']*/gi, "$1***");
};
