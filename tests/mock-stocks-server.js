// Local stand-in for Finnhub's REST API, used only for integration checks. Serves /quote, /stock/profile2, /stock/metric,
// /stock/market-status, /search and /stock/candle from tests/fixtures/finnhub-data.js (INVENTED companies: QFRN, BRMB, MIDS).
// Every API request must carry the header "X-Finnhub-Token: test-key", else the answer is 401; a request whose URL contains a
// "token" parameter is refused with 400 and counted (the plugin must never put the key in a URL). A foreign symbol (BMBH.DE)
// answers 403, like the free plan does.
// GET /__mode?market=open|closed|pre|post|holiday&candles=ok|403|nodata&quote=ok|429|500&profile=ok|500 switches behaviour;
// GET /__delay?ms=2000 slows every reply. GET /__stats reports the request counts by endpoint. Usage: bun tests/mock-stocks-server.js [port]
// Point the plugin at it with DEGOOG_STOCKS_API_BASE=http://host:4510/api/v1
import { candlesFor, metricFor, profileFor, quoteFor, searchFor, statusFor } from "./fixtures/finnhub-data.js";

const port = Number(process.argv[2] || 4510);
const stats = { quote: 0, profile: 0, metric: 0, status: 0, search: 0, candle: 0, unauthorized: 0, tokenInUrl: 0, throttled: 0, errors: 0, forbidden: 0 };
const mode = { market: "open", candles: "ok", quote: "ok", profile: "ok" };
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
    // Only the method and path are logged: never a header or a query string.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (/token|apikey|api_key/i.test(url.search)) {
      stats.tokenInUrl += 1;
      return reply({ error: "a key in the URL is refused" }, 400);
    }
    if (request.headers.get("x-finnhub-token") !== "test-key") {
      stats.unauthorized += 1;
      return reply({ error: "Invalid API key" }, 401);
    }
    if (delay) await Bun.sleep(delay);
    const symbol = String(url.searchParams.get("symbol") ?? "").toUpperCase();
    const route = url.pathname.replace(/^\/api\/v1/, "");
    if (route === "/quote") {
      stats.quote += 1;
      if (mode.quote === "429") {
        stats.throttled += 1;
        return reply({ error: "API limit reached. Please try again later. Remaining Limit: 0" }, 429, { "retry-after": "30" });
      }
      if (mode.quote === "500") {
        stats.errors += 1;
        return reply({ error: "internal" }, 500);
      }
      if (symbol.includes(".")) {
        stats.forbidden += 1;
        return reply({ error: "You don't have access to this resource." }, 403);
      }
      return reply(quoteFor(symbol));
    }
    if (route === "/stock/profile2") {
      stats.profile += 1;
      if (mode.profile === "500") {
        stats.errors += 1;
        return reply({ error: "internal" }, 500);
      }
      return reply(profileFor(symbol));
    }
    if (route === "/stock/metric") {
      stats.metric += 1;
      return reply(metricFor(symbol));
    }
    if (route === "/stock/market-status") {
      stats.status += 1;
      return reply(statusFor(mode.market));
    }
    if (route === "/search") {
      stats.search += 1;
      return reply(searchFor(url.searchParams.get("q") ?? ""));
    }
    if (route === "/stock/candle") {
      stats.candle += 1;
      if (mode.candles === "403") {
        stats.forbidden += 1;
        return reply({ error: "You don't have access to this resource." }, 403);
      }
      return reply(mode.candles === "nodata" ? { s: "no_data" } : candlesFor(symbol));
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock stocks listening on ${port}`);
