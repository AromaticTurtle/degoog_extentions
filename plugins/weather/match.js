// Decides whether a query asks for the weather, and where. Pure: no I/O, never throws.
//
// Ownership (see README): only queries with an explicit weather word (weather, forecast, temperature in, is it raining in...) are
// taken. Pure math, currency and dictionary questions never contain one. "weather the storm", "weather app", "weather radar",
// "sales forecast", "bad weather" and the like are left alone.

const TIME = String.raw`(?:today|tonight|tomorrow|now|right now|currently|this week|this weekend|this morning|this afternoon|this evening|next week|hourly|daily|weekly|current|(?:5|7|10|14|five|seven|ten) ?-?\s?day)`;
const TIME_AT_END = new RegExp(String.raw`(?:\s+${TIME})+$`);
const LEAD = /^(?:(?:what(?:'s|\s+is|\s+are)|how(?:'s|\s+is)|show(?:\s+me)?|tell\s+me|check|get|give\s+me|see)\s+)?(?:the\s+)?(?:current\s+|todays?\s+|today's\s+)?/;

const HOME_WORDS = new Set(["me", "near me", "nearby", "here", "my location", "my area", "home", "local", "my city", "around me", "close to me"]);

// A place made of these words is something else: "weather app", "weather radar", "sales forecast", "bad weather"...
const BLOCK = new Set([
  "app", "apps", "channel", "radar", "map", "maps", "station", "stations", "satellite", "balloon", "vane", "widget", "widgets", "api", "data", "history", "historical", "stats",
  "statistics", "network", "underground", "bug", "warning", "warnings", "alert", "alerts", "service", "forecaster", "forecasters", "model", "models", "stripping", "proof", "man",
  "girl", "report", "reports", "news", "live", "cam", "cams", "camera", "pattern", "patterns", "chart", "charts", "symbols", "icons", "emoji", "jokes", "quotes", "poem", "poems",
  "sales", "economic", "economy", "market", "markets", "stock", "stocks", "price", "prices", "revenue", "growth", "inflation", "gdp", "demand", "budget", "financial", "earnings",
  "crypto", "bitcoin", "btc", "ethereum", "eth", "fantasy", "nfl", "nba", "mlb", "nhl", "football", "baseball", "basketball", "election", "polls", "poll", "traffic", "demographic",
  "bad", "good", "severe", "space", "winter", "summer", "spring", "fall", "autumn", "cold", "hot", "hurricane", "hurricanes", "tropical", "extreme", "fair", "nice", "rainy", "stormy",
  "sunny", "wet", "dry", "inclement", "foul", "stormy", "the", "this", "that", "my", "your", "our", "a", "an", "it", "is", "are", "was", "be", "not", "to", "of", "and", "or", "for",
  "what", "how", "why", "when", "where", "who", "which", "will", "would", "can", "could", "should", "do", "does", "did", "have", "has", "if", "so", "but", "weather", "forecast",
  "temperature", "temp", "rain", "snow", "storm", "in", "at", "near", "around", "on", "by", "with", "from", "like", "define", "definition", "definitions", "meaning", "synonym",
  "synonyms", "antonym", "antonyms", "pronounce", "pronunciation", "girls", "boys", "band", "song", "lyrics", "movie", "film", "show", "tv", "game", "games", "book", "books", "wiki",
  "wikipedia", "me",
]);

const PLACE = /^[\p{L}\p{M}][\p{L}\p{M}\s.,'’-]*$/u;

const stripTime = (text) => {
  let out = text;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(TIME_AT_END, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
};

// -> { place } | { reason }. place "" with `home: true` means the home location.
const placeOf = (raw) => {
  let text = stripTime(String(raw ?? "").trim());
  text = text.replace(/^(?:the\s+)/, "").replace(/\s+/g, " ").trim();
  if (!text) return { reason: "no place" };
  if (HOME_WORDS.has(text)) return { place: "", home: true };
  if (text.length > 60) return { reason: "the place is too long" };
  if (!PLACE.test(text)) return { reason: "the place has characters a place name does not" };
  const words = text.split(" ");
  if (words.length > 5) return { reason: "the place has too many words" };
  const bad = words.map((w) => w.replace(/[.,]/g, "")).find((w) => BLOCK.has(w));
  if (bad) return { reason: `"${bad}" is not part of a place name` };
  return { place: text, home: false };
};

const WEATHER_WORD = String.raw`(?:weather(?:\s+forecast)?|forecast)`;

const rules = [
  // "is it raining in seattle", "will it snow tomorrow", "is it going to rain in x"
  [new RegExp(String.raw`^(?:is\s+it|is\s+it\s+(?:going\s+to|gonna)|will\s+it|does\s+it|will\s+there\s+be)\s+(?:rain(?:ing)?|snow(?:ing)?|storm(?:ing)?|hot|cold|warm|sunny|cloudy|windy|foggy)(?:\s+(?:in|at|near|for|around)\s+(.+))?(?:\s+${TIME})*$`), "question", 1],
  [new RegExp(String.raw`^how\s+(?:hot|cold|warm)\s+is\s+it(?:\s+(?:in|at|near|around)\s+(.+))?(?:\s+${TIME})*$`), "question", 1],
  [/^(?:current\s+)?(?:temperature|temp)\s+(?:in|at|for|near)\s+(.+)$/, "temperature", 1],
  [/^(?:what(?:'s|\s+is)\s+the\s+)?(?:current\s+)?(?:temperature|temp)\s+(?:in|at|for|near)\s+(.+)$/, "temperature", 1],
];

// -> { parsed: { place, home, bare, rule } | null, reason }
export const parseQuery = (query) => {
  let text = String(query ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[?!]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return { parsed: null, reason: "empty" };
  if (text.length > 100) return { parsed: null, reason: "too long" };
  if (/[a-z]+:\/\/|@|\bwww\./.test(text) || /[\d]\s*[+*/^=]\s*\d/.test(text)) return { parsed: null, reason: "looks like a URL or a calculation" };
  text = text.replace(LEAD, "").trim();
  text = text.replace(new RegExp(`^(?:${TIME}\\s+)+`), "").trim();

  for (const [pattern, rule] of rules) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (match[1] === undefined) return { parsed: { place: "", home: true, bare: false, rule }, reason: `weather question (${rule}), no place: home location` };
    const place = placeOf(match[1]);
    if (place.reason) return { parsed: null, reason: place.reason };
    return { parsed: { place: place.place, home: place.home, bare: false, rule }, reason: `weather question (${rule})` };
  }

  if (new RegExp(`^${WEATHER_WORD}(?:\\s+${TIME})*$`).test(text)) return { parsed: { place: "", home: true, bare: true, rule: "bare weather" }, reason: "bare weather word: home location" };

  const leading = new RegExp(`^${WEATHER_WORD}\\s+(?:like\\s+)?(?:(?:in|for|at|near|around)\\s+)?(.+)$`).exec(text);
  if (leading) {
    const place = placeOf(leading[1]);
    if (place.reason) return { parsed: null, reason: place.reason };
    return { parsed: { place: place.place, home: place.home, bare: false, rule: "weather <place>" }, reason: "weather <place>" };
  }
  const trailing = new RegExp(`^(.+?)\\s+${WEATHER_WORD}(?:\\s+${TIME})*$`).exec(text);
  if (trailing) {
    const place = placeOf(trailing[1]);
    if (place.reason) return { parsed: null, reason: place.reason };
    return { parsed: { place: place.place, home: place.home, bare: false, rule: "<place> weather" }, reason: "<place> weather" };
  }
  return { parsed: null, reason: "no weather word (weather, forecast, temperature in, is it raining in...)" };
};
