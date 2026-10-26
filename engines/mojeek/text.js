const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export const decodeEntities = (text) =>
  text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });

export const stripTags = (text) => text.replace(/<\/?[a-z][^>]*>/gi, "");

export const cleanText = (value) =>
  typeof value === "string"
    ? decodeEntities(stripTags(value)).replace(/\s+/g, " ").trim()
    : "";

export const truncate = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;

export const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export const doiUrl = (value) => {
  if (typeof value !== "string") return "";
  const doi = value
    .trim()
    .replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "")
    .toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>"]+$/.test(doi) ? `https://doi.org/${doi}` : "";
};

export const isHttpUrl = (value) => typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());

export const citationLabel = (count) =>
  Number.isInteger(count) && count > 0 ? `${count} ${count === 1 ? "citation" : "citations"}` : "";

export const authorLine = (names, max = 3) => {
  const clean = names.map(cleanText).filter(Boolean);
  if (clean.length === 0) return "";
  return clean.length > max ? `${clean.slice(0, max).join(", ")} et al.` : clean.join(", ");
};

export const isoDay = (value) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;

export const buildSnippet = (metaParts, abstract, maxAbstract = 320) => {
  const meta = metaParts.filter(Boolean).join(" · ");
  const body = truncate(abstract, maxAbstract);
  if (meta && body) return `${meta} — ${body}`;
  return meta || body;
};
