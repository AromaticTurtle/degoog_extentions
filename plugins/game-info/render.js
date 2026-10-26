import { coverUrl, igdbGamePage, isAppId, protonDbPage, steamStorePage } from "./request.js";

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

const PROTON_TIERS = ["platinum", "gold", "silver", "bronze", "borked", "pending"];

const scoreClass = (score) => (score >= 75 ? "good" : score >= 50 ? "mixed" : "bad");
const count = (n) => n.toLocaleString("en-US");
const capitalise = (word) => (word ? word[0].toUpperCase() + word.slice(1) : "");

const badge = ({ tone, value, label, note = "", title, href = "" }) => {
  const inner = `${esc(String(value))}<small>${esc(label)}</small>${note ? `<small>${esc(note)}</small>` : ""}`;
  const classes = `game-info-score game-info-score--${tone}`;
  return href
    ? `<a class="${classes}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${inner}</a>`
    : `<span class="${classes}" title="${esc(title)}">${inner}</span>`;
};

const badges = (game, proton, appId) => {
  const parts = [];
  if (game.criticScore > 0) {
    parts.push(
      badge({
        tone: scoreClass(game.criticScore),
        value: game.criticScore,
        label: "Critics · IGDB",
        note: game.criticCount > 0 ? `${count(game.criticCount)} ${game.criticCount === 1 ? "review" : "reviews"}` : "",
        title: "Average critic score (0-100), from IGDB",
      }),
    );
  }
  if (game.userScore > 0) {
    parts.push(
      badge({
        tone: scoreClass(game.userScore),
        value: game.userScore,
        label: "Players · IGDB",
        note: game.userCount > 0 ? `${count(game.userCount)} ${game.userCount === 1 ? "rating" : "ratings"}` : "",
        title: "Average player score (0-100), from IGDB",
      }),
    );
  }
  if (proton && appId) {
    parts.push(
      badge({
        tone: `proton game-info-proton--${proton.tier}`,
        value: capitalise(proton.tier),
        label: "ProtonDB",
        note: proton.total > 0 ? `${count(proton.total)} ${proton.total === 1 ? "report" : "reports"}` : "",
        title: "Proton compatibility on Linux, from ProtonDB user reports",
        href: protonDbPage(appId),
      }),
    );
  }
  if (game.ageRating) {
    parts.push(badge({ tone: "plain", value: game.ageRating, label: "Age rating", title: "Age rating" }));
  }
  return parts.length ? `<div class="game-info-scores">${parts.join("")}</div>` : "";
};

const fact = (label, value) =>
  value ? `<div class="game-info-fact"><dt>${esc(label)}</dt><dd>${value}</dd></div>` : "";

const chips = (items) => items.map((item) => `<span class="game-info-chip">${esc(item)}</span>`).join("");

const link = (href, label) =>
  href ? `<a class="game-info-link" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : "";

// "about 28 h main story · 56 h with extras · 120 h completionist", only the parts that are known.
export const timeToBeatText = (ttb) => {
  const parts = [
    [ttb?.hastily, "main story"],
    [ttb?.normally, "with extras"],
    [ttb?.completely, "completionist"],
  ]
    .filter(([hours]) => hours > 0)
    .map(([hours, label]) => `${hours} h ${label}`);
  return parts.length ? `about ${parts.join(" · ")}` : "";
};

// game comes from compactGame (steamAppId may have been filled in by the Steam lookup),
// ttb from compactTimeToBeat and proton from compactProton, both optional.
export const buildPanel = ({ game, ttb, proton, signProxy, locale, showDescription = true }) => {
  const appId = isAppId(game.steamAppId) ? String(game.steamAppId) : "";
  const protonData = proton && appId && PROTON_TIERS.includes(proton.tier) ? proton : null;
  const year = (game.released || "").slice(0, 4);
  const pagePath = igdbGamePage(game.slug);
  const imageSource = coverUrl(game.image);
  const signed = imageSource && signProxy ? signProxy(imageSource) : "";
  const image = signed
    ? `<${pagePath ? `a class="game-info-cover" href="${esc(pagePath)}" target="_blank" rel="noopener"` : 'div class="game-info-cover"'}><img src="${esc(signed)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></${pagePath ? "a" : "div"}>`
    : "";
  const title = pagePath
    ? `<a class="game-info-title-link" href="${esc(pagePath)}" target="_blank" rel="noopener"><h3 class="game-info-title">${esc(game.name)}</h3></a>`
    : `<h3 class="game-info-title">${esc(game.name)}</h3>`;

  const summary = showDescription ? summarize(game.summary, 300) : "";
  const facts = [
    fact("Released", esc(formatDate(game.released, locale))),
    fact("Platforms", chips(game.platforms ?? [])),
    fact("Genres", chips(game.genres ?? [])),
    fact("Developer", esc((game.developers ?? []).join(", "))),
    fact("Publisher", esc((game.publishers ?? []).join(", "))),
    fact("Modes", esc((game.modes ?? []).join(", "))),
    fact("Time to beat", esc(timeToBeatText(ttb))),
  ].join("");

  const links = [
    link(steamStorePage(appId), "Steam page"),
    link(safeUrl(game.officialSite), "Official site"),
    link(pagePath, "IGDB page"),
  ]
    .filter(Boolean)
    .join("");

  const attribution = `Data from <a href="https://www.igdb.com" target="_blank" rel="noopener">IGDB</a>${
    protonData ? `, <a href="https://www.protondb.com" target="_blank" rel="noopener">ProtonDB</a>` : ""
  }`;

  return [
    `<div class="game-info-card">`,
    `<div class="game-info-hero">`,
    image,
    `<div class="game-info-body">`,
    `<div class="game-info-kicker">Video game${year ? ` · ${esc(year)}` : ""}</div>`,
    title,
    badges(game, protonData, appId),
    `</div>`,
    `</div>`,
    summary ? `<p class="game-info-desc">${esc(summary)}</p>` : "",
    facts ? `<dl class="game-info-facts">${facts}</dl>` : "",
    links ? `<div class="game-info-links">${links}</div>` : "",
    `<div class="game-info-attribution">${attribution}</div>`,
    `</div>`,
  ].join("");
};
