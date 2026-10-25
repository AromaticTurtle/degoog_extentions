import {
  authorLine,
  buildSnippet,
  citationLabel,
  cleanText,
  doiUrl,
  isHttpUrl,
  isoDay,
} from "./text.js";

export const reconstructAbstract = (index) => {
  if (!index || typeof index !== "object") return "";
  const slots = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      if (Number.isInteger(position) && position >= 0 && position < 20_000) slots[position] = word;
    }
  }
  return cleanText(slots.filter((word) => typeof word === "string").join(" "));
};

const pickUrl = (work) => {
  const candidates = [
    doiUrl(work.doi),
    work.primary_location?.landing_page_url,
    work.open_access?.oa_url,
    work.id,
  ];
  return candidates.find((candidate) => isHttpUrl(candidate))?.trim() ?? "";
};

export const parseWorks = (data, source) => {
  if (!data || !Array.isArray(data.results)) return null;
  const seen = new Set();
  const out = [];
  for (const work of data.results) {
    const title = cleanText(work?.title) || cleanText(work?.display_name);
    const url = work ? pickUrl(work) : "";
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    const names = (work.authorships ?? []).map((entry) => entry?.author?.display_name).filter(Boolean);
    const snippet = buildSnippet(
      [
        authorLine(names),
        cleanText(work.primary_location?.source?.display_name),
        Number.isInteger(work.publication_year) ? String(work.publication_year) : "",
        citationLabel(work.cited_by_count),
        work.open_access?.is_oa === true ? "Open access" : "",
      ],
      reconstructAbstract(work.abstract_inverted_index),
    );
    const result = { title, url, snippet, source };
    const publishedAt = isoDay(work.publication_date);
    if (publishedAt && /^\d{4}-\d{2}-\d{2}$/.test(work.publication_date)) result.publishedAt = publishedAt;
    out.push(result);
  }
  return out;
};
