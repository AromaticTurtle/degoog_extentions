export const API_BASE = "https://pixabay.com/api";

// Filters degoog's Images tab can offer for this engine, and how they map to Pixabay's parameters.
export const filters = {
  layout: ["wide", "tall"],
  color: ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "gray", "black", "white", "monochrome", "transparent"],
  type: ["photo", "clipart", "lineart"],
  nsfw: ["on", "moderate", "off"],
};

const ORIENTATION = { wide: "horizontal", tall: "vertical" };
const COLOR = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  teal: "turquoise",
  blue: "blue",
  purple: "lilac",
  pink: "pink",
  brown: "brown",
  gray: "gray",
  black: "black",
  white: "white",
  monochrome: "grayscale",
  transparent: "transparent",
};
const IMAGE_TYPE = { photo: "photo", clipart: "illustration", lineart: "vector" };

export const IMAGE_TYPES = ["all", "photo", "illustration", "vector"];
export const ORIENTATIONS = ["all", "horizontal", "vertical"];
export const ORDERS = ["popular", "latest"];
const LANGUAGES = new Set(["cs", "da", "de", "en", "es", "fr", "id", "it", "hu", "nl", "no", "pl", "pt", "ro", "sk", "fi", "sv", "tr", "vi", "th", "bg", "ru", "el", "ja", "ko", "zh"]);

// "en-US" -> "en", "nb" -> "no"; "" when Pixabay does not search in that language
export const languageOf = (value) => {
  const code = String(value ?? "").trim().toLowerCase().split(/[-_]/)[0];
  const mapped = code === "nb" || code === "nn" ? "no" : code;
  return LANGUAGES.has(mapped) ? mapped : "";
};

export const MAX_QUERY_CHARS = 100; // Pixabay's limit
export const MAX_HITS = 500; // the API returns at most 500 images per query

// -> { url, cacheKey }. The key is in the url (Pixabay has no header authentication) and ONLY there: the cache key, the debug
// lines and every error message are made without it, so it never reaches a log or a cache.
export const buildRequest = (apiKey, query, page, options, base = API_BASE) => {
  const filter = options.imageFilter ?? {};
  const params = {
    q: Array.from(String(query)).slice(0, MAX_QUERY_CHARS).join(""),
    per_page: String(options.perPage),
    order: options.order,
    safesearch: options.safe ? "true" : "false",
  };
  if (page > 1) params.page = String(page);
  const imageType = IMAGE_TYPE[filter.type] ?? (IMAGE_TYPES.includes(options.imageType) ? options.imageType : "all");
  if (imageType !== "all") params.image_type = imageType;
  const orientation = ORIENTATION[filter.layout] ?? (options.orientation !== "all" ? options.orientation : "");
  if (ORIENTATIONS.includes(orientation) && orientation !== "all") params.orientation = orientation;
  if (COLOR[filter.color]) params.colors = COLOR[filter.color];
  const lang = languageOf(options.language);
  if (lang && lang !== "en") params.lang = lang;

  const sorted = Object.keys(params).sort();
  const query_string = new URLSearchParams(sorted.map((name) => [name, params[name]])).toString();
  const root = `${base.replace(/\/+$/, "")}/`;
  return {
    url: `${root}?key=${encodeURIComponent(apiKey)}&${query_string}`,
    cacheKey: `${root}?${query_string}`,
  };
};

export const buildHeaders = () => ({
  Accept: "application/json",
  "User-Agent": "degoog-pixabay-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
});

// Removes the key from any text that may mention the address (error messages of fetch implementations include it)
export const redact = (text, apiKey) => {
  let out = String(text ?? "");
  if (apiKey) {
    for (const form of new Set([apiKey, encodeURIComponent(apiKey)])) out = out.split(form).join("***");
  }
  return out.replace(/([?&]key=)[^&\s"']*/gi, "$1***");
};
