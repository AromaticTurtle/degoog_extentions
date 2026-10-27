// Local stand-in for Hardcover's GraphQL API, used only for integration checks.
// POST /v1/graphql needs the header "authorization: Bearer test-token", else it answers 401.
// Switches by the search term: "quota" answers 429 (Retry-After 120), "scope" answers 403 insufficient_scope,
// "gqlerror" answers HTTP 200 with an errors list, "slow" waits 3 s, "zzz" finds nothing. Everything else returns the fixture.
// GET /__stats reports how many requests were served, by outcome.
// Usage: bun tests/mock-books-server.js [port]
// Point the plugin at it with DEGOOG_HARDCOVER_API_URL=http://host:4470/v1/graphql
const port = Number(process.argv[2] || 4470);
const fixture = await Bun.file(new URL("./fixtures/hardcover-search.json", import.meta.url)).json();
const stats = { requests: 0, unauthorized: 0, throttled: 0, refused: 0, errors: 0, searches: 0 };

const reply = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    // Only the method and path are logged: never a body or a header.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (url.pathname !== "/v1/graphql" || request.method !== "POST") return new Response("not found", { status: 404 });
    stats.requests += 1;
    if (request.headers.get("authorization") !== "Bearer test-token") {
      stats.unauthorized += 1;
      return reply({ error: "invalid_token", error_description: "The access token is invalid" }, 401);
    }
    let term = "";
    try {
      term = String((await request.json())?.variables?.q ?? "");
    } catch {
      return reply({ error: "Malformed request body" }, 400);
    }
    if (term.includes("quota")) {
      stats.throttled += 1;
      return reply({ error: "Too Many Requests", message: "try again later" }, 429, { "retry-after": "120", ratelimit: '"Free";r=0;t=120, "daily";r=4000;t=3600' });
    }
    if (term.includes("scope")) {
      stats.refused += 1;
      return reply({ error: "insufficient_scope", error_description: "The token is missing a scope", scope: "read:catalog" }, 403);
    }
    if (term.includes("gqlerror")) {
      stats.errors += 1;
      return reply({ errors: [{ message: "field 'search' timed out", extensions: { code: "timeout" } }] });
    }
    if (term.includes("slow")) await Bun.sleep(3000);
    stats.searches += 1;
    if (term.includes("zzz")) return reply({ data: { search: { results: { found: 0, hits: [], page: 1 } } } });
    return reply(fixture, 200, { ratelimit: '"Free";r=9;t=0, "daily";r=4999;t=3600' });
  },
});
console.log(`mock hardcover listening on ${port}`);
