import { directionOf, exchangeLabel, fmtCap, fmtChange, fmtPercent, fmtPrice, fmtRatio, fmtYield, formatStamp, percentOf, sparkPoints } from "./format.js";

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = (path) =>
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ARROW_UP = ICON('<path d="M12 19V5M5 12l7-7 7 7"/>');
const ARROW_DOWN = ICON('<path d="M12 5v14M19 12l-7 7-7-7"/>');
const FLAT = ICON('<path d="M5 12h14"/>');
const EXTERNAL = ICON('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>');

export const FINNHUB_URL = "https://finnhub.io";

const PILLS = {
  open: ["Market open", "open"],
  pre: ["Pre-market", "pre"],
  post: ["After hours", "post"],
  closed: ["Market closed", "closed"],
  holiday: ["Market closed", "closed"],
};

const statusPill = (session, holiday) => {
  const entry = PILLS[session];
  if (!entry) return "";
  const text = session === "holiday" && holiday ? `Closed · ${holiday}` : entry[0];
  return `<span class="stocks-pill stocks-pill--${entry[1]}"><svg class="stocks-pill-dot" viewBox="0 0 8 8" width="8" height="8" aria-hidden="true"><circle cx="4" cy="4" r="4"/></svg>${esc(text)}</span>`;
};

const rangeBar = (low, high, price, label) => {
  const at = percentOf(price, low, high);
  return `<svg class="stocks-range" viewBox="0 0 100 4" preserveAspectRatio="none" role="img" aria-label="${esc(label)}" width="100%" height="4"><rect class="stocks-range-track" width="100" height="4" rx="2"/><rect class="stocks-range-marker" x="${Math.max(0, Math.min(97, at - 1.5)).toFixed(1)}" width="3" height="4" rx="1.5"/></svg>`;
};

const rangeBlock = (title, low, high, price) => {
  if (!Number.isFinite(low) || !Number.isFinite(high) || !(high >= low)) return "";
  const lo = Math.min(low, price);
  const hi = Math.max(high, price);
  return `<div class="stocks-range-wrap"><div class="stocks-range-labels"><span>${esc(fmtPrice(lo))}</span><span>${esc(title)}</span><span>${esc(fmtPrice(hi))}</span></div>${rangeBar(lo, hi, price, `${title}: ${fmtPrice(lo)} to ${fmtPrice(hi)}`)}</div>`;
};

const changeBadge = (quote) => {
  if (!Number.isFinite(quote.change)) return "";
  const dir = directionOf(quote.change);
  const arrow = dir === "up" ? ARROW_UP : dir === "down" ? ARROW_DOWN : FLAT;
  const percent = fmtPercent(quote.percent);
  return `<span class="stocks-change stocks-change--${dir}">${arrow}<span>${esc(fmtChange(quote.change, quote.price))}${percent ? ` (${esc(percent)})` : ""}</span></span>`;
};

const cell = (value, label) => `<div class="stocks-cell"><span class="stocks-cell-value">${esc(value)}</span><span class="stocks-cell-label">${esc(label)}</span></div>`;

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

const footer = () => `<div class="stocks-footer">Data from ${link(FINNHUB_URL, "Finnhub")}</div>`;

// layout: "inline" (detailed) or "panel" (compact). data: { symbol, quote, profile, metric, session, holiday, points, logoSrc, currency }
export const buildCard = (data, { layout = "inline" } = {}) => {
  const { symbol, quote, profile, metric, session, holiday, points, logoSrc } = data;
  const currency = profile?.currency || "USD";
  const exchange = exchangeLabel(profile?.exchange);
  const kicker = `<div class="stocks-kicker">Stock · ${esc(exchange ? `${exchange}: ${symbol}` : symbol)}</div>`;
  const price = `<div class="stocks-price-row"><span class="stocks-price">${esc(fmtPrice(quote.price))}</span><span class="stocks-currency">${esc(currency)}</span>${changeBadge(quote)}</div>`;
  const pill = statusPill(session, holiday);

  if (layout === "panel") {
    const name = profile?.name ? `<div class="stocks-name">${esc(profile.name)}</div>` : "";
    return `<div class="stocks-card stocks-card--panel">${kicker}${name}${price}${pill ? `<div class="stocks-status">${pill}</div>` : ""}${rangeBlock("Day range", quote.low, quote.high, quote.price)}${footer()}</div>`;
  }

  const logo = logoSrc ? `<img class="stocks-logo" src="${esc(logoSrc)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">` : "";
  const sub = [exchange, profile?.industry].filter(Boolean).join(" · ");
  const head = profile?.name || logo ? `<div class="stocks-head">${logo}<div class="stocks-head-text"><div class="stocks-name">${esc(profile?.name || symbol)}</div>${sub ? `<div class="stocks-sub">${esc(sub)}</div>` : ""}</div></div>` : "";
  const updated = formatStamp(quote.time);
  const status = pill || updated ? `<div class="stocks-status">${pill}${updated ? `<span class="stocks-updated">Updated ${esc(updated)}</span>` : ""}</div>` : "";
  const spark = Array.isArray(points) && points.length >= 2 ? sparkLine(points, quote) : "";
  const ranges = [rangeBlock("Day range", quote.low, quote.high, quote.price), rangeBlock("52-week range", metric?.low52, metric?.high52, quote.price)].filter(Boolean).join("");
  const cells = [
    ["Open", quote.open !== null ? fmtPrice(quote.open) : ""],
    ["Prev. close", quote.prevClose !== null ? fmtPrice(quote.prevClose) : ""],
    ["Market cap", profile && Number.isFinite(profile.marketCap) ? fmtCap(profile.marketCap, profile.currency) : ""],
    ["P/E", metric && Number.isFinite(metric.pe) ? fmtRatio(metric.pe) : ""],
    ["EPS", metric && Number.isFinite(metric.eps) ? fmtRatio(metric.eps) : ""],
    ["Dividend yield", metric && Number.isFinite(metric.dividendYield) && metric.dividendYield > 0 ? fmtYield(metric.dividendYield) : ""],
    ["Beta", metric && Number.isFinite(metric.beta) ? fmtRatio(metric.beta) : ""],
  ].filter(([, value]) => value);
  const grid = cells.length ? `<div class="stocks-grid">${cells.map(([label, value]) => cell(value, label)).join("")}</div>` : "";
  const site = profile?.website ? `<div class="stocks-links">${link(profile.website, new URL(profile.website).hostname.replace(/^www\./, ""))}${EXTERNAL}</div>` : "";
  return `<div class="stocks-card stocks-card--inline">${kicker}${head}${price}${status}${spark}${ranges}${grid}${site}${footer()}</div>`;
};

const sparkLine = (points, quote) => {
  const dir = Number.isFinite(quote.change) ? directionOf(quote.change) : "flat";
  const poly = sparkPoints(points);
  if (!poly) return "";
  return `<svg class="stocks-spark stocks-spark--${dir}" viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="Price over the last days" width="100%" height="32"><polyline points="${poly}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
};
