// Tuning constants. How popular a book must be depends on how specific the query is (see specificity()):
// a long, distinctive title needs very little, a short generic word needs a lot.
export const SUBTITLE_EXACT = 0.88;
export const STRIPPED_TITLE_SIMILARITY = 0.95; // a title that only matches once its subtitle is cut off
export const ALT_TITLE_LOW_SIMILARITY = 0.85; // a short generic query matching only an alternative title
export const SERIES_SIMILARITY = 0.95; // the query is the name of the book's series

// Popularity needed per kind of match and specificity band, in "reader equivalents" (see popularityOf()).
export const BARS = {
  exact: { low: 1000, medium: 50, high: 2 }, // the whole title matches
  prefix: { low: 2000, medium: 300, high: 40 }, // the title starts with the query (or the query adds words)
  subtitle: { low: 5000, medium: 1000, high: 300 }, // the query is the subtitle
};
export const INTENT_MIN_SIMILARITY = 0.9;
export const INTENT_MIN_POPULARITY = 3;
export const INTENT_LOOSE_MIN_SIMILARITY = 0.8;
export const INTENT_LOOSE_MIN_POPULARITY = 60;

// Words that say "this is about a book" without being part of a title. Only trailing ones are removed.
const BOOK_WORDS = [
  "books?",
  "novels?",
  "authors?",
  "paperbacks?",
  "hardcovers?",
  "audiobooks?",
  "e-?books?",
  "isbn",
  "series",
  "trilogy",
  "sequels?",
  "prequels?",
  "summary",
  "synopsis",
  "chapters?",
  "reading order",
  "read",
];

// Video game and board game words: a query with one of them is about something else, unless it also says "book".
const OTHER_MEDIA_WORDS = [
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
  "board ?games?",
  "boardgames?",
  "tabletop",
  "bgg",
  "boardgamegeek",
  "meeples?",
  "rulebook",
  "card games?",
  "dice games?",
  "worker placement",
  "deck ?builder",
];

const TRAILING = new RegExp(`(?:\\s+(?:${BOOK_WORDS.join("|")}))+\\s*$`, "i");
const BOOK_WORD = new RegExp(`(?:^|\\s)(?:${BOOK_WORDS.join("|")})(?:\\s|$)`, "i");
const OTHER_MEDIA_WORD = new RegExp(`(?:^|\\s)(?:${OTHER_MEDIA_WORDS.join("|")})(?:\\s|$)`, "i");
const BY_AUTHOR = /^(.*\S)\s+by\s+(\S.*)$/i;
const BOX_SET = /\b(?:box(?:ed)?\s?set|omnibus|complete\s+(?:collection|series|saga)|bundle|collection)\b/i;

// Questions, how-tos, searches for software or addresses and similar.
const NOT_A_BOOK = /^(how\s|what\s(is|are|does|do)\s|why\s|where\s(can|do|is)|when\s(did|does|is|was)|can\si|should\si|define\s|weather|recipe|price\sof|buy\s|install\s|code\s|error\s|fix\s|debug\s|www\.|https?:|[a-z0-9-]+\.(com|org|net|io|dev)\b)/i;

export const MIN_QUERY = 2;
export const MAX_QUERY = 80;
export const MAX_WORDS = 8;

export const hasBookWord = (query) => BOOK_WORD.test(query);
export const hasOtherMediaWord = (query) => OTHER_MEDIA_WORD.test(query);

export const looksLikeATitleSearch = (query) => {
  const q = String(query ?? "").trim();
  if (q.length < MIN_QUERY || q.length > MAX_QUERY) return false;
  if (q.split(/\s+/).length > MAX_WORDS) return false;
  if (NOT_A_BOOK.test(q)) return false;
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

// Series markers, edition marks and the like at the END of a title: "Dungeon Crawler Carl (Dungeon Crawler Carl, #1)",
// "Dune: A Novel", "Wingspan (Second Edition)", "Skyrim Special Edition", "Title, Book One", "Title #1".
const EDITION =
  "(?:special|anniversary|deluxe|collector'?s|collectors|definitive|complete|digital|enhanced|extended|ultimate|gold|standard|revised|updated|second|third|fourth|2nd|3rd|4th|\\d+(?:st|nd|rd|th) anniversary|game of the year|goty|director'?s cut)\\s+edition";
const PAREN_TAIL = /\s*[(\[][^()[\]]*[)\]]\s*$/;
const DECORATIONS = [
  /\s*[:,\-–—]?\s*a novel$/i,
  // Only "book one" and "#1" are cut off: "#2" and "book two" name a different book than the bare title.
  /\s*,\s*book\s+(?:0*1|one)$/i,
  /\s+#0*1$/i,
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

// "<title> by <author>" splits on the LAST " by ". The search text is "<title> <author>", which Hardcover
// matches against author names too. intent is a book word, or a "by <author>" part.
export const parseQuery = (query) => {
  const term = extractTerm(query);
  const split = BY_AUTHOR.exec(term);
  const title = split ? split[1].trim() : "";
  const author = split ? split[2].trim() : "";
  return { term, title, author, search: split ? `${title} ${author}` : term, intent: hasBookWord(query) || Boolean(split) };
};

// Questions and other media never reach Hardcover, unless the query also says it is about a book.
export const isOtherMediaQuery = (query) => hasOtherMediaWord(query) && !hasBookWord(query);

// How distinctive a title is: "dune" is low, "wingspan" or "the road" medium, "dungeon crawler carl" high.
// The more distinctive, the less popularity is needed to be sure it is the book meant.
export const specificity = (term) => {
  const stripped = stripDecorations(term);
  const words = normalizeTitle(stripped).split(" ").filter(Boolean);
  const chars = words.join("").length;
  // normalizeTitle drops a leading "the", but "the road" is still more specific than "road".
  const count = words.length + (/^\s*the\s/i.test(stripped) && words.length ? 1 : 0);
  if (count >= 3 || chars >= 14) return "high";
  if (count === 2 || chars >= 8) return "medium";
  return "low";
};

const segments = (title) => String(title ?? "").split(/\s*:\s*|\s+[-–—]\s+/);

// "Dune: The Graphic Novel" -> ["the graphic novel"]. Lets a short query find a book by its subtitle.
export const subtitles = (title) => segments(title).slice(1).map(normalizeTitle).filter(Boolean);

// "Dune: The Graphic Novel" -> "dune". Tells apart two series that share a subtitle.
const series = (title) => normalizeTitle(segments(title)[0]);

// extraWords false: the query may not simply add words to the title ("skyrim vr" is not "Skyrim"). Used for alternative names.
const plainSimilarity = (query, title, extraWords = true) => {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(`${q} `)) return 0.9;
  if (extraWords && q.startsWith(`${t} `)) {
    // "dune 2" must not match "Dune": a trailing number or numeral names a different book.
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

// sim also counts a match that only holds once series markers and edition marks are cut off of both sides;
// raw is the plain match, used to prefer "Skyrim Special Edition" for that query over the base game.
export const titleMatch = (query, title, extraWords = true) => {
  const raw = plainSimilarity(query, title, extraWords);
  const q = stripDecorations(query);
  const t = stripDecorations(title);
  if (q === String(query ?? "").trim() && t === String(title ?? "").trim()) return { sim: raw, raw };
  return { sim: Math.max(raw, plainSimilarity(q, t, extraWords)), raw };
};

export const titleSimilarity = (query, title) => titleMatch(query, title).sim;

// Several Hardcover counts say how well known a book is. A rating or a review is rarer than a save, so each counts for
// more. The highest wins, so a missing or small count never hides a book that the others show to be popular.
export const SIGNAL_WEIGHTS = { saved: 1, read: 1, ratings: 2, lists: 2, reviews: 5 };
export const popularitySignals = (book) => ({
  saved: Math.max(0, Number(book?.saved) || 0),
  read: Math.max(0, Number(book?.readers) || 0),
  ratings: Math.max(0, Number(book?.ratingsCount) || 0),
  lists: Math.max(0, Number(book?.listsCount) || 0),
  reviews: Math.max(0, Number(book?.reviewsCount) || 0),
});
export const popularity = (book) => {
  const signals = popularitySignals(book);
  return Math.max(0, ...Object.entries(signals).map(([name, value]) => value * SIGNAL_WEIGHTS[name]));
};

const words = (text) => normalizeTitle(text).split(" ").filter(Boolean);

// The query without the words of this book's own authors: "dune herbert" -> "dune" for a book by Frank Herbert.
// Empty means the query was only the author. A dangling "by" ("dune by") goes too.
export const titlePart = (queryText, book) => {
  const owned = new Set((book?.authors ?? []).flatMap(words));
  const remaining = words(queryText).filter((word) => !owned.has(word));
  while (remaining[remaining.length - 1] === "by") remaining.pop();
  return remaining.join(" ");
};

// Every name a book answers to: its title, the title without a subtitle, title plus subtitle, alternative titles.
// A short generic query ("carl") only trusts an alternative title a little.
const namesOf = (book, band) => {
  const title = String(book?.title ?? "");
  const names = [{ name: title, cap: 1, primary: true }];
  const head = segments(title)[0].trim();
  if (head && head !== title) names.push({ name: head, cap: STRIPPED_TITLE_SIMILARITY, primary: true });
  if (book?.subtitle && !normalizeTitle(title).includes(normalizeTitle(book.subtitle))) names.push({ name: `${title}: ${book.subtitle}`, cap: 1, primary: true });
  for (const alternative of Array.isArray(book?.alternatives) ? book.alternatives : []) {
    names.push({ name: String(alternative), cap: band === "low" ? ALT_TITLE_LOW_SIMILARITY : 1, primary: false });
  }
  return names;
};

const queryVariants = (parsed, book) =>
  [...new Set([titlePart(parsed.term, book), parsed.title ? titlePart(parsed.title, book) : ""].filter(Boolean))];

// How well a book fits the query. skip is true for an author-only query (there is no author panel in this version).
export const scoreBook = (parsed, book, band = specificity(parsed.title || parsed.term)) => {
  const variants = queryVariants(parsed, book);
  if (!variants.length) return { sim: 0, raw: 0, skip: true, name: "", variant: "", primary: false };
  let best = { sim: 0, raw: 0, skip: false, name: "", variant: "", primary: false };
  for (const variant of variants) {
    for (const { name, cap, primary } of namesOf(book, band)) {
      const match = titleMatch(variant, name, primary);
      const sim = Math.min(match.sim, cap);
      const raw = Math.min(match.raw, cap);
      if (sim > best.sim || (sim === best.sim && raw > best.raw)) best = { sim, raw, skip: false, name, variant, primary };
    }
  }
  return best;
};

// The query is the name of the book's series ("dungeon crawler carl" for a book of that series).
const seriesMatches = (parsed, book) => {
  const names = [book?.seriesName, ...(Array.isArray(book?.seriesNames) ? book.seriesNames : [])].filter(Boolean).map((name) => normalizeTitle(stripDecorations(name)));
  if (!names.length) return false;
  return queryVariants(parsed, book).some((variant) => names.includes(normalizeTitle(stripDecorations(variant))));
};

// The verdict for one candidate: accepted by which rule, or rejected because of what.
// rank is the position in Hardcover's own result list: a first result that matches closely needs half the popularity.
export const RANK_BONUS_FACTOR = 0.5;
export const judge = ({ sim, pop, intent, band, rank }) => {
  const bonus = rank === 0 && sim >= 0.9;
  const note = bonus ? " (first result)" : "";
  const scale = (need) => (bonus ? Math.ceil(need * RANK_BONUS_FACTOR) : need);
  const rules = [
    { name: "exact title", applies: sim >= 1, need: scale(BARS.exact[band]) },
    { name: "title prefix", applies: sim >= 0.9, need: scale(BARS.prefix[band]) },
    { name: "subtitle", applies: sim >= SUBTITLE_EXACT, need: scale(BARS.subtitle[band]) },
    { name: "intent", applies: intent && sim >= INTENT_MIN_SIMILARITY, need: INTENT_MIN_POPULARITY },
    { name: "intent (loose)", applies: intent && sim >= INTENT_LOOSE_MIN_SIMILARITY, need: INTENT_LOOSE_MIN_POPULARITY },
  ];
  const open = rules.filter((rule) => rule.applies);
  const hit = open.find((rule) => pop >= rule.need);
  if (hit) return { accepted: true, rule: `${hit.name}, ${band} specificity${note}`, need: hit.need, have: pop };
  if (!open.length) return { accepted: false, rule: `similarity ${sim.toFixed(2)} is too low`, need: 0, have: pop };
  const need = Math.min(...open.map((rule) => rule.need));
  return { accepted: false, rule: `needs pop>=${need}${note}, has ${pop}`, need, have: pop };
};

export const isConfident = (sim, pop, intent, band = "low", rank = -1) => judge({ sim, pop, intent, band, rank }).accepted;

const isCompilation = (book) => Boolean(book?.compilation) || BOX_SET.test(String(book?.title ?? ""));
const isAudioOnly = (book) => !(book?.pages > 0) && book?.audioHours > 0;
const positionOf = (book) => (book?.seriesPosition > 0 ? book.seriesPosition : Number.POSITIVE_INFINITY);

// Everything that decides whether a book panel shows, with the reasons. Several Hardcover entries share names
// (editions, re-releases, compilations), so: an exact title wins; else the first book of the series the query names;
// else the closest title. Compilations and audiobook-only entries only when nothing else fits, and a subtitle-only
// match ("legacy") that fits books of different series is ambiguous, so nothing is shown unless the query names a book.
export const evaluate = (parsed, books, { explain = false } = {}) => {
  const band = specificity(parsed.title || parsed.term);
  const list = Array.isArray(books) ? books : [];
  const rows = [];
  list.forEach((book, rank) => {
    if (!book || !book.id || !book.title) return;
    const score = scoreBook(parsed, book, band);
    const pop = popularity(book);
    const verdict = score.skip ? { accepted: false, rule: "the query is only the author", need: 0, have: pop } : judge({ sim: score.sim, pop, intent: parsed.intent, band, rank });
    const seriesHit = !score.skip && seriesMatches(parsed, book);
    const seriesVerdict = seriesHit ? judge({ sim: SERIES_SIMILARITY, pop, intent: parsed.intent, band, rank }) : null;
    rows.push({ book, rank, score, pop, verdict, seriesVerdict });
  });

  const byQuality = (a, b) =>
    b.score.sim - a.score.sim ||
    Number(b.score.primary) - Number(a.score.primary) ||
    b.score.raw - a.score.raw ||
    Number(isAudioOnly(a.book)) - Number(isAudioOnly(b.book)) ||
    Number(b.book.year > 0) - Number(a.book.year > 0) ||
    b.pop - a.pop;

  const accepted = rows.filter((row) => row.verdict.accepted);
  const plain = accepted.filter((row) => !isCompilation(row.book));
  const pool = (plain.length ? plain : accepted).slice().sort(byQuality);
  const best = pool[0];
  const finish = (pick, how) => ({ pick: pick ?? null, how, band, rows: explain ? rows : [] });

  if (best && best.score.sim >= 1) return finish(best.book, `exact title: ${best.verdict.rule}`);

  const seriesPool = rows
    .filter((row) => row.seriesVerdict?.accepted && !isCompilation(row.book) && !isAudioOnly(row.book))
    .sort((a, b) => positionOf(a.book) - positionOf(b.book) || b.pop - a.pop);
  if (seriesPool.length) {
    const row = seriesPool[0];
    return finish(row.book, `first book of the series the query names: ${row.seriesVerdict.rule}`);
  }

  if (!best) return finish(null, "no candidate is confident");
  if (!parsed.intent && best.score.sim === SUBTITLE_EXACT && subtitles(best.score.name).includes(normalizeTitle(best.score.variant))) {
    const rival = pool.some((other) => other.score.sim === best.score.sim && series(other.score.name) !== series(best.score.name));
    if (rival) return finish(null, "the subtitle fits books of different series, so it is ambiguous");
  }
  return finish(best.book, `closest title: ${best.verdict.rule}`);
};

export const pickBook = (parsed, books) => evaluate(parsed, books).pick;

const oneLine = (value, max = 70) => String(value ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim().slice(0, max);

// The explain block of debugMatching: one header, up to six candidates with their popularity signals and the verdict,
// and the outcome. Only the query and catalog titles are in it, nothing secret.
export const formatExplanation = (query, parsed, result, source = "hardcover") => {
  const lines = [`[books] "${oneLine(query, 100)}" term="${oneLine(parsed.term, 100)}" intent=${parsed.intent} specificity=${result.band} source=${source}`];
  for (const row of result.rows.slice(0, 6)) {
    const signals = Object.entries(popularitySignals(row.book))
      .filter(([, value]) => value > 0)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    const verdict = row.verdict.accepted ? `accepted by ${row.verdict.rule}` : `rejected: ${row.verdict.rule}`;
    // The series-name rule is only worth a note on the book it actually selected.
    const bySeries = row.book === result.pick && result.how.startsWith("first book of the series") && row.seriesVerdict;
    const series = bySeries ? `; chosen as the first book of the series the query names (${row.seriesVerdict.rule})` : "";
    lines.push(`  #${row.rank + 1} "${oneLine(row.book.title)}" sim=${row.score.sim.toFixed(2)} signals[${signals || "none"}] pop=${row.pop} -> ${verdict}${series}`);
  }
  if (!result.rows.length) lines.push("  (no candidates)");
  lines.push(result.pick ? `  => panel: "${oneLine(result.pick.title)}" (${result.how})` : `  => no panel (${result.how})`);
  return lines.join("\n");
};

export const cacheKey = (term) => normalizeTitle(term).slice(0, 120);
