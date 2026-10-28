// Local stand-in for Reddit's public Atom search feed, used only for integration checks. It serves the hand-written fixture
// (invented posts) for GET /search.rss and GET /r/<names>/search.rss.
//   q containing "rate"    -> 429 with Retry-After: 120
//   q containing "blocked" -> 403 with an HTML "You've been blocked by network security." page
//   q containing "zzz"     -> an empty feed
//   include_over_18=0      -> the NSFW fixture post (r/testnsfw) is left out
//   after=t3_xxxx          -> posts after that one;   MOCK_PAGE_SIZE=3 (environment) makes pages that small (default 25)
// GET /__stats counts requests, GET /__last shows the parameters of the last search request (never a header value other than
// the user agent), GET /__reset clears both.
// Usage: bun tests/mock-reddit-server.js [port]
// Point the engine at it with DEGOOG_REDDIT_FEED_BASE=http://host:4472
const port = Number(process.argv[2] || 4472);
const pageSize = Math.max(1, Number(process.env.MOCK_PAGE_SIZE || 25));
const xml = await Bun.file(new URL("./fixtures/reddit-search.atom.xml", import.meta.url)).text();

const head = xml.slice(0, xml.indexOf("<entry>"));
const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? [];
const idOf = (entry) => /<id>([^<]*)<\/id>/.exec(entry)?.[1] ?? "";
const nonPosts = entries.filter((entry) => !idOf(entry).startsWith("t3_"));
const posts = entries.filter((entry) => idOf(entry).startsWith("t3_"));

let stats = { requests: 0, ok: 0, throttled: 0, blocked: 0 };
let last = null;

const feed = (list) => `${head}${list.join("")}</feed>\n`;

Bun.serve({
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    if (url.pathname === "/__last") return Response.json(last ?? {});
    if (url.pathname === "/__reset") {
      stats = { requests: 0, ok: 0, throttled: 0, blocked: 0 };
      last = null;
      return Response.json({ reset: true });
    }
    // Only the method and path are logged: never a query.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (!/^\/(?:r\/[A-Za-z0-9_+]+\/)?search\.rss$/.test(url.pathname)) return new Response("not found", { status: 404 });

    stats.requests += 1;
    const params = Object.fromEntries(url.searchParams);
    last = { path: url.pathname, ...params, userAgent: request.headers.get("user-agent") ?? "" };
    const query = params.q ?? "";
    if (query.includes("rate")) {
      stats.throttled += 1;
      return new Response("Too Many Requests", { status: 429, headers: { "retry-after": "120" } });
    }
    if (query.includes("blocked")) {
      stats.blocked += 1;
      return new Response("<!DOCTYPE html><html><head><title>Blocked</title></head><body><h1>Whoa there, pardner!</h1><p>You've been blocked by network security.</p></body></html>", {
        status: 403,
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }
    stats.ok += 1;
    const headers = { "content-type": "application/atom+xml; charset=UTF-8" };
    if (query.includes("zzz")) return new Response(feed([]), { headers });

    let list = posts.filter((entry) => params.include_over_18 === "1" || !entry.includes('label="r/testnsfw"'));
    const wanted = /^\/r\/([A-Za-z0-9_+]+)\//.exec(url.pathname)?.[1]?.split("+").map((name) => name.toLowerCase());
    if (wanted && params.restrict_sr === "1") list = list.filter((entry) => wanted.includes((/label="r\/([^"]*)"/.exec(entry)?.[1] ?? "").toLowerCase()));
    if (/^t3_/.test(params.after ?? "")) {
      const at = list.findIndex((entry) => idOf(entry) === params.after);
      list = at >= 0 ? list.slice(at + 1) : [];
    }
    const page = list.slice(0, pageSize);
    return new Response(feed(params.after ? page : [...nonPosts, ...page]), { headers });
  },
});
console.log(`mock reddit feed listening on ${port}`);
