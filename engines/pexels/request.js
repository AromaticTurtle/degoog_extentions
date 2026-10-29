export const API_BASE = "https://api.pexels.com/v1";

// Filters degoog's Images tab can offer for this engine, and how they map to Pexels' parameters.
export const filters = {
  layout: ["square", "wide", "tall"],
  color: ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "brown", "gray", "black", "white"],
  size: ["large", "medium", "small"],
};

const ORIENTATION = { square: "square", wide: "landscape", tall: "portrait" };
const COLOR = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  teal: "turquoise",
  blue: "blue",
  purple: "violet",
  pink: "pink",
  brown: "brown",
  gray: "gray",
  black: "black",
  white: "white",
};
const SIZE = { large: "large", medium: "medium", small: "small" };

export const ORIENTATIONS = ["any", "landscape", "portrait", "square"];
export const SIZES = ["any", "large", "medium", "small"];
export const FULL_SIZES = ["large", "large2x", "original"];

const LOCALES = {
  en: "en-US", pt: "pt-BR", es: "es-ES", ca: "ca-ES", de: "de-DE", it: "it-IT", fr: "fr-FR", sv: "sv-SE", id: "id-ID", pl: "pl-PL", ja: "ja-JP",
  zh: "zh-CN", ko: "ko-KR", th: "th-TH", nl: "nl-NL", hu: "hu-HU", vi: "vi-VN", cs: "cs-CZ", da: "da-DK", fi: "fi-FI", uk: "uk-UA", el: "el-GR",
  ro: "ro-RO", nb: "nb-NO", no: "nb-NO", nn: "nb-NO", sk: "sk-SK", tr: "tr-TR", ru: "ru-RU",
};
const SUPPORTED_LOCALES = new Set(Object.values(LOCALES).concat(["zh-TW"]));

// "de" / "de-AT" / "de-DE" -> "de-DE"; "" when Pexels does not support the language
export const localeOf = (value) => {
  const text = String(value ?? "").trim();
  if (SUPPORTED_LOCALES.has(text)) return text;
  const code = text.toLowerCase().split(/[-_]/)[0];
  return LOCALES[code] ?? "";
};

export const MAX_QUERY_CHARS = 500;

// -> { url, cacheKey }. There is no credential in either: the key travels in the Authorization header only.
export const buildRequest = (query, page, options, base = API_BASE) => {
  const filter = options.imageFilter ?? {};
  const params = { query: Array.from(String(query)).slice(0, MAX_QUERY_CHARS).join(""), per_page: String(options.perPage) };
  if (page > 1) params.page = String(page);
  const orientation = ORIENTATION[filter.layout] ?? (ORIENTATIONS.includes(options.orientation) && options.orientation !== "any" ? options.orientation : "");
  if (orientation) params.orientation = orientation;
  const size = SIZE[filter.size] ?? (SIZES.includes(options.size) && options.size !== "any" ? options.size : "");
  if (size) params.size = size;
  if (COLOR[filter.color]) params.color = COLOR[filter.color];
  const locale = localeOf(options.locale);
  if (locale) params.locale = locale;
  const sorted = Object.keys(params).sort();
  const queryString = new URLSearchParams(sorted.map((name) => [name, params[name]])).toString();
  const root = `${base.replace(/\/+$/, "")}/search`;
  return { url: `${root}?${queryString}`, cacheKey: `${root}?${queryString}` };
};

// The key is sent exactly as Pexels documents it: the bare key in an Authorization header (no "Bearer")
export const buildHeaders = (apiKey) => ({
  Accept: "application/json",
  Authorization: apiKey,
  "User-Agent": "degoog-pexels-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)",
});
