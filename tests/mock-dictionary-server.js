// Local stand-in for the Free Dictionary API, used only for integration checks.
//   GET /api/v2/entries/en/<word>           florbit and quillfern (invented words) are found; "florbits" and anything else is 404;
//                                           "limitword" answers 429 (Retry-After 90); "slowword" waits 3 s; "boomword" answers 500
//   GET /media/pronunciations/en/<file>     a few bytes of "audio" (audio/mpeg); "bad-" files answer text/html
// GET /__stats reports how many requests each route served. Usage: bun tests/mock-dictionary-server.js [port]
// Point the plugin at it with DEGOOG_DICTIONARY_API_BASE=http://host:4490 and DEGOOG_DICTIONARY_MEDIA_BASE=http://host:4490.
const port = Number(process.argv[2] || 4490);
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
const florbit = await read("dictionary-florbit.json");
const quillfern = await read("dictionary-quillfern.json");
const notFound = await read("dictionary-not-found.json");
const stats = { lookups: 0, found: 0, notFound: 0, throttled: 0, errors: 0, media: 0 };
const clip = new Uint8Array(Array.from({ length: 2048 }, (_, i) => (i * 31) % 251));

const rate = { "x-ratelimit-limit": "450", "x-ratelimit-remaining": "448", "x-ratelimit-reset": "30" };

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    // Only the method and path are logged.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    const entry = /^\/api\/v2\/entries\/en\/(.+)$/.exec(url.pathname);
    if (entry) {
      stats.lookups += 1;
      const word = decodeURIComponent(entry[1]).toLowerCase();
      if (word === "limitword") {
        stats.throttled += 1;
        return Response.json({ message: "Too many requests" }, { status: 429, headers: { "retry-after": "90" } });
      }
      if (word === "boomword") {
        stats.errors += 1;
        return Response.json({ message: "internal" }, { status: 500 });
      }
      if (word === "slowword") await Bun.sleep(3000);
      if (word === "florbit" || word === "slowword") {
        stats.found += 1;
        return Response.json(florbit, { headers: rate });
      }
      if (word === "quillfern") {
        stats.found += 1;
        return Response.json(quillfern, { headers: rate });
      }
      stats.notFound += 1;
      return Response.json(notFound, { status: 404, headers: rate });
    }
    if (url.pathname.startsWith("/media/pronunciations/en/")) {
      stats.media += 1;
      if (url.pathname.includes("/bad-")) return new Response("<html>no</html>", { headers: { "content-type": "text/html" } });
      return new Response(clip, { headers: { "content-type": "audio/mpeg", "content-length": String(clip.length) } });
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock dictionary listening on ${port}`);
