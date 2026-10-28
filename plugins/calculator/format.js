// Turning evaluated values and token lists into text. Floats are never shown raw: they are rounded to `digits` significant
// digits first, so 0.1+0.2 is 0.3 and sin(30 deg) is 0.5.

const SUPERSCRIPT = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", "+": "⁺" };
export const superscript = (text) => String(text).replace(/[0-9+-]/g, (c) => SUPERSCRIPT[c]);

const MAX_EXACT_DIGITS = 60;

export const group = (digits, separator = ",") => digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);

const groupNumberText = (text, separators) => {
  if (!separators) return text;
  const match = /^(-?)(\d+)(\.\d+)?$/.exec(text);
  if (!match) return text;
  return `${match[1]}${group(match[2])}${match[3] ?? ""}`;
};

// "1.2300e+25" -> { mantissa: "1.23", exponent: 25 }
const splitExponential = (n, digits) => {
  const [mantissa, exponent] = n.toExponential(Math.max(0, digits - 1)).split("e");
  const trimmed = mantissa.includes(".") ? mantissa.replace(/0+$/, "").replace(/\.$/, "") : mantissa;
  return { mantissa: trimmed, exponent: Number.parseInt(exponent, 10) };
};

export const scientificText = (n, digits) => {
  const { mantissa, exponent } = splitExponential(n, digits);
  return `${mantissa} × 10${superscript(exponent)}`;
};

const bigScientific = (big, digits) => {
  const negative = big < 0n;
  const text = (negative ? -big : big).toString();
  const head = text.slice(0, Math.max(1, digits));
  const mantissa = `${head[0]}${head.length > 1 ? `.${head.slice(1)}` : ""}`.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${negative ? "-" : ""}${mantissa} × 10${superscript(text.length - 1)}`;
};

// -> { text, plain, approximate, scientific } where `plain` has no separators (for copying)
export const formatValue = (value, { digits = 12, separators = true } = {}) => {
  if (value.k === "int") {
    const negative = value.v < 0n;
    const text = (negative ? -value.v : value.v).toString();
    if (text.length > MAX_EXACT_DIGITS) {
      const sci = bigScientific(value.v, digits);
      return { text: sci, plain: (negative ? "-" : "") + text, approximate: true, scientific: sci, digitCount: text.length };
    }
    const sign = negative ? "-" : "";
    const sci = text.length > 4 ? bigScientific(value.v, Math.min(digits, text.length)) : null;
    return { text: sign + (separators ? group(text) : text), plain: sign + text, approximate: false, scientific: sci, digitCount: text.length };
  }
  const n = value.v;
  if (n === 0 || Object.is(n, -0)) return { text: "0", plain: "0", approximate: false, scientific: null };
  const rounded = Number(n.toPrecision(Math.min(21, Math.max(1, digits))));
  const abs = Math.abs(rounded);
  const sci = abs >= 1000 || abs < 0.01 ? scientificText(rounded, digits) : null;
  if (abs >= 1e21 || abs < 1e-6) {
    const text = scientificText(rounded, digits);
    return { text, plain: String(rounded), approximate: true, scientific: text };
  }
  const plain = String(rounded);
  return { text: groupNumberText(plain, separators), plain, approximate: !Number.isInteger(rounded) || rounded !== n, scientific: sci };
};

const BIG_RADIX_LIMIT = 2n ** 128n;

const nibbles = (text, size) => {
  const out = [];
  for (let i = text.length; i > 0; i -= size) out.unshift(text.slice(Math.max(0, i - size), i));
  return out.join(" ");
};

// integer values only (and not huge ones): { hex, bin, oct, dec }
export const radixForms = (value) => {
  if (value.k !== "int") return null;
  const negative = value.v < 0n;
  const abs = negative ? -value.v : value.v;
  if (abs >= BIG_RADIX_LIMIT) return null;
  const sign = negative ? "-" : "";
  return {
    hex: `${sign}0x${abs.toString(16).toUpperCase()}`,
    bin: `${sign}0b${nibbles(abs.toString(2), 4)}`,
    oct: `${sign}0o${abs.toString(8)}`,
  };
};

export const toBase = (value, base) => {
  if (value.k !== "int") return null;
  const negative = value.v < 0n;
  const abs = negative ? -value.v : value.v;
  if (abs.toString(2).length > 512) return null;
  const sign = negative ? "-" : "";
  if (base === 16) return `${sign}0x${abs.toString(16).toUpperCase()}`;
  if (base === 2) return `${sign}0b${nibbles(abs.toString(2), 4)}`;
  if (base === 8) return `${sign}0o${abs.toString(8)}`;
  return `${sign}${abs.toString(10)}`;
};

// A clean rational ("0.375" -> "3/8"), found with a continued fraction; null when the value is not clearly a fraction.
export const fractionHint = (n, { maxDenominator = 1000 } = {}) => {
  if (!Number.isFinite(n) || Number.isInteger(n) || Math.abs(n) > 1e9) return null;
  const sign = n < 0 ? -1 : 1;
  const x = Math.abs(n);
  let [h1, h0, k1, k0] = [1, 0, 0, 1];
  let y = x;
  for (let i = 0; i < 32; i += 1) {
    const a = Math.floor(y);
    [h1, h0] = [a * h1 + h0, h1];
    [k1, k0] = [a * k1 + k0, k1];
    if (k1 > maxDenominator) return null;
    if (Math.abs(x - h1 / k1) < 1e-10 * Math.max(1, x)) break;
    const rest = y - a;
    if (rest < 1e-12) break;
    y = 1 / rest;
  }
  if (k1 < 2 || k1 > maxDenominator || Math.abs(x - h1 / k1) >= 1e-9 * Math.max(1, x)) return null;
  return `${sign < 0 ? "-" : ""}${h1}/${k1}`;
};

const WORD_OPERANDS = new Set(["pi", "tau", "phi", "e", "percent", "pct", "deg", "degree", "degrees", "rad", "radian", "radians"]);

// The expression as typed, tidied: spaces around binary operators, × ÷ π, simple powers as superscripts.
export const prettyExpression = (tokens) => {
  let out = "";
  let previous = null;
  const operandEnd = (token) => token && (token.t === "num" || token === ")" || (token.t === "id" && WORD_OPERANDS.has(token.v)) || (token.t === "op" && ["!", "%"].includes(token.v)));
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "(" || token === ")") {
      out += token;
    } else if (token === ",") {
      out += ", ";
    } else if (token.t === "num") {
      out += (previous && previous.t === "id" && !WORD_OPERANDS.has(previous.v) && previous.v !== "sqrt" ? " " : "") + token.raw;
    } else if (token.t === "id") {
      const glue = previous && (previous.t === "num" || previous === ")" || (previous.t === "op" && ["%", "!"].includes(previous.v))) ? " " : "";
      const sep = previous && previous.t === "id" ? " " : glue;
      out += sep + (token.v === "pi" ? "π" : token.v === "tau" ? "τ" : token.v === "phi" ? "φ" : token.v === "sqrt" ? "√" : token.v);
    } else if (token.t === "op") {
      if (token.v === "!") out += "!";
      else if (token.v === "%") out += "%";
      else if (token.v === "^") {
        const exponent = tokens[i + 1];
        const closed = tokens[i + 2];
        const simple = exponent && exponent.t === "num" && /^\d{1,3}$/.test(exponent.raw) && !(closed && closed.t === "op" && closed.v === "!");
        if (simple) {
          out += superscript(exponent.raw);
          i += 1;
        } else out += "^";
      } else if (operandEnd(previous)) {
        out += ` ${token.v === "*" ? "×" : token.v === "/" ? "÷" : token.v === "-" ? "−" : token.v} `;
      } else {
        out += token.v === "-" ? "−" : token.v;
      }
    }
    previous = token;
  }
  return out.replace(/√ \(/g, "√(").replace(/\s+/g, " ").trim();
};
