const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const decodeEntities = (text) =>
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

const clean = (value) =>
  typeof value === "string"
    ? decodeEntities(value).replace(/\s+/g, " ").trim()
    : "";

export const parseResults = (data, source) => {
  if (!data || !Array.isArray(data.results)) return null;
  const seen = new Set();
  const out = [];
  for (const item of data.results) {
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    const title = clean(item?.title);
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title, url, snippet: clean(item.description), source });
  }
  return out;
};
