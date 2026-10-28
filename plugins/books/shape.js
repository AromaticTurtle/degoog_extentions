import { imageUrl } from "./request.js";

const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : typeof value === "number" && Number.isFinite(value) ? String(value).slice(0, max) : "");
const number = (value) => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(n) ? n : 0;
};
const integer = (value) => Math.max(0, Math.trunc(number(value)));
const round = (value, places) => Math.round(number(value) * 10 ** places) / 10 ** places;
const bool = (value) => value === true || value === "true" || value === 1;
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

export const MAX_DOCUMENTS = 25;
export const MAX_BOOKS = 8;
export const REPLY_MAX_CHARS = 1_000_000;
const DESCRIPTION_SOURCE_LIMIT = 6000;
const DESCRIPTION_LIMIT = 2000;

const HTML_NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
};

const codePoint = (n) => {
  const valid = n === 9 || n === 10 || n === 13 || (n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff);
  return valid ? String.fromCodePoint(n) : "";
};

const decodeEntities = (value) =>
  value.replace(/&(?:#x([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z]{2,8}));/g, (match, hex, dec, name) => {
    if (name) return Object.hasOwn(HTML_NAMED, name) ? HTML_NAMED[name] : match;
    return codePoint(hex ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10));
  });

// Descriptions are plain text, but some hold markup or entities. Tags go, entities are decoded, whitespace is collapsed.
export const cleanDescription = (raw) => {
  let value = typeof raw === "string" ? raw.slice(0, DESCRIPTION_SOURCE_LIMIT) : "";
  value = value.replace(/<\s*br\s*\/?>/gi, " ").replace(/<\/\s*(?:p|div|li)\s*>/gi, " ");
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  value = decodeEntities(value).replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return value.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT);
};

// A value that may be a single string, a list of strings, or a list of { name } objects.
const names = (value, limit, max = 80) => {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const out = [];
  for (const entry of list) {
    const label = typeof entry === "object" && entry !== null ? text(entry.name ?? entry.tag ?? entry.label, max) : text(entry, max);
    if (label && !out.includes(label)) out.push(label);
    if (out.length >= limit) break;
  }
  return out;
};

const authorsOf = (doc) => {
  const direct = names(doc.author_names, 4);
  if (direct.length) return direct;
  return names(
    (Array.isArray(doc.contributions) ? doc.contributions : []).map((entry) => object(object(entry).author).name),
    4,
  );
};

const yearOf = (doc) => {
  const year = integer(doc.release_year);
  if (year >= 1 && year <= 3000) return year;
  const dated = String(integer(doc.release_date_i));
  return /^\d{8}$/.test(dated) ? Number(dated.slice(0, 4)) : 0;
};

// "Orchard Cycle #2": the series object may hold the name itself or a nested series object.
const seriesOf = (doc) => {
  const featured = object(doc.featured_series);
  const name = text(object(featured.series).name, 80) || text(featured.name, 80) || names(doc.series_names, 1)[0] || "";
  if (!name) return "";
  const position = number(doc.featured_series_position ?? featured.position);
  return position > 0 && position < 10_000 ? `${name} #${Number.isInteger(position) ? position : round(position, 2)}` : name;
};

// The series' own name and the book's number in it (0 when unknown); the matcher uses them for series-name queries.
const seriesNameOf = (doc) => {
  const featured = object(doc.featured_series);
  return text(object(featured.series).name, 80) || text(featured.name, 80) || names(doc.series_names, 1)[0] || "";
};

const seriesPositionOf = (doc) => {
  const featured = object(doc.featured_series);
  const position = number(doc.featured_series_position ?? featured.position);
  return position > 0 && position < 10_000 ? position : 0;
};

const isbnOf = (doc) => {
  const clean = (Array.isArray(doc.isbns) ? doc.isbns : [])
    .map((value) => text(value, 30).replace(/[\s-]/g, ""))
    .filter((value) => /^(?:\d{13}|\d{9}[\dXx])$/.test(value));
  return clean.find((value) => value.length === 13) ?? clean[0] ?? "";
};

const imageOf = (doc) => {
  for (const candidate of [object(doc.image).url, doc.image, object(doc.cached_image).url, doc.cached_image]) {
    const url = imageUrl(candidate);
    if (url) return url;
  }
  return "";
};

const idOf = (doc) => {
  const id = typeof doc.id === "number" ? String(Math.trunc(doc.id)) : text(doc.id, 20);
  return /^\d{1,12}$/.test(id) ? id : "";
};

// One book document of a Hardcover search. Keeps only catalog fields and aggregate numbers (never anything a user
// owns), coerces carefully because values may be strings, numbers, lists or single values, and never throws.
export const compactBook = (document) => {
  const doc = object(document);
  const rating = round(doc.rating, 2);
  return {
    id: idOf(doc),
    slug: text(doc.slug, 200),
    title: text(doc.title),
    subtitle: text(doc.subtitle),
    alternatives: names(doc.alternative_titles, 10, 200),
    authors: authorsOf(doc),
    year: yearOf(doc),
    pages: integer(doc.pages),
    description: cleanDescription(doc.description),
    genres: names(doc.genres, 5, 40),
    moods: names(doc.moods, 4, 40),
    series: seriesOf(doc),
    seriesName: seriesNameOf(doc),
    seriesNames: names(doc.series_names, 4, 80),
    seriesPosition: seriesPositionOf(doc),
    rating: rating >= 0 && rating <= 5 ? rating : 0,
    ratingsCount: integer(doc.ratings_count),
    readers: integer(doc.users_read_count),
    saved: integer(doc.users_count),
    listsCount: integer(doc.lists_count),
    reviewsCount: integer(doc.reviews_count),
    compilation: bool(doc.compilation),
    hasAudiobook: bool(doc.has_audiobook),
    hasEbook: bool(doc.has_ebook),
    audioHours: round(integer(doc.audio_seconds) / 3600, 1),
    isbn: isbnOf(doc),
    image: imageOf(doc),
  };
};

// results is a Typesense response: { hits: [{ document }], found }. A JSON string, a bare list of hits or documents,
// and a multi-search { results: [{ hits }] } are accepted too. null means "not a search result at all".
export const extractDocuments = (results) => {
  let value = results;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  let entries = null;
  if (Array.isArray(value)) entries = value;
  else if (value && typeof value === "object") {
    if (Array.isArray(value.hits)) entries = value.hits;
    else if (Array.isArray(value.results) && value.results.length && Array.isArray(object(value.results[0]).hits)) entries = value.results[0].hits;
  }
  if (!entries) return null;
  return entries
    .slice(0, MAX_DOCUMENTS)
    .map((entry) => {
      const hit = object(entry);
      if ("document" in hit) return object(hit.document);
      return hit;
    })
    .filter((doc) => Object.keys(doc).length > 0);
};

// A GraphQL reply as { books } (possibly none), or { error }: "errors" (the reply carries a GraphQL errors list)
// or "invalid" (not JSON, or not a search reply).
export const parseSearchReply = (body) => {
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return { error: "invalid" };
  }
  if (Array.isArray(data?.errors) && data.errors.length) return { error: "errors" };
  const documents = extractDocuments(data?.data?.search?.results);
  if (!documents) return { error: "invalid" };
  return { books: documents.map(compactBook).filter((book) => book.id && book.title).slice(0, MAX_BOOKS) };
};
