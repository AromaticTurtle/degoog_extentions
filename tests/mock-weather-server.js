// Local stand-in for Open-Meteo, used only for integration checks. One port serves all three services:
//   GET /v1/search        geocoding (tests/fixtures/open-meteo-geocode.json by lower-cased name; "zzzz" finds nothing,
//                         "quota" answers 429 with Retry-After, "boom" answers 500, "slow" waits 3 s then answers like "seattle")
//   GET /v1/forecast      a forecast built from invented numbers (tests/fixtures/open-meteo-builder.js), honouring the unit parameters
//   GET /v1/air-quality   current US AQI
// GET /__mode?forecast=ok|429|500|bad&air=ok|500 switches behaviour; GET /__delay?ms=2000 slows every reply.
// GET /__stats reports how many requests each service served and the last query strings. Usage: bun tests/mock-weather-server.js [port]
// Point the plugin at it with DEGOOG_WEATHER_FORECAST_BASE, DEGOOG_WEATHER_GEOCODING_BASE and DEGOOG_WEATHER_AIR_BASE
// (all three the same http://host:4500 address).
import { buildAir, buildForecast } from "./fixtures/open-meteo-builder.js";

const port = Number(process.argv[2] || 4500);
const geocode = await Bun.file(new URL("./fixtures/open-meteo-geocode.json", import.meta.url)).json();
const stats = { geocode: 0, forecast: 0, air: 0, throttled: 0, errors: 0, last: {} };
const mode = { forecast: "ok", air: "ok" };
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
    if (url.pathname === "/v1/search") {
      stats.geocode += 1;
      let name = String(url.searchParams.get("name") ?? "").toLowerCase().trim();
      stats.last.geocode = url.search;
      if (name === "quota") {
        stats.throttled += 1;
        return reply({ error: true, reason: "Daily API request limit exceeded." }, 429, { "retry-after": "120" });
      }
      if (name === "boom") {
        stats.errors += 1;
        return reply({ error: true, reason: "internal" }, 500);
      }
      if (name === "slow") {
        await Bun.sleep(3000);
        name = "seattle";
      }
      const results = geocode[name];
      return reply(results ? { results, generationtime_ms: 0.5 } : { generationtime_ms: 0.3 });
    }
    if (url.pathname === "/v1/forecast") {
      stats.forecast += 1;
      stats.last.forecast = url.search;
      if (mode.forecast === "429") {
        stats.throttled += 1;
        return reply({ error: true, reason: "Hourly API request limit exceeded." }, 429, { "retry-after": "90" });
      }
      if (mode.forecast === "500") {
        stats.errors += 1;
        return reply({ error: true, reason: "internal" }, 500);
      }
      if (mode.forecast === "bad") return reply({ latitude: 1, longitude: 2 });
      const imperial = url.searchParams.get("temperature_unit") === "fahrenheit";
      return reply(buildForecast({ system: imperial ? "imperial" : "metric", latitude: Number(url.searchParams.get("latitude")) || 0, longitude: Number(url.searchParams.get("longitude")) || 0 }));
    }
    if (url.pathname === "/v1/air-quality") {
      stats.air += 1;
      stats.last.air = url.search;
      if (mode.air === "500") {
        stats.errors += 1;
        return reply({ error: true }, 500);
      }
      return reply(buildAir());
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock weather listening on ${port}`);
