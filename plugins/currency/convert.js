// Turning a parsed query and the fetched data into the numbers of a card. Pure.

const usdPerUnit = (currency, { rates, spots }) => {
  if (currency.kind === "fiat") {
    const rate = rates?.[currency.code];
    return rate ? 1 / rate : null;
  }
  return spots?.[currency.code] ?? null;
};

export const rateBetween = (from, to, data) => {
  const a = usdPerUnit(from, data);
  const b = usdPerUnit(to, data);
  if (!a || !b) return null;
  const rate = a / b;
  return Number.isFinite(rate) && rate > 0 ? rate : null;
};

export const MAX_GRID = 5;

// -> the card's data, or null when a needed rate is missing
export const buildResult = ({ parsed, rates, spots = {}, stats = null, secondary = [], updated = 0, stale = false }) => {
  const { from, to, amount } = parsed;
  const data = { rates, spots };
  const rate = rateBetween(from, to, data);
  const inverse = rateBetween(to, from, data);
  if (!rate || !inverse) return null;
  const grid = [];
  for (const code of secondary) {
    if (grid.length >= MAX_GRID) break;
    if (code === from.code || code === to.code) continue;
    const other = rateBetween(from, { code, kind: "fiat" }, data);
    if (other) grid.push({ code, value: amount * other });
  }
  // the crypto side of a crypto <-> fiat pair gets the 24 hour figures, in the fiat currency of the pair
  let crypto = null;
  const cryptoSide = from.kind === "crypto" ? from : to.kind === "crypto" ? to : null;
  const fiatSide = cryptoSide === from ? to : from;
  if (cryptoSide && fiatSide.kind === "fiat") {
    const price = rateBetween(cryptoSide, fiatSide, data);
    if (price) {
      const toFiat = (usd) => {
        const per = usdPerUnit(fiatSide, data);
        return per ? usd / per : null;
      };
      crypto = { code: cryptoSide.code, fiat: fiatSide.code, price };
      if (stats) {
        const high = toFiat(stats.high);
        const low = toFiat(stats.low);
        // The 24 h change is a ratio, so the currency does not matter (fiat moves are ignored: this is the USD change)
        crypto.change = (stats.last - stats.open) / stats.open;
        if (high && low) {
          crypto.high = Math.max(high, price);
          crypto.low = Math.min(low, price);
        }
        crypto.volume = stats.volume;
      }
    }
  }
  return {
    kind: parsed.kind,
    amount,
    from: { code: from.code, kind: from.kind },
    to: { code: to.code, kind: to.kind },
    converted: amount * rate,
    rate,
    inverse,
    grid,
    crypto,
    updated,
    stale,
    usesFiat: parsed.kind === "fiat" || grid.length > 0 || [from, to].some((side) => side.kind === "fiat" && side.code !== "USD"),
    usesCoinbase: from.kind === "crypto" || to.kind === "crypto",
  };
};

// ---- number formatting -----------------------------------------------------------------------------------------------

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const trimZeros = (text) => (text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text);

const fixed = (value, decimals) => {
  const [whole, fraction] = Math.abs(value).toFixed(decimals).split(".");
  return `${value < 0 ? "-" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
};

// decimals: "auto" or a whole number 2..8; kind picks the automatic precision (crypto amounts need more digits)
export const formatMoney = (value, { decimals = "auto", kind = "fiat" } = {}) => {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (typeof decimals === "number" && decimals >= 2 && decimals <= 8) return fixed(value, decimals);
  if (kind === "crypto") {
    if (abs >= 1000) return fixed(value, 2);
    if (abs >= 1) return trimZeros(fixed(value, 4)).replace(/^(-?[\d,]+)$/, "$1");
    if (abs === 0) return "0";
    return trimZeros(abs >= 0.001 ? fixed(value, 6) : fixed(value, 8));
  }
  if (abs >= 1) return fixed(value, 2);
  if (abs >= 0.01) return fixed(value, 4);
  if (abs === 0) return "0.00";
  return fixed(value, 6);
};

// 5 significant digits for rates: 0.8982, 1.1133, 149.52, 81,466.44
export const formatRate = (value) => {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1000) return fixed(value, 2);
  if (abs >= 100) return fixed(value, 2);
  if (abs === 0) return "0";
  const text = Number(value.toPrecision(5)).toString();
  if (/e/i.test(text)) return value.toPrecision(5);
  return text;
};

export const formatPercent = (ratio) => `${(Math.abs(ratio) * 100).toFixed(2)}%`;

// The amount as the user typed it: 100, 1,000.5, 0.00000123 (no forced decimals)
export const formatInput = (value) => {
  if (!Number.isFinite(value)) return "—";
  const [whole, fraction] = trimZeros(Math.abs(value).toFixed(8)).split(".");
  return `${value < 0 ? "-" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
};
