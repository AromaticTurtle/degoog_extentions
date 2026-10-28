import { formatInput, formatMoney, formatPercent, formatRate } from "./convert.js";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = (path) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ARROW_UP = ICON('<path d="M12 19V5M5 12l7-7 7 7"/>');
const ARROW_DOWN = ICON('<path d="M12 5v14M19 12l-7 7-7-7"/>');
const SWAP = ICON('<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>');

export const ER_URL = "https://www.exchangerate-api.com";
export const COINBASE_URL = "https://www.coinbase.com";

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

// Date and time in the host's time zone, e.g. "Oct 28, 2026, 12:02 AM UTC"
export const formatStamp = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
};

const rangeBar = (low, price, high) => {
  const span = high - low;
  const at = span > 0 ? Math.min(100, Math.max(0, ((price - low) / span) * 100)) : 50;
  return `<svg class="currency-range" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="Price within the 24 hour range" width="100%" height="4"><rect class="currency-range-track" width="100" height="4" rx="2"/><rect class="currency-range-marker" x="${Math.max(0, Math.min(97, at - 1.5)).toFixed(1)}" width="3" height="4" rx="1.5"/></svg>`;
};

const swapQuery = (result) => `${result.amount} ${result.to.code} to ${result.from.code}`;

const footer = (result, { compact = false } = {}) => {
  const parts = [];
  if (result.usesFiat) {
    const when = formatStamp(result.updated);
    if (!compact || result.stale) parts.push(result.stale && when ? `Rates from ${when} (could not refresh)` : when ? `Updated ${when}` : "");
    parts.push(link(ER_URL, "Rates By Exchange Rate API"));
  }
  if (result.usesCoinbase) parts.push(`Prices from ${link(COINBASE_URL, "Coinbase")}`);
  return parts.filter(Boolean).join('<span class="currency-dot" aria-hidden="true"> · </span>');
};

const changeBadge = (change) => {
  if (!Number.isFinite(change)) return "";
  const up = change >= 0;
  return `<span class="currency-change ${up ? "currency-change--up" : "currency-change--down"}">${up ? ARROW_UP : ARROW_DOWN}<span>${esc(formatPercent(change))}</span><span class="currency-change-window">24 h</span></span>`;
};

// layout: "inline" (detailed) or "panel" (compact)
export const buildCard = (result, { layout = "inline", decimals = "auto" } = {}) => {
  const kindOf = (side) => side.kind;
  const amountText = formatInput(result.amount);
  const valueText = formatMoney(result.converted, { decimals, kind: kindOf(result.to) });
  const kicker = `${result.kind === "crypto" ? "Crypto" : "Currency"} · ${result.from.code} → ${result.to.code}`;
  const rateLine = `${esc(`1 ${result.from.code} = ${formatRate(result.rate)} ${result.to.code}`)}<span class="currency-dot" aria-hidden="true"> · </span>${esc(`1 ${result.to.code} = ${formatRate(result.inverse)} ${result.from.code}`)}`;
  const head = `<div class="currency-kicker">${esc(kicker)}</div><div class="currency-expression">${esc(`${amountText} ${result.from.code} =`)}</div>`;
  const value = `<div class="currency-value"><span class="currency-value-number">${esc(valueText)}</span><span class="currency-value-code">${esc(result.to.code)}</span></div>`;
  const crypto = result.crypto;

  if (layout === "panel") {
    const change = crypto && Number.isFinite(crypto.change) ? changeBadge(crypto.change) : "";
    const forward = esc(`1 ${result.from.code} = ${formatRate(result.rate)} ${result.to.code}`);
    const compactFooter = footer(result, { compact: true });
    return `<div class="currency-card currency-card--panel">${head}<div class="currency-answer">${value}</div><div class="currency-rate">${forward}${change}</div><div class="currency-footer">${compactFooter}</div></div>`;
  }

  const answer = `<div class="currency-answer">${value}<a class="currency-swap" href="search?q=${encodeURIComponent(swapQuery(result))}" title="Swap the currencies">${SWAP}<span>Swap</span></a></div>`;
  let body = `<div class="currency-rate">${rateLine}</div>`;
  if (crypto && Number.isFinite(crypto.change)) {
    const price = `${formatMoney(crypto.price, { decimals, kind: "fiat" })} ${esc(crypto.fiat)}`;
    let stats = `<div class="currency-stats"><div class="currency-stat"><span class="currency-stat-label">1 ${esc(crypto.code)}</span><span class="currency-stat-value">${price}</span></div><div class="currency-stat"><span class="currency-stat-label">Change</span><span class="currency-stat-value">${changeBadge(crypto.change)}</span></div>`;
    if (crypto.volume) stats += `<div class="currency-stat"><span class="currency-stat-label">Volume 24 h</span><span class="currency-stat-value">${esc(formatMoney(crypto.volume, { kind: "fiat" }).replace(/\.00$/, ""))} ${esc(crypto.code)}</span></div>`;
    stats += "</div>";
    body += stats;
    if (crypto.high && crypto.low) {
      body += `<div class="currency-range-wrap"><div class="currency-range-labels"><span>${esc(formatMoney(crypto.low, { decimals, kind: "fiat" }))}</span><span>24 h range · ${esc(crypto.fiat)}</span><span>${esc(formatMoney(crypto.high, { decimals, kind: "fiat" }))}</span></div>${rangeBar(crypto.low, crypto.price, crypto.high)}</div>`;
    }
  }
  if (result.grid.length) {
    body += `<div class="currency-grid">${result.grid.map((cell) => `<div class="currency-cell"><span class="currency-cell-value">${esc(formatMoney(cell.value, { decimals, kind: "fiat" }))}</span><span class="currency-cell-label">${esc(cell.code)}</span></div>`).join("")}</div>`;
  }
  return `<div class="currency-card currency-card--inline">${head}${answer}${body}<div class="currency-footer">${footer(result)}</div></div>`;
};
