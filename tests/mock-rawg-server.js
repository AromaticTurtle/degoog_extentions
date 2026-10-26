// Local stand-in for the RAWG API, used only for integration checks.
// The key must be "test-key" (query parameter, like the real API). A search containing "quota" answers 429,
// "brokenkey" answers 401, and "zzz" finds nothing. GET /__stats reports how many requests were served.
// Usage: bun tests/mock-rawg-server.js [port]
const port = Number(process.argv[2] || 4467);
const search = await Bun.file(new URL("./fixtures/rawg-search.json", import.meta.url)).json();
const detail = await Bun.file(new URL("./fixtures/rawg-detail.json", import.meta.url)).json();
const stats = { search: 0, detail: 0 };

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    const query = url.searchParams.get("search") ?? "";
    console.log(`MOCK ${url.pathname} search=${query} key=${url.searchParams.get("key") ? "set" : "none"}`);
    if (url.searchParams.get("key") !== "test-key") return Response.json({ detail: "Invalid key" }, { status: 401 });
    if (url.pathname === "/games") {
      stats.search += 1;
      if (query.includes("quota")) return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
      if (query.includes("brokenkey")) return new Response("no", { status: 401 });
      if (query.includes("zzz")) return Response.json({ count: 0, results: [] });
      return Response.json(search);
    }
    if (/^\/games\/\d+$/.test(url.pathname)) {
      stats.detail += 1;
      return Response.json(detail);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock rawg listening on ${port}`);
