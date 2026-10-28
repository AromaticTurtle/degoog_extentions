// Local stand-in for open.er-api.com and Coinbase's public APIs, used only for integration checks. One port serves all of:
//   GET /v6/latest/USD                  fiat rates (fixture)
//   GET /v2/prices/<CODE>-USD/spot      spot price (BTC, ETH, DOGE, SOL known; others 404)
//   GET /products/<CODE>-USD/stats      24 h stats (BTC, ETH known; others 404)
//   GET /v2/currencies/crypto           crypto list (fixture)
// GET /__mode?er=ok|429|500|bad&spot=ok|429&stats=ok|500 switches behaviour; GET /__delay?ms=2000 slows every reply.
// GET /__stats reports how many requests each endpoint served. Usage: bun tests/mock-currency-server.js [port]
// Point the plugin at it with DEGOOG_CURRENCY_ER_BASE, DEGOOG_CURRENCY_COINBASE_BASE and DEGOOG_CURRENCY_EXCHANGE_BASE
// (all three the same http://host:4480 address).
const port = Number(process.argv[2] || 4480);
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
const er = await read("er-api-usd.json");
const spotBtc = await read("coinbase-spot-btc.json");
const statsBtc = await read("coinbase-stats-btc.json");
const list = await read("coinbase-crypto-list.json");

const PRICES = { BTC: "64250.5", ETH: "3120.75", DOGE: "0.1534", SOL: "148.2" };
const STATS = { BTC: statsBtc, ETH: { ...statsBtc, open: "3050.00", high: "3180.00", low: "3010.00", last: "3120.75", volume: "88231.4" } };
const stats = { er: 0, spot: 0, stats: 0, list: 0, throttled: 0, errors: 0 };
const mode = { er: "ok", spot: "ok", stats: "ok" };
let delay = 0;

const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    if (url.pathname === "/__mode") {
      for (const key of Object.keys(mode)) if (url.searchParams.has(key)) mode[key] = url.searchParams.get(key);
      return Response.json(mode);
    }
    if (url.pathname === "/__delay") {
      delay = Number(url.searchParams.get("ms") || 0);
      return Response.json({ delay });
    }
    // Only the method and path are logged.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (delay) await Bun.sleep(delay);
    if (url.pathname === "/v6/latest/USD") {
      stats.er += 1;
      if (mode.er === "429") {
        stats.throttled += 1;
        return reply({ result: "error", "error-type": "quota-reached" }, 429, { "retry-after": "1200" });
      }
      if (mode.er === "500") {
        stats.errors += 1;
        return reply({ result: "error" }, 500);
      }
      if (mode.er === "bad") return reply({ result: "success", rates: {} });
      return reply(er, 200, { "cache-control": "max-age=3600" });
    }
    const spot = /^\/v2\/prices\/([A-Z0-9]+)-USD\/spot$/.exec(url.pathname);
    if (spot) {
      stats.spot += 1;
      if (mode.spot === "429") {
        stats.throttled += 1;
        return reply({ errors: [{ id: "rate_limit_exceeded" }] }, 429, { "retry-after": "30" });
      }
      const price = PRICES[spot[1]];
      if (!price) return reply({ errors: [{ id: "not_found", message: "Invalid currency" }] }, 404);
      return reply({ data: { ...spotBtc.data, base: spot[1], amount: price } }, 200, { "cache-control": "no-store" });
    }
    const productStats = /^\/products\/([A-Z0-9]+)-USD\/stats$/.exec(url.pathname);
    if (productStats) {
      stats.stats += 1;
      if (mode.stats === "500") {
        stats.errors += 1;
        return reply({ message: "internal" }, 500);
      }
      const body = STATS[productStats[1]];
      return body ? reply(body) : reply({ message: "NotFound" }, 404);
    }
    if (url.pathname === "/v2/currencies/crypto") {
      stats.list += 1;
      return reply(list, 200, { "cache-control": "max-age=14400" });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock currency listening on ${port}`);
