// Local stand-in for the Marginalia API, used only for integration checks.
// Usage: bun tests/mock-marginalia-server.js [port]
const port = Number(process.argv[2] || 4466);
const fixture = await Bun.file(new URL("./fixtures/marginalia-search.json", import.meta.url)).json();

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const hasKey = request.headers.get("api-key") === "test-key-123";
    console.log(`MOCK ${request.method} ${url.pathname}${url.search} api-key-header=${hasKey ? "ok" : "missing"}`);
    return Response.json(fixture);
  },
});
console.log(`mock marginalia listening on ${port}`);
