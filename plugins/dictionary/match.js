// Decides whether a query is an explicit dictionary question, and for which word. Pure: no I/O, never throws.
//
// Ownership (see README): the dictionary only answers when the query has an explicit dictionary word (define, definition,
// meaning, synonym, antonym, pronounce...). A bare word never triggers.

export const MAX_WORD_CHARS = 40;
export const MAX_WORDS = 3;

const WORD = String.raw`[a-z][a-z'’-]*`;
const TERM = String.raw`(${WORD}(?:\s+${WORD}){0,${MAX_WORDS - 1}})`;
const STOP = new Set(["the", "a", "an", "this", "that", "it", "of", "in", "to", "for", "is", "what", "and", "or", "on", "at", "by", "my", "your", "word", "words", "term", "meaning", "definition", "definitions", "synonym", "synonyms", "antonym", "antonyms", "pronunciation", "dictionary"]);

const rules = [
  // intent "define"
  [new RegExp(`^define\\s*:?\\s+${TERM}$`), "define"],
  [new RegExp(`^definitions?\\s+(?:of|for)\\s+${TERM}$`), "define"],
  [new RegExp(`^what(?:'s|\\s+is|\\s+are)\\s+the\\s+(?:definition|meaning|definitions)\\s+(?:of|for)\\s+${TERM}$`), "define"],
  [new RegExp(`^(?:the\\s+)?meanings?\\s+of\\s+${TERM}$`), "define"],
  [new RegExp(`^what\\s+does\\s+${TERM}\\s+mean$`), "define"],
  [new RegExp(`^what\\s+do\\s+${TERM}\\s+mean$`), "define"],
  [new RegExp(`^${TERM}\\s+(?:word\\s+)?(?:definitions?|meanings?)$`), "define"],
  [new RegExp(`^${TERM}\\s+dictionary$`), "define"],
  [new RegExp(`^dictionary\\s+${TERM}$`), "define"],
  // intent "synonyms" / "antonyms"
  [new RegExp(`^(?:synonyms?|words?\\s+like)\\s+(?:for|of)\\s+${TERM}$`), "synonyms"],
  [new RegExp(`^${TERM}\\s+synonyms?$`), "synonyms"],
  [new RegExp(`^antonyms?\\s+(?:for|of)\\s+${TERM}$`), "antonyms"],
  [new RegExp(`^${TERM}\\s+antonyms?$`), "antonyms"],
  [new RegExp(`^opposite\\s+of\\s+${TERM}$`), "antonyms"],
  // intent "pronunciation"
  [new RegExp(`^how\\s+(?:to|do\\s+you|do\\s+i)\\s+pronounce\\s+${TERM}$`), "pronunciation"],
  [new RegExp(`^pronounce\\s+${TERM}$`), "pronunciation"],
  [new RegExp(`^${TERM}\\s+pronunciation$`), "pronunciation"],
  [new RegExp(`^pronunciation\\s+(?:of|for)\\s+${TERM}$`), "pronunciation"],
];

const clean = (query) =>
  String(query ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/["“”]/g, "")
    .replace(/[?!.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

// -> { parsed: { word, intent, rule } | null, reason }
export const parseQuery = (query) => {
  const text = clean(query);
  if (!text) return { parsed: null, reason: "empty" };
  if (text.length > 80) return { parsed: null, reason: "too long" };
  if (/[a-z]+:\/\/|@|\bwww\./.test(text)) return { parsed: null, reason: "looks like a URL or address" };
  let matched = false;
  for (const [pattern, intent] of rules) {
    const match = pattern.exec(text);
    if (!match) continue;
    matched = true;
    const word = match[1]
      .replace(/^[-'’]+|[-'’]+$/g, "")
      .replace(/^(?:the\s+)?(?:word|term|phrase)\s+/, "")
      .replace(/^the\s+(?=\S+\s)/, "")
      .trim();
    const words = word.split(" ");
    if (!word || word.length > MAX_WORD_CHARS) return { parsed: null, reason: "the word is too long" };
    if (words.every((w) => STOP.has(w))) continue;
    if (STOP.has(words[0]) && words.length === 1) continue;
    return { parsed: { word, intent, rule: pattern.source.slice(0, 40) }, reason: `dictionary question (${intent})` };
  }
  return { parsed: null, reason: matched ? "the word is only a stop word" : "no dictionary word (define, definition, meaning, synonym, antonym, pronounce...) with a word" };
};

// One simple fallback form for a word the dictionary does not know: a plural or an inflected verb form. null when none applies.
export const lemmaOf = (word) => {
  const w = String(word ?? "").toLowerCase();
  if (!/^[a-z]{4,40}$/.test(w)) return null;
  const vowel = /[aeiou]/;
  const undouble = (base) => (/([^aeiou])\1$/.test(base) && !/(ll|ss|ff|zz)$/.test(base) ? base.slice(0, -1) : base);
  // a short consonant-vowel-consonant stem lost its final "e": mak(ing) -> make, lik(ed) -> like
  const restoreE = (base) => (/^[^aeiou]*[aeiou][^aeiouwxy]$/.test(base) && base.length <= 4 ? `${base}e` : base);
  let out = null;
  if (/ies$/.test(w) && w.length > 4) out = `${w.slice(0, -3)}y`;
  else if (/ied$/.test(w) && w.length > 4) out = `${w.slice(0, -3)}y`;
  else if (/(sses|xes|ches|shes|zzes)$/.test(w)) out = w.slice(0, -2);
  else if (/ing$/.test(w) && w.length > 5 && vowel.test(w.slice(0, -3))) {
    const base = w.slice(0, -3);
    out = undouble(base) === base ? restoreE(base) : undouble(base);
  } else if (/ed$/.test(w) && w.length > 4 && vowel.test(w.slice(0, -2))) {
    const base = w.slice(0, -2);
    out = undouble(base) === base ? restoreE(base) : undouble(base);
  } else if (/oes$/.test(w)) out = w.slice(0, -2);
  else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) out = w.slice(0, -1);
  return out && out !== w && out.length >= 2 ? out : null;
};
