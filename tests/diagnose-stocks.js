// Checks what YOUR Finnhub plan serves, and what the stocks plugin does with a query. Run it in your own terminal so the key never
// leaves your machine (fish shell):
//   read -sx FINNHUB_API_KEY; bun ./tests/diagnose-stocks.js AAPL; set -e FINNHUB_API_KEY
//   (bash: read -rs FINNHUB_API_KEY; export FINNHUB_API_KEY; bun ./tests/diagnose-stocks.js AAPL; unset FINNHUB_API_KEY)
// The argument is a ticker (default AAPL) or any query ("apple stock", "$AAPL"). It first prints, with NO request, how the plugin
// classifies the query. Then it makes at most 6 requests, one per endpoint, 1.2 s apart: /quote, /stock/profile2, /search,
// /stock/metric, /stock/market-status and /stock/candle. For each one it prints the status, whether the plan includes it, and the
// field NAMES it found (never values). The key goes only in the X-Finnhub-Token header; the output is refused if it contains the key.
import { BARE_STOPLIST, WELL_KNOWN } from "../plugins/stocks/stoplist.js";
import { parseQuery } from "../plugins/stocks/match.js";
import { DEFAULT_BASE, TOKEN_HEADER, candleUrl, clean, metricUrl, parseCandles, parseMetric, parseProfile, parseQuote, parseSearch, parseStatus, pickResult, profileUrl, quoteUrl, searchUrl, sessionOf, statusUrl } from "../plugins/stocks/finnhub.js";

const key = (process.env.FINNHUB_API_KEY ?? "").trim();
const argument = process.argv.slice(2).join(" ").trim() || "AAPL";
if (!key) {
  console.error("Set FINNHUB_API_KEY in the environment first (fish: read -sx FINNHUB_API_KEY).");
  process.exit(1);
}

const out = [];
const say = (line = "") => out.push(line);

const parsedQuery = parseQuery(argument, { bare: true });
say(`Query: "${argument}"`);
if (parsedQuery.parsed) {
  const p = parsedQuery.parsed;
  say(`  the plugin would treat it as: ${p.kind} (rule: ${p.rule}), symbol ${p.symbol || "(by company name: " + p.term + ")"}, ${p.direct ? "quoted directly" : "found through /search first"}`);
} else {
  say(`  the plugin would NOT look this up: ${parsedQuery.reason}`);
  say(`  (stoplisted: ${BARE_STOPLIST.has(argument.toUpperCase())}, well-known ticker: ${WELL_KNOWN.has(argument.toUpperCase())})`);
}
const symbol = (parsedQuery.parsed?.symbol || (/^\$?[A-Za-z.]{1,7}$/.test(argument) ? argument.replace(/^\$/, "") : "AAPL")).toUpperCase();
say(`  probing with the symbol ${symbol}`);
say();

const base = process.env.DEGOOG_STOCKS_API_BASE || DEFAULT_BASE;
const headers = { [TOKEN_HEADER]: key, "User-Agent": "degoog-stocks-diagnose/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)", Accept: "application/json" };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probe = async (name, url, describe) => {
  const started = performance.now();
  let line = `${name.padEnd(20)}`;
  try {
    const response = await fetch(url, { headers });
    const text = await response.text();
    const ms = Math.round(performance.now() - started);
    const plan = response.status === 200 ? "available" : response.status === 403 ? "NOT on your plan (403)" : response.status === 401 ? "KEY REJECTED (401)" : response.status === 429 ? "rate limited (429)" : `HTTP ${response.status}`;
    line += `${plan}, ${text.length} bytes, ${ms} ms`;
    say(line);
    if (response.status === 200) for (const detail of describe(text)) say(`    ${detail}`);
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (remaining !== null) say(`    rate limit headers: remaining=${remaining} limit=${response.headers.get("x-ratelimit-limit") ?? "-"}`);
    return response.status;
  } catch {
    say(`${line}network error`);
    return 0;
  }
};

const keysOf = (text) => {
  try {
    const json = JSON.parse(text);
    return Array.isArray(json) ? [`array of ${json.length}`] : Object.keys(json);
  } catch {
    return ["(not JSON)"];
  }
};

const first = await probe("quote", quoteUrl(base, symbol), (text) => {
  const quote = parseQuote(text);
  return [`fields: ${keysOf(text).join(",")}`, quote ? `usable: price ${quote.price > 0 ? "> 0" : "?"}, change ${quote.change === null ? "missing" : "ok"}, day range ${quote.low && quote.high ? "ok" : "missing"}, timestamp ${quote.time ? "ok" : "missing"}` : "NOT usable (c is zero: the symbol is unknown to this plan)"];
});
if (first === 401) {
  say();
  say("The key was rejected: nothing else was tried.");
} else {
  await sleep(1200);
  await probe("profile2", profileUrl(base, symbol), (text) => {
    const profile = parseProfile(text);
    const wanted = ["name", "ticker", "exchange", "logo", "marketCapitalization", "finnhubIndustry", "weburl", "currency"];
    let present = [];
    try {
      const json = JSON.parse(text);
      present = wanted.map((field) => `${field}:${json[field] ? "yes" : "no"}`);
    } catch {
      /* ignore */
    }
    return [`fields: ${present.join(" ")}`, profile ? `logo host accepted: ${profile.logo ? "yes" : "no (the card shows no logo)"}; exchange label: ${clean(profile.exchange, 40) || "-"}` : "NOT usable"];
  });
  await sleep(1200);
  await probe("search", searchUrl(base, argument.replace(/^\$/, "")), (text) => {
    const list = parseSearch(text) ?? [];
    const types = {};
    for (const r of list) types[r.type || "(empty)"] = (types[r.type || "(empty)"] ?? 0) + 1;
    const pick = pickResult(list, { term: argument.replace(/^\$/, "").toLowerCase() });
    return [`${list.length} results; types seen: ${Object.entries(types).map(([t, n]) => `${t} x${n}`).join(", ") || "-"}`, `the plugin would pick: ${pick ? pick.symbol : "nothing"}`];
  });
  await sleep(1200);
  await probe("metric", metricUrl(base, symbol), (text) => {
    const metric = parseMetric(text);
    return [metric ? `usable: ${Object.entries(metric).map(([k, v]) => `${k}:${v === null ? "no" : "yes"}`).join(" ")}` : "NOT usable"];
  });
  await sleep(1200);
  await probe("market-status", statusUrl(base, "US"), (text) => {
    const status = parseStatus(text);
    return [status ? `session seen: ${status.session || "(none)"}, isOpen ${status.isOpen}, the card shows: ${sessionOf(status)}` : "NOT usable"];
  });
  await sleep(1200);
  const candles = await probe("candle", candleUrl(base, symbol, Date.now() / 1000), (text) => {
    const parsed = parseCandles(text);
    return [`status field: ${(() => { try { return JSON.parse(text).s; } catch { return "?"; } })()}, usable points: ${parsed ? parsed.points.length : 0}`];
  });
  say();
  say(candles === 403 ? "Candles are not on your plan: the plugin tries once, remembers it for a day, and shows no sparkline." : candles === 200 ? "Candles work: the inline card draws a sparkline." : "Candles: see the line above.");
}

const report = out.join("\n");
if (report.includes(key)) {
  console.error("Refusing to print: the output contains the API key. Nothing was printed.");
  process.exit(1);
}
console.log(report);
