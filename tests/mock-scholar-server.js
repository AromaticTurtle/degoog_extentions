// Local stand-in for the OpenAlex and CORE APIs, used only for integration checks.
// Usage: bun tests/mock-scholar-server.js [port]
const port = Number(process.argv[2] || 4466);
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
const openAlex = await read("openalex-search.json");
const core = await read("core-search.json");

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization");
    console.log(`MOCK ${request.method} ${url.pathname}${url.search} authorization=${auth ? "present" : "none"}`);
    if (url.pathname === "/works") return Response.json(openAlex);
    if (url.pathname === "/v3/search/works/") return Response.json(core);
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock scholar apis listening on ${port}`);
