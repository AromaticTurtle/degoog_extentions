// Builds Finnhub-shaped replies from INVENTED companies and numbers. It is used by the stocks tests and by tests/mock-stocks-server.js;
// it is not a recording of anything. The layouts (field names) follow Finnhub's documentation: /quote {c,d,dp,h,l,o,pc,t},
// /stock/profile2, /stock/metric {metric:{...},series:{...}}, /stock/market-status, /search {count,result:[...]}, /stock/candle {c,h,l,o,s,t,v}.

export const KNOWN = {
  QFRN: {
    name: "Quillfern Systems Inc",
    exchange: "NASDAQ NMS - GLOBAL MARKET",
    industry: "Technology",
    web: "https://www.quillfern.example/",
    logo: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/QFRN.png",
    price: 189.84, prev: 187.52, high: 190.7, low: 186.9, open: 187.9, time: 1793223480,
    cap: 2_910_450.5, pe: 29.41, eps: 6.45, yield: 0.52, beta: 1.21, high52: 214.3, low52: 141.2,
  },
  BRMB: {
    name: "Brambleton Foods Co",
    exchange: "NEW YORK STOCK EXCHANGE, INC.",
    industry: "Food Products",
    web: "https://www.brambleton.example/",
    logo: "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/BRMB.png",
    price: 58.12, prev: 59.0, high: 59.2, low: 57.8, open: 58.9, time: 1793223480,
    cap: 41_200.2, pe: 17.8, eps: 3.27, yield: 2.84, beta: 0.64, high52: 66.4, low52: 51.05,
  },
  MIDS: {
    name: "Midsummer Optics Ltd",
    exchange: "NYSE ARCA",
    industry: "Technology",
    web: "https://www.midsummer.example/",
    logo: "",
    price: 0.4321, prev: 0.4321, high: 0.44, low: 0.42, open: 0.43, time: 1793223480,
    cap: 120.4, pe: null, eps: null, yield: 0, beta: 1.9, high52: 1.2, low52: 0.3,
  },
};

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// An unknown symbol answers zeros, like Finnhub does
export const quoteFor = (symbol) => {
  const k = KNOWN[symbol];
  if (!k) return { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 };
  const d = round(k.price - k.prev, 4);
  return { c: k.price, d, dp: round((d / k.prev) * 100, 4), h: k.high, l: k.low, o: k.open, pc: k.prev, t: k.time };
};

export const profileFor = (symbol) => {
  const k = KNOWN[symbol];
  if (!k) return {};
  return { country: "US", currency: "USD", estimateCurrency: "USD", exchange: k.exchange, finnhubIndustry: k.industry, ipo: "1999-03-14", logo: k.logo, marketCapitalization: k.cap, name: k.name, phone: "5555550100", shareOutstanding: 15000.5, ticker: symbol, weburl: k.web };
};

export const metricFor = (symbol) => {
  const k = KNOWN[symbol];
  if (!k) return {};
  const metric = { "52WeekHigh": k.high52, "52WeekLow": k.low52, beta: k.beta, dividendYieldIndicatedAnnual: k.yield, "10DayAverageTradingVolume": 51.2 };
  if (k.pe !== null) metric.peTTM = k.pe;
  if (k.eps !== null) metric.epsTTM = k.eps;
  return { metric, series: { annual: {} }, metricType: "all", symbol };
};

// mode: "open" | "closed" | "pre" | "post" | "holiday"
export const statusFor = (mode = "open") => ({
  exchange: "US",
  holiday: mode === "holiday" ? "Thanksgiving Day" : null,
  isOpen: mode === "open" || mode === "pre" || mode === "post",
  session: mode === "open" ? "regular" : mode === "pre" ? "pre-market" : mode === "post" ? "post-market" : null,
  t: 1793223480,
  timezone: "America/New_York",
});

export const searchFor = (q) => {
  const text = String(q).toLowerCase();
  const result = [];
  if (text.includes("quillfern") || text === "qfrn" || text === "quill") {
    result.push({ description: "QUILLFERN SYSTEMS INC", displaySymbol: "QFRN", symbol: "QFRN", type: "Common Stock" });
    result.push({ description: "QUILLFERN SYSTEMS INC", displaySymbol: "QFRN.DE", symbol: "QFRN.DE", type: "Common Stock" });
    result.push({ description: "QUILLFERN SYSTEMS INC - WARRANT", displaySymbol: "QFRNW", symbol: "QFRNW", type: "Warrant" });
  }
  if (text.includes("brambleton") || text === "brmb") result.push({ description: "BRAMBLETON FOODS CO", displaySymbol: "BRMB", symbol: "BRMB", type: "Common Stock" });
  if (text.includes("midsummer") || text === "mids") result.push({ description: "MIDSUMMER OPTICS LTD", displaySymbol: "MIDS", symbol: "MIDS", type: "ETP" });
  if (text.includes("berlin") || text === "bmbh") result.push({ description: "BERLIN MOTOR WERKE", displaySymbol: "BMBH.DE", symbol: "BMBH.DE", type: "Common Stock" });
  if (text === "zzz") result.push({ description: "ZZZ SLEEP CORP", displaySymbol: "ZZZ", symbol: "ZZZ", type: "Common Stock" });
  return { count: result.length, result };
};

// A gentle invented curve: about 35 hourly closes
export const candlesFor = (symbol) => {
  const k = KNOWN[symbol];
  if (!k) return { s: "no_data" };
  const c = Array.from({ length: 35 }, (_, i) => round(k.prev * (1 + Math.sin(i / 5) * 0.012 + (i / 35) * ((k.price - k.prev) / k.prev)), 2));
  const t = c.map((_, i) => 1792800000 + i * 3600);
  return { c, h: c.map((v) => v + 0.3), l: c.map((v) => v - 0.3), o: c, s: "ok", t, v: c.map(() => 1000) };
};
