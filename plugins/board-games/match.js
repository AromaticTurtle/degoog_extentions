// Tuning constants. Popularity is BGG's number of ratings (usersrated).
export const SUBTITLE_EXACT = 0.88;
export const EXACT_MIN_RATINGS = 200;
export const PREFIX_MIN_RATINGS = 1500;
export const SUBTITLE_MIN_RATINGS = 3000;
export const INTENT_MIN_SIMILARITY = 0.9;
export const INTENT_MIN_RATINGS = 50;
export const INTENT_LOOSE_MIN_SIMILARITY = 0.8;
export const INTENT_LOOSE_MIN_RATINGS = 300;

// A search result is only worth a details request when its title is at least this close to the query.
export const CANDIDATE_MIN_SIMILARITY = 0.8;
export const MAX_CANDIDATES = 8;

// BGG item types that are the game itself. A missing type is accepted too.
export const ACCEPTED_ITEM_TYPES = ["boardgame"];

// Words that say "this is about a board game" without being part of a title. Only trailing ones are removed.
const BOARD_WORDS = [
  "board ?games?",
  "boardgames?",
  "tabletop",
  "bgg",
  "boardgamegeek",
  "meeples?",
  "rulebook",
  "rules",
  "setup",
  "expansions?",
  "solo variant",
  "worker placement",
  "deck ?builder",
  "co-?op board",
  "card games?",
  "dice games?",
  "how to play",
  "player count",
];

// Words that mean a video game, unless the query also says "board game".
const VIDEO_WORDS = [
  "video games?",
  "gameplay",
  "steam",
  "pc",
  "ps[2-5]",
  "playstation(?: [2-5])?",
  "xbox(?: (?:one|360|series [xs]))?",
  "nintendo(?: switch(?: 2)?)?",
  "switch",
  "dlc",
  "walkthrough",
  "speedrun",
  "mods?",
  "cheats?",
  "controller",
  "console",
  "patch notes",
  "trailer",
  "system requirements",
  "fps",
];

const TRAILING = new RegExp(`(?:\\s+(?:${BOARD_WORDS.join("|")}))+\\s*$`, "i");
const BOARD_WORD = new RegExp(`(?:^|\\s)(?:${BOARD_WORDS.join("|")})(?:\\s|$)`, "i");
const VIDEO_WORD = new RegExp(`(?:^|\\s)(?:${VIDEO_WORDS.join("|")})(?:\\s|$)`, "i");

// Questions, how-tos, searches for software or addresses and similar.
const NOT_A_GAME = /^(how\s|what\s(is|are|does|do)\s|why\s|where\s(can|do|is)|when\s(did|does|is|was)|can\si|should\si|define\s|weather|recipe|price\sof|buy\s|install\s|code\s|error\s|fix\s|debug\s|www\.|https?:|[a-z0-9-]+\.(com|org|net|io|dev)\b)/i;

export const MIN_QUERY = 2;
export const MAX_QUERY = 80;
export const MAX_WORDS = 8;

export const hasBoardGameWord = (query) => BOARD_WORD.test(query);
export const hasVideoGameWord = (query) => VIDEO_WORD.test(query);

export const looksLikeATitleSearch = (query) => {
  const q = String(query ?? "").trim();
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) return false;
  if (q.split(/\s+/).length > MAX_WORDS) return false;
  if (NOT_A_GAME.test(q)) return false;
  if (/^[\d\s.,+\-*/^()=%]+$/.test(q)) return false;
  return true;
};

// A video game query ("skyrim walkthrough", "elden ring ps5") does not need a board game lookup.
export const isVideoGameQuery = (query) => hasVideoGameWord(query) && !hasBoardGameWord(query);

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

// "Gloomhaven: Jaws of the Lion" -> ["jaws of the lion"]. Lets a short query find a game by its subtitle.
export const subtitles = (title) => segments(title).slice(1).map(normalizeTitle).filter(Boolean);

// "Gloomhaven: Jaws of the Lion" -> "gloomhaven". Tells apart two series that share a subtitle.
const series = (title) => normalizeTitle(segments(title)[0]);

export const titleSimilarity = (query, title) => {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(`${q} `)) return 0.9;
  if (q.startsWith(`${t} `)) {
    // "azul 2" must not match "Azul": a trailing number or numeral names a different game.
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

export const namesOf = (game) => [game?.name, ...(Array.isArray(game?.alternates) ? game.alternates : [])].filter((name) => typeof name === "string" && name);

// The best similarity over the primary and the alternate names, and the name that gave it.
export const bestSimilarity = (term, names) => {
  let best = { sim: 0, name: "" };
  for (const name of names) {
    const sim = titleSimilarity(term, name);
    if (sim > best.sim) best = { sim, name };
  }
  return best;
};

export const popularity = (game) => Math.max(0, Number(game?.ratingCount) || 0);

export const isAcceptedType = (itemType) => {
  const type = String(itemType ?? "").trim().toLowerCase();
  return !type || ACCEPTED_ITEM_TYPES.includes(type);
};

// From a search reply (ids, names and years only): the ids worth a details request, closest title first,
// ties in BGG's order, at most MAX_CANDIDATES.
export const rankCandidates = (term, results, limit = MAX_CANDIDATES) =>
  (Array.isArray(results) ? results : [])
    .map((result, index) => ({ result, index, sim: bestSimilarity(term, namesOf(result)).sim }))
    .filter((entry) => entry.sim >= CANDIDATE_MIN_SIMILARITY)
    .sort((a, b) => b.sim - a.sim || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.result.id);

export const isConfidentMatch = (term, game, intent) => {
  const sim = bestSimilarity(term, namesOf(game)).sim;
  const rated = popularity(game);
  if (sim >= 1 && rated >= EXACT_MIN_RATINGS) return true;
  if (sim >= 0.9 && rated >= PREFIX_MIN_RATINGS) return true;
  if (sim >= SUBTITLE_EXACT && rated >= SUBTITLE_MIN_RATINGS) return true;
  if (intent && sim >= INTENT_MIN_SIMILARITY && rated >= INTENT_MIN_RATINGS) return true;
  if (intent && sim >= INTENT_LOOSE_MIN_SIMILARITY && rated >= INTENT_LOOSE_MIN_RATINGS) return true;
  return false;
};

// Several BGG entries share names (reprints, editions, promos), so take the closest title, then the most rated.
// A subtitle-only match ("origins") that fits games of different series is ambiguous, so nothing is shown
// unless the query also says it is about a board game.
export const pickGame = (term, results, intent) => {
  const candidates = (Array.isArray(results) ? results : [])
    .filter((game) => game && game.id && game.name && isAcceptedType(game.itemType) && isConfidentMatch(term, game, intent))
    .map((game) => ({ game, ...bestSimilarity(term, namesOf(game)) }))
    .sort((a, b) => b.sim - a.sim || popularity(b.game) - popularity(a.game));
  const best = candidates[0];
  if (!best) return null;
  if (!intent && best.sim === SUBTITLE_EXACT && subtitles(best.name).includes(normalizeTitle(term))) {
    const rival = candidates.some((other) => other.sim === best.sim && series(other.name) !== series(best.name));
    if (rival) return null;
  }
  return best.game;
};

export const cacheKey = (term) => normalizeTitle(term).slice(0, 120);
