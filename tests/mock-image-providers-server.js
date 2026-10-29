// Local stand-in for the Pixabay, Pexels and Openverse image APIs, used only for integration checks (invented data, tests/fixtures).
//   GET /pixabay/api/?key=test-pixabay-key&q=...        Pixabay: the key must be the "key" parameter
//   GET /pexels/v1/search?query=...                      Pexels: the key must be the Authorization header (test-pexels-key)
//   GET /openverse/v1/images/?q=...                      Openverse: anonymous, or "Authorization: Bearer <token>" after the token call
//   POST /openverse/v1/auth_tokens/token/                client_credentials with id test-ov-id and secret test-ov-secret
//   GET /img/<provider>/...   a coloured SVG;  GET /page/<provider>/...  a tiny html page (the "source pages")
// Modes: GET /__mode?pixabay=ok|429|500|empty|slow|badkey&pexels=...&openverse=...&token=ok|fail
// A query containing "quota" answers 429 and "empty" returns no results, whatever the mode. GET /__delay?ms=2000 slows every reply.
// GET /__stats counts requests per route and records WHERE the credential was (never the credential itself): keyInUrl, keyInHeader.
// Usage: bun tests/mock-image-providers-server.js [port] [public base, default http://localhost:<port>]
// Point the engines at it with DEGOOG_PIXABAY_API_BASE=<base>/pixabay/api, DEGOOG_PEXELS_API_BASE=<base>/pexels/v1,
// DEGOOG_OPENVERSE_API_BASE=<base>/openverse/v1 and DEGOOG_*_EXTRA_HOSTS=<the mock's host name> (Pixabay, Pexels).
const port = Number(process.argv[2] || 4470);
const publicBase = (process.argv[3] || `http://localhost:${port}`).replace(/\/+$/, "");
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const fixtures = {
  pixabay: await read("pixabay-search.json"),
  pexels: await read("pexels-search.json"),
  openverse: await read("openverse-images.json"),
  token: await read("openverse-token.json"),
};

const KEYS = { pixabay: "test-pixabay-key", pexels: "test-pexels-key", id: "test-ov-id", secret: "test-ov-secret" };
const stats = { pixabay: 0, pexels: 0, openverse: 0, token: 0, images: 0, throttled: 0, errors: 0, last: {} };
const mode = { pixabay: "ok", pexels: "ok", openverse: "ok", token: "ok" };
let delay = 0;
let issuedToken = "";

// the fixtures name the real hosts; the mock serves them itself so thumbnails and source pages load in the browser
const localise = (text) =>
  text.replace(/https?:\/\/([a-z0-9.-]+)\/([^"]*)/g, (whole, host, path) => {
    if (/(^|\.)pixabay\.com$/.test(host)) return host === "pixabay.com" && !path.startsWith("get/") ? `${publicBase}/page/pixabay/${path}` : `${publicBase}/img/pixabay/${path}`;
    if (/(^|\.)pexels\.com$/.test(host)) return host.startsWith("images.") ? `${publicBase}/img/pexels/${path}` : `${publicBase}/page/pexels/${path}`;
    if (host === "api.openverse.org" && path.includes("/thumb/")) return `${publicBase}/img/openverse/${path.split("/")[2]}`;
    if (host.endsWith("example.test")) return /\.(jpg|png)$/.test(path) ? `${publicBase}/img/openverse/${host}/${path}` : `${publicBase}/page/openverse/${host}/${path}`;
    return whole;
  });

const hash = (text) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const svg = (seed) => {
  const h = hash(seed) % 360;
  const label = (seed.split("/").pop() || "image").slice(0, 24).replace(/[<&]/g, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="${420 + (hash(seed) % 4) * 40}" viewBox="0 0 640 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},60%,62%)"/><stop offset="1" stop-color="hsl(${(h + 60) % 360},55%,38%)"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><text x="24" y="392" font-family="sans-serif" font-size="22" fill="#fff">${label}</text></svg>`;
};

const reply = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "application/json", ...headers } });

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    if (url.pathname === "/__mode") {
      for (const name of Object.keys(mode)) if (url.searchParams.has(name)) mode[name] = url.searchParams.get(name);
      return Response.json(mode);
    }
    if (url.pathname === "/__delay") {
      delay = Number(url.searchParams.get("ms") || 0);
      return Response.json({ delay });
    }
    // Only the method and path are logged: never a query string or a credential.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (url.pathname.startsWith("/img/")) {
      stats.images += 1;
      return new Response(svg(decodeURIComponent(url.pathname)), { headers: { "content-type": "image/svg+xml" } });
    }
    if (url.pathname.startsWith("/page/")) return new Response("<!doctype html><title>source page</title><p>An invented source page.</p>", { headers: { "content-type": "text/html" } });
    if (delay) await Bun.sleep(delay);

    if (url.pathname === "/pixabay/api/") {
      stats.pixabay += 1;
      const query = url.searchParams.get("q") ?? "";
      stats.last.pixabay = { keyInUrl: url.searchParams.has("key"), keyInHeader: Boolean(request.headers.get("authorization") || request.headers.get("x-api-key")), params: [...url.searchParams.keys()].filter((name) => name !== "key").sort() };
      if (mode.pixabay === "badkey" || url.searchParams.get("key") !== KEYS.pixabay) return new Response("[ERROR 400] Invalid API key", { status: 400 });
      if (mode.pixabay === "429" || query.includes("quota")) {
        stats.throttled += 1;
        return new Response("API rate limit exceeded", { status: 429, headers: { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "42" } });
      }
      if (mode.pixabay === "500") return new Response("boom", { status: 500 });
      if (mode.pixabay === "slow") await Bun.sleep(12_000);
      if (Number(url.searchParams.get("page") || 1) > 3) return new Response('[ERROR 400] "page" is out of valid range.', { status: 400 });
      const body = mode.pixabay === "empty" || query.includes("empty") ? { total: 0, totalHits: 0, hits: [] } : JSON.parse(localise(fixtures.pixabay));
      return reply(JSON.stringify(body), 200, { "x-ratelimit-limit": "100", "x-ratelimit-remaining": "97", "x-ratelimit-reset": "52" });
    }

    if (url.pathname === "/pexels/v1/search") {
      stats.pexels += 1;
      const query = url.searchParams.get("query") ?? "";
      stats.last.pexels = { keyInUrl: [...url.searchParams.keys()].some((name) => /key|token|auth/i.test(name)), keyInHeader: Boolean(request.headers.get("authorization")), bearerPrefix: /^Bearer /i.test(request.headers.get("authorization") ?? ""), params: [...url.searchParams.keys()].sort() };
      if (request.headers.get("authorization") !== KEYS.pexels) return reply(JSON.stringify({ error: "Unauthorized" }), 401);
      if (mode.pexels === "429" || query.includes("quota")) {
        stats.throttled += 1;
        return reply(JSON.stringify({ error: "Too many requests" }), 429);
      }
      if (mode.pexels === "403") return reply(JSON.stringify({ error: "Forbidden" }), 403);
      if (mode.pexels === "500") return new Response("boom", { status: 500 });
      if (mode.pexels === "slow") await Bun.sleep(12_000);
      const body = mode.pexels === "empty" || query.includes("empty") ? { total_results: 0, page: 1, per_page: 30, photos: [] } : JSON.parse(localise(fixtures.pexels));
      return reply(JSON.stringify(body), 200, { "x-ratelimit-limit": "20000", "x-ratelimit-remaining": "19950", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 86400 * 20) });
    }

    if (url.pathname === "/openverse/v1/auth_tokens/token/" && request.method === "POST") {
      stats.token += 1;
      const form = new URLSearchParams(await request.text());
      stats.last.token = { grantType: form.get("grant_type"), contentType: request.headers.get("content-type") };
      if (mode.token === "fail" || form.get("client_id") !== KEYS.id || form.get("client_secret") !== KEYS.secret) return reply(JSON.stringify({ error: "invalid_client" }), 401);
      issuedToken = JSON.parse(fixtures.token).access_token;
      return reply(fixtures.token);
    }

    if (url.pathname === "/openverse/v1/images/") {
      stats.openverse += 1;
      const query = url.searchParams.get("q") ?? "";
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      stats.last.openverse = { authenticated: Boolean(bearer) && bearer === issuedToken, tokenInUrl: [...url.searchParams.keys()].some((name) => /token|secret/i.test(name)), mature: url.searchParams.get("mature"), params: [...url.searchParams.keys()].sort() };
      if (mode.openverse === "429" || query.includes("quota")) {
        stats.throttled += 1;
        return reply(JSON.stringify({ detail: "Request was throttled." }), 429, { "retry-after": "120" });
      }
      if (mode.openverse === "401") return reply(JSON.stringify({ detail: "Invalid token." }), 401);
      if (mode.openverse === "500") return new Response("boom", { status: 500 });
      if (mode.openverse === "slow") await Bun.sleep(12_000);
      if (Number(url.searchParams.get("page") || 1) > 3) return reply(JSON.stringify({ detail: "Pagination depth exceeded." }), 400);
      const body = mode.openverse === "empty" || query.includes("empty") ? { result_count: 0, page_count: 0, page_size: 20, page: 1, results: [] } : JSON.parse(localise(fixtures.openverse));
      return reply(JSON.stringify(body));
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock image providers listening on ${port} (public base ${publicBase})`);
