// Tuning constants. Popularity is IGDB's rating count (players plus critics).
export const SUBTITLE_EXACT = 0.88;
export const EXACT_MIN_POPULARITY = 5;
export const PREFIX_MIN_POPULARITY = 30;
export const SUBTITLE_MIN_POPULARITY = 150;
export const INTENT_MIN_SIMILARITY = 0.9;
export const INTENT_LOOSE_MIN_SIMILARITY = 0.8;
export const INTENT_LOOSE_MIN_POPULARITY = 20;

// IGDB game types that are the game itself. A missing type is accepted too.
export const ACCEPTED_GAME_TYPES = ["main game", "remake", "remaster", "expanded game", "port", "standalone expansion"];

// Words that say "this is about a video game" without being part of a title.
// Only trailing ones are removed, so "game dev tycoon" keeps its first word.
const TRAILING_WORDS = [
  "video games?",
  "games?",
  "gameplay",
  "steam",
  "pc",
  "ps[2-5]",
  "playstation(?: [2-5])?",
  "xbox(?: (?:one|360|series [xs]))?",
  "nintendo switch(?: 2)?",
  "walkthrough",
  "guide",
  "wiki",
  "review",
  "reviews",
  "trailer",
  "release date",
  "system requirements",
  "requirements",
  "metacritic",
  "dlc",
  "mods?",
  "cheats?",
  "speedrun",
  "patch notes",
  "multiplayer",
  "co-?op",
];

const TRAILING = new RegExp(`(?:\\s+(?:${TRAILING_WORDS.join("|")}))+\\s*$`, "i");

const GAME_WORD = new RegExp(
  `(?:^|\\s)(?:${TRAILING_WORDS.join("|")}|rpg|fps|roguelike|soulslike|indie game|remaster(?:ed)?|remake)(?:\\s|$)`,
  "i",
);

// Questions, how-tos, searches for software or addresses and similar. Same idea as the official movie slot.
const NOT_A_GAME = /^(how\s|what\s(is|are|does|do)\s|why\s|where\s(can|do|is)|when\s(did|does|is|was)|can\si|should\si|define\s|weather|recipe|price\sof|buy\s|install\s|code\s|error\s|fix\s|debug\s|www\.|https?:|[a-z0-9-]+\.(com|org|net|io|dev)\b)/i;

export const MIN_QUERY = 2;
export const MAX_QUERY = 80;
export const MAX_WORDS = 8;

export const hasGameWord = (query) => GAME_WORD.test(query);

export const looksLikeATitleSearch = (query) => {
  const q = String(query ?? "").trim();
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) return false;
  if (q.split(/\s+/).length > MAX_WORDS) return false;
  if (NOT_A_GAME.test(q)) return false;
  if (/^[\d\s.,+\-*/^()=%]+$/.test(q)) return false;
  return true;
};

export const extractTerm = (query) => String(query ?? "").trim().replace(TRAILING, "").trim();

export const normalizeTitle = (text) =>
  String(text ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\((?:19|20)\d{2}\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");

const segments = (title) => String(title ?? "").split(/\s*:\s*|\s+[-–—]\s+/);

// "The Elder Scrolls V: Skyrim" -> ["skyrim"]. Lets a one-word query find a game by its subtitle.
export const subtitles = (title) => segments(title).slice(1).map(normalizeTitle).filter(Boolean);

// "The Elder Scrolls V: Skyrim" -> "elder scrolls v". Tells apart two series that share a subtitle.
const series = (title) => normalizeTitle(segments(title)[0]);

export const titleSimilarity = (query, title) => {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(`${q} `)) return 0.9;
  if (q.startsWith(`${t} `)) {
    // "hades 2" must not match "Hades": a trailing number or numeral names a different game.
    const extra = q.slice(t.length + 1).split(" ");
    return extra.some((word) => /\d/.test(word) || /^[ivxl]+$/.test(word)) ? 0.5 : 0.9;
  }
  if (subtitles(title).includes(q)) return SUBTITLE_EXACT;
  const qWords = q.split(" ");
  const tWords = new Set(t.split(" "));
  const shared = qWords.filter((word) => tWords.has(word)).length;
  if (qWords.length >= 2 && shared === qWords.length) return 0.8;
  return shared / Math.max(qWords.length, t.split(" ").length);
};

export const popularity = (game) =>
  Number(game?.totalRatingCount) || (Number(game?.userCount) || 0) + (Number(game?.criticCount) || 0);

export const isAcceptedType = (gameType) => {
  const type = String(gameType ?? "").trim().toLowerCase();
  return !type || ACCEPTED_GAME_TYPES.includes(type);
};

export const isConfidentMatch = (term, game, intent) => {
  const sim = titleSimilarity(term, game?.name);
  const pop = popularity(game);
  if (sim >= 1 && pop >= EXACT_MIN_POPULARITY) return true;
  if (sim >= 0.9 && pop >= PREFIX_MIN_POPULARITY) return true;
  if (sim >= SUBTITLE_EXACT && pop >= SUBTITLE_MIN_POPULARITY) return true;
  if (intent && sim >= INTENT_MIN_SIMILARITY) return true;
  if (intent && sim >= INTENT_LOOSE_MIN_SIMILARITY && pop >= INTENT_LOOSE_MIN_POPULARITY) return true;
  return false;
};

// Several IGDB entries share names (mods, ports, re-releases), so take the closest title, then the most rated.
// A subtitle-only match ("origins") that fits games of different series is ambiguous, so nothing is shown
// unless the query also says it is about a game.
export const pickGame = (term, results, intent) => {
  const candidates = (Array.isArray(results) ? results : [])
    .filter((game) => game && game.id && game.name && isAcceptedType(game.gameType) && isConfidentMatch(term, game, intent))
    .map((game) => ({ game, sim: titleSimilarity(term, game.name) }))
    .sort((a, b) => b.sim - a.sim || popularity(b.game) - popularity(a.game));
  const best = candidates[0];
  if (!best) return null;
  if (!intent && best.sim === SUBTITLE_EXACT && subtitles(best.game.name).includes(normalizeTitle(term))) {
    const rival = candidates.some((other) => other.sim === best.sim && series(other.game.name) !== series(best.game.name));
    if (rival) return null;
  }
  return best.game;
};

export const cacheKey = (term) => normalizeTitle(term).slice(0, 120);
