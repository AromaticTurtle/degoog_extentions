const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  copy: "©",
  trade: "™",
  euro: "€",
};

// Named entities from a short list and numeric ones (&#32; &#x27;). Anything else is left as it is.
// Custom or external entities are never expanded.
export const decodeEntities = (text) =>
  String(text ?? "").replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = Number.isFinite(code) && code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff);
      return valid ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });

// Markup out of a text. The inside of <script> and <style> goes too.
export const stripTags = (text) =>
  String(text ?? "")
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ");

export const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim();

// Cuts at the last sentence end after 40 % of max, else at the last word after 50 %, and adds an ellipsis then.
export const cutText = (text, max) => {
  const clean = collapse(text);
  if (clean.length <= max) return clean;
  const window = clean.slice(0, max + 1);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence > max * 0.4) return clean.slice(0, sentence + 1);
  const space = clean.slice(0, max).lastIndexOf(" ");
  return `${clean.slice(0, space > max * 0.5 ? space : max).trimEnd()}…`;
};

export const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const truthy = (value, fallback = false) => (value === undefined || value === "" || value === null ? fallback : value === true || value === "true");

// "Jun 22, 2024" from an ISO date, always in UTC.
export const dayLabel = (iso) => {
  const when = new Date(`${iso}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso ?? "")) || Number.isNaN(when.getTime())) return "";
  return when.toLocaleDateString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" });
};
