import { BARE_STOPLIST, NOT_FINANCIAL, REJECT_FIRST, WELL_KNOWN } from "./stoplist.js";

// Decides whether a query asks for a stock quote. Pure: no I/O, never throws.
//
// Three kinds of trigger:
//   "$AAPL"                                  the dollar sign always means "ticker"
//   explicit: "AAPL stock", "apple stock price", "stock AAPL", "AAPL quote", "tesla shares"
//   bare:     "AAPL" (a single 1-5 letter token), only when `bare` is on and the guards below pass
// The match only proposes a symbol or a company name; the slot verifies it against Finnhub (a positive quote) before a card shows.
//
// Ownership (see README): never takes currency or crypto codes without a "$", never takes pure math, never takes "stock" in a
// non-financial sense ("chicken stock", "stock photo", "stock pot", "out of stock", "stock market").

const TICKER = /^(?:[a-z]{1,5}|[a-z]{2,5}\.[a-z])$/i;
const SUFFIX = /^(.+?)\s+(?:stock\s+price|share\s+price|stock\s+quote|stock\s+value|stock\s+chart|stock|shares?|quote|ticker)(?:\s+(?:today|now|right\s+now|live|currently|current|price))*$/i;
const PREFIX = /^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?(?:current\s+|latest\s+)?(?:stock|share)(?:\s+price|\s+quote)?(?:\s+(?:of|for))?\s+(.+)$/i;
const PRICE_OF = /^(?:what(?:'s|\s+is)\s+)?(?:the\s+)?(?:current\s+|latest\s+)?(?:stock\s+|share\s+)price\s+(?:of|for)\s+(.+)$/i;
const DOLLAR = /^\$([a-z]{1,5}(?:\.[a-z])?)(?:\s+(?:stock|price|quote|stock\s+price|share\s+price))?$/i;
const LEAD_WORDS = /^(?:what(?:'s|\s+is)|should\s+i\s+buy|should\s+i\s+sell|buy|sell|current|latest|the|today's|todays)\s+/i;
const CURRENCY_OR_CRYPTO = /^(?:usd|eur|gbp|jpy|cad|aud|chf|cny|inr|mxn|brl|krw|btc|eth|xrp|doge|ltc|ada|sol|usdt|usdc|bch|xlm|dot|link|shib|uni|atom|etc|dai|trx)$/i;

const NAME = /^[\p{L}0-9&.'’ -]{1,40}$/u;

const reject = (reason) => ({ parsed: null, reason });

// The X of "X stock" -> { symbol, term, direct } or { reason }. `original` is the query as typed (its case matters).
const target = (raw, original) => {
  let text = raw.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = text.replace(LEAD_WORDS, "");
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return { reason: "no company or ticker" };
  if (!NAME.test(text)) return { reason: "the name has characters a company name does not" };
  const words = text.toLowerCase().split(" ");
  if (words.length > 4) return { reason: "too many words for a company name" };
  if (REJECT_FIRST.has(words[0])) return { reason: `"${words[0]}" starts a question or a concept, not a company` };
  const non = words.find((w) => NOT_FINANCIAL.has(w));
  if (non) return { reason: `"${non}" next to "stock" is not about shares` };
  if (words.length === 1 && TICKER.test(text)) {
    const symbol = text.toUpperCase();
    if (CURRENCY_OR_CRYPTO.test(text)) return { reason: `${symbol} is a currency or crypto code (write $${symbol} for the stock)` };
    // "AAPL stock" in capitals is a ticker for sure; "aapl stock" only when the ticker is well known
    const typed = original.split(" ").find((word) => word.toUpperCase().replace(/[^A-Z.]/g, "") === symbol) ?? "";
    const upper = typed !== "" && typed === typed.toUpperCase() && /[A-Z]/.test(typed);
    return { symbol, term: text.toLowerCase(), direct: upper || WELL_KNOWN.has(symbol) };
  }
  return { symbol: "", term: text.toLowerCase(), direct: false };
};

// -> { parsed: { kind: "dollar" | "explicit" | "bare", symbol, term, direct, rule } | null, reason }
export const parseQuery = (query, { bare = true } = {}) => {
  const raw = String(query ?? "").replace(/\s+/g, " ").trim().replace(/[?!]+$/g, "").trim();
  if (!raw) return reject("empty");
  if (raw.length > 60) return reject("too long");
  if (/[a-z]+:\/\/|@|\bwww\./i.test(raw) || /\d\s*[+*/^=]\s*\d/.test(raw)) return reject("looks like a URL or a calculation");

  const dollar = DOLLAR.exec(raw);
  if (dollar) {
    const symbol = dollar[1].toUpperCase();
    return { parsed: { kind: "dollar", symbol, term: symbol.toLowerCase(), direct: true, rule: "$TICKER" }, reason: "$ticker" };
  }

  const forms = [
    [SUFFIX, "<name> stock"],
    [PRICE_OF, "stock price of <name>"],
    [PREFIX, "stock <name>"],
  ];
  for (const [pattern, rule] of forms) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const t = target(match[1], raw);
    if (t.reason) return reject(t.reason);
    return { parsed: { kind: "explicit", symbol: t.symbol, term: t.term, direct: t.direct, rule }, reason: `explicit stock query (${rule})` };
  }

  if (TICKER.test(raw)) {
    if (!bare) return reject("bare tickers are turned off in the settings");
    const symbol = raw.toUpperCase();
    if (BARE_STOPLIST.has(symbol)) return reject(`${symbol} is a common word, an abbreviation or a currency/crypto code (write $${symbol} to force it)`);
    const upper = raw === raw.toUpperCase();
    const known = WELL_KNOWN.has(symbol);
    if (known && (symbol.length >= 3 || upper)) return { parsed: { kind: "bare", symbol, term: symbol.toLowerCase(), direct: true, rule: "well-known ticker" }, reason: "bare well-known ticker" };
    if (upper) return { parsed: { kind: "bare", symbol, term: symbol.toLowerCase(), direct: false, rule: "uppercase ticker" }, reason: "bare uppercase ticker" };
    return reject(`a lowercase word that is not a well-known ticker (type it in capitals, or write $${symbol})`);
  }
  return reject("no stock word (stock, share price, quote, $TICKER) and not a bare ticker");
};
