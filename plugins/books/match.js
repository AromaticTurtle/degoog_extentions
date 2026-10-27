// Tuning constants. Popularity is Hardcover's users_count (readers who saved the book).
export const SUBTITLE_EXACT = 0.88;
export const EXACT_MIN_USERS = 20;
export const PREFIX_MIN_USERS = 200;
export const SUBTITLE_MIN_USERS = 1000;
export const INTENT_MIN_SIMILARITY = 0.9;
export const INTENT_MIN_USERS = 3;
export const INTENT_LOOSE_MIN_SIMILARITY = 0.8;
export const INTENT_LOOSE_MIN_USERS = 60;
// A title that only matches once its subtitle is cut off ("Dune: The Graphic Novel" for "dune") is never an exact match.
export const STRIPPED_TITLE_SIMILARITY = 0.95;

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
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "");

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

const segments = (title) => String(title ?? "").split(/\s*:\s*|\s+[-–—]\s+/);

// "Dune: The Graphic Novel" -> ["the graphic novel"]. Lets a short query find a book by its subtitle.
export const subtitles = (title) => segments(title).slice(1).map(normalizeTitle).filter(Boolean);

// "Dune: The Graphic Novel" -> "dune". Tells apart two series that share a subtitle.
const series = (title) => normalizeTitle(segments(title)[0]);

export const titleSimilarity = (query, title) => {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.startsWith(`${q} `)) return 0.9;
  if (q.startsWith(`${t} `)) {
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

export const popularity = (book) => Math.max(0, Number(book?.saved) || 0);

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
const namesOf = (book) => {
  const title = String(book?.title ?? "");
  const names = [{ name: title, cap: 1 }];
  const head = segments(title)[0].trim();
  if (head && head !== title) names.push({ name: head, cap: STRIPPED_TITLE_SIMILARITY });
  if (book?.subtitle && !normalizeTitle(title).includes(normalizeTitle(book.subtitle))) names.push({ name: `${title}: ${book.subtitle}`, cap: 1 });
  for (const alternative of Array.isArray(book?.alternatives) ? book.alternatives : []) names.push({ name: String(alternative), cap: 1 });
  return names;
};

// How well a book fits the query. skip is true for an author-only query (there is no author panel in this version).
export const scoreBook = (parsed, book) => {
  const variants = [...new Set([titlePart(parsed.term, book), parsed.title ? titlePart(parsed.title, book) : ""].filter(Boolean))];
  if (!variants.length) return { sim: 0, skip: true, name: "", variant: "" };
  let best = { sim: 0, skip: false, name: "", variant: "" };
  for (const variant of variants) {
    for (const { name, cap } of namesOf(book)) {
      const sim = Math.min(titleSimilarity(variant, name), cap);
      if (sim > best.sim) best = { sim, skip: false, name, variant };
    }
  }
  return best;
};

export const isConfident = (sim, saved, intent) => {
  if (sim >= 1 && saved >= EXACT_MIN_USERS) return true;
  if (sim >= 0.9 && saved >= PREFIX_MIN_USERS) return true;
  if (sim >= SUBTITLE_EXACT && saved >= SUBTITLE_MIN_USERS) return true;
  if (intent && sim >= INTENT_MIN_SIMILARITY && saved >= INTENT_MIN_USERS) return true;
  if (intent && sim >= INTENT_LOOSE_MIN_SIMILARITY && saved >= INTENT_LOOSE_MIN_USERS) return true;
  return false;
};

// Several Hardcover entries share names (editions, re-releases, compilations), so take the closest title, then the
// one with a release year, then the most saved. Compilations only when nothing else fits. A subtitle-only match
// ("legacy") that fits books of different series is ambiguous, so nothing is shown unless the query names a book.
export const pickBook = (parsed, books) => {
  const candidates = (Array.isArray(books) ? books : [])
    .filter((book) => book && book.id && book.title)
    .map((book) => ({ book, ...scoreBook(parsed, book) }))
    .filter((entry) => !entry.skip && isConfident(entry.sim, popularity(entry.book), parsed.intent));
  const plain = candidates.filter((entry) => !entry.book.compilation);
  const pool = (plain.length ? plain : candidates)
    .slice()
    .sort((a, b) => b.sim - a.sim || Number(b.book.year > 0) - Number(a.book.year > 0) || popularity(b.book) - popularity(a.book));
  const best = pool[0];
  if (!best) return null;
  if (!parsed.intent && best.sim === SUBTITLE_EXACT && subtitles(best.name).includes(normalizeTitle(best.variant))) {
    const rival = pool.some((other) => other.sim === best.sim && series(other.name) !== series(best.name));
    if (rival) return null;
  }
  return best.book;
};

export const cacheKey = (term) => normalizeTitle(term).slice(0, 120);
