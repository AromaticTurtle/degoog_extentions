import { isLive } from "./rank.js";
import { kickoffLabel, shortDate } from "./time.js";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = (path, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const WIN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M17 5v14L6 12z"/></svg>';
const PIN = ICON('<path d="M12 21s-6-5.2-6-10a6 6 0 1 1 12 0c0 4.8-6 10-6 10z"/><circle cx="12" cy="11" r="2"/>');
const TV = ICON('<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/>');
const DOT = '<svg class="sports-dot" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4"/></svg>';

export const ESPN_URL = "https://www.espn.com";

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
const footer = () => `<div class="sports-footer">Data from ${link(ESPN_URL, "ESPN")}</div>`;
export const searchHref = (query) => `search?q=${encodeURIComponent(query)}`;

const badgeText = (team) => (team.abbr || team.short || team.name || "?").slice(0, 4).toUpperCase();

// A logo (through degoog's image proxy) laid over an abbreviation badge: when the image fails to load, a script removes it and
// the badge shows. Without a proxy function there is only the badge.
const mark = (team, logo) => {
  const src = team.logo && typeof logo === "function" ? logo(team.logo) : "";
  return `<span class="sports-mark"><span class="sports-badge">${esc(badgeText(team))}</span>${src ? `<img class="sports-logo" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</span>`;
};

const pill = (kind, text, dot = false) => `<span class="sports-pill sports-pill--${kind}">${dot ? DOT : ""}${esc(text)}</span>`;

// { pill, label } for the status line
export const statusParts = (game, ctx) => {
  switch (game.phase) {
    case "live":
    case "halftime":
    case "break":
      return { pill: pill("live", "Live", true), label: game.label };
    case "delayed":
      return { pill: pill("warn", "Delayed"), label: game.label === "Delayed" ? "" : game.label };
    case "suspended":
    case "forfeit":
      return { pill: pill("warn", game.label), label: "" };
    case "postponed":
    case "canceled":
      return { pill: pill("closed", game.label), label: kickoffLabel(game.ts, ctx.now, ctx.zone) ? `was ${kickoffLabel(game.ts, ctx.now, ctx.zone)}` : "" };
    case "final":
      return { pill: pill("final", game.label || "Final"), label: shortDate(game.ts, ctx.zone) };
    default:
      return { pill: pill("pre", kickoffLabel(game.ts, ctx.now, ctx.zone) || "Scheduled"), label: "" };
  }
};

const statusLine = (game, ctx) => {
  const parts = statusParts(game, ctx);
  const note = ctx.layout === "inline" && game.note ? `<span class="sports-note">${esc(game.note)}</span>` : "";
  return `<div class="sports-status">${parts.pill}${parts.label ? `<span class="sports-label">${esc(parts.label)}</span>` : ""}${note}</div>`;
};

const teamRow = (team, game, ctx) => {
  const winner = game.state === "post" && team.winner;
  const loser = game.state === "post" && !team.winner && game.teams.some((other) => other.winner);
  const rank = team.rank ? `<span class="sports-rank">${team.rank}</span>` : "";
  const name = ctx.layout === "panel" ? team.short : team.name;
  const record = team.record ? `<span class="sports-record">${esc(team.record)}</span>` : "";
  const score = team.score !== "" ? `<span class="sports-win">${winner ? `${WIN}<span class="sports-sr">Winner</span>` : ""}</span><span class="sports-score">${esc(team.score)}</span>` : "";
  return `<div class="sports-team${winner ? " sports-team--winner" : ""}${loser ? " sports-team--loser" : ""}">${mark(team, ctx.logo)}<div class="sports-team-text"><span class="sports-team-name">${rank}${esc(name)}</span>${record}</div>${score}</div>`;
};

const columnLabel = (league, index) => {
  const regulation = league?.periods ?? 4;
  if (league?.sport === "baseball") return String(index + 1);
  if (index < regulation) return String(index + 1);
  const over = index - regulation + 1;
  return over === 1 ? "OT" : `${over}OT`;
};

const linescore = (game, league) => {
  if (game.state === "pre" || league?.sport === "soccer") return "";
  const [a, b] = game.teams;
  const count = Math.max(a.lines.length, b.lines.length);
  if (count < 2 || a.lines.length !== b.lines.length || count > 14) return "";
  const head = `<tr><th scope="col"><span class="sports-sr">Team</span></th>${Array.from({ length: count }, (_, i) => `<th scope="col">${esc(columnLabel(league, i))}</th>`).join("")}<th scope="col" class="sports-lines-total">T</th></tr>`;
  const row = (team) => `<tr><th scope="row">${esc(team.abbr || team.short)}</th>${team.lines.map((value) => `<td>${esc(value)}</td>`).join("")}<td class="sports-lines-total">${esc(team.score)}</td></tr>`;
  return `<div class="sports-lines-wrap"><table class="sports-lines"><thead>${head}</thead><tbody>${row(a)}${row(b)}</tbody></table></div>`;
};

const metaLine = (game) => {
  const items = [];
  if (game.venue) {
    const text = [game.venue.name, game.venue.place].filter(Boolean).join(" · ");
    if (text) items.push(`<span class="sports-meta-item">${PIN}<span>${esc(text)}</span></span>`);
  }
  if (game.tv.length) items.push(`<span class="sports-meta-item">${TV}<span>${esc(game.tv.join(", "))}</span></span>`);
  return items.length ? `<div class="sports-meta">${items.join("")}</div>` : "";
};

const versus = (game, focusId) => {
  const home = game.teams[1];
  const other = game.teams.find((team) => team.id !== String(focusId)) ?? game.teams[0];
  return `${home && home.id !== String(focusId) ? "at" : "vs"} ${other.short}`;
};

// "Next: Sun 1:00 PM EDT at Rams" / "Last: W 24-17 vs Rams · Oct 26"
const aroundLines = (next, last, focusId, ctx) => {
  const lines = [];
  if (last) {
    const me = last.teams.find((team) => team.id === String(focusId));
    const them = last.teams.find((team) => team.id !== String(focusId));
    const result = me && them && me.score !== "" && them.score !== "" ? `${Number(me.score) > Number(them.score) ? "W" : Number(me.score) < Number(them.score) ? "L" : "T"} ${me.score}–${them.score} ` : "";
    lines.push(`<div class="sports-around-line"><span class="sports-around-label">Last</span><span>${esc(`${result}${versus(last, focusId)} · ${shortDate(last.ts, ctx.zone)}`)}</span></div>`);
  }
  if (next) lines.push(`<div class="sports-around-line"><span class="sports-around-label">Next</span><span>${esc(`${kickoffLabel(next.ts, ctx.now, ctx.zone)} ${versus(next, focusId)}`.trim())}</span></div>`);
  return lines.length ? `<div class="sports-around">${lines.join("")}</div>` : "";
};

const chips = (list) => (list?.length ? `<div class="sports-also"><span class="sports-also-label">Also</span>${list.map((chip) => `<a class="sports-chip sports-link" href="${esc(chip.href)}">${esc(chip.label)}</a>`).join("")}</div>` : "");

const rootAttrs = (cls, live, refresh) => {
  const attrs = [`class="sports-card ${cls}"`, `data-live="${live ? "true" : "false"}"`];
  if (live && refresh?.query) attrs.push(`data-query="${esc(refresh.query)}"`, `data-refresh="${Math.round(refresh.seconds)}"`);
  return attrs.join(" ");
};

// One game. data: { game, league, focusId, chips, next, last }; ctx: { layout, zone, now, logo, refresh }
export const buildGameCard = (data, ctx) => {
  const { game, league } = data;
  const focus = game.teams.find((team) => team.id === String(data.focusId)) ?? game.teams[0];
  const kicker = `<div class="sports-kicker">${esc(league.name)} · ${esc(focus.short)}</div>`;
  const rows = `<div class="sports-teams">${game.teams.map((team) => teamRow(team, game, ctx)).join("")}</div>`;
  const attrs = rootAttrs(ctx.layout === "panel" ? "sports-card--panel" : "sports-card--inline", isLive(game), ctx.refresh);
  if (ctx.layout === "panel") {
    const venue = game.venue?.name ? `<div class="sports-meta"><span class="sports-meta-item">${PIN}<span>${esc(game.venue.name)}</span></span></div>` : "";
    return `<div ${attrs}>${kicker}${statusLine(game, ctx)}${rows}${venue}${footer()}</div>`;
  }
  const situation = game.situation ? `<div class="sports-situation">${esc(game.situation)}</div>` : "";
  const leaders = game.leaders.length ? `<ul class="sports-leaders">${game.leaders.map((entry) => `<li><span class="sports-leader-team">${esc(entry.abbr)}</span><span>${esc(entry.text)}</span></li>`).join("")}</ul>` : "";
  return `<div ${attrs}>${kicker}${statusLine(game, ctx)}${rows}${linescore(game, league)}${situation}${metaLine(game)}${leaders}${aroundLines(data.next, data.last, focus.id, ctx)}${chips(data.chips)}${footer()}</div>`;
};

const miniStatus = (game, ctx) => {
  if (isLive(game)) return `<span class="sports-game-status sports-game-status--live">${DOT}<span>${esc(game.label)}</span></span>`;
  if (game.phase === "final") return `<span class="sports-game-status">${esc(game.label || "Final")}</span>`;
  if (game.phase === "scheduled") return `<span class="sports-game-status">${esc(kickoffLabel(game.ts, ctx.now, ctx.zone))}</span>`;
  return `<span class="sports-game-status">${esc(game.label)}</span>`;
};

const miniTeam = (team, game, ctx) => {
  const winner = game.state === "post" && team.winner;
  const loser = game.state === "post" && !team.winner && game.teams.some((other) => other.winner);
  const score = team.score !== "" ? `<span class="sports-win">${winner ? `${WIN}<span class="sports-sr">Winner</span>` : ""}</span><span class="sports-score">${esc(team.score)}</span>` : "";
  return `<div class="sports-team${winner ? " sports-team--winner" : ""}${loser ? " sports-team--loser" : ""}">${mark(team, ctx.logo)}<span class="sports-team-name">${team.rank ? `<span class="sports-rank">${team.rank}</span>` : ""}${esc(team.short)}</span>${score}</div>`;
};

export const PANEL_LIST_MAX = 6;
export const INLINE_LIST_MAX = 30;

// A league's scoreboard. data: { league, games (already ordered), week }
export const buildLeagueCard = (data, ctx) => {
  const { league } = data;
  const max = ctx.layout === "panel" ? PANEL_LIST_MAX : INLINE_LIST_MAX;
  const shown = data.games.slice(0, max);
  const hidden = data.games.length - shown.length;
  const live = data.games.some(isLive);
  const week = data.week ? `<span class="sports-week">Week ${data.week}</span>` : "";
  const kicker = `<div class="sports-kicker">${esc(league.name)} · Scores</div>`;
  const head = week || ctx.dateLabel ? `<div class="sports-status">${week}${ctx.dateLabel ? `<span class="sports-label">${esc(ctx.dateLabel)}</span>` : ""}</div>` : "";
  const list = shown.length
    ? `<div class="sports-list">${shown.map((game) => `<div class="sports-game">${miniStatus(game, ctx)}<div class="sports-mini">${game.teams.map((team) => miniTeam(team, game, ctx)).join("")}</div></div>`).join("")}</div>`
    : `<div class="sports-empty">No games on this scoreboard.</div>`;
  const more = hidden > 0 ? `<div class="sports-more">and ${hidden} more</div>` : "";
  const attrs = rootAttrs(`sports-card--list ${ctx.layout === "panel" ? "sports-card--panel" : "sports-card--inline"}`, live, ctx.refresh);
  return `<div ${attrs}>${kicker}${head}${list}${more}${footer()}</div>`;
};
