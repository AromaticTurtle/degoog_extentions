import { cleanText, truncate } from "./text.js";

const MASHED_RUN = 28;

const isMashed = (token) => !/[/:.@_=?&]/.test(token) && new RegExp(`[A-Za-z]{${MASHED_RUN},}`).test(token);

export const dropMashedText = (text) => {
  const words = text.split(" ");
  const index = words.findIndex(isMashed);
  if (index === -1) return text;
  const kept = words.slice(0, index).join(" ").replace(/[\s,;:–-]+$/, "").trim();
  return kept ? `${kept}…` : "";
};

export const parseResults = (data, source) => {
  if (!data || !Array.isArray(data.results)) return null;
  const seen = new Set();
  const out = [];
  for (const hit of data.results) {
    const url = typeof hit?.url === "string" ? hit.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url) || seen.has(url)) continue;
    const title = truncate(cleanText(hit.title), 160);
    if (!title) continue;
    seen.add(url);
    out.push({ title, url, snippet: truncate(dropMashedText(cleanText(hit.content)), 300), source });
  }
  return out;
};
