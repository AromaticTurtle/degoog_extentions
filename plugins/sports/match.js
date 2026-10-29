import { LEAGUES } from "./leagues.js";
import { norm, resolveTeams } from "./teams.js";

// Decides whether a query asks about a game, and which teams or league. Pure: no I/O (the team snapshot is bundled), never throws.
//
// A query must carry a TEAM and a SCORE-ish word. A bare team name ("panthers", "lakers") never triggers. Score-ish forms:
//   "<team> score", "<team> game score", "<team> game|match [today|tonight|yesterday|tomorrow]", "<team> result(s)|live|final",
//   "<team> vs|v|versus|@|at <team> [score]", "did the <team> win", "who won the <team> game", "how did the <team> do",
//   "when do the <team> play", "score of the <team> game"  and  "<league> scores [today]" (nfl scores, premier league scores...)
// A phrase that does not resolve to a team in the bundled snapshot ("ram trucks score", "credit score", "high score") is no query.
//
// Ownership (see README): the dictionary owns "define score", nobody owns "credit score"; weather, stocks and the others never
// contain a team plus a score word.

const WHEN = String.raw`(?:today|tonight|yesterday|tomorrow|now|right now|live|last night|this weekend|this week|this morning)`;
const WHEN_TAIL = String.raw`(?:\s+${WHEN})*`;

// League phrases, longest first, so "college football" wins over "football"
const PHRASES = [];
for (const league of LEAGUES) for (const word of league.words) PHRASES.push([word, league.key]);
const phraseMap = new Map();
for (const [word, key] of PHRASES) phraseMap.set(word, [...(phraseMap.get(word) ?? []), key]);
const PHRASE_LIST = [...phraseMap.keys()].sort((a, b) => b.length - a.length);
const PHRASE_ALT = PHRASE_LIST.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

const LEAGUE_BOARD = [
  new RegExp(String.raw`^(?:(?:today'?s|todays|live|all|current)\s+)?(${PHRASE_ALT})\s+(?:scores?|games|scoreboard|results?)${WHEN_TAIL}$`),
  new RegExp(String.raw`^(?:scores?|games|results?)\s+(?:for|in|from)\s+(?:the\s+)?(${PHRASE_ALT})${WHEN_TAIL}$`),
  new RegExp(String.raw`^(?:scores?|games|results?)\s+(?:today\s+)?(${PHRASE_ALT})${WHEN_TAIL}$`),
];

const TEAM_FORMS = [
  [new RegExp(String.raw`^(.+?)(?:\s+game)?\s+scores?${WHEN_TAIL}$`), "<team> score"],
  [new RegExp(String.raw`^(.+?)\s+(?:game|match)${WHEN_TAIL}$`), "<team> game"],
  [new RegExp(String.raw`^(.+?)\s+(?:results?|live|final|scoreboard|live scores?)${WHEN_TAIL}$`), "<team> result"],
  [new RegExp(String.raw`^(?:what(?:'s| is)\s+the\s+)?(?:current\s+|latest\s+|live\s+|final\s+)?(?:scores?|results?)\s+(?:of|for)\s+(?:the\s+)?(.+?)(?:\s+(?:game|match))?${WHEN_TAIL}$`), "score of <team>"],
  [new RegExp(String.raw`^(?:did|do|does|will|are|is|were|was)\s+(?:the\s+)?(.+?)\s+(?:win|lose|won|lost|play|playing|winning|losing|beat|score)${WHEN_TAIL}$`), "did <team> win"],
  [new RegExp(String.raw`^who\s+(?:won|wins|is winning|is leading|leads|beat|lost)\s+(?:the\s+)?(.+?)(?:\s+(?:game|match))?${WHEN_TAIL}$`), "who won <team>"],
  [new RegExp(String.raw`^how\s+(?:did|are|is|do)\s+(?:the\s+)?(.+?)\s+(?:do|doing|play|played|look|looking)${WHEN_TAIL}$`), "how did <team> do"],
  [new RegExp(String.raw`^when\s+(?:do|does|is|are)\s+(?:the\s+)?(.+?)\s+(?:play|playing)(?:\s+(?:next|again))?${WHEN_TAIL}$`), "when do <team> play"],
  [new RegExp(String.raw`^(?:when\s+is\s+)?(?:the\s+)?next\s+(.+?)\s+game$`), "next <team> game"],
  [new RegExp(String.raw`^(?:when\s+is\s+)?(?:the\s+)?(.+?)\s+next\s+game$`), "<team> next game"],
];

const VS = new RegExp(String.raw`^(.+?)\s+(?:vs|versus|v|@|at)\s+(.+?)(?:\s+(?:scores?|game|match|result|results|live|final))*${WHEN_TAIL}$`);

const clean = (query) =>
  String(query ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b(vs|v)\.(?=\s)/g, "$1")
    .replace(/@/g, " @ ")
    .replace(/[?!,;:"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const TEAM_TEXT = /^[a-z0-9][a-z0-9 '’.&-]{0,40}$/;

// A team phrase with league words on its edges: "nfl panthers", "panthers hockey", "college football duke"
// -> { text, leagueKeys }
const splitLeagueWords = (phrase) => {
  let text = phrase.trim().replace(/^the\s+/, "");
  const keys = new Set();
  for (let i = 0; i < 2; i += 1) {
    let changed = false;
    for (const word of PHRASE_LIST) {
      if (text === word) break;
      if (text.startsWith(`${word} `)) {
        text = text.slice(word.length + 1).trim();
        for (const key of phraseMap.get(word)) keys.add(key);
        changed = true;
        break;
      }
      if (text.endsWith(` ${word}`)) {
        text = text.slice(0, -word.length - 1).trim();
        for (const key of phraseMap.get(word)) keys.add(key);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return { text, leagueKeys: [...keys] };
};

const whenOf = (query) => {
  if (/\b(?:yesterday|last night)\b/.test(query)) return "yesterday";
  if (/\btomorrow\b/.test(query)) return "tomorrow";
  return "";
};

// phrase -> { text, leagueKeys, candidates } or null (nothing resolves)
const teamFrom = (phrase) => {
  if (!phrase || !TEAM_TEXT.test(phrase)) return null;
  const { text, leagueKeys } = splitLeagueWords(phrase);
  if (!text) return null;
  const resolved = resolveTeams(text, { leagueKeys, allowLocation: leagueKeys.length > 0 });
  if (!resolved.candidates.length) return null;
  return { text, leagueKeys, candidates: resolved.candidates, filtered: resolved.filtered };
};

const reject = (reason) => ({ parsed: null, reason });

// -> { parsed: { kind: "team" | "vs" | "league", ... , when, rule } | null, reason }
export const parseQuery = (query) => {
  const q = clean(query);
  if (!q) return reject("empty");
  if (q.length > 90) return reject("too long");
  if (/[a-z]+:\/\/|\bwww\./.test(q) || /\d\s*[+*/^=]\s*\d/.test(q)) return reject("looks like a URL or a calculation");
  const when = whenOf(q);

  for (const pattern of LEAGUE_BOARD) {
    const match = pattern.exec(q);
    if (match) return { parsed: { kind: "league", leagueKeys: phraseMap.get(match[1]), word: match[1], when, rule: "<league> scores" }, reason: "league scoreboard" };
  }

  const vs = VS.exec(q);
  if (vs) {
    const a = teamFrom(vs[1]);
    const b = teamFrom(vs[2]);
    // two teams only make a game when they share a league: "lions vs tigers" is about animals, not an NFL and an MLB club
    // (a nickname that is also a college team, like "lions" or "tigers", only counts for the pro leagues)
    const anyPro = a && b && [...a.candidates, ...b.candidates].some((candidate) => candidate.league.kind === "pro");
    const meet = a && b && a.candidates.some((x) => b.candidates.some((y) => x.team.league === y.team.league && x.team.id !== y.team.id && (!anyPro || x.league.kind === "pro")));
    if (meet) return { parsed: { kind: "vs", a, b, when, rule: "<team> vs <team>" }, reason: "two teams" };
    if (a && b) return reject(`"${vs[1]}" and "${vs[2]}" are teams, but not in the same league`);
    if (!a && !b) return reject(`neither "${vs[1]}" nor "${vs[2]}" is a team in the index`);
    // one side is a team: fall through, a "<team> vs <other> score" may still be a team question
  }

  let lastReason = "no score word (score, game, match, vs, did ... win, result) with a team";
  for (const [pattern, rule] of TEAM_FORMS) {
    const match = pattern.exec(q);
    if (!match) continue;
    const team = teamFrom(match[1]);
    if (!team) {
      lastReason = `"${match[1]}" is not a team in the index`;
      continue;
    }
    return { parsed: { kind: "team", team, when, next: /next|when/.test(rule), rule }, reason: `team question (${rule})` };
  }
  return reject(lastReason);
};

export const leagueWords = () => PHRASE_LIST.slice();
export { norm };
