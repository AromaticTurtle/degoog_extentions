import { bggPage, imageUrl } from "./request.js";

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

const ratingClass = (rating) => (rating >= 7.5 ? "good" : rating >= 6 ? "mixed" : "bad");
const count = (n) => n.toLocaleString("en-US");

const badge = ({ tone, value, label, note = "", title }) =>
  `<span class="board-games-score board-games-score--${tone}" title="${esc(title)}">${esc(String(value))}<small>${esc(label)}</small>${note ? `<small>${esc(note)}</small>` : ""}</span>`;

const badges = (game) => {
  const parts = [];
  if (game.rating > 0) {
    parts.push(
      badge({
        tone: ratingClass(game.rating),
        value: game.rating.toFixed(1),
        label: "BGG rating",
        note: game.ratingCount > 0 ? `${count(game.ratingCount)} ${game.ratingCount === 1 ? "rating" : "ratings"}` : "",
        title: "Average rating (1-10) from BoardGameGeek users",
      }),
    );
  }
  if (game.rank > 0) {
    parts.push(badge({ tone: "plain", value: `#${count(game.rank)}`, label: "BGG rank", title: "Overall rank among all board games on BoardGameGeek" }));
  }
  if (game.weight > 0) {
    parts.push(badge({ tone: "plain", value: game.weight.toFixed(1), label: "Weight / 5", title: "BGG community complexity rating" }));
  }
  return parts.length ? `<div class="board-games-scores">${parts.join("")}</div>` : "";
};

const fact = (label, value) =>
  value ? `<div class="board-games-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : "";

const chips = (items) => (items ?? []).map((item) => `<span class="board-games-chip">${esc(item)}</span>`).join("");

const playersParts = (game) => {
  const min = game.minPlayers;
  const max = game.maxPlayers;
  const range = min > 0 && max > 0 ? (min === max ? String(min) : `${min}–${max}`) : String(max || min || "");
  const parts = [];
  if (range && range !== "0") parts.push(range);
  if (game.bestWith) parts.push(`Best with ${game.bestWith}`);
  if (game.recommendedWith) parts.push(`Recommended ${game.recommendedWith}`);
  return parts;
};

export const playersText = (game) => playersParts(game).join(" · ");

// Each phrase stays on one line, so a range such as 1–4 is never split.
const playersHtml = (game) => playersParts(game).map((part) => `<span class="board-games-nowrap">${esc(part)}</span>`).join(" · ");

export const playTimeText = (game) => {
  const min = game.minPlayTime;
  const max = game.maxPlayTime;
  if (min > 0 && max > 0 && min !== max) return `${min}–${max} min`;
  const single = max || min || game.playingTime;
  return single > 0 ? `${single} min` : "";
};

// game comes from compactThing.
export const buildPanel = ({ game, signProxy, showDescription = true }) => {
  const year = game.year > 0 ? String(game.year) : "";
  const page = bggPage(game.id);
  const source = imageUrl(game.image) || imageUrl(game.thumbnail);
  const signed = source && signProxy ? signProxy(source) : "";
  const image = signed
    ? `<${page ? `a class="board-games-cover" href="${esc(page)}" target="_blank" rel="noopener"` : 'div class="board-games-cover"'}><img src="${esc(signed)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></${page ? "a" : "div"}>`
    : "";
  const title = page
    ? `<a class="board-games-title-link" href="${esc(page)}" target="_blank" rel="noopener"><h3 class="board-games-title">${esc(game.name)}</h3></a>`
    : `<h3 class="board-games-title">${esc(game.name)}</h3>`;

  const summary = showDescription ? summarize(game.description, 300) : "";
  const age = game.minAge > 0 ? `${game.minAge}+` : "";
  const expansions = game.expansions > 0 ? `${count(game.expansions)} ${game.expansions === 1 ? "expansion" : "expansions"} on BGG` : "";
  const facts = [
    fact("Players", playersHtml(game)),
    fact("Playing time", esc(playTimeText(game))),
    fact("Age", esc(age)),
    fact("Designers", esc((game.designers ?? []).join(", "))),
    fact("Publishers", esc((game.publishers ?? []).join(", "))),
    fact("Categories", chips(game.categories)),
    fact("Mechanics", chips(game.mechanics)),
    fact("Expansions", esc(expansions)),
  ].join("");

  return [
    `<div class="board-games-card">`,
    `<div class="board-games-hero">`,
    image,
    `<div class="board-games-body">`,
    `<div class="board-games-kicker">Board game${year ? ` · ${esc(year)}` : ""}</div>`,
    title,
    badges(game),
    `</div>`,
    `</div>`,
    summary ? `<p class="board-games-desc">${esc(summary)}</p>` : "",
    facts ? `<dl class="board-games-facts">${facts}</dl>` : "",
    page ? `<div class="board-games-links"><a class="board-games-link" href="${esc(page)}" target="_blank" rel="noopener">BGG page</a></div>` : "",
    `<div class="board-games-attribution"><a class="board-games-credit" href="https://boardgamegeek.com" target="_blank" rel="noopener">Powered by BGG</a></div>`,
    `</div>`,
  ].join("");
};
