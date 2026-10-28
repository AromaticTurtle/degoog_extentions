import { evaluate, normalise, parseExpression, MAX_EXPRESSION_CHARS } from "./expr.js";
import { convertValue, findUnit, relatedUnits } from "./units.js";

// Decides whether a query is a calculation, and computes it. Pure: no I/O, never throws.
//
// Ownership (see README): this plugin never takes currency codes or names ("100 usd to eur" belongs to the currency plugin)
// and never takes ordinary text. A query must contain an operator, function, percent form, constant with an operator,
// or be a "<number> <unit> to <unit>" conversion, or "<integer> in hex/binary/octal".

const PREFIX = /^(?:what\s+is|what\s+are|what's|whats|how\s+much\s+is|calculate|calculator|calc|compute|solve|evaluate|eval|convert)\b\s*[:,]?\s*/i;
const SUFFIX = /\s*[=?]+\s*$/;
const BASE_TARGET = /^(.+?)\s+(?:in|to|as|into)\s+(hex|hexadecimal|binary|octal|decimal|base\s*(?:2|8|10|16))$/i;
const NUMBER_HEAD = /^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[+-]?\d+)?|[+-]?\.\d+)\s*(.*)$/i;
const CONNECTIVE = /^(.+?)\s+(?:to|in|as|into|->|→)\s+(.+)$/i;
const BASES = { hex: 16, hexadecimal: 16, binary: 2, octal: 8, decimal: 10 };

// Functions that only count as a calculation when called with parentheses: "round 6" or "max 3" is more likely a name.
const PAREN_ONLY = new Set(["min", "max", "pow", "mod", "round", "floor", "ceil", "exp", "fact", "abs"]);

const RADIX_LITERAL = /^[+-]?0[xbo][0-9a-f]+$/i;

const reject = (reason, text, explicit) => ({ answer: null, reason, text, explicit });

const baseOf = (word) => {
  const lower = word.toLowerCase().replace(/\s+/g, "");
  if (lower.startsWith("base")) return Number.parseInt(lower.slice(4), 10);
  return BASES[lower];
};

const unwrap = (node) => (node.type === "paren" ? unwrap(node.arg) : node);

const numberOf = (tree, angle) => {
  const result = evaluate(tree, { angle });
  if (!result.ok) return null;
  return result.value.k === "int" ? Number(result.value.v) : result.value.v;
};

// "15% of 80", "80 + 15%", "20% off 45": the pieces for the little breakdown
const percentBreakdown = (tree, angle) => {
  const root = unwrap(tree);
  let x = null;
  let y = null;
  let mode = null;
  if ((root.type === "pctOf" || root.type === "pctOff") && root.pct.type === "pct") {
    x = numberOf(root.pct.arg, angle);
    y = numberOf(root.base, angle);
    mode = root.type === "pctOf" ? "of" : "off";
  } else if (root.type === "bin" && root.relative && (root.op === "+" || root.op === "-") && root.right.type === "pct") {
    x = numberOf(root.right.arg, angle);
    y = numberOf(root.left, angle);
    mode = root.op === "+" ? "plus" : "minus";
  }
  if (x === null || y === null) return null;
  const share = (x / 100) * y;
  return { x, y, mode, of: share, plus: y + share, minus: y - share };
};

const unitAnswer = (text, angle) => {
  const head = NUMBER_HEAD.exec(text);
  if (!head) return null;
  const connective = CONNECTIVE.exec(head[2].trim());
  if (!connective) return null;
  const amount = Number(head[1].replace(/,/g, ""));
  const from = findUnit(connective[1]);
  const to = findUnit(connective[2]);
  if (!Number.isFinite(amount) || !from || !to) return { unknown: true };
  if (from.category !== to.category) return { mismatch: true };
  const result = convertValue(amount, from, to);
  if (!Number.isFinite(result)) return null;
  const others = relatedUnits(from, to, 4).map((unit) => ({ unit, value: convertValue(amount, from, unit) }));
  return { answer: { kind: "units", amount, from, to, result, others } };
};

const baseAnswer = (text, angle) => {
  const match = BASE_TARGET.exec(text);
  if (!match) return null;
  const base = baseOf(match[2]);
  if (!base) return null;
  const parsed = parseExpression(match[1]);
  if (!parsed) return null;
  const left = match[1].trim();
  const plainDecimal = /^[+-]?\d[\d,]*$/.test(left);
  if (base === 10 && plainDecimal) return null;
  const evaluated = evaluate(parsed.tree, { angle });
  if (!evaluated.ok || evaluated.value.k !== "int") return null;
  return { answer: { kind: "base", input: normalise(match[1]), tokens: parsed.tokens, value: evaluated.value, base, source: RADIX_LITERAL.test(left) ? "literal" : "expression" } };
};

export const analyse = (query, { angle = "radians" } = {}) => {
  const raw = String(query ?? "").trim();
  if (!raw) return reject("empty", "", false);
  if (raw.length > MAX_EXPRESSION_CHARS + 30) return reject("too long", raw, false);
  if (/[a-z]+:\/\/|www\.|@|\bhttps?\b/i.test(raw)) return reject("looks like a URL or address", raw, false);

  let text = raw;
  let explicit = false;
  for (let i = 0; i < 3; i += 1) {
    const stripped = text.replace(PREFIX, "").replace(/^=\s*/, "");
    if (stripped === text) break;
    text = stripped;
    explicit = true;
  }
  const withoutSuffix = text.replace(SUFFIX, "");
  if (withoutSuffix !== text) explicit = true;
  text = withoutSuffix.trim();
  if (!text) return reject("nothing left after the prefix", raw, explicit);

  if (!explicit) {
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(text)) return reject("looks like a date", text, explicit);
    if (/^\d+(?:-\d+)+$/.test(text)) return reject("looks like a range, phone number or code", text, explicit);
    if (/^\d{1,2}\/\d{1,4}$/.test(text) || /^\d+(?:\/\d+){2,}$/.test(text)) return reject("looks like a fraction, date or code written without spaces", text, explicit);
    if (/^\+?\(?\d{2,4}\)?[\s.-]?\d{3}[\s.-]?\d{3,4}$/.test(text)) return reject("looks like a phone number", text, explicit);
    if (/\d[xX]\d/.test(text) && !/\s/.test(text)) return reject("NxM without spaces (a size, not a product)", text, explicit);
  }

  const units = unitAnswer(text, angle);
  if (units?.answer) return { ...units, reason: "unit conversion", text, explicit };
  const base = baseAnswer(text, angle);
  if (base?.answer) return { ...base, reason: "number base conversion", text, explicit };

  const parsed = parseExpression(text);
  if (!parsed) return reject(units?.unknown ? "unknown unit (or a currency: not handled here)" : units?.mismatch ? "units of different kinds" : "not a math expression", text, explicit);
  const f = parsed.features;
  const operatorish = f.operators > 0 || f.functions > 0 || f.factorial > 0 || f.implicit > 0 || f.percentOf > 0;
  if (!operatorish) return reject("no operator, function or percent form", text, explicit);

  if (!explicit) {
    // "round 6", "max 3": a function word without parentheses is only a calculation for the usual math functions
    for (let i = 0; i < parsed.tokens.length; i += 1) {
      const token = parsed.tokens[i];
      if (token.t === "id" && PAREN_ONLY.has(token.v) && parsed.tokens[i + 1] !== "(") return reject(`"${token.v}" without parentheses`, text, explicit);
    }
  }

  const result = evaluate(parsed.tree, { angle });
  const answer = {
    kind: "math",
    input: normalise(text),
    tokens: parsed.tokens,
    tree: parsed.tree,
    features: f,
    percent: percentBreakdown(parsed.tree, angle),
  };
  if (result.ok) answer.value = result.value;
  else answer.error = result.error;
  return { answer, reason: "math expression", text, explicit };
};
