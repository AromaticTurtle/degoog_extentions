// Local stand-in for selfhst/cdn's directory files, used only for integration checks.
// Serves tests/fixtures/selfhst/<name>.json with an ETag and honours If-None-Match.
// Usage: bun tests/mock-selfhst-server.js [port]
const port = Number(process.argv[2] || 4466);

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const match = /^\/([a-z]+)\.json$/.exec(url.pathname);
    const ifNoneMatch = request.headers.get("if-none-match");
    console.log(`MOCK ${url.pathname} if-none-match=${ifNoneMatch ?? "none"}`);
    if (!match) return new Response("not found", { status: 404 });
    const file = Bun.file(new URL(`./fixtures/selfhst/${match[1]}.json`, import.meta.url));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const body = await file.text();
    const etag = `"mock-${match[1]}-${body.length}"`;
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers: { etag } });
    return new Response(body, { headers: { etag, "content-type": "text/plain; charset=utf-8" } });
  },
});
console.log(`mock selfhst directory listening on ${port}`);
