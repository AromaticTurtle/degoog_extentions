// Local stand-in for Unsplash's official API, used only for integration checks.
// A query containing "quota" makes it answer 403 "Rate Limit Exceeded", like a spent demo quota.
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
    if (url.pathname !== "/search/photos") return new Response("not found", { status: 404 });
    if (query.includes("quota")) return new Response("Rate Limit Exceeded", { status: 403 });
    if (auth !== "Client-ID test-access-key") return new Response("unauthorized", { status: 401 });
    return Response.json(fixture, { headers: { "x-ratelimit-remaining": "49" } });
  },
});
console.log(`mock unsplash listening on ${port}`);
