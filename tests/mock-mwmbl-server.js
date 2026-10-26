// Local stand-in for Mwmbl's v2 search API, used only for integration checks.
// A query containing "quota" answers 429 with Mwmbl's real monthly-quota wording.
// Usage: bun tests/mock-mwmbl-server.js [port]
const port = Number(process.argv[2] || 4466);
const fixture = await Bun.file(new URL("./fixtures/mwmbl-search.json", import.meta.url)).json();

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    console.log(`MOCK ${url.pathname} q=${query} x-api-key=${request.headers.get("x-api-key") ?? "none"}`);
    if (url.pathname !== "/api/v2/search/") return new Response("not found", { status: 404 });
    if (query.includes("quota")) {
      return new Response("Monthly quota exceeded: your account allows 2,000 requests per month and you have used 2,000.", { status: 429 });
    }
    return Response.json({ ...fixture, query });
  },
});
console.log(`mock mwmbl listening on ${port}`);
