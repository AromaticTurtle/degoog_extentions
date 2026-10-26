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
  const qWords = q.split(" ");
  const tWords = new Set(t.split(" "));
  const shared = qWords.filter((word) => tWords.has(word)).length;
  if (qWords.length >= 2 && shared === qWords.length) return 0.8;
  return shared / Math.max(qWords.length, t.split(" ").length);
};

const popularity = (game) => Number(game?.added) || 0;

export const isConfidentMatch = (term, game, intent) => {
  const sim = titleSimilarity(term, game?.name);
  const added = popularity(game);
  if (sim >= 1 && added >= 50) return true;
  if (sim >= 0.9 && added >= 300) return true;
  if (intent && sim >= 0.9) return true;
  if (intent && sim >= 0.8 && added >= 100) return true;
  return false;
};

// Several RAWG entries share names (fan games, ports, re-releases), so take the closest title, then the most added.
export const pickGame = (term, results, intent) => {
  const candidates = (Array.isArray(results) ? results : [])
    .filter((game) => game && game.id && game.name && isConfidentMatch(term, game, intent))
    .map((game) => ({ game, sim: titleSimilarity(term, game.name) }))
    .sort((a, b) => b.sim - a.sim || popularity(b.game) - popularity(a.game));
  return candidates[0]?.game ?? null;
};

export const cacheKey = (term) => normalizeTitle(term).slice(0, 120);
