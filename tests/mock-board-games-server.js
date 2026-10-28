// Local stand-in for every upstream of the board-games plugin, used only for integration checks.
// One server, one base URL, path-routed:
//   /xmlapi2/search, /xmlapi2/thing   BoardGameGeek XML API (needs "Authorization: Bearer test-token", else 401)
//   /recommend/api/games/             recommend.games
//   /geekdo/api/geekitems, /geekdo/api/dynamicinfo   BoardGameGeek's website JSON API (game 900001 only, else 404)
//   /wikidata/w/api.php               Wikidata (search and wbgetentities)
// Failure switches, by a word in the search term:
//   "apidown" -> the XML API search answers 503     "recdown" -> recommend.games answers 503
//   "cfblock" -> from then on the geekdo endpoints answer a Cloudflare-style 403 page (GET /__reset clears it)
//   "quota"   -> the XML API and recommend.games answer 429     "zzz" -> every search finds nothing
// Invented titles that are ALSO video games in the game-info mock (BGG ids 910101...): "moonharvest" (board 2023), "tiebreak"
// (board 2020), "driftwood" (board 2018). "starfall" (board 2019) is the main fixture game. Searching exactly for one of them
// returns just that game from the XML API (search and thing) and from recommend.games.
// MOCK_RG_UNORDERED_DELAY_MS=17000 makes recommend.games answer slowly unless the request asks for an explicit ordering
// (ordering=-num_votes), like the real service: 15 to 20 s without it, 1 to 2 s with it.
// MOCK_DELAY_MS=4000 (environment) makes every answer except /__stats and /__reset wait that long first, to try a slow upstream.
// GET /__stats reports the requests served per upstream.
// Usage: bun tests/mock-board-games-server.js [port]
// Point the plugin at it:  DEGOOG_BGG_API_BASE=http://host:4469/xmlapi2  DEGOOG_RECOMMEND_GAMES_BASE=http://host:4469/recommend
//   DEGOOG_GEEKDO_BASE=http://host:4469/geekdo/api  DEGOOG_WIKIDATA_API=http://host:4469/wikidata/w/api.php
const port = Number(process.argv[2] || 4469);
const delayMs = Number(process.env.MOCK_DELAY_MS || 0);
const unorderedDelayMs = Number(process.env.MOCK_RG_UNORDERED_DELAY_MS || 0);
const text = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const json = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
const search = await text("bgg-search.xml");
const thing = await text("bgg-thing.xml");
const recommend = await json("recommend-games-search.json");
const geekitem = await json("geekdo-geekitem.json");
const dynamicinfo = await json("geekdo-dynamicinfo.json");
const wikidataSearch = await json("wikidata-search.json");
const wikidataEntities = await json("wikidata-entities.json");

const fresh = () => ({
  bgg: { search: 0, thing: 0, unauthorized: 0 },
  recommend: { search: 0 },
  geekdo: { geekitems: 0, dynamicinfo: 0 },
  wikidata: { search: 0, entities: 0 },
});
let stats = fresh();
let cfblock = false;

const xml = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml; charset=utf-8" } });
const cloudflare = () =>
  new Response('<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>', {
    status: 403,
    headers: { "content-type": "text/html; charset=UTF-8", "cf-mitigated": "challenge" },
  });

// The fixture's items, so a thing request can be answered for just the ids that were asked for.
const itemBlocks = thing.match(/<item\b[\s\S]*?<\/item>/g) ?? [];

const extras = {
  moonharvest: { id: 910101, name: "Moonharvest", year: 2023 },
  tiebreak: { id: 910102, name: "Tiebreak", year: 2020 },
  driftwood: { id: 910103, name: "Driftwood", year: 2018 },
};
const extraFor = (term) => extras[String(term ?? "").trim().toLowerCase()] ?? null;
const extraSearch = (game) =>
  `<?xml version="1.0" encoding="utf-8"?><items total="1" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"><item type="boardgame" id="${game.id}"><name type="primary" value="${game.name}" /><yearpublished value="${game.year}" /></item></items>`;
const extraBlock = (game) =>
  `<item type="boardgame" id="${game.id}"><thumbnail>https://cf.geekdo-images.com/placeholder/img/thumb-${game.id}.jpg</thumbnail><image>https://cf.geekdo-images.com/placeholder/img/full-${game.id}.jpg</image><name type="primary" sortindex="1" value="${game.name}" /><description>An invented board game with the same title as an invented video game. This text is made up for tests.</description><yearpublished value="${game.year}" /><minplayers value="1" /><maxplayers value="4" /><playingtime value="60" /><minplaytime value="30" /><maxplaytime value="60" /><minage value="10" /><link type="boardgamecategory" id="1" value="Farming" /><link type="boardgamemechanic" id="2" value="Set Collection" /><link type="boardgamedesigner" id="3" value="Invented Designer" /><statistics page="1"><ratings><usersrated value="9000" /><average value="7.8" /><bayesaverage value="7.5" /><ranks><rank type="subtype" id="1" name="boardgame" friendlyname="Board Game Rank" value="120" bayesaverage="7.5" /></ranks><averageweight value="2.1" /></ratings></statistics></item>`;
const extraRecommend = (game) => ({
  ...recommend.results[0],
  bgg_id: game.id,
  name: game.name,
  alt_name: [],
  year: game.year,
  num_votes: 9000,
  url: `https://boardgamegeek.com/boardgame/${game.id}`,
});

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    if (url.pathname === "/__reset") {
      stats = fresh();
      cfblock = false;
      return Response.json({ reset: true });
    }
    // Only the method and path are logged: never a query string or a header.
    console.log(`MOCK ${request.method} ${url.pathname}`);
    if (delayMs > 0) await Bun.sleep(delayMs);

    if (url.pathname.startsWith("/xmlapi2/")) {
      if (request.headers.get("authorization") !== "Bearer test-token") {
        stats.bgg.unauthorized += 1;
        return new Response("Unauthorized. See https://boardgamegeek.com/using_the_xml_api", { status: 401 });
      }
      if (url.pathname === "/xmlapi2/search") {
        stats.bgg.search += 1;
        const query = url.searchParams.get("query") ?? "";
        if (query.includes("apidown")) return new Response("Service Unavailable", { status: 503 });
        if (query.includes("quota")) return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
        if (query.includes("zzz")) return xml('<?xml version="1.0" encoding="utf-8"?><items total="0" termsofuse="https://boardgamegeek.com/xmlapi/termsofuse"></items>');
        const only = extraFor(query);
        if (only) return xml(extraSearch(only));
        return xml(search);
      }
      if (url.pathname === "/xmlapi2/thing") {
        stats.bgg.thing += 1;
        const ids = new Set((url.searchParams.get("id") ?? "").split(","));
        const blocks = [...itemBlocks.filter((block) => ids.has(/\bid="(\d+)"/.exec(block)?.[1])), ...Object.values(extras).filter((game) => ids.has(String(game.id))).map(extraBlock)];
        return xml(`<?xml version="1.0" encoding="utf-8"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">${blocks.join("\n")}</items>`);
      }
    }

    if (url.pathname === "/recommend/api/games/") {
      stats.recommend.search += 1;
      const term = url.searchParams.get("search") ?? "";
      if (unorderedDelayMs > 0 && !url.searchParams.get("ordering")) await Bun.sleep(unorderedDelayMs);
      if (term.includes("recdown")) return new Response("Bad gateway", { status: 503 });
      if (term.includes("quota")) return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
      if (term.includes("zzz")) return Response.json({ count: 0, next: null, previous: null, results: [] });
      const only = extraFor(term);
      if (only) return Response.json({ count: 1, next: null, previous: null, results: [extraRecommend(only)] });
      return Response.json(recommend);
    }

    if (url.pathname === "/geekdo/api/geekitems" || url.pathname === "/geekdo/api/dynamicinfo") {
      const which = url.pathname.endsWith("geekitems") ? "geekitems" : "dynamicinfo";
      stats.geekdo[which] += 1;
      if (cfblock) return cloudflare();
      if (url.searchParams.get("objectid") !== "900001" || url.searchParams.get("objecttype") !== "thing") {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return Response.json(which === "geekitems" ? geekitem : dynamicinfo);
    }

    if (url.pathname === "/wikidata/w/api.php") {
      const action = url.searchParams.get("action");
      if (action === "query") {
        stats.wikidata.search += 1;
        const term = url.searchParams.get("srsearch") ?? "";
        if (term.includes("cfblock")) cfblock = true;
        if (term.includes("zzz")) return Response.json({ batchcomplete: "", query: { searchinfo: { totalhits: 0 }, search: [] } });
        return Response.json(wikidataSearch);
      }
      if (action === "wbgetentities") {
        stats.wikidata.entities += 1;
        const ids = new Set((url.searchParams.get("ids") ?? "").split("|"));
        const entities = Object.fromEntries(Object.entries(wikidataEntities.entities).filter(([id]) => ids.has(id)));
        return Response.json({ entities, success: 1 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});
console.log(`mock board-games upstreams listening on ${port}`);
