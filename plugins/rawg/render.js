import { rawgGamePage, resizedImage } from "./request.js";

export const esc = (value) =>
  typeof value !== "string"
    ? ""
    : value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const safeUrl = (value) => {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
};

export const formatDate = (iso, locale) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(date.getTime())) return "";
  try {
    return date.toLocaleDateString(locale || "en-US", { timeZone: "UTC", dateStyle: "medium" });
  } catch {
    return iso;
  }
};

export const splitDescription = (description, previewChars = 320) => {
  const text = String(description ?? "").trim();
  if (text.length <= previewChars + 80) return { preview: text, rest: "" };
  const space = text.lastIndexOf(" ", previewChars);
  const cut = space > previewChars / 2 ? space : previewChars;
  return { preview: `${text.slice(0, cut).trimEnd()}…`, rest: text.slice(cut).trim() };
};

const scoreClass = (metacritic) => (metacritic >= 75 ? "good" : metacritic >= 50 ? "mixed" : "bad");

const fact = (label, value) =>
  value ? `<div class="rawg-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : "";

const chips = (items) => items.map((item) => `<span class="rawg-chip">${esc(item)}</span>`).join("");

const link = (href, label, cls = "rawg-link") =>
  href ? `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : "";

const scores = (metacritic, rating, ratingsCount, esrb) => {
  const parts = [];
  if (metacritic > 0) {
    parts.push(`<span class="rawg-score rawg-score--${scoreClass(metacritic)}" title="Metacritic score">${metacritic}<small>Metacritic</small></span>`);
  }
  if (rating > 0) {
    const votes = ratingsCount > 0 ? `<small>${esc(ratingsCount.toLocaleString("en-US"))} ratings</small>` : "<small>RAWG</small>";
    parts.push(`<span class="rawg-score rawg-score--plain" title="RAWG user rating, out of 5">${rating.toFixed(1)}${votes}</span>`);
  }
  if (esrb) parts.push(`<span class="rawg-score rawg-score--plain" title="ESRB rating">${esc(esrb)}<small>ESRB</small></span>`);
  return parts.length ? `<div class="rawg-scores">${parts.join("")}</div>` : "";
};

// game comes from compactSearchResult, detail (optional) from compactDetail.
export const buildPanel = ({ game, detail, signProxy, locale }) => {
  const year = (detail?.released || game.released || "").slice(0, 4);
  const released = formatDate(detail?.released || game.released, locale);
  const pagePath = rawgGamePage(game.slug);
  const imageSource = resizedImage(detail?.image || game.image);
  const signed = imageSource && signProxy ? signProxy(imageSource) : "";
  const image = signed
    ? `<${pagePath ? `a class="rawg-cover" href="${esc(pagePath)}" target="_blank" rel="noopener"` : 'div class="rawg-cover"'}><img src="${esc(signed)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></${pagePath ? "a" : "div"}>`
    : "";
  const title = pagePath
    ? `<a class="rawg-title-link" href="${esc(pagePath)}" target="_blank" rel="noopener"><h3 class="rawg-title">${esc(game.name)}</h3></a>`
    : `<h3 class="rawg-title">${esc(game.name)}</h3>`;

  const { preview, rest } = splitDescription(detail?.description);
  const description = preview
    ? `<p class="rawg-desc">${esc(preview)}</p>${rest ? `<details class="rawg-more"><summary>Read more</summary><p class="rawg-desc">${esc(rest)}</p></details>` : ""}`
    : "";

  const playtime = (detail?.playtime || game.playtime) > 0 ? `about ${detail?.playtime || game.playtime} h` : "";
  const facts = [
    fact("Released", esc(released)),
    fact("Platforms", chips(game.platforms)),
    fact("Genres", chips(game.genres)),
    fact("Developer", esc((detail?.developers ?? []).join(", "))),
    fact("Publisher", esc((detail?.publishers ?? []).join(", "))),
    fact("Average playtime", esc(playtime)),
    fact("Stores", chips(game.stores)),
  ].join("");

  const links = [
    link(safeUrl(detail?.website), "Official site"),
    link(safeUrl(detail?.reddit), "Reddit"),
    link(pagePath, "RAWG page"),
  ]
    .filter(Boolean)
    .join("");

  return [
    `<div class="rawg-card">`,
    image,
    `<div class="rawg-body">`,
    `<div class="rawg-kicker">Video game${year ? ` · ${esc(year)}` : ""}</div>`,
    title,
    scores(detail?.metacritic || game.metacritic, game.rating, game.ratingsCount, detail?.esrb || game.esrb),
    description,
    facts ? `<dl class="rawg-facts">${facts}</dl>` : "",
    links ? `<div class="rawg-links">${links}</div>` : "",
    `<div class="rawg-attribution">Game data from <a href="https://rawg.io/" target="_blank" rel="noopener">RAWG</a></div>`,
    `</div>`,
    `</div>`,
  ].join("");
};
