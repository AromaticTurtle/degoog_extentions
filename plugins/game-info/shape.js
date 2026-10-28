import { isAppId, isImageId } from "./request.js";

const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const names = (list, pick, limit) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => text(pick(entry), 60))
    .filter(Boolean)
    .slice(0, limit);
const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" && value !== true ? Number(value) : 0);
const score = (value) => Math.max(0, Math.round(number(value)));
const list = (value) => (Array.isArray(value) ? value : []);

const SUMMARY_LIMIT = 2000;
const STEAM_URL = /^https?:\/\/store\.steampowered\.com\/app\/(\d+)/i;
const VALID_TIERS = ["platinum", "gold", "silver", "bronze", "borked", "pending"];

// first_release_date is a unix timestamp in seconds.
export const isoDate = (seconds) => {
  const value = number(seconds);
  if (value <= 0) return "";
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const gameTypeName = (value) => (typeof value === "string" ? text(value, 60) : text(value?.type ?? value?.name, 60));

const companies = (game, role) =>
  names(
    list(game?.involved_companies).filter((entry) => entry && entry[role] === true),
    (entry) => entry?.company?.name,
    4,
  );

const platformLabel = (entry) => text(entry?.abbreviation) || text(entry?.name);

// A Steam app id is a run of digits. external_games is the better source, a Steam store link in websites the fallback.
export const steamAppIdOf = (game) => {
  for (const entry of list(game?.external_games)) {
    const source = text(entry?.external_game_source?.name ?? entry?.external_game_source, 40).toLowerCase();
    const uid = typeof entry?.uid === "number" ? String(entry.uid) : text(entry?.uid, 20);
    if (source === "steam" && /^\d+$/.test(uid) && isAppId(uid)) return uid;
  }
  for (const entry of list(game?.websites)) {
    const match = STEAM_URL.exec(text(entry?.url, 300));
    if (match && isAppId(match[1])) return match[1];
  }
  return "";
};

const officialSiteOf = (game) => {
  for (const entry of list(game?.websites)) {
    const type = text(entry?.type?.type ?? entry?.type, 40).toLowerCase();
    const url = text(entry?.url, 300);
    if (type === "official" && /^https?:\/\//i.test(url)) return url;
  }
  return "";
};

// ESRB first, then PEGI. IGDB returns the organisation and the rating category as expanded objects.
const ageRatingOf = (game) => {
  const ratings = list(game?.age_ratings)
    .map((entry) => ({ organization: text(entry?.organization?.name, 20), rating: text(entry?.rating_category?.rating, 20) }))
    .filter((entry) => entry.organization && entry.rating);
  const pick = ratings.find((entry) => entry.organization.toUpperCase() === "ESRB") ?? ratings.find((entry) => entry.organization.toUpperCase() === "PEGI");
  return pick ? `${pick.organization} ${pick.rating}` : "";
};

// Keeps only the fields the panel uses, which also keeps the cache small.
export const compactGame = (game) => ({
  id: Math.trunc(number(game?.id)),
  slug: text(game?.slug, 120),
  name: text(game?.name, 200),
  alternatives: names(game?.alternative_names, (entry) => entry?.name, 10),
  summary: text(game?.summary, SUMMARY_LIMIT),
  released: isoDate(game?.first_release_date),
  gameType: gameTypeName(game?.game_type),
  image: isImageId(game?.cover?.image_id) ? game.cover.image_id : "",
  genres: names(game?.genres, (entry) => entry?.name, 6),
  platforms: names(game?.platforms, platformLabel, 8),
  platformNames: names(game?.platforms, (entry) => entry?.name, 40),
  developers: companies(game, "developer"),
  publishers: companies(game, "publisher"),
  criticScore: score(game?.aggregated_rating),
  criticCount: Math.trunc(number(game?.aggregated_rating_count)),
  userScore: score(game?.rating),
  userCount: Math.trunc(number(game?.rating_count)),
  totalRatingCount: Math.trunc(number(game?.total_rating_count)),
  modes: names(game?.game_modes, (entry) => entry?.name, 6),
  steamAppId: steamAppIdOf(game),
  officialSite: officialSiteOf(game),
  ageRating: ageRatingOf(game),
});

const hours = (seconds) => Math.max(0, Math.round(number(seconds) / 3600));

// IGDB reports seconds. The panel shows whole hours.
export const compactTimeToBeat = (entry) => {
  const t = Array.isArray(entry) ? entry[0] : entry;
  return { hastily: hours(t?.hastily), normally: hours(t?.normally), completely: hours(t?.completely) };
};

const tierOf = (value) => (VALID_TIERS.includes(value) ? value : "");

export const compactProton = (summary) => {
  const tier = tierOf(summary?.tier);
  if (!tier) return null;
  return {
    tier,
    bestTier: tierOf(summary?.bestReportedTier),
    trendingTier: tierOf(summary?.trendingTier),
    total: Math.max(0, Math.trunc(number(summary?.total))),
    confidence: text(summary?.confidence, 20),
  };
};
