// Local stand-in for Unsplash's API and website endpoint, used only for integration checks.
// A query containing "quota" makes the official API answer 429, to exercise the fallback.
// Usage: bun tests/mock-unsplash-server.js [port]
const port = Number(process.argv[2] || 4466);
const fixture = await Bun.file(new URL("./fixtures/unsplash-search.json", import.meta.url)).json();

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const query = url.searchParams.get("query") ?? "";
    const auth = request.headers.get("authorization");
    console.log(`MOCK ${url.pathname} query=${query} authorization=${auth ?? "none"} orientation=${url.searchParams.get("orientation") ?? "-"}`);
    if (url.pathname === "/search/photos") {
      if (query.includes("quota")) return new Response("Rate Limit Exceeded", { status: 403 });
      if (auth !== "Client-ID test-access-key") return new Response("unauthorized", { status: 401 });
      return Response.json(fixture, { headers: { "x-ratelimit-remaining": "49" } });
    }
    if (url.pathname === "/napi/search/photos") return Response.json(fixture);
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock unsplash listening on ${port}`);
