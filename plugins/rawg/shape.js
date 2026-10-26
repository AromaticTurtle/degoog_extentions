const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const names = (list, pick, limit) =>
  (Array.isArray(list) ? list : [])
    .map((entry) => text(pick(entry), 60))
    .filter(Boolean)
    .slice(0, limit);
const number = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : 0);

const DESCRIPTION_LIMIT = 1800;

// RAWG often appends the same description in Spanish after an "Español" line. Keep the first part.
export const cleanDescription = (raw) => {
  const value = typeof raw === "string" ? raw.replace(/\r/g, "") : "";
  const cut = value.search(/\n\s*Español\s*\n/);
  return (cut >= 0 ? value.slice(0, cut) : value).replace(/\n{3,}/g, "\n\n").trim().slice(0, DESCRIPTION_LIMIT);
};

// Families (PC, PlayStation, Xbox) read better in a narrow panel; fall back to individual platforms.
const platformNames = (game) => {
  const families = names(game?.parent_platforms, (entry) => entry?.platform?.name, 8);
  return families.length ? families : names(game?.platforms, (entry) => entry?.platform?.name, 8);
};

// Keeps only the fields the panel uses, which also keeps the cache small.
export const compactSearchResult = (game) => ({
  id: number(game?.id),
  slug: text(game?.slug, 120),
  name: text(game?.name, 200),
  released: text(game?.released, 10),
  image: text(game?.background_image, 500),
  rating: number(game?.rating),
  ratingsCount: number(game?.ratings_count),
  metacritic: number(game?.metacritic),
  added: number(game?.added),
  playtime: number(game?.playtime),
  esrb: text(game?.esrb_rating?.name, 40),
  platforms: platformNames(game),
  genres: names(game?.genres, (entry) => entry?.name, 6),
  stores: names(game?.stores, (entry) => entry?.store?.name, 8),
});

export const compactDetail = (game) => ({
  description: cleanDescription(game?.description_raw),
  website: text(game?.website, 300),
  reddit: text(game?.reddit_url, 300),
  developers: names(game?.developers, (entry) => entry?.name, 4),
  publishers: names(game?.publishers, (entry) => entry?.name, 4),
  esrb: text(game?.esrb_rating?.name, 40),
  metacritic: number(game?.metacritic),
  released: text(game?.released, 10),
  playtime: number(game?.playtime),
  image: text(game?.background_image, 500),
});
