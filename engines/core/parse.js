import {
  authorLine,
  buildSnippet,
  citationLabel,
  cleanText,
  doiUrl,
  isHttpUrl,
  isoDay,
} from "./text.js";

const pickUrl = (work) => {
  const doi = doiUrl(work.doi);
  if (doi) return doi;
  if (work.id !== undefined && work.id !== null && /^\d+$/.test(String(work.id))) {
    return `https://core.ac.uk/works/${work.id}`;
  }
  const link = (work.links ?? []).find((entry) => isHttpUrl(entry?.url));
  return [link?.url, work.downloadUrl].find((candidate) => isHttpUrl(candidate))?.trim() ?? "";
};

export const parseWorks = (data, source) => {
  if (!data || !Array.isArray(data.results)) return null;
  const seen = new Set();
  const out = [];
  for (const work of data.results) {
    const title = cleanText(work?.title);
    const url = work ? pickUrl(work) : "";
    if (!title || !url || seen.has(url)) continue;
    seen.add(url);

    const names = (work.authors ?? []).map((entry) => entry?.name).filter(Boolean);
    const journal = (work.journals ?? []).map((entry) => cleanText(entry?.title)).find(Boolean) ?? "";
    const year = Number.isInteger(work.yearPublished) && work.yearPublished > 0 ? String(work.yearPublished) : "";
    const snippet = buildSnippet(
      [
        authorLine(names),
        journal,
        year,
        citationLabel(work.citationCount),
        isHttpUrl(work.downloadUrl) ? "Full text" : "",
      ],
      cleanText(work.abstract),
    );
    const result = { title, url, snippet, source };
    const publishedAt = isoDay(work.publishedDate);
    if (publishedAt) result.publishedAt = publishedAt;
    out.push(result);
  }
  return out;
};
