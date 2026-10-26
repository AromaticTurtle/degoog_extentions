// Local stand-in for BoardGameGeek's XML API, used only for integration checks.
// Needs the header "Authorization: Bearer test-token", else answers 401. A search containing "quota" answers 429,
// "zzz" finds nothing. /xmlapi2/thing only returns the requested ids. GET /__stats reports the requests served.
// Usage: bun tests/mock-board-games-server.js [port]
// Point the plugin at it with DEGOOG_BGG_API_BASE=http://host:4469/xmlapi2
const port = Number(process.argv[2] || 4469);
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const search = await read("bgg-search.xml");
const thing = await read("bgg-thing.xml");
const stats = { search: 0, thing: 0, unauthorized: 0 };

const xml = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });

// The fixture's items, so a thing request can be answered for just the ids that were asked for.
const itemBlocks = thing.match(/<item\b[\s\S]*?<\/item>/g) ?? [];

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    // Only the method and path are logged: never a query string or a header.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (request.headers.get("authorization") !== "Bearer test-token") {
      stats.unauthorized += 1;
      return new Response("Unauthorized. See https://boardgamegeek.com/using_the_xml_api", { status: 401 });
    }
    if (url.pathname === "/xmlapi2/search") {
      stats.search += 1;
      const query = url.searchParams.get("query") ?? "";
      if (query.includes("quota")) return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
      if (query.includes("zzz")) return xml('<?xml version="1.0" encoding="utf-8"?><items total="0" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"></items>');
      return xml(search);
    }
    if (url.pathname === "/xmlapi2/thing") {
      stats.thing += 1;
      const ids = new Set((url.searchParams.get("id") ?? "").split(","));
      const blocks = itemBlocks.filter((block) => ids.has(/\bid="(\d+)"/.exec(block)?.[1]));
      return xml(`<?xml version="1.0" encoding="utf-8"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">${blocks.join("\n")}</items>`);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock board-games upstream listening on ${port}`);
