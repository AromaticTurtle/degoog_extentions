// The whole behaviour of the Reddit lens as pure functions: what becomes of a query typed into degoog.

export const SITE = "reddit.com";
export const MAX_QUERY_CHARS = 300;
export const MAX_TRIGGER_WORDS = 5;
// A trailing "reddit" after a question word is a question about the word when little else is said: "who owns reddit".
export const QUESTION_MAX_WORDS = 4;

export const DEFAULT_OPTIONS = Object.freeze({
  triggerWords: ["reddit"],
  position: "either",
  enableBang: true,
  alsoTrigger: true,
  skipQuestions: true,
  showNotice: true,
});

export const POSITIONS = ["first", "last", "either"];

const BANG = /^!(?:reddit|rl)$/i;
const SUBREDDIT = /^\/?r\/([A-Za-z0-9_]{2,21})\/?$/;
const OPERATOR = /(^|\s)-?(?:site|inurl|url):/i;
// Questions about the word itself: "what is reddit", "who owns reddit", "how does reddit work"
const QUESTION_START = new Set(["what", "whats", "who", "whom", "whose", "why", "when", "where", "which", "how", "is", "are", "was", "were", "does", "do", "did", "can", "could", "should", "would", "will", "define", "explain", "tell"]);
const STOP = new Set([...QUESTION_START, "a", "an", "the", "of", "to", "in", "on", "it", "this", "that", "about", "me", "i", "my", "s", "and", "or", "for"]);

// "reddit, Subreddit" -> ["reddit", "subreddit"]; letters and digits only, at most 5; empty means the default.
export const parseWords = (text) => {
  const out = [];
  for (const part of String(text ?? "").split(/[\s,;]+/)) {
    const word = part.toLowerCase();
    if (/^[a-z0-9]{2,20}$/.test(word) && !out.includes(word)) out.push(word);
    if (out.length >= MAX_TRIGGER_WORDS) break;
  }
  return out.length ? out : [...DEFAULT_OPTIONS.triggerWords];
};

const truthy = (value, fallback) => (value === undefined || value === null || value === "" ? fallback : value === true || value === "true");

// Settings as degoog hands them over (strings or booleans) -> clean options.
export const optionsFrom = (settings = {}) => ({
  triggerWords: parseWords(settings.triggerWords),
  position: POSITIONS.includes(settings.position) ? settings.position : DEFAULT_OPTIONS.position,
  enableBang: truthy(settings.enableBang, DEFAULT_OPTIONS.enableBang),
  alsoTrigger: truthy(settings.alsoTrigger, DEFAULT_OPTIONS.alsoTrigger),
  skipQuestions: truthy(settings.skipQuestions, DEFAULT_OPTIONS.skipQuestions),
  showNotice: truthy(settings.showNotice, DEFAULT_OPTIONS.showNotice),
});

const isUrlLike = (text) => /^(?:https?:|ftp:|www\.)/i.test(text) || /:\/\//.test(text) || /^[^\s/]+\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(text);

// A query that is only quoted phrases is an exact-phrase search: left alone.
const isQuotedOnly = (text) => /^(?:"[^"]*"\s*)+$/.test(text) || /^(?:'[^']*'\s*)+$/.test(text);

const subredditToken = (token) => SUBREDDIT.exec(token)?.[1] ?? "";

const unchanged = (query) => ({ query, changed: false, via: "", subreddit: "" });

// The text with `r/<name>` taken out when it is the first or the last word, and that name.
const takeSubreddit = (tokens) => {
  const first = subredditToken(tokens[0] ?? "");
  if (first && tokens.length > 1) return { tokens: tokens.slice(1), subreddit: first };
  const last = subredditToken(tokens.at(-1) ?? "");
  if (last && tokens.length > 1) return { tokens: tokens.slice(0, -1), subreddit: last };
  return { tokens, subreddit: "" };
};

const finish = (tokens, subreddit, via) => ({
  query: `${tokens.join(" ")} site:${SITE}${subreddit ? `/r/${subreddit}` : ""}`,
  changed: true,
  via,
  subreddit,
});

// -> { query, changed, via: "word" | "bang" | "subreddit" | "", subreddit }
//   "best homelab os reddit", "reddit best homelab os"  ->  "best homelab os site:reddit.com"
//   "!reddit best homelab os", "!rl best homelab os"     ->  "best homelab os site:reddit.com"
//   "r/homelab best os"                                  ->  "best os site:reddit.com/r/homelab"
// Never for: a query that already has site:/inurl:, a URL, only quoted phrases, only the word, a question about the word
// itself ("what is reddit"), or a word that is not the first or last one.
export const rewriteQuery = (query, options = DEFAULT_OPTIONS) => {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const text = String(query ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_QUERY_CHARS) return unchanged(String(query ?? ""));
  if (OPERATOR.test(text) || isUrlLike(text) || isQuotedOnly(text)) return unchanged(text === String(query ?? "") ? text : String(query ?? ""));
  const original = String(query ?? "");
  const tokens = text.split(" ");
  const words = new Set(opts.triggerWords.map((word) => word.toLowerCase()));
  const isWord = (token) => words.has(token.toLowerCase());

  let rest = tokens;
  let via = "";
  if (opts.enableBang && BANG.test(tokens[0])) {
    rest = tokens.slice(1);
    via = "bang";
  } else {
    const lead = opts.position !== "last" && isWord(tokens[0]);
    const tail = opts.position !== "first" && tokens.length > 1 && isWord(tokens.at(-1));
    if (lead || tail) {
      rest = tokens.slice(lead ? 1 : 0, tail ? -1 : undefined);
      // "what is reddit": a question about the word, not a request for Reddit pages
      const questionAboutIt = tail && !lead && opts.skipQuestions && rest.length <= QUESTION_MAX_WORDS && QUESTION_START.has(tokens[0].toLowerCase().replace(/'s$/, ""));
      if (questionAboutIt) return unchanged(original);
      via = "word";
    }
  }
  // nothing but stop words is left ("reddit", "what is reddit", "the reddit"): not a search for Reddit pages
  if (via && rest.every((token) => STOP.has(token.toLowerCase().replace(/[^a-z']/g, "")) || !token)) return unchanged(original);
  if (!via && !opts.alsoTrigger) return unchanged(original);
  // only a subreddit is left ("reddit r/homelab"): nothing to search for
  if (via && rest.length === 1 && subredditToken(rest[0])) return unchanged(original);

  if (opts.alsoTrigger || via) {
    const { tokens: without, subreddit } = opts.alsoTrigger ? takeSubreddit(rest) : { tokens: rest, subreddit: "" };
    if (subreddit) return finish(without, subreddit, via || "subreddit");
  }
  if (!via) return unchanged(original);
  if (!rest.length) return unchanged(original);
  return finish(rest, "", via);
};

// The query of the !reddit command: it was asked for explicitly, so only the subreddit form is looked at.
export const commandQuery = (args, options = DEFAULT_OPTIONS) => {
  const text = String(args ?? "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX_QUERY_CHARS) return "";
  const tokens = text.split(" ");
  if (OPERATOR.test(tokens.join(" "))) return tokens.join(" ");
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const { tokens: without, subreddit } = opts.alsoTrigger ? takeSubreddit(tokens) : { tokens, subreddit: "" };
  return finish(without, subreddit, "bang").query;
};
