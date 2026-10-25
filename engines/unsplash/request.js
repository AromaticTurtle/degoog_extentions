export const API_BASE = "https://api.unsplash.com";
export const WEB_BASE = "https://unsplash.com";

export const filters = {
  layout: ["square", "wide", "tall"],
  color: ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "black", "white"],
  nsfw: ["on", "moderate", "off"],
};

const ORIENTATION = { square: "squarish", wide: "landscape", tall: "portrait" };
const COLOR = {
  red: "red",
  orange: "orange",
  yellow: "yellow",
  green: "green",
  teal: "teal",
  blue: "blue",
  purple: "purple",
  pink: "magenta",
  black: "black",
  white: "white",
};

const MAX_QUERY_CHARS = 500;

const searchParams = (query, page, options) => {
  const params = new URLSearchParams({
    query: query.slice(0, MAX_QUERY_CHARS),
    per_page: String(options.perPage),
  });
  if (page > 1) params.set("page", String(page));
  const imageFilter = options.imageFilter ?? {};
  if (ORIENTATION[imageFilter.layout]) params.set("orientation", ORIENTATION[imageFilter.layout]);
  if (COLOR[imageFilter.color]) params.set("color", COLOR[imageFilter.color]);
  if (imageFilter.nsfw === "on") params.set("content_filter", "high");
  return params;
};

export const buildApiUrl = (query, page, options, base = API_BASE) =>
  `${base.replace(/\/+$/, "")}/search/photos?${searchParams(query, page, options)}`;

export const buildWebUrl = (query, page, options, base = WEB_BASE) =>
  `${base.replace(/\/+$/, "")}/napi/search/photos?${searchParams(query, page, options)}`;

const USER_AGENT = "degoog-unsplash-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";

export const buildApiHeaders = (accessKey) => ({
  Accept: "application/json",
  "Accept-Version": "v1",
  Authorization: `Client-ID ${accessKey}`,
  "User-Agent": USER_AGENT,
});

export const buildWebHeaders = () => ({
  Accept: "application/json",
  "User-Agent": USER_AGENT,
});
