export const DEFAULT_API_BASE = "https://api.igdb.com/v4";
export const DEFAULT_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
export const DEFAULT_PROTONDB_BASE = "https://www.protondb.com";
export const DEFAULT_STEAM_BASE = "https://store.steampowered.com";
export const USER_AGENT = "degoog-game-info/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const SEARCH_LIMIT = 8;
export const MAX_TERM_LENGTH = 100;

const IMAGE_BASE = "https://images.igdb.com/igdb/image/upload";

const GAME_FIELDS = [
  "name",
  "slug",
  "summary",
  "first_release_date",
  "game_type.type",
  "version_parent",
  "parent_game",
  "cover.image_id",
  "genres.name",
  "platforms.name",
  "platforms.abbreviation",
  "involved_companies.developer",
  "involved_companies.publisher",
  "involved_companies.company.name",
  "aggregated_rating",
  "aggregated_rating_count",
  "rating",
  "rating_count",
  "total_rating",
  "total_rating_count",
  "game_modes.name",
  "external_games.uid",
  "external_games.url",
  "external_games.external_game_source.name",
  "websites.url",
  "websites.type.type",
  "alternative_names.name",
  "age_ratings.organization.name",
  "age_ratings.rating_category.rating",
].join(",");

const trimBase = (base, fallback) => String(base || fallback).replace(/\/+$/, "");

// The term ends up inside a quoted Apicalypse string, so quotes, backslashes, semicolons and control characters go.
export const sanitizeTerm = (term) =>
  String(term ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\;]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM_LENGTH)
    .trim();

export const buildSearchQuery = (term) =>
  `search "${sanitizeTerm(term)}"; fields ${GAME_FIELDS}; where version_parent = null; limit ${SEARCH_LIMIT};`;

export const buildTimeToBeatQuery = (id) =>
  `fields game_id,hastily,normally,completely,count; where game_id = ${Math.trunc(Number(id)) || 0};`;

export const igdbUrl = (base, endpoint) => `${trimBase(base, DEFAULT_API_BASE)}/${endpoint}`;

export const buildIgdbHeaders = (clientId, token) => ({
  "Client-ID": clientId,
  Authorization: `Bearer ${token}`,
  Accept: "application/json",
  "Content-Type": "text/plain",
});

// The credentials travel in the form body, never in the URL.
export const buildTokenRequest = (clientId, clientSecret, url = DEFAULT_TOKEN_URL) => ({
  url: url || DEFAULT_TOKEN_URL,
  init: {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }).toString(),
  },
});

export const pluginHeaders = () => ({ Accept: "application/json", "User-Agent": USER_AGENT });

export const isAppId = (value) => /^\d{1,10}$/.test(String(value ?? ""));
export const isImageId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value);
export const isSlug = (value) => typeof value === "string" && /^[a-z0-9-]+$/.test(value);

export const coverUrl = (imageId) => (isImageId(imageId) ? `${IMAGE_BASE}/t_cover_big_2x/${imageId}.jpg` : "");

export const igdbGamePage = (slug) => (isSlug(slug) ? `https://www.igdb.com/games/${slug}` : "");
export const steamStorePage = (appId) => (isAppId(appId) ? `https://store.steampowered.com/app/${appId}/` : "");
export const protonDbPage = (appId) => (isAppId(appId) ? `https://www.protondb.com/app/${appId}` : "");

export const protonSummaryUrl = (base, appId) =>
  isAppId(appId) ? `${trimBase(base, DEFAULT_PROTONDB_BASE)}/api/v1/reports/summaries/${appId}.json` : "";

export const steamSearchUrl = (base, name) =>
  `${trimBase(base, DEFAULT_STEAM_BASE)}/api/storesearch/?${new URLSearchParams({ term: sanitizeTerm(name), cc: "us", l: "en" })}`;

export const retryAfterMs = (header, fallbackMs = 600_000, maxMs = 3_600_000) => {
  const seconds = Number.parseInt(String(header ?? ""), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs;
  return Math.min(maxMs, seconds * 1000);
};
