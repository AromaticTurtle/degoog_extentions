import {
  BARE_CRYPTO,
  CRYPTO_NAMES,
  DOLLAR,
  FIAT_CODES,
  FIAT_NAMES,
  IRREGULAR_PLURALS,
  STARTER_CRYPTO,
  SYMBOLS,
  WORDLIKE_CRYPTO,
  WORDLIKE_FIAT,
  WORDLIKE_NAMES,
} from "./currencies.js";

// Decides whether a query asks for a currency conversion or a crypto price, and what exactly. Pure: no I/O, never throws.
//
// Ownership (see README): pure math never triggers here (the calculator takes it) and neither do non-currency units
// ("5 km to miles"). English words that are also currency codes or names ("try", "all", "won", "pound"...) only count in
// an unambiguous form: a number before them AND "to"/"in"/"into", or a "convert ..." query.

export const MAX_AMOUNT = 1e15;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+`;
const CONNECTIVE = /^(.+?)\s+(?:to|in|into|as|vs|versus|=|->)\s+(.+)$/;
const LEADING = /^(?:how\s+much\s+(?:is|are|do|does)|what(?:'s|\s+is|\s+are)|whats|convert|exchange|change|currency\s+converter|currency|calculate)\s+/;
const TRAILING = /\s+(?:exchange\s+rates?|rates?|conversion|converter|currency|today|now|right\s+now)$/;
const PRICE_OF = /^(?:(?:what\s+is\s+|what's\s+)?(?:the\s+)?(?:current\s+|latest\s+)?price\s+of\s+)(.+)$/;
const PRICE_SUFFIX = /^(.+?)\s+(?:price|value)(?:\s+(?:in|to|vs)\s+(.+))?$/;

const symbolPattern = new RegExp(`^(${[...SYMBOLS.keys()].filter((key) => key !== "zł").sort((a, b) => b.length - a.length).map((key) => key.replace(/[$.*+?^{}()|[\]\\]/g, "\\$&")).join("|")})\\s*(${AMOUNT})(?![\\d.,]*\\d)(.*)$`, "i");

const singularForms = (phrase) => {
  const forms = [phrase];
  if (IRREGULAR_PLURALS.has(phrase)) forms.push(IRREGULAR_PLURALS.get(phrase));
  if (phrase.endsWith("s")) forms.push(phrase.slice(0, -1));
  if (phrase.endsWith("es")) forms.push(phrase.slice(0, -2));
  return forms;
};

const cryptoCodeOf = (upper, known) => (STARTER_CRYPTO.has(upper) || known?.has(upper) ? upper : null);

// "eur", "euros", "canadian dollars", "€", "btc", "bitcoin" -> { code, kind, via, wordlike } or null
export const resolveCurrency = (phrase, { dollarMeans = "USD", crypto = null } = {}) => {
  const text = String(phrase ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || text.length > 40) return null;
  const symbol = SYMBOLS.get(text);
  if (symbol) {
    if (symbol === DOLLAR) return { code: dollarMeans, kind: "fiat", via: "symbol", wordlike: false };
    return symbol === "BTC" ? { code: "BTC", kind: "crypto", via: "symbol", wordlike: false } : { code: symbol, kind: "fiat", via: "symbol", wordlike: false };
  }
  if (/^[a-z]{3}$/.test(text)) {
    const upper = text.toUpperCase();
    if (FIAT_CODES.has(upper)) return { code: upper, kind: "fiat", via: "code", wordlike: WORDLIKE_FIAT.has(upper) };
  }
  for (const form of singularForms(text)) {
    const code = FIAT_NAMES.get(form);
    if (code) return { code: code === DOLLAR ? dollarMeans : code, kind: "fiat", via: "name", wordlike: WORDLIKE_NAMES.has(form) };
  }
  for (const form of singularForms(text)) {
    const code = CRYPTO_NAMES.get(form);
    if (code) return { code, kind: "crypto", via: "name", wordlike: false };
  }
  if (/^[a-z0-9]{2,8}$/.test(text)) {
    const upper = text.toUpperCase();
    const code = cryptoCodeOf(upper, crypto);
    if (code) return { code, kind: "crypto", via: "code", wordlike: WORDLIKE_CRYPTO.has(code) || code.length < 3 };
  }
  return null;
};

const parseAmount = (text) => {
  const value = Number(String(text).replace(/,/g, ""));
  return Number.isFinite(value) && value > 0 && value <= MAX_AMOUNT ? value : null;
};

// The counterpart of a lone amount: the home currency, or the first secondary one when it already is the home currency.
export const defaultTarget = (from, { homeCurrency = "USD", secondary = [] } = {}) => {
  const candidates = [homeCurrency, ...secondary, "USD", "EUR"];
  const code = candidates.find((candidate) => candidate && candidate !== from.code);
  return code ? { code, kind: "fiat", via: "home", wordlike: false } : null;
};

const reject = (reason, partial = false, text = "") => ({ parsed: null, reason, partial, text });

export const parseQuery = (query, options = {}) => {
  const { enableCrypto = true } = options;
  let text = String(query ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[?!]+$/g, "")
    .replace(/\s*(?:→|->|⇒)\s*/g, " to ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return reject("empty");
  if (text.length > 80) return reject("too long");
  if (/[a-z]+:\/\/|@|\bwww\./.test(text)) return reject("looks like a URL or address");

  let convertPrefix = false;
  for (let i = 0; i < 2; i += 1) {
    const match = LEADING.exec(text);
    if (!match) break;
    if (/^(?:convert|exchange|change|currency)/.test(match[0])) convertPrefix = true;
    text = text.slice(match[0].length);
  }
  for (let i = 0; i < 2; i += 1) {
    const stripped = text.replace(TRAILING, "");
    if (stripped === text) break;
    text = stripped;
  }
  if (!text) return reject("nothing left after the prefix");

  let amount = null;
  let left = "";
  let right = null;
  let priceWord = false;
  let rule = "";

  const pair = /^([a-z]{3})\s*\/\s*([a-z]{3})$/.exec(text);
  const symbolFirst = symbolPattern.exec(text);
  const numberFirst = new RegExp(`^(${AMOUNT})\\s*(.*)$`).exec(text);
  if (pair) {
    left = pair[1];
    right = pair[2];
    rule = "currency pair";
  } else if (symbolFirst) {
    amount = parseAmount(symbolFirst[2]);
    left = symbolFirst[1];
    const rest = symbolFirst[3].trim();
    if (rest) {
      const connective = /^(?:to|in|into|as|vs|versus|=)\s+(.+)$/.exec(rest);
      if (!connective) return reject("text after the amount is not a currency", true, text);
      right = connective[1];
    }
    rule = "symbol and amount";
  } else if (numberFirst) {
    amount = parseAmount(numberFirst[1]);
    const rest = numberFirst[2].trim();
    if (!rest) return reject("a bare number");
    const connective = CONNECTIVE.exec(rest);
    left = connective ? connective[1] : rest;
    right = connective ? connective[2] : null;
    rule = "amount first";
  } else {
    const priceOf = PRICE_OF.exec(text);
    const priceSuffix = priceOf ? null : PRICE_SUFFIX.exec(text);
    if (priceOf) {
      priceWord = true;
      const connective = CONNECTIVE.exec(priceOf[1]);
      left = connective ? connective[1] : priceOf[1];
      right = connective ? connective[2] : null;
      rule = "price of";
    } else if (priceSuffix && resolveCurrency(priceSuffix[1], options)?.kind === "crypto") {
      priceWord = true;
      left = priceSuffix[1];
      right = priceSuffix[2] ?? null;
      rule = "price suffix";
    } else {
      const connective = CONNECTIVE.exec(text);
      left = connective ? connective[1] : text;
      right = connective ? connective[2] : null;
      rule = connective ? "currency to currency" : "bare currency";
    }
  }
  if (amount === null && (symbolFirst || numberFirst) && !pair) return reject("the amount is zero, too large or unreadable", false, text);

  const from = resolveCurrency(left, options);
  if (!from) return reject("the first part is not a currency", false, text);
  let to = null;
  if (right !== null) {
    to = resolveCurrency(right, options);
    if (!to) return reject("the second part is not a currency", true, text);
  }
  if ((from.kind === "crypto" || to?.kind === "crypto") && !enableCrypto) return reject("crypto is turned off", true, text);

  const amountGiven = amount !== null;
  const connective = right !== null;
  const unambiguousForm = (amountGiven && connective) || convertPrefix;
  for (const side of [from, to]) {
    if (!side || !side.wordlike || unambiguousForm) continue;
    if (priceWord && side === from && side.via === "name") continue;
    return reject(`"${side.via === "code" ? side.code : left}" is also an ordinary word: write an amount and "to", or start with "convert"`, true, text);
  }

  if (!connective) {
    if (!amountGiven && !(from.kind === "crypto" && (BARE_CRYPTO.has(from.code) || priceWord))) return reject("a lone currency is not a conversion", true, text);
    to = defaultTarget(from, options);
    if (!to) return reject("no counterpart currency", true, text);
  }
  if (to.code === from.code) return reject("the same currency on both sides", true, text);

  return {
    parsed: { amount: amount ?? 1, amountGiven, from, to, rule, priceWord, convertPrefix, kind: from.kind === "crypto" || to.kind === "crypto" ? "crypto" : "fiat" },
    reason: rule,
    partial: true,
    text,
  };
};
