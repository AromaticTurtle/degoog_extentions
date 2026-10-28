// Number and time formatting for the stock card. Pure.

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const fixed = (value, decimals) => {
  const [whole, fraction] = Math.abs(value).toFixed(decimals).split(".");
  return `${value < 0 ? "-" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
};

export const fmtPrice = (value) => {
  if (!Number.isFinite(value)) return "–";
  return Math.abs(value) >= 1 ? fixed(value, 2) : fixed(value, 4);
};

// "+1.23" / "-0.40" / "0.00": the sign is part of the text, so colour is never the only signal
export const fmtChange = (value, price) => {
  if (!Number.isFinite(value)) return "";
  const text = fixed(Math.abs(value), Number.isFinite(price) && Math.abs(price) < 1 ? 4 : 2);
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
};

export const fmtPercent = (value) => (Number.isFinite(value) ? `${Math.abs(value).toFixed(2)}%` : "");

// Finnhub reports market capitalisation in millions of the company's currency
export const fmtCap = (millions, currency = "USD") => {
  if (!Number.isFinite(millions) || millions <= 0) return "–";
  const prefix = currency === "USD" || !currency ? "$" : `${currency} `;
  if (millions >= 1_000_000) return `${prefix}${(millions / 1_000_000).toFixed(2)}T`;
  if (millions >= 1000) return `${prefix}${(millions / 1000).toFixed(1)}B`;
  return `${prefix}${millions.toFixed(1)}M`;
};

export const fmtRatio = (value) => (Number.isFinite(value) ? fixed(value, 2) : "–");
export const fmtYield = (value) => (Number.isFinite(value) && value > 0 ? `${value.toFixed(2)}%` : "–");

// Direction of a change: "up" | "down" | "flat"
export const directionOf = (change) => (change > 0 ? "up" : change < 0 ? "down" : "flat");

// "NASDAQ NMS - GLOBAL MARKET" -> "NASDAQ", "NEW YORK STOCK EXCHANGE, INC." -> "NYSE", anything else: the first words, short
export const exchangeLabel = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const upper = text.toUpperCase();
  if (/NASDAQ/.test(upper)) return "NASDAQ";
  if (/ARCA/.test(upper)) return "NYSE Arca";
  if (/AMERICAN|AMEX/.test(upper)) return "NYSE American";
  if (/NEW YORK STOCK EXCHANGE|^NYSE/.test(upper)) return "NYSE";
  if (/CBOE|BATS/.test(upper)) return "Cboe";
  return text.split(/[\s,-]+/).slice(0, 2).join(" ").slice(0, 16);
};

export const percentOf = (value, low, high) => {
  const span = high - low;
  if (!(span > 0)) return 50;
  return Math.min(100, Math.max(0, ((value - low) / span) * 100));
};

// Date and time in the host's time zone, e.g. "Oct 28, 3:58 PM EDT"
export const formatStamp = (seconds) => {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
};

// Closing prices -> the points attribute of an SVG polyline in a 100 x 24 box (y grows downwards), or "" for fewer than 2 points
export const sparkPoints = (values, width = 100, height = 24) => {
  const list = (Array.isArray(values) ? values : []).filter((v) => Number.isFinite(v));
  if (list.length < 2) return "";
  const min = Math.min(...list);
  const max = Math.max(...list);
  const span = max - min || 1;
  return list.map((v, i) => `${((i / (list.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
};
