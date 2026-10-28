import { bookPage, imageUrl } from "./request.js";

export const esc = (value) =>
  typeof value !== "string"
    ? ""
    : value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Collapses whitespace, then cuts at the last sentence end after 40 % of the limit, else at a word after 50 %.
export const summarize = (text, max = 300) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const window = clean.slice(0, max + 1);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentence > max * 0.4) return clean.slice(0, sentence + 1);
  const space = clean.slice(0, max).lastIndexOf(" ");
  return `${clean.slice(0, space > max * 0.5 ? space : max).trimEnd()}…`;
};

const ratingClass = (rating) => (rating >= 4 ? "good" : rating >= 3.3 ? "mixed" : "bad");
const count = (n) => n.toLocaleString("en-US");

const badge = ({ tone, value, label, note = "", title }) =>
  `<span class="books-score books-score--${tone}" title="${esc(title)}">${esc(String(value))}<small>${esc(label)}</small>${note ? `<small>${esc(note)}</small>` : ""}</span>`;

// Only aggregate Hardcover numbers are shown, always labelled as Hardcover's. Nothing a user owns.
const badges = (book) => {
  const parts = [];
  if (book.rating > 0) {
    parts.push(
      badge({
        tone: ratingClass(book.rating),
        value: book.rating.toFixed(1),
        label: "Hardcover rating",
        note: book.ratingsCount > 0 ? `${count(book.ratingsCount)} ${book.ratingsCount === 1 ? "rating" : "ratings"}` : "",
        title: "Average rating (out of 5) from Hardcover readers",
      }),
    );
  }
  if (book.readers > 0) {
    parts.push(badge({ tone: "plain", value: count(book.readers), label: "Readers", note: "on Hardcover", title: "Hardcover readers who marked this book as read" }));
  }
  return parts.length ? `<div class="books-scores">${parts.join("")}</div>` : "";
};

const fact = (label, value) => (value ? `<div class="books-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : "");
const chips = (items) => (items ?? []).map((item) => `<span class="books-chip">${esc(item)}</span>`).join("");

const formatParts = (book) => {
  const parts = [];
  if (book.hasAudiobook) parts.push(book.audioHours > 0 ? `Audiobook · ${book.audioHours} h` : "Audiobook");
  if (book.hasEbook) parts.push("E-book");
  return parts;
};

export const formatsText = (book) => formatParts(book).join(", ");

// Each format stays on one line, so "E-book" is never split at its hyphen.
const formatsHtml = (book) => formatParts(book).map((part) => `<span class="books-nowrap">${esc(part)}</span>`).join(", ");

// book comes from compactBook.
export const buildPanel = ({ book, signProxy, showDescription = true }) => {
  const year = book.year > 0 ? String(book.year) : "";
  const page = bookPage(book.slug);
  const source = imageUrl(book.image);
  const signed = source && signProxy ? signProxy(source) : "";
  const image = signed
    ? `<${page ? `a class="books-cover" href="${esc(page)}" target="_blank" rel="noopener"` : 'div class="books-cover"'}><img src="${esc(signed)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></${page ? "a" : "div"}>`
    : "";
  const title = page
    ? `<a class="books-title-link" href="${esc(page)}" target="_blank" rel="noopener"><h3 class="books-title">${esc(book.title)}</h3></a>`
    : `<h3 class="books-title">${esc(book.title)}</h3>`;
  const kicker = ["Book", year, book.series].filter(Boolean).map(esc).join(" · ");
  const authors = (book.authors ?? []).length ? `<div class="books-authors">by ${esc(book.authors.join(", "))}</div>` : "";

  const summary = showDescription ? summarize(book.description, 300) : "";
  const facts = [
    fact("Series", esc(book.seriesName ?? "")),
    fact("Pages", esc(book.pages > 0 ? count(book.pages) : "")),
    fact("Published", esc(year)),
    fact("Genres", chips(book.genres)),
    fact("Moods", chips(book.moods)),
    fact("Formats", formatsHtml(book)),
    fact("ISBN", esc(book.isbn)),
  ].join("");

  return [
    `<div class="books-card">`,
    `<div class="books-hero">`,
    image,
    `<div class="books-body">`,
    `<div class="books-kicker">${kicker}</div>`,
    title,
    authors,
    badges(book),
    `</div>`,
    `</div>`,
    summary ? `<p class="books-desc">${esc(summary)}</p>` : "",
    facts ? `<dl class="books-facts">${facts}</dl>` : "",
    page ? `<div class="books-links"><a class="books-link" href="${esc(page)}" target="_blank" rel="noopener">Hardcover page</a></div>` : "",
    `<div class="books-attribution">Data from <a href="https://hardcover.app" target="_blank" rel="noopener">Hardcover</a></div>`,
    `</div>`,
  ].join("");
};
