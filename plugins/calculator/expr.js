// A small, safe expression engine: a tokenizer and a recursive-descent parser that builds a tree, and an evaluator over that
// tree. There is no eval and no Function. Integers stay exact (BigInt) for + - * and non-negative integer powers within size
// caps; everything else is a float. It never throws to the caller: parseExpression() returns null for anything it cannot read.

export const MAX_EXPRESSION_CHARS = 200;
export const MAX_NESTING = 40;
export const MAX_BIGINT_DIGITS = 5000;
export const MAX_FACTORIAL = 1000;

class CalcError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // "syntax" | "div0" | "domain" | "overflow"
  }
}

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, phi: (1 + Math.sqrt(5)) / 2 };
// Constants that may be written right after a number without a sign: "2pi". "2e" is not one of them (see tokenizer).
const IMPLICIT_CONSTANTS = new Set(["pi", "tau", "phi"]);
const FUNCTIONS = new Set([
  "sqrt", "cbrt", "abs", "round", "floor", "ceil", "ln", "log", "log2", "exp",
  "sin", "cos", "tan", "asin", "acos", "atan", "sinh", "cosh", "tanh",
  "min", "max", "pow", "mod", "fact",
]);
const ANGLE_UNITS = { deg: Math.PI / 180, degree: Math.PI / 180, degrees: Math.PI / 180, rad: 1, radian: 1, radians: 1 };
const PERCENT_WORDS = new Set(["percent", "pct"]);

const isDigit = (c) => c >= "0" && c <= "9";
const isLetter = (c) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

const NORMALISE = [
  [/[×·⋅∙✕]/g, "*"], [/÷/g, "/"], [/[−–—]/g, "-"], [/π/g, " pi "], [/τ/g, " tau "], [/φ/g, " phi "],
  [/²/g, "^2"], [/³/g, "^3"], [/°/g, " deg "], [/\u00a0/g, " "],
];

export const normalise = (text) => {
  let out = String(text ?? "");
  for (const [pattern, replacement] of NORMALISE) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim();
};

// ---- tokenizer -----------------------------------------------------------------------------------------------------

const intValue = (digits, radix) => {
  const prefix = radix === 16 ? "0x" : radix === 2 ? "0b" : "0o";
  return BigInt(prefix + digits);
};

// -> tokens, or null. Tokens: { t: "num", big: BigInt|null, n: Number } | { t: "id", v } | { t: "op", v } | "(" | ")" | ","
export const tokenize = (input) => {
  const text = normalise(input);
  if (!text || text.length > MAX_EXPRESSION_CHARS) return null;
  const tokens = [];
  const calls = []; // for each open "(": is it a function call? commas separate arguments there, not thousands
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " ") {
      i += 1;
      continue;
    }
    // hex, binary, octal literals
    const prefixed = /^0([xbo])([0-9a-f]+)/i.exec(text.slice(i));
    if (prefixed && !isLetter(text[i + prefixed[0].length] ?? "")) {
      const radix = { x: 16, b: 2, o: 8 }[prefixed[1].toLowerCase()];
      const digits = prefixed[2];
      const valid = radix === 16 ? /^[0-9a-f]+$/i.test(digits) : radix === 2 ? /^[01]+$/.test(digits) : /^[0-7]+$/.test(digits);
      if (!valid || digits.length > 80) return null;
      const big = intValue(digits, radix);
      tokens.push({ t: "num", big, n: Number(big), raw: prefixed[0] });
      i += prefixed[0].length;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(text[i + 1] ?? ""))) {
      const insideCall = calls.length > 0 && calls[calls.length - 1];
      // 1,234,567.89 (thousands separators) outside function calls
      const grouped = insideCall ? null : /^\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?/.exec(text.slice(i));
      const plain = /^(?:\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      let raw = (grouped ?? plain)[0];
      let value = raw.replace(/,/g, "");
      i += raw.length;
      // 1.5e3, 2E-4 (an "e" that is not followed by digits is the constant: "2e" is 2 times e, which is refused later)
      const exponent = /^[eE]([+-]?\d+)/.exec(text.slice(i));
      if (exponent && Math.abs(Number(exponent[1])) <= 400) {
        value += `e${exponent[1]}`;
        i += exponent[0].length;
        raw += exponent[0];
      }
      if (text[i] === "." && isDigit(text[i + 1] ?? "")) return null; // 3.5.1, 192.168.1.1: not a number
      const isInt = /^\d+$/.test(value);
      if (isInt && value.length > MAX_BIGINT_DIGITS) return null;
      tokens.push({ t: "num", big: isInt ? BigInt(value) : null, n: Number(value), raw });
      continue;
    }
    if (isLetter(c) || c === "_") {
      let j = i;
      while (j < text.length && (isLetter(text[j]) || text[j] === "_")) j += 1;
      let word = text.slice(i, j).toLowerCase();
      if (word === "log" && text[j] === "2" && !isDigit(text[j + 1] ?? "")) {
        word = "log2";
        j += 1;
      }
      // "2x3": a lone x between values is a multiplication sign
      if (word === "x" && tokens.length && ["num", ")"].includes(tokens[tokens.length - 1].t ?? tokens[tokens.length - 1])) {
        tokens.push({ t: "op", v: "*" });
      } else tokens.push({ t: "id", v: word });
      i = j;
      continue;
    }
    if (c === "*" && text[i + 1] === "*") {
      tokens.push({ t: "op", v: "^" });
      i += 2;
      continue;
    }
    if ("+-*/^%!".includes(c)) {
      tokens.push({ t: "op", v: c });
      i += 1;
      continue;
    }
    if (c === "√") {
      tokens.push({ t: "id", v: "sqrt" });
      i += 1;
      continue;
    }
    if (c === "(") {
      const previous = tokens[tokens.length - 1];
      calls.push(Boolean(previous && previous.t === "id" && FUNCTIONS.has(previous.v)));
      tokens.push("(");
      i += 1;
      continue;
    }
    if (c === ")") {
      calls.pop();
      tokens.push(")");
      i += 1;
      continue;
    }
    if (c === ",") {
      tokens.push(",");
      i += 1;
      continue;
    }
    return null;
  }
  return tokens.length ? tokens : null;
};

// ---- parser --------------------------------------------------------------------------------------------------------

const isOperandStart = (token) =>
  token !== undefined &&
  (token === "(" ||
    token.t === "num" ||
    (token.t === "id" && !["of", "off", ...PERCENT_WORDS, ...Object.keys(ANGLE_UNITS), "in", "to", "as"].includes(token.v) && (FUNCTIONS.has(token.v) || token.v in CONSTANTS)));

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.at = 0;
    this.depth = 0;
    this.features = { operators: 0, functions: 0, percent: 0, percentOf: 0, implicit: 0, factorial: 0 };
  }

  peek(offset = 0) {
    return this.tokens[this.at + offset];
  }

  next() {
    return this.tokens[this.at++];
  }

  isOp(token, ...values) {
    return token && token.t === "op" && values.includes(token.v);
  }

  enter() {
    this.depth += 1;
    if (this.depth > MAX_NESTING) throw new CalcError("syntax");
  }

  leave() {
    this.depth -= 1;
  }

  parse() {
    const node = this.additive();
    if (this.at < this.tokens.length) throw new CalcError("syntax");
    return node;
  }

  additive() {
    let left = this.term();
    while (this.isOp(this.peek(), "+", "-")) {
      const op = this.next().v;
      const right = this.term();
      this.features.operators += 1;
      left = { type: "bin", op, left, right, relative: right.type === "pct" };
    }
    return left;
  }

  term() {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, "*", "/")) {
        this.next();
        left = { type: "bin", op: token.v, left, right: this.unary() };
        this.features.operators += 1;
      } else if (this.isOp(token, "%")) {
        // only reached when the % is followed by an operand: 10 % 3 is a remainder
        this.next();
        left = { type: "bin", op: "mod", left, right: this.unary() };
        this.features.operators += 1;
      } else if (token && token.t === "id" && (token.v === "of" || token.v === "off") && left.type === "pct") {
        this.next();
        left = { type: token.v === "of" ? "pctOf" : "pctOff", pct: left, base: this.unary() };
        this.features.percentOf += 1;
      } else if (isOperandStart(token) && this.implicitAllowed(left, token)) {
        this.features.implicit += 1;
        left = { type: "bin", op: "*", left, right: this.unary(), implicit: true };
      } else break;
    }
    return left;
  }

  // "2(3+4)", "(1+2)(3+4)", "2pi", "2 sin(0)", "(2)3": yes. "2e", "2 pi" with a word like "pie": no (not a constant).
  implicitAllowed(left, token) {
    if (token === "(") return true;
    if (token.t === "num") return left.type === "paren" || left.type === "pct";
    if (token.t === "id") {
      if (FUNCTIONS.has(token.v)) return true;
      return IMPLICIT_CONSTANTS.has(token.v);
    }
    return false;
  }

  unary() {
    const token = this.peek();
    if (this.isOp(token, "-", "+")) {
      this.next();
      this.enter();
      const node = this.unary();
      this.leave();
      return token.v === "-" ? { type: "neg", arg: node } : node;
    }
    return this.power();
  }

  power() {
    const base = this.postfix();
    if (this.isOp(this.peek(), "^")) {
      this.next();
      this.features.operators += 1;
      this.enter();
      const exponent = this.unary(); // right associative, and 2^-3 works
      this.leave();
      return { type: "bin", op: "^", left: base, right: exponent };
    }
    return base;
  }

  postfix() {
    let node = this.primary();
    for (;;) {
      const token = this.peek();
      if (this.isOp(token, "!")) {
        this.next();
        this.features.factorial += 1;
        node = { type: "fact", arg: node };
      } else if (this.isOp(token, "%") && !isOperandStart(this.peek(1))) {
        this.next();
        this.features.percent += 1;
        node = { type: "pct", arg: node };
      } else if (token && token.t === "id" && PERCENT_WORDS.has(token.v)) {
        this.next();
        this.features.percent += 1;
        node = { type: "pct", arg: node };
      } else if (token && token.t === "id" && token.v in ANGLE_UNITS) {
        this.next();
        node = { type: "angle", arg: node, factor: ANGLE_UNITS[token.v] };
      } else break;
    }
    return node;
  }

  primary() {
    const token = this.next();
    if (token === undefined) throw new CalcError("syntax");
    if (token === "(") {
      this.enter();
      const node = this.additive();
      this.leave();
      if (this.next() !== ")") throw new CalcError("syntax");
      return { type: "paren", arg: node };
    }
    if (token.t === "num") return { type: "num", big: token.big, n: token.n };
    if (token.t === "id") {
      if (FUNCTIONS.has(token.v)) {
        this.features.functions += 1;
        if (this.peek() === "(") {
          this.next();
          const args = [];
          this.enter();
          if (this.peek() !== ")") {
            args.push(this.additive());
            while (this.peek() === ",") {
              this.next();
              args.push(this.additive());
              if (args.length > 8) throw new CalcError("syntax");
            }
          }
          this.leave();
          if (this.next() !== ")") throw new CalcError("syntax");
          return { type: "call", name: token.v, args };
        }
        // "sqrt 16", "√9": one operand, binding like a prefix operator
        if (isOperandStart(this.peek()) || this.isOp(this.peek(), "-", "+")) {
          const arg = this.unary();
          return { type: "call", name: token.v, args: [arg] };
        }
        throw new CalcError("syntax");
      }
      if (token.v in CONSTANTS) return { type: "const", name: token.v, n: CONSTANTS[token.v] };
    }
    throw new CalcError("syntax");
  }
}

// -> { tree, features } or null
export const parseExpression = (input) => {
  try {
    const tokens = tokenize(input);
    if (!tokens) return null;
    const parser = new Parser(tokens);
    const tree = parser.parse();
    return { tree, features: parser.features, tokens };
  } catch {
    return null;
  }
};

// ---- evaluator -----------------------------------------------------------------------------------------------------

const big = (v) => ({ k: "int", v });
const num = (v, extra = {}) => ({ k: "num", v, ...extra });
const toNumber = (value) => (value.k === "int" ? Number(value.v) : value.v);
const digitsOf = (n) => (n < 0n ? -n : n).toString().length;

const sized = (value) => {
  if (value.k === "int" && digitsOf(value.v) > MAX_BIGINT_DIGITS) throw new CalcError("overflow");
  return value;
};
const finite = (n) => {
  if (!Number.isFinite(n)) throw new CalcError(Number.isNaN(n) ? "domain" : "overflow");
  return n;
};

const gcd = (a, b) => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};

const factorial = (value) => {
  const n = toNumber(value);
  if (!Number.isInteger(n) || n < 0) throw new CalcError("domain");
  if (n > MAX_FACTORIAL) throw new CalcError("overflow");
  let result = 1n;
  for (let i = 2n; i <= BigInt(n); i += 1n) result *= i;
  return big(result);
};

const power = (a, b) => {
  if (a.k === "int" && b.k === "int" && b.v >= 0n) {
    const exponent = Number(b.v);
    const bits = a.v === 0n || a.v === 1n || a.v === -1n ? 1 : Math.log10(Number(a.v < 0n ? -a.v : a.v) || 1) * exponent;
    if (exponent <= 100_000 && (a.v === 0n || a.v === 1n || a.v === -1n || bits <= MAX_BIGINT_DIGITS)) return sized(big(a.v ** b.v));
  }
  const x = toNumber(a);
  const y = toNumber(b);
  if (x === 0 && y < 0) throw new CalcError("div0");
  if (x < 0 && !Number.isInteger(y)) throw new CalcError("domain");
  return num(finite(x ** y));
};

const remainder = (a, b) => {
  if (toNumber(b) === 0) throw new CalcError("div0");
  if (a.k === "int" && b.k === "int") return big(a.v % b.v);
  return num(finite(toNumber(a) % toNumber(b)));
};

const divide = (a, b) => {
  if (toNumber(b) === 0) throw new CalcError("div0");
  if (a.k === "int" && b.k === "int" && a.v % b.v === 0n) return big(a.v / b.v);
  return num(finite(toNumber(a) / toNumber(b)));
};

const arith = (op, a, b) => {
  if (a.k === "int" && b.k === "int") {
    if (op === "+") return sized(big(a.v + b.v));
    if (op === "-") return sized(big(a.v - b.v));
    if (op === "*") return sized(big(a.v * b.v));
  }
  const x = toNumber(a);
  const y = toNumber(b);
  return num(finite(op === "+" ? x + y : op === "-" ? x - y : x * y));
};

const rounded = (value, digits = 0) => {
  const n = toNumber(value);
  if (value.k === "int" && digits >= 0) return value;
  const factor = 10 ** digits;
  return num(finite(Math.round((n + Math.sign(n) * Number.EPSILON * Math.abs(n)) * factor) / factor));
};

const call = (name, args, ctx) => {
  const x = args[0];
  const need = (count) => {
    if (args.length !== count) throw new CalcError("syntax");
  };
  const radians = (value) => (value.angle ? value.v : ctx.angle === "degrees" ? (toNumber(value) * Math.PI) / 180 : toNumber(value));
  const back = (radiansValue) => (ctx.angle === "degrees" ? (radiansValue * 180) / Math.PI : radiansValue);
  switch (name) {
    case "sqrt": {
      need(1);
      const n = toNumber(x);
      if (n < 0) throw new CalcError("domain");
      if (x.k === "int") {
        const root = BigInt(Math.round(Math.sqrt(n)));
        if (x.v < 2n ** 52n && root * root === x.v) return big(root);
      }
      return num(finite(Math.sqrt(n)));
    }
    case "cbrt": {
      need(1);
      const n = toNumber(x);
      const root = Math.cbrt(n);
      if (x.k === "int" && x.v < 2n ** 52n && x.v > -(2n ** 52n) && Math.round(root) ** 3 === n) return big(BigInt(Math.round(root)));
      return num(finite(root));
    }
    case "abs":
      need(1);
      return x.k === "int" ? big(x.v < 0n ? -x.v : x.v) : num(Math.abs(x.v));
    case "round":
      if (args.length === 2) return rounded(x, Math.trunc(toNumber(args[1])));
      need(1);
      return x.k === "int" ? x : num(finite(Math.round(x.v)));
    case "floor":
      need(1);
      return x.k === "int" ? x : num(finite(Math.floor(x.v)));
    case "ceil":
      need(1);
      return x.k === "int" ? x : num(finite(Math.ceil(x.v)));
    case "ln":
      need(1);
      if (toNumber(x) <= 0) throw new CalcError("domain");
      return num(finite(Math.log(toNumber(x))));
    case "log":
      need(1);
      if (toNumber(x) <= 0) throw new CalcError("domain");
      return num(finite(Math.log10(toNumber(x))));
    case "log2":
      need(1);
      if (toNumber(x) <= 0) throw new CalcError("domain");
      return num(finite(Math.log2(toNumber(x))));
    case "exp":
      need(1);
      return num(finite(Math.exp(toNumber(x))));
    case "sin":
    case "cos":
    case "tan": {
      need(1);
      const r = radians(x);
      const result = Math[name](r);
      // sin(pi) is 0, not 1.2e-16
      return num(finite(Math.abs(result) < 1e-15 ? 0 : name === "tan" && Math.abs(Math.cos(r)) < 1e-15 ? Number.NaN : result));
    }
    case "asin":
    case "acos":
    case "atan": {
      need(1);
      const n = toNumber(x);
      if (name !== "atan" && Math.abs(n) > 1) throw new CalcError("domain");
      return num(finite(back(Math[name](n))));
    }
    case "sinh":
    case "cosh":
    case "tanh":
      need(1);
      return num(finite(Math[name](toNumber(x))));
    case "min":
    case "max": {
      if (!args.length) throw new CalcError("syntax");
      let best = args[0];
      for (const value of args.slice(1)) if (name === "min" ? toNumber(value) < toNumber(best) : toNumber(value) > toNumber(best)) best = value;
      return best;
    }
    case "pow":
      need(2);
      return power(args[0], args[1]);
    case "mod":
      need(2);
      return remainder(args[0], args[1]);
    case "fact":
      need(1);
      return factorial(x);
    default:
      throw new CalcError("syntax");
  }
};

const evaluateNode = (node, ctx) => {
  switch (node.type) {
    case "num":
      return node.big !== null ? big(node.big) : num(node.n);
    case "const":
      return num(node.n);
    case "paren":
      return evaluateNode(node.arg, ctx);
    case "neg": {
      const value = evaluateNode(node.arg, ctx);
      return value.k === "int" ? big(-value.v) : num(-value.v, value.angle ? { angle: true } : {});
    }
    case "pct":
      return num(finite(toNumber(evaluateNode(node.arg, ctx)) / 100));
    case "angle": {
      const value = evaluateNode(node.arg, ctx);
      return num(finite(toNumber(value) * node.factor), { angle: true });
    }
    case "fact":
      return factorial(evaluateNode(node.arg, ctx));
    case "call":
      return call(node.name, node.args.map((arg) => evaluateNode(arg, ctx)), ctx);
    case "pctOf":
      return num(finite(toNumber(evaluateNode(node.pct, ctx)) * toNumber(evaluateNode(node.base, ctx))));
    case "pctOff":
      return num(finite(toNumber(evaluateNode(node.base, ctx)) * (1 - toNumber(evaluateNode(node.pct, ctx)))));
    case "bin": {
      const left = evaluateNode(node.left, ctx);
      // 80 + 15% is 80 + 15 % of 80
      if (node.relative && (node.op === "+" || node.op === "-")) {
        const share = toNumber(left) * toNumber(evaluateNode(node.right, ctx));
        return arith(node.op, left, num(share));
      }
      const right = evaluateNode(node.right, ctx);
      let result;
      switch (node.op) {
        case "+":
        case "-":
          result = arith(node.op, left, right);
          if (left.angle && right.angle) result.angle = true;
          return result;
        case "*":
          result = arith("*", left, right);
          if (Boolean(left.angle) !== Boolean(right.angle)) result.angle = true;
          return result;
        case "/":
          result = divide(left, right);
          if (Boolean(left.angle) !== Boolean(right.angle)) result.angle = true;
          return result;
        case "mod":
          return remainder(left, right);
        case "^":
          return power(left, right);
        default:
          throw new CalcError("syntax");
      }
    }
    default:
      throw new CalcError("syntax");
  }
};

// -> { ok: true, value: { k: "int", v: BigInt } | { k: "num", v: Number } } | { ok: false, error: "div0" | "domain" | "overflow" | "syntax" }
export const evaluate = (tree, { angle = "radians" } = {}) => {
  try {
    const value = evaluateNode(tree, { angle });
    if (value.k === "num" && !Number.isFinite(value.v)) return { ok: false, error: "overflow" };
    return { ok: true, value: value.k === "int" ? { k: "int", v: value.v } : { k: "num", v: value.v } };
  } catch (error) {
    return { ok: false, error: error instanceof CalcError ? error.kind : "syntax" };
  }
};

export { gcd };
