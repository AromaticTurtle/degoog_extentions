// Tuning constants. Popularity is IGDB's rating count (see popularity()). How popular a game must be depends on how
// specific the query is (see specificity()): a long, distinctive title needs very little, a short generic word a lot.
export const SUBTITLE_EXACT = 0.88;
export const ALT_NAME_LOW_SIMILARITY = 0.85; // a short generic query matching only an alternative name
export const BARS = {
  exact: { low: 20, medium: 3, high: 1 }, // the whole title matches
  prefix: { low: 60, medium: 30, high: 10 }, // the title starts with the query (or the query adds words)
  subtitle: { low: 150, medium: 100, high: 50 }, // the query is a subtitle ("skyrim")
};
export const RANK_BONUS_FACTOR = 0.5; // the first IGDB result that matches closely needs half the popularity
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


// Words that can only mean a VIDEO game. They skip the board game lookup and keep this panel. Bare "game", "guide",
// "review", "wiki", "release date", "requirements", "trailer", "co-op" and "multiplayer" are ambiguous: board games have
// them too, so they say nothing either way. The same list is in the board-games plugin (a test keeps them in step).
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
  "patch notes",
  "system requirements",
  "controller",
  "console",
  "fps",
  "remaster(?:ed)?",
  "remake",
  "rpg",
  "roguelike",
  "soulslike",
];

// Words that can only mean a BOARD game (or tabletop game in general). Without a video-game-specific word they keep this
// panel from showing. The same list is in the board-games plugin.
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

// Trailing board game words are dropped from the term too ("skyrim board game ps5" searches "skyrim"); the query only gets
// here with a video-game-specific word, see isBoardGameQuery().
const TRAILING = new RegExp(`(?:\\s+(?:${[...TRAILING_WORDS, ...BOARD_WORDS].join("|")}))+\\s*$`, "i");
const VIDEO_WORD = new RegExp(`(?:^|\\s)(?:${VIDEO_WORDS.join("|")})(?:\\s|$)`, "i");
const BOARD_WORD = new RegExp(`(?:^|\\s)(?:${BOARD_WORDS.join("|")})(?:\\s|$)`, "i");

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
export const hasVideoGameWord = (query) => VIDEO_WORD.test(query);
export const hasBoardGameWord = (query) => BOARD_WORD.test(query);

// A board game query ("catan rules", "wingspan board game") is not a video game search, unless it also has a word that
// can only mean a video game ("wingspan board game ps5").
export const isBoardGameQuery = (query) => hasBoardGameWord(query) && !hasVideoGameWord(query);

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
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");

// Series markers, edition marks and the like at the END of a title: "Elden Ring (Deluxe Edition)", "Skyrim Special
// Edition", "Game of the Year Edition", "Title (2018)", "Title: A Novel".
const EDITION =
  "(?:special|anniversary|deluxe|collector'?s|collectors|definitive|complete|digital|enhanced|extended|ultimate|gold|standard|legendary|revised|updated|\\d+(?:st|nd|rd|th) anniversary|game of the year|goty|director'?s cut)\\s+edition";
const PAREN_TAIL = /\s*[(\[][^()[\]]*[)\]]\s*$/;
const DECORATIONS = [
  new RegExp(`\\s*[:,\\-–—]?\\s*(?:the\\s+)?${EDITION}$`, "i"),
  /\s*[:,\-–—]?\s*(?:hd\s+)?remaster(?:ed)?$/i,
];

export const stripDecorations = (text) => {
  const original = String(text ?? "").trim();
  let value = original;
  for (let i = 0; i < 4; i += 1) {
    let next = value.replace(PAREN_TAIL, "");
    for (const pattern of DECORATIONS) next = next.replace(pattern, "");
    next = next.trim();
    if (next === value) break;
    value = next;
  }
  return value || original;
};

// How distinctive a title is: "skyrim" is low, "elden ring" or "hollow knight" medium, "red dead redemption" high.
// The more distinctive, the less popularity is needed to be sure it is the game meant.
export const specificity = (term) => {
  const stripped = stripDecorations(term);
  const words = normalizeTitle(stripped).split(" ").filter(Boolean);
  const chars = words.join("").length;
  const count = words.length + (/^\s*the\s/i.test(stripped) && words.length ? 1 : 0);
  if (count >= 3 || chars >= 14) return "high";
  if (count === 2 || chars >= 8) return "medium";
  return "low";
};

const segments = (title) => String(title ?? "").split(/\s*:\s*|\s+[-–—]\s+/);

// "The Elder Scrolls V: Skyrim" -> ["skyrim"]. Lets a one-word query find a game by its subtitle.
export const subtitles = (title) => segments(title).slice(1).map(normalizeTitle).filter(Boolean);

// "The Elder Scrolls V: Skyrim" -> "elder scrolls v". Tells apart two series that share a subtitle.
const series = (title) => normalizeTitle(segments(title)[0]);

// extraWords false: the query may not simply add words to the title ("skyrim vr" is not "Skyrim"). Used for alternative names.
const plainSimilarity = (query, title, extraWords = true) => {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(`${q} `)) return 0.9;
  if (extraWords && q.startsWith(`${t} `)) {
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

// sim also counts a match that only holds once edition marks are cut off of both sides; raw is the plain match,
// used to prefer "Skyrim Special Edition" for that query over the base game.
export const titleMatch = (query, title, extraWords = true) => {
  const raw = plainSimilarity(query, title, extraWords);
  const q = stripDecorations(query);
  const t = stripDecorations(title);
  if (q === String(query ?? "").trim() && t === String(title ?? "").trim()) return { sim: raw, raw };
  return { sim: Math.max(raw, plainSimilarity(q, t, extraWords)), raw };
};

export const titleSimilarity = (query, title) => titleMatch(query, title).sim;

// IGDB has several counts of how many people rated a game. The strongest one wins, so a missing or small count never
// hides a game that another count shows to be well known.
export const popularitySignals = (game) => ({
  total: Math.max(0, Number(game?.totalRatingCount) || 0),
  users: Math.max(0, Number(game?.userCount) || 0),
  critics: Math.max(0, Number(game?.criticCount) || 0),
  combined: Math.max(0, (Number(game?.userCount) || 0) + (Number(game?.criticCount) || 0)),
});
export const popularity = (game) => Math.max(0, ...Object.values(popularitySignals(game)));

export const isAcceptedType = (gameType) => {
  const type = String(gameType ?? "").trim().toLowerCase();
  return !type || ACCEPTED_GAME_TYPES.includes(type);
};

// Every name a game answers to: its name and its alternative names. A short generic query only trusts an alternative
// name a little.
// A name with letters of another script ("Skyrim 上古卷轴") would lose them when normalised and could then match too much,
// so only names in Latin letters are compared.
const isLatinName = (name) => !/[^\u0000-\u024f\u2000-\u206f]/.test(name);

const namesOf = (game, band) => [
  { name: String(game?.name ?? ""), cap: 1, primary: true },
  ...(Array.isArray(game?.alternatives) ? game.alternatives : [])
    .map(String)
    .filter(isLatinName)
    .map((alternative) => ({ name: alternative, cap: band === "low" ? ALT_NAME_LOW_SIMILARITY : 1, primary: false })),
];

export const scoreGame = (term, game, band = specificity(term)) => {
  let best = { sim: 0, raw: 0, name: "", primary: false };
  for (const { name, cap, primary } of namesOf(game, band)) {
    const match = titleMatch(term, name, primary);
    const sim = Math.min(match.sim, cap);
    const raw = Math.min(match.raw, cap);
    if (sim > best.sim || (sim === best.sim && raw > best.raw)) best = { sim, raw, name, primary };
  }
  return best;
};

// The verdict for one candidate: accepted by which rule, or rejected because of what.
// rank is the position in IGDB's own result list: a first result that matches closely needs half the popularity.
export const judge = ({ sim, pop, intent, band, rank }) => {
  const bonus = rank === 0 && sim >= 0.9;
  const note = bonus ? " (first result)" : "";
  const scale = (need) => (bonus ? Math.ceil(need * RANK_BONUS_FACTOR) : need);
  const rules = [
    { name: "exact title", applies: sim >= 1, need: scale(BARS.exact[band]) },
    { name: "title prefix", applies: sim >= 0.9, need: scale(BARS.prefix[band]) },
    { name: "subtitle", applies: sim >= SUBTITLE_EXACT, need: scale(BARS.subtitle[band]) },
    { name: "intent", applies: intent && sim >= INTENT_MIN_SIMILARITY, need: 0 },
    { name: "intent (loose)", applies: intent && sim >= INTENT_LOOSE_MIN_SIMILARITY, need: INTENT_LOOSE_MIN_POPULARITY },
  ];
  const open = rules.filter((rule) => rule.applies);
  const hit = open.find((rule) => pop >= rule.need);
  if (hit) return { accepted: true, rule: `${hit.name}, ${band} specificity${note}`, need: hit.need, have: pop };
  if (!open.length) return { accepted: false, rule: `similarity ${sim.toFixed(2)} is too low`, need: 0, have: pop };
  const need = Math.min(...open.map((rule) => rule.need));
  return { accepted: false, rule: `needs pop>=${need}${note}, has ${pop}`, need, have: pop };
};

export const isConfidentMatch = (term, game, intent, rank = -1) => {
  const band = specificity(term);
  return judge({ sim: scoreGame(term, game, band).sim, pop: popularity(game), intent, band, rank }).accepted;
};

// Everything that decides whether a game panel shows, with the reasons. Several IGDB entries share names (mods, ports,
// re-releases), so take the closest title, then the most rated. A subtitle-only match ("origins") that fits games of
// different series is ambiguous, so nothing is shown unless the query also says it is about a game.
export const evaluate = (term, results, intent, { explain = false } = {}) => {
  const band = specificity(term);
  const rows = [];
  (Array.isArray(results) ? results : []).forEach((game, rank) => {
    if (!game || !game.id || !game.name) return;
    const score = scoreGame(term, game, band);
    const pop = popularity(game);
    const typeOk = isAcceptedType(game.gameType);
    const verdict = typeOk ? judge({ sim: score.sim, pop, intent, band, rank }) : { accepted: false, rule: `game type "${game.gameType}" is not a game of its own`, need: 0, have: pop };
    rows.push({ game, rank, score, pop, verdict });
  });
  const candidates = rows
    .filter((row) => row.verdict.accepted)
    .sort((a, b) => b.score.sim - a.score.sim || Number(b.score.primary) - Number(a.score.primary) || b.score.raw - a.score.raw || b.pop - a.pop);
  const best = candidates[0];
  const finish = (pick, how) => ({ pick: pick ?? null, how, band, rows: explain ? rows : [] });
  if (!best) return finish(null, "no candidate is confident");
  if (!intent && best.score.sim === SUBTITLE_EXACT && subtitles(best.score.name).includes(normalizeTitle(term))) {
    const rival = candidates.some((other) => other.score.sim === best.score.sim && series(other.score.name) !== series(best.score.name));
    if (rival) return finish(null, "the subtitle fits games of different series, so it is ambiguous");
  }
  return finish(best.game, `${best.score.sim >= 1 ? "exact" : "closest"} title: ${best.verdict.rule}`);
};

export const pickGame = (term, results, intent) => evaluate(term, results, intent).pick;

const oneLine = (value, max = 70) => String(value ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, max);

// The explain block of debugMatching: one header, up to six candidates with their popularity signals and the verdict,
// and the outcome. Only the query and catalog names are in it, nothing secret.
export const formatExplanation = (query, term, intent, result, source = "igdb") => {
  const lines = [`[game-info] "${oneLine(query, 100)}" term="${oneLine(term, 100)}" intent=${intent} specificity=${result.band} source=${source}`];
  for (const row of result.rows.slice(0, 6)) {
    const signals = Object.entries(popularitySignals(row.game))
      .filter(([, value]) => value > 0)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    const verdict = row.verdict.accepted ? `accepted by ${row.verdict.rule}` : `rejected: ${row.verdict.rule}`;
    lines.push(`  #${row.rank + 1} "${oneLine(row.game.name)}" sim=${row.score.sim.toFixed(2)} signals[${signals || "none"}] pop=${row.pop} -> ${verdict}`);
  }
  if (!result.rows.length) lines.push("  (no candidates)");
  lines.push(result.pick ? `  => panel: "${oneLine(result.pick.name)}" (${result.how})` : `  => no panel (${result.how})`);
  return lines.join("\n");
};

export const cacheKey = (term) => normalizeTitle(term).slice(0, 120);

// ---- A title that is both a board game and a video game ----------------------------------------------------------
// The same block is in the board-games and the game-info plugin (each keeps its own copy; a test checks they agree).
// mode is the game-info setting "whenBothMatch": "oldest" (default), "board-game", "video-game" or "both".
export const WHEN_BOTH_MODES = ["oldest", "board-game", "video-game", "both"];
export const DEFAULT_WHEN_BOTH = "oldest";
export const normalizeWhenBoth = (value) => (WHEN_BOTH_MODES.includes(value) ? value : DEFAULT_WHEN_BOTH);

// A release year: a positive whole number (a number, or a string of digits). Anything else is unknown (0).
export const validYear = (value) => {
  const year = typeof value === "number" ? value : typeof value === "string" && /^\s*\d{1,4}\s*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(year) && year > 0 && year <= 9999 ? year : 0;
};

// Which panel shows when both a board game and a video game match: "board", "video" or "both". With "oldest" the
// earlier release year wins; a tie, an unknown year or an invalid year goes to the BOARD game.
export const decideBothMatch = (input) => {
  const { mode, boardYear, videoYear } = input ?? {};
  const chosen = normalizeWhenBoth(mode);
  if (chosen === "both") return "both";
  if (chosen === "board-game") return "board";
  if (chosen === "video-game") return "video";
  const board = validYear(boardYear);
  const video = validYear(videoYear);
  return board && video && video < board ? "video" : "board";
};
