// Tests for the three data sources of the board-games plugin (BGG XML API, recommend.games, BGG's website JSON API
// with Wikidata) and the fallback chain between them.
//
// NOTE: every fixture used here is HAND-WRITTEN to the documented or observed layout of the upstream and holds INVENTED
// games, texts and numbers ("Starfall" and friends, ids from 900001, invented Wikidata Q-ids). None of it is a real
// recording. The layouts were checked against the live services (field names and types only) while building.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, geekdoUsageFile, recommendGamesUsageFile, usageFile } from "../plugins/board-games/budget.js";
import { Upstream } from "../plugins/board-games/upstream.js";
import { looksBlocked } from "../plugins/board-games/request.js";
import {
  RECOMMEND_MAX_RESULTS,
  blankGame,
  compactGeekdo,
  compactRecommendGame,
  geekdoId,
  isGeekdoBoardGame,
  isRecommendExpansion,
  parseRecommendGames,
  rangeText,
} from "../plugins/board-games/shape.js";
import { attributionHtml, buildPanel } from "../plugins/board-games/render.js";
import { BoardGamesSlot } from "../plugins/board-games/index.js";
import { DEFAULT_RECOMMEND_BASE, recommendSearchUrl } from "../plugins/board-games/sources/recommend-games.js";
import { DEFAULT_GEEKDO_BASE, dynamicInfoUrl, geekitemsUrl } from "../plugins/board-games/sources/bgg-internal.js";
import {
  BGG_ID_PROPERTY,
  DEFAULT_WIKIDATA_API,
  parseEntities,
  parseSearchQids,
  wikidataEntitiesUrl,
  wikidataSearchUrl,
} from "../plugins/board-games/sources/wikidata.js";

const readText = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const readJson = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
const searchXml = await readText("bgg-search.xml");
const thingXml = await readText("bgg-thing.xml");
const recommendText = await readText("recommend-games-search.json");
const recommendFixture = JSON.parse(recommendText);
const geekitem = await readJson("geekdo-geekitem.json");
const dynamicinfo = await readJson("geekdo-dynamicinfo.json");
const wikidataSearch = await readJson("wikidata-search.json");
const wikidataEntities = await readJson("wikidata-entities.json");

const TOKEN = "test-bgg-token-5d7e1b9c2a";
const folders = [];
afterEach(() => {
  while (folders.length) rmSync(folders.pop(), { recursive: true, force: true });
});
const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "board-games-sources-"));
  folders.push(folder);
  return folder;
};

const withEnv = async (vars, work) => {
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const capture = async (work) => {
  const lines = [];
  const originals = {};
  for (const method of ["log", "warn", "error", "info", "debug"]) {
    originals[method] = console[method];
    console[method] = (...args) => lines.push(args.join(" "));
  }
  try {
    await work();
  } finally {
    Object.assign(console, originals);
  }
  return lines;
};

// ---- a fake world: four hosts that behave like the real upstreams, with the fixtures as their answers ----

const xmlResponse = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml" } });
const itemBlocks = thingXml.match(/<item\b[\s\S]*?<\/item>/g);
const thingFor = (url) => {
  const ids = new Set((new URL(url).searchParams.get("id") ?? "").split(","));
  return `<?xml version="1.0"?><items>${itemBlocks.filter((block) => ids.has(/\bid="(\d+)"/.exec(block)?.[1])).join("")}</items>`;
};
const EMPTY_SEARCH = '<?xml version="1.0"?><items total="0"></items>';
const EMPTY_RECOMMEND = JSON.stringify({ count: 0, next: null, previous: null, results: [] });

const kindOf = (url) => {
  const u = new URL(url);
  if (u.hostname === "bgg.test") return u.pathname.endsWith("/thing") ? "bgg-thing" : "bgg-search";
  if (u.hostname === "rg.test") return "rg";
  if (u.hostname === "geekdo.test") return u.pathname.endsWith("/dynamicinfo") ? "dynamicinfo" : "geekitems";
  return u.searchParams.get("action") === "wbgetentities" ? "wd-entities" : "wd-search";
};
const kinds = (context) => context.calls.map((call) => call.kind);
const count = (context, kind) => kinds(context).filter((entry) => entry === kind).length;

const makeContext = ({ search = searchXml, recommend = recommendText, wdSearch = wikidataSearch, respond } = {}) => {
  const calls = [];
  return {
    calls,
    signProxyUrl: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    fetch: async (url, init = {}) => {
      const kind = kindOf(url);
      calls.push({ url: String(url), init, kind, at: Date.now() });
      const override = respond?.(kind, { url: String(url), init });
      if (override) return override;
      const u = new URL(url);
      if (kind === "bgg-search" || kind === "bgg-thing") {
        if (init.headers?.Authorization !== `Bearer ${TOKEN}`) return new Response("Unauthorized", { status: 401 });
        return xmlResponse(kind === "bgg-search" ? search : thingFor(url));
      }
      if (kind === "rg") return new Response(recommend, { status: 200, headers: { "content-type": "application/json" } });
      if (kind === "geekitems" || kind === "dynamicinfo") {
        if (u.searchParams.get("objectid") !== "900001") return Response.json({ error: "Not found" }, { status: 404 });
        return Response.json(kind === "geekitems" ? geekitem : dynamicinfo);
      }
      if (kind === "wd-search") return Response.json(wdSearch);
      const ids = new Set((u.searchParams.get("ids") ?? "").split("|"));
      return Response.json({ entities: Object.fromEntries(Object.entries(wikidataEntities.entities).filter(([id]) => ids.has(id))), success: 1 });
    },
  };
};

const SOURCE_SETTINGS = { apiToken: TOKEN, enableApi: "true", enableRecommendGames: "true", enableBggInternal: "false" };

const make = (settings = {}) => {
  const slot = new BoardGamesSlot();
  slot.spacingMs = 0;
  slot.sources.api.base = "https://bgg.test/xmlapi2";
  slot.sources.recommend.base = "https://rg.test";
  slot.sources.internal.base = "https://geekdo.test/api";
  slot.sources.internal.wikidata.base = "https://wikidata.test/w/api.php";
  for (const source of Object.values(slot.sources)) source.budget = new Budget({ file: "", cap: 10_000, now: () => slot.now() });
  slot.configure({ ...SOURCE_SETTINGS, ...settings });
  return slot;
};

const EMPTY = { title: "", html: "" };
const sourceOf = (out) => /data-source="([^"]*)"/.exec(out.html)?.[1] ?? "";
const html5xx = (status = 503) => new Response("Service Unavailable", { status });
const cloudflarePage = (status = 403) =>
  new Response("<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>Checking</body></html>", {
    status,
    headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
  });

// ---- recommend.games ----

describe("recommend.games parsing", () => {
  const games = parseRecommendGames(recommendText);
  const [STARFALL, DUEL, LEGACY, STATION] = games;

  test("the fixture parses into normalised games and expansions are dropped", () => {
    expect(games.map((game) => game.id)).toEqual(["900001", "900003", "900004", "900005"]);
    expect(isRecommendExpansion(recommendFixture.results[1])).toBe(true);
    expect(isRecommendExpansion(recommendFixture.results[0])).toBe(false);
    expect(STATION.name).toBe("Starfield Station");
  });

  test("a full game keeps every field the panel uses", () => {
    expect(STARFALL).toMatchObject({
      id: "900001",
      source: "recommend-games",
      name: "Starfall",
      alternates: ["Sternenfall", "Chute d'étoiles", "Caída estelar"],
      year: 2019,
      minPlayers: 1,
      maxPlayers: 4,
      bestPlayers: "2–3",
      recommendedPlayers: "1–4",
      minPlayTime: 60,
      maxPlayTime: 120,
      minAge: 12,
      rating: 8.52,
      ratingCount: 24310,
      rank: 12,
      weight: 3.91,
      designers: ["Ada Quill", "Bo Marlowe"],
      publishers: [],
      categories: ["Economic", "Science Fiction", "Space Exploration"],
      mechanics: ["Cooperative Game", "Hand Management", "Route Planning", "Solo / Solitaire Game"],
      expansionCount: 0,
    });
    expect(Object.keys(STARFALL).sort()).toEqual(Object.keys(blankGame("x")).sort());
    expect(STARFALL.description).toStartWith("Starfall is a cooperative game for one to four players");
    expect(STARFALL.description).toContain("—description from the publisher");
    expect(STARFALL.description).not.toContain("\n");
    expect(DUEL).toMatchObject({ bestPlayers: "2", recommendedPlayers: "2", rank: 640, ratingCount: 3200 });
  });

  test("the small cover is preferred, and only https geekdo-images.com hosts are accepted", () => {
    expect(STARFALL.image).toBe("https://cf.geekdo-images.com/placeholder-starfall/small/img/small-900001.jpg");
    const image = (value) => compactRecommendGame({ bgg_id: 1, name: "X", image_url: value }).image;
    expect(image(["https://cf.geekdo-images.com/o.jpg"])).toBe("https://cf.geekdo-images.com/o.jpg");
    expect(image(["https://cf.geekdo-images.com/o.jpg", "https://evil.test/s.jpg"])).toBe("https://cf.geekdo-images.com/o.jpg");
    expect(image("https://cf.geekdo-images.com/s.jpg")).toBe("https://cf.geekdo-images.com/s.jpg");
    for (const bad of [["http://cf.geekdo-images.com/a.jpg"], ["https://evil.test/geekdo-images.com/x.jpg", "javascript:alert(1)"], [], "", null, undefined, 5, [null, 5]]) {
      expect(image(bad)).toBe("");
    }
  });

  test("null ranks, ages and weights become zero", () => {
    expect(LEGACY).toMatchObject({ rank: 0, minAge: 0, weight: 0, image: "", ratingCount: 85, rating: 7.9, minPlayTime: 0, maxPlayTime: 0 });
    expect(compactRecommendGame({ bgg_id: "900009", name: "S", num_votes: "1200", bgg_rank: "38", min_age: "10" })).toMatchObject({ id: "900009", ratingCount: 1200, rank: 38, minAge: 10 });
    expect(compactRecommendGame({ bgg_id: 1, name: "S", bgg_rank: "Not Ranked" }).rank).toBe(0);
  });

  test("alternate names, lists and ranges are capped and tidied", () => {
    const many = Array.from({ length: 30 }, (_, i) => `Name ${i}`);
    const game = compactRecommendGame({ bgg_id: 1, name: "Name 0", alt_name: many, designer_name: many, category_name: many, mechanic_name: many });
    expect([game.alternates.length, game.designers.length, game.categories.length, game.mechanics.length]).toEqual([12, 4, 6, 6]);
    expect(game.alternates).not.toContain("Name 0");
    expect(rangeText(3, 3)).toBe("3");
    expect(rangeText(3, 4)).toBe("3–4");
    expect(rangeText(2, 0)).toBe("2");
    expect(rangeText(0, 5)).toBe("5");
    expect(rangeText(0, 0)).toBe("");
    expect(rangeText(null, "x")).toBe("");
  });

  test("garbage and hostile replies give null or nothing, never an error", () => {
    for (const bad of [null, undefined, "", "   ", "not json", "[]", "{}", '{"results":"x"}', '{"results":{}}', "<html>Just a moment</html>", 5]) {
      expect(parseRecommendGames(bad)).toBeNull();
    }
    expect(parseRecommendGames('{"results":[]}')).toEqual([]);
    expect(parseRecommendGames('{"results":[null,5,"x",[],{},{"bgg_id":"abc","name":"x"},{"bgg_id":1e30,"name":"y"},{"name":"no id"}]}')).toEqual([]);
    expect(compactRecommendGame(null)).toEqual(blankGame("recommend-games"));
    expect(compactRecommendGame({ bgg_id: { a: 1 }, name: ["x"], alt_name: "x", year: "soon", description: 5 })).toEqual(blankGame("recommend-games"));
    const hostile = compactRecommendGame({ bgg_id: 7, name: '<script>alert("x")</script>', description: "<b>bold</b> &amp; <script>x</script>", designer_name: ["<i>d</i>"] });
    expect(hostile.name).toBe('<script>alert("x")</script>');
    expect(hostile.description).toBe("bold & x");
  });

  test("only the first 30 results are read, expansions do not count against them", () => {
    const entry = (i, expansion = false) => ({ bgg_id: i + 1, name: `Game ${i}`, category_name: expansion ? ["Expansion for Base-game"] : [] });
    const body = JSON.stringify({ count: 100, results: Array.from({ length: 100 }, (_, i) => entry(i, i % 2 === 0)) });
    const parsed = parseRecommendGames(body);
    expect(RECOMMEND_MAX_RESULTS).toBe(30);
    expect(parsed).toHaveLength(15);
    expect(parsed[0].id).toBe("2");
  });

  test("a reply over the size cap is read object by object", () => {
    const big = (i) => ({ bgg_id: i + 1, name: `Game ${i}`, description: `a } { \\" b ${"x".repeat(60_000)}`, category_name: [] });
    const body = `{"count": 99999, "next": "https://x.test/?page=2", "results": [${Array.from({ length: 60 }, (_, i) => JSON.stringify(big(i))).join(",")}]}`;
    expect(body.length).toBeGreaterThan(2_000_000);
    const parsed = parseRecommendGames(body);
    expect(parsed).toHaveLength(30);
    expect(parsed[0].name).toBe("Game 0");
    expect(parsed[29].name).toBe("Game 29");
    // A reply that is cut in the middle of an object still yields the whole objects before it.
    const cut = `{"results": [${JSON.stringify(big(0))},${JSON.stringify(big(1))},{"bgg_id": 3, "name": "Cut o`;
    expect(parseRecommendGames(cut.padEnd(2_100_000, " "))?.map((game) => game.id)).toEqual(["1", "2"]);
    expect(parseRecommendGames(`${"x".repeat(2_100_000)}`)).toBeNull();
  });

  test("the search url encodes the term", () => {
    const url = new URL(recommendSearchUrl("star fall & co", "https://rg.test/"));
    expect(url.origin + url.pathname).toBe("https://rg.test/api/games/");
    expect(url.searchParams.get("search")).toBe("star fall & co");
    expect(recommendSearchUrl("x").startsWith(`${DEFAULT_RECOMMEND_BASE}/api/games/?`)).toBe(true);
  });
});

// ---- BGG's website JSON API ----

describe("BGG website API parsing", () => {
  const game = compactGeekdo(geekitem, dynamicinfo);

  test("the two replies make one normalised game", () => {
    expect(game).toMatchObject({
      id: "900001",
      source: "bgg-internal",
      name: "Starfall",
      alternates: ["Sternenfall", "Chute d'étoiles"],
      year: 2019,
      minPlayers: 1,
      maxPlayers: 4,
      bestPlayers: "2–3",
      recommendedPlayers: "1–4",
      minPlayTime: 60,
      maxPlayTime: 120,
      minAge: 12,
      rating: 8.52,
      ratingCount: 24310,
      rank: 12,
      weight: 3.91,
      designers: ["Ada Quill", "Bo Marlowe"],
      publishers: ["Lantern & Oak Games", "Harbor Lights Publishing"],
      categories: ["Economic", "Science Fiction", "Space Exploration"],
      mechanics: ["Cooperative Game", "Hand Management", "Route Planning"],
      expansionCount: 2,
    });
    expect(Object.keys(game).sort()).toEqual(Object.keys(blankGame("x")).sort());
  });

  test("the HTML description becomes plain text", () => {
    expect(game.description).toStartWith("Starfall is a cooperative game for one to four players");
    expect(game.description).toContain("light the “beacon” before the last shuttle leaves.");
    expect(game.description).toContain("an hour and a half — and it’s friendly to newcomers & veterans alike.");
    expect(game.description).not.toMatch(/[<>]|&#|&[a-z]+;/);
    expect(game.description).not.toContain("\n");
    const html = (description) => compactGeekdo({ item: { objectid: 1, name: "X", description } }, {}).description;
    expect(html("a<br>b<br/>c</p><p>d&nbsp;e")).toBe("a b c d e");
    expect(html("&lsquo;x&rsquo; &ldquo;y&rdquo; &hellip; &amp;amp;")).toBe("‘x’ “y” … &amp;");
    expect(html("<script>alert(1)</script>ok")).toBe("alert(1) ok");
    expect(compactGeekdo({ item: { objectid: 1, name: "X", short_description: "short" } }, {}).description).toBe("short");
  });

  test("the cover comes from previewthumb or imageurl, https geekdo-images.com only", () => {
    expect(game.image).toBe("https://cf.geekdo-images.com/placeholder-starfall/previewthumb/img/previewthumb-900001.jpg");
    const image = (item) => compactGeekdo({ item: { objectid: 1, name: "X", ...item } }, {}).image;
    expect(image({ images: { previewthumb: "https://evil.test/x.jpg" }, imageurl: "https://cf.geekdo-images.com/i.jpg" })).toBe("https://cf.geekdo-images.com/i.jpg");
    expect(image({ images: { previewthumb: "http://cf.geekdo-images.com/x.jpg" }, imageurl: "javascript:alert(1)" })).toBe("");
    expect(image({ images: null, imageurl: 5 })).toBe("");
  });

  test("rank: a number is a rank, anything else is unranked, and only the board game subtype counts", () => {
    const rank = (rankinfo) => compactGeekdo({ item: { objectid: 1, name: "X" } }, { item: { rankinfo } }).rank;
    const subtype = (value) => ({ rankobjecttype: "subtype", browsesubtype: "boardgame", rank: value });
    expect(rank([subtype("38")])).toBe(38);
    expect(rank([subtype(38)])).toBe(38);
    expect(rank([subtype("Not Ranked")])).toBe(0);
    expect(rank([subtype("")])).toBe(0);
    expect(rank([subtype("-4")])).toBe(0);
    expect(rank([{ rankobjecttype: "family", browsesubtype: "strategygames", rank: "9" }])).toBe(0);
    expect(rank([{ rankobjecttype: "family", browsesubtype: "strategygames", rank: "9" }, subtype("12")])).toBe(12);
    expect(rank([{ rankobjecttype: "subtype", browsesubtype: "rpgitem", rank: "5" }])).toBe(0);
    expect(rank(null)).toBe(0);
    expect(rank([null, 5, "x"])).toBe(0);
  });

  test("player polls may hold several ranges", () => {
    const players = (userplayers) => compactGeekdo({ item: { objectid: 1, name: "X" } }, { item: { polls: { userplayers } } });
    expect(players({ best: [{ min: 2, max: 2 }, { min: 4, max: 5 }], recommended: [{ min: 1, max: 6 }] })).toMatchObject({ bestPlayers: "2, 4–5", recommendedPlayers: "1–6" });
    expect(players({ best: [{ min: 3 }], recommended: [] })).toMatchObject({ bestPlayers: "3", recommendedPlayers: "" });
    expect(players({ best: [null, {}, { min: "x" }] })).toMatchObject({ bestPlayers: "", recommendedPlayers: "" });
  });

  test("ids and subtypes", () => {
    expect(geekdoId(geekitem)).toBe("900001");
    expect(geekdoId({ item: { objectid: "17" } })).toBe("17");
    for (const bad of [null, {}, { item: {} }, { item: { objectid: "abc" } }, { item: { objectid: null } }, { item: { objectid: "1/../2" } }]) expect(geekdoId(bad)).toBe("");
    expect(isGeekdoBoardGame(geekitem)).toBe(true);
    expect(isGeekdoBoardGame({ item: {} })).toBe(true);
    for (const subtype of ["boardgameexpansion", "boardgameaccessory", "rpgitem"]) expect(isGeekdoBoardGame({ item: { subtype } })).toBe(false);
  });

  test("missing, null and odd fields never throw", () => {
    const empty = blankGame("bgg-internal");
    expect(compactGeekdo(null, null)).toEqual(empty);
    expect(compactGeekdo({}, {})).toEqual(empty);
    expect(compactGeekdo({ item: null }, { item: "x" })).toEqual(empty);
    const odd = compactGeekdo(
      { item: { objectid: "5", name: 7, primaryname: "x", alternatenames: "y", yearpublished: "soon", minplayers: null, links: { boardgamedesigner: [null, 5, {}] }, images: "z" } },
      { item: { stats: null, polls: 5, rankinfo: {} } },
    );
    expect(odd).toEqual({ ...empty, id: "5" });
  });

  test("the urls hold only validated ids", () => {
    expect(geekitemsUrl("900001", "https://g.test/api/")).toBe("https://g.test/api/geekitems?objectid=900001&objecttype=thing");
    expect(dynamicInfoUrl("900001", "https://g.test/api")).toBe("https://g.test/api/dynamicinfo?objectid=900001&objecttype=thing");
    expect(geekitemsUrl("900001").startsWith(`${DEFAULT_GEEKDO_BASE}/geekitems?`)).toBe(true);
    for (const bad of ["", "x", "1&objecttype=x", "../1", null, undefined]) {
      expect(geekitemsUrl(bad)).toBe("");
      expect(dynamicInfoUrl(bad)).toBe("");
    }
  });
});

// ---- Wikidata ----

describe("Wikidata", () => {
  test("the BoardGameGeek id property", () => {
    expect(BGG_ID_PROPERTY).toBe("P2339");
  });

  test("urls", () => {
    const search = new URL(wikidataSearchUrl("starfall", "https://w.test/w/api.php"));
    expect(search.origin + search.pathname).toBe("https://w.test/w/api.php");
    expect(search.searchParams.get("action")).toBe("query");
    expect(search.searchParams.get("list")).toBe("search");
    expect(search.searchParams.get("srsearch")).toBe("haswbstatement:P2339 starfall");
    expect(search.searchParams.get("srlimit")).toBe("5");
    expect(search.searchParams.get("format")).toBe("json");
    const tricky = new URL(wikidataSearchUrl('intitle:foo "bar" -baz haswbstatement:P31=Q5 a&b|c', "https://w.test/w/api.php")).searchParams.get("srsearch");
    expect(tricky).toBe("haswbstatement:P2339 intitle foo bar baz haswbstatement P31 Q5 a b c");
    const entities = new URL(wikidataEntitiesUrl(["Q1", "Q2"], "https://w.test/w/api.php"));
    expect(entities.searchParams.get("action")).toBe("wbgetentities");
    expect(entities.searchParams.get("ids")).toBe("Q1|Q2");
    expect(entities.searchParams.get("props")).toBe("labels|claims");
    expect(entities.searchParams.get("languages")).toBe("en");
    expect(wikidataSearchUrl("x")).toStartWith(`${DEFAULT_WIKIDATA_API}?`);
  });

  test("search replies give Q-ids only", () => {
    expect(parseSearchQids(JSON.stringify(wikidataSearch))).toEqual(["Q900000002", "Q900000001", "Q900000003"]);
    expect(parseSearchQids(JSON.stringify({ query: { search: [{ title: "Q1" }, { title: "Property:P1" }, { title: "Q12x" }, null, { title: 5 }] } }))).toEqual(["Q1"]);
    expect(parseSearchQids(JSON.stringify({ query: { search: [] } }))).toEqual([]);
    for (const bad of ["", "nope", "{}", '{"error":{"code":"x"}}', '{"query":{"search":"x"}}', "[]", null]) expect(parseSearchQids(bad)).toBeNull();
  });

  test("entities need an English label and a BoardGameGeek id claim", () => {
    const parsed = parseEntities(JSON.stringify(wikidataEntities), ["Q900000001", "Q900000002", "Q900000003", "Q404"]);
    expect(parsed).toEqual([
      { qid: "Q900000001", label: "Starfall", bggId: "900001" },
      { qid: "Q900000002", label: "Starfall Duel", bggId: "900003" },
    ]);
    const odd = {
      entities: {
        Q1: { labels: { en: { value: "No label claim" } }, claims: { P2339: [{ mainsnak: { snaktype: "novalue" } }] } },
        Q2: { labels: { en: { value: "Bad value" } }, claims: { P2339: [{ mainsnak: { datavalue: { value: "abc" } } }] } },
        Q3: { labels: {}, claims: { P2339: [{ mainsnak: { datavalue: { value: "7" } } }] } },
        Q4: { labels: { en: { value: "Second claim wins" } }, claims: { P2339: [{ mainsnak: { datavalue: { value: "x" } } }, { mainsnak: { datavalue: { value: "42" } } }] } },
        Q5: null,
        Q6: { labels: { en: { value: "Numeric" } }, claims: { P2339: [{ mainsnak: { datavalue: { value: 9 } } }] } },
      },
    };
    expect(parseEntities(JSON.stringify(odd), ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"])).toEqual([{ qid: "Q4", label: "Second claim wins", bggId: "42" }]);
    for (const bad of ["", "nope", "{}", '{"entities":5}', '{"error":{}}', null]) expect(parseEntities(bad, ["Q1"])).toBeNull();
  });

  describe("resolving a name", () => {
    const resolve = async (term, options = {}) => {
      const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
      const context = makeContext(options);
      const result = await slot.sources.internal.wikidata.resolve({ term, context, deadline: Date.now() + 60_000 });
      return { slot, context, result };
    };

    test("candidates are ordered by title similarity, not by Wikidata's order", async () => {
      const { result, context } = await resolve("starfall duel");
      expect(result.ok).toBe(true);
      expect(result.candidates.map((candidate) => [candidate.bggId, candidate.sim])).toEqual([["900003", 1], ["900001", 0.9]]);
      expect(kinds(context)).toEqual(["wd-search", "wd-entities"]);
      const exact = await resolve("starfall");
      expect(exact.result.candidates.map((candidate) => candidate.bggId)).toEqual(["900001", "900003"]);
    });

    test("a title that is not close enough is not a candidate", async () => {
      expect((await resolve("star")).result).toEqual({ ok: true, candidates: [] });
      expect((await resolve("starfall legacy sequel part 2")).result.candidates).toEqual([]);
    });

    test("an entity without a BoardGameGeek id claim is skipped", async () => {
      const only = { batchcomplete: "", query: { search: [{ title: "Q900000003" }] } };
      const { result } = await resolve("starfall", { wdSearch: only });
      expect(result).toEqual({ ok: true, candidates: [] });
    });

    test("no search hits means no entities request", async () => {
      const { result, context } = await resolve("starfall", { wdSearch: { query: { search: [] } } });
      expect(result).toEqual({ ok: true, candidates: [] });
      expect(kinds(context)).toEqual(["wd-search"]);
    });

    test("requests carry a descriptive user agent and never the BGG token", async () => {
      const { context } = await resolve("starfall");
      for (const call of context.calls) {
        expect(call.init.headers["User-Agent"]).toBe("degoog-board-games/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)");
        expect(call.init.headers["Api-User-Agent"]).toBe(call.init.headers["User-Agent"]);
        expect(JSON.stringify(call.init)).not.toContain(TOKEN);
        expect(call.init.headers.Authorization).toBeUndefined();
      }
    });

    test("errors make it fail, and a 429 pauses Wikidata only", async () => {
      const failures = [
        [() => new Response("slow", { status: 429, headers: { "retry-after": "30" } }), "rate"],
        [() => html5xx(502), "server"],
        [() => new Response("not json", { status: 200 }), "invalid"],
        [() => Response.json({ error: { code: "badvalue" } }), "invalid"],
        [() => new Response("no", { status: 403 }), "rejected"],
        [() => {
          throw new Error(`down ${TOKEN}`);
        }, "network"],
      ];
      for (const [respond, reason] of failures) {
        let outcome;
        const lines = await capture(async () => {
          outcome = await resolve("starfall", { respond: (kind) => (kind === "wd-search" ? respond() : undefined) });
        });
        expect(outcome.result).toEqual({ ok: false, reason });
        expect(lines.join("")).not.toContain(TOKEN);
        expect(lines.join("")).not.toContain("http");
        expect(outcome.slot.sources.internal.upstream.paused).toBe(false);
      }
      let limited;
      await capture(async () => {
        limited = await resolve("starfall", { respond: (kind) => (kind === "wd-search" ? new Response("slow", { status: 429 }) : undefined) });
      });
      expect(limited.slot.sources.internal.wikidata.upstream.paused).toBe(true);
      expect(limited.slot.sources.internal.upstream.paused).toBe(false);
      let second;
      await capture(async () => {
        second = await resolve("starfall", { respond: (kind) => (kind === "wd-entities" ? html5xx() : undefined) });
      });
      expect(second.result.ok).toBe(false);
    });
  });
});

// ---- the shared per-upstream helper ----

describe("an upstream", () => {
  const world = () => {
    let clock = 5_000_000;
    const sleeps = [];
    const host = {
      now: () => clock,
      spacingMs: 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    };
    return { host, sleeps, advance: (ms) => (clock += ms), time: () => clock };
  };
  const ask = (upstream, response, options = {}) =>
    upstream.request("https://x.test/a", { context: { fetch: async () => (typeof response === "function" ? response() : response) }, deadline: Date.now() + 10 ** 9, ...options });

  test("an answer comes back as text and pauses nothing", async () => {
    const { host } = world();
    const upstream = new Upstream({ host, label: "Thing" });
    expect(await ask(upstream, new Response("hello"))).toEqual({ ok: true, status: 200, text: "hello" });
    expect(upstream.paused).toBe(false);
  });

  test("each kind of failure has its reason and its pause, and logs once", async () => {
    const cases = [
      [() => new Response("no", { status: 404 }), "http", 404, 0],
      [() => new Response("no", { status: 418 }), "http", 418, 0],
      [() => new Response("slow", { status: 429, headers: { "retry-after": "45" } }), "rate", 429, 45_000],
      [() => new Response("slow", { status: 429 }), "rate", 429, 600_000],
      [() => new Response("slow", { status: 429, headers: { "retry-after": "999999" } }), "rate", 429, 3_600_000],
      [() => new Response("no", { status: 401 }), "rejected", 401, 1_800_000],
      [() => new Response("no", { status: 403 }), "rejected", 403, 1_800_000],
      [() => new Response("queued", { status: 202 }), "busy", 202, 60_000],
      [() => html5xx(500), "server", 500, 60_000],
      [() => html5xx(503), "server", 503, 60_000],
      [() => cloudflarePage(503), "blocked", 503, 1_800_000],
      [() => new Response("x", { status: 503, headers: { "cf-mitigated": "challenge" } }), "blocked", 503, 1_800_000],
      [() => new Response("<!DOCTYPE html><html>challenge</html>", { status: 200 }), "blocked", 200, 1_800_000],
      [() => new Response('<html lang="en"><title>Just a moment...</title>', { status: 200 }), "blocked", 200, 1_800_000],
      [
        () => {
          throw new Error("down https://x.test/secret?token=abc");
        },
        "network",
        0,
        60_000,
      ],
    ];
    for (const [response, reason, status, pause] of cases) {
      const { host, time } = world();
      const upstream = new Upstream({ host, label: "Thing", blockMessage: "Thing blocked the request" });
      let result;
      const lines = await capture(async () => {
        result = await ask(upstream, response);
        await ask(upstream, response);
      });
      expect(result).toEqual({ ok: false, status, reason });
      if (pause === 0) {
        expect(upstream.paused).toBe(false);
        expect(lines).toHaveLength(0);
      } else {
        expect(upstream.pausedUntil - time()).toBe(pause);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toMatch(/http|secret|token/);
        expect((await ask(upstream, new Response("x"))).reason).toBe("paused");
      }
    }
    const { host } = world();
    const upstream = new Upstream({ host, label: "Thing", blockMessage: "Thing blocked the request" });
    const lines = await capture(() => ask(upstream, new Response("no", { status: 403 })));
    expect(lines).toEqual(["[board-games] Thing blocked the request; paused for 30 min"]);
  });

  test("a JSON reply that merely mentions a moment is not a block page", async () => {
    const { host } = world();
    const upstream = new Upstream({ host, label: "Thing" });
    const body = JSON.stringify({ description: "Just a moment, wait: <title>Just a moment" });
    expect((await ask(upstream, new Response(body))).ok).toBe(true);
    expect(looksBlocked('{"description":"Just a moment..."}')).toBe(false);
    expect(looksBlocked("<html><head><title>Just a moment...</title>")).toBe(true);
  });

  test("a paused upstream makes no request, and an empty address is refused", async () => {
    const { host } = world();
    const upstream = new Upstream({ host, label: "Thing" });
    let calls = 0;
    const context = { fetch: async () => (calls++, new Response("x")) };
    expect((await upstream.request("", { context, deadline: Infinity })).reason).toBe("invalid");
    await capture(async () => upstream.pause(60_000, "a pause"));
    expect((await upstream.request("https://x.test/a", { context, deadline: Infinity })).reason).toBe("paused");
    expect(calls).toBe(0);
  });

  test("requests keep their distance, and are skipped when the wait does not fit before the deadline", async () => {
    const { host, sleeps, time } = world();
    host.spacingMs = 1000;
    const upstream = new Upstream({ host, label: "Thing" });
    expect((await ask(upstream, new Response("a"))).ok).toBe(true);
    expect((await ask(upstream, new Response("b"))).ok).toBe(true);
    expect(sleeps).toEqual([1000]);
    const tight = await ask(upstream, new Response("c"), { deadline: time() + 500 });
    expect(tight).toEqual({ ok: false, status: 0, reason: "time" });
    expect((await ask(upstream, new Response("d"), { deadline: time() - 1 })).reason).toBe("time");
  });

  test("a daily budget is spent per request and pauses the upstream until it resets", async () => {
    const { host, time } = world();
    const budget = new Budget({ cap: 2, now: () => time() });
    const upstream = new Upstream({ host, label: "Thing", budgetOf: () => budget });
    expect((await ask(upstream, new Response("a"))).ok).toBe(true);
    expect((await ask(upstream, new Response("b"))).ok).toBe(true);
    let third;
    const lines = await capture(async () => {
      third = await ask(upstream, new Response("c"));
    });
    expect(third.reason).toBe("budget");
    expect(lines).toEqual(["[board-games] the daily Thing request limit is reached; paused for 60 min"]);
    expect(upstream.pausedUntil - time()).toBeLessThanOrEqual(3_600_000);
  });

  test("replies are read only up to the limit", async () => {
    const { host } = world();
    const upstream = new Upstream({ host, label: "Thing" });
    const result = await ask(upstream, new Response("x".repeat(5000)), { maxChars: 100 });
    expect(result.text).toHaveLength(101);
  });
});

// ---- the chain ----

describe("the fallback chain", () => {
  test("with everything on and a token, only the XML API is called", async () => {
    const slot = make({ enableBggInternal: "true" });
    const context = makeContext();
    const out = await slot.execute("starfall", context);
    expect(kinds(context)).toEqual(["bgg-search", "bgg-thing"]);
    expect(out.title).toBe("Starfall");
    expect(sourceOf(out)).toBe("bgg-api");
    expect(out.html).toContain("Powered by BGG");
    expect(out.html).not.toContain("recommend.games");
  });

  test("a failing XML API hands over to recommend.games, which is then credited", async () => {
    const failures = [
      [() => new Response("no", { status: 401 }), "bgg-search"],
      [() => new Response("no", { status: 403 }), "bgg-search"],
      [() => new Response("slow", { status: 429, headers: { "retry-after": "60" } }), "bgg-search"],
      [() => html5xx(503), "bgg-search"],
      [() => cloudflarePage(), "bgg-search"],
      [() => new Response("hello", { status: 200 }), "bgg-search"],
      [() => new Response('<items total="1"><item id="1"', { status: 200 }), "bgg-search"],
      [() => html5xx(502), "bgg-thing"],
      [() => new Response("<items><oops></items>", { status: 200 }), "bgg-thing"],
    ];
    for (const [fail, failingKind] of failures) {
      const slot = make();
      const context = makeContext({ respond: (kind) => (kind === failingKind ? fail() : undefined) });
      let out;
      await capture(async () => {
        out = await slot.execute("starfall", context);
      });
      expect(sourceOf(out)).toBe("recommend-games");
      expect(out.title).toBe("Starfall");
      expect(count(context, "rg")).toBe(1);
      expect(out.html).toContain('Data from <a href="https://recommend.games" target="_blank" rel="noopener">recommend.games</a> (originally from <a href="https://boardgamegeek.com" target="_blank" rel="noopener">BoardGameGeek</a>)');
      expect(out.html).not.toContain("Powered by BGG");
    }
  });

  test("an unusable XML API is skipped without a request or a warning", async () => {
    const lines = await capture(async () => {
      const noToken = make({ apiToken: "" });
      await withEnv({ BGG_API_TOKEN: undefined }, async () => {
        noToken.configure({ ...SOURCE_SETTINGS, apiToken: "" });
        const context = makeContext();
        const out = await noToken.execute("starfall", context);
        expect(kinds(context)).toEqual(["rg"]);
        expect(sourceOf(out)).toBe("recommend-games");
      });

      const disabled = make({ enableApi: "false" });
      const disabledContext = makeContext();
      expect(sourceOf(await disabled.execute("starfall", disabledContext))).toBe("recommend-games");
      expect(kinds(disabledContext)).toEqual(["rg"]);

      const spent = make();
      spent.sources.api.budget = new Budget({ cap: 1, now: () => spent.now() });
      spent.sources.api.budget.spend();
      const spentContext = makeContext();
      expect(sourceOf(await spent.execute("starfall", spentContext))).toBe("recommend-games");
      expect(kinds(spentContext)).toEqual(["rg"]);

      const paused = make();
      paused.sources.api.upstream.pause(60_000, "a test pause");
      const pausedContext = makeContext();
      expect(sourceOf(await paused.execute("starfall", pausedContext))).toBe("recommend-games");
      expect(kinds(pausedContext)).toEqual(["rg"]);
    });
    expect(lines).toEqual(["[board-games] a test pause; paused for 1 min"]);
  });

  test("with the XML API and recommend.games both failing, the website API is used through Wikidata", async () => {
    const slot = make({ enableBggInternal: "true" });
    const context = makeContext({
      respond: (kind) => (kind === "bgg-search" ? html5xx() : kind === "rg" ? html5xx(502) : undefined),
    });
    let out;
    await capture(async () => {
      out = await slot.execute("starfall", context);
    });
    expect(kinds(context)).toEqual(["bgg-search", "rg", "wd-search", "wd-entities", "geekitems", "dynamicinfo"]);
    expect(sourceOf(out)).toBe("bgg-internal");
    expect(out.title).toBe("Starfall");
    expect(out.html).toContain('Data from <a href="https://boardgamegeek.com" target="_blank" rel="noopener">BoardGameGeek</a>');
    expect(out.html).not.toContain("Powered by BGG");
    expect(out.html).not.toContain("recommend.games");
    for (const label of ["BGG rating", "BGG rank", "Weight / 5"]) expect(out.html).toContain(label);
    expect(out.html).toContain("Lantern &amp; Oak Games");
    expect(out.html).toContain("light the “beacon”");
  });

  test("the website API is off by default", async () => {
    const slot = make();
    expect(slot.sources.internal.enabled).toBe(false);
    const context = makeContext({ respond: (kind) => (kind === "bgg-search" ? html5xx() : kind === "rg" ? html5xx(502) : undefined) });
    let out;
    await capture(async () => {
      out = await slot.execute("starfall", context);
    });
    expect(out).toEqual(EMPTY);
    expect(kinds(context)).toEqual(["bgg-search", "rg"]);
    expect(new BoardGamesSlot().sources.internal.enabled).toBe(false);
  });

  test("each toggle skips its source", async () => {
    const failApi = (kind) => (kind === "bgg-search" ? html5xx() : undefined);
    const noRecommend = make({ enableRecommendGames: "false" });
    const noRecommendContext = makeContext({ respond: failApi });
    await capture(async () => expect(await noRecommend.execute("starfall", noRecommendContext)).toEqual(EMPTY));
    expect(count(noRecommendContext, "rg")).toBe(0);

    const onlyInternal = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    const internalContext = makeContext();
    expect(sourceOf(await onlyInternal.execute("starfall", internalContext))).toBe("bgg-internal");
    expect(kinds(internalContext)).toEqual(["wd-search", "wd-entities", "geekitems", "dynamicinfo"]);

    const onlyRecommend = make({ enableApi: "false" });
    const recommendContext = makeContext();
    expect(sourceOf(await onlyRecommend.execute("starfall", recommendContext))).toBe("recommend-games");
    expect(kinds(recommendContext)).toEqual(["rg"]);
  });

  test("toggling a source takes effect immediately, because each source has its own caches", async () => {
    const slot = make();
    const context = makeContext();
    expect(sourceOf(await slot.execute("starfall", context))).toBe("bgg-api");
    context.calls.length = 0;
    slot.configure({ ...SOURCE_SETTINGS, enableApi: "false" });
    expect(sourceOf(await slot.execute("starfall", context))).toBe("recommend-games");
    expect(kinds(context)).toEqual(["rg"]);
    context.calls.length = 0;
    slot.configure({ ...SOURCE_SETTINGS });
    expect(sourceOf(await slot.execute("starfall", context))).toBe("bgg-api");
    expect(context.calls).toHaveLength(0);
  });

  test("a working source that finds no confident match ends the chain, and the answer is cached", async () => {
    const slot = make({ enableBggInternal: "true" });
    const context = makeContext({ search: EMPTY_SEARCH });
    expect(await slot.execute("zzz nothing", context)).toEqual(EMPTY);
    expect(kinds(context)).toEqual(["bgg-search"]);
    await slot.execute("zzz nothing", context);
    expect(context.calls).toHaveLength(1);

    const unconfirmed = make();
    const unconfirmedContext = makeContext();
    expect(await unconfirmed.execute("starfield", unconfirmedContext)).toEqual(EMPTY);
    expect(kinds(unconfirmedContext)).toEqual(["bgg-search", "bgg-thing"]);
    await unconfirmed.execute("starfield", unconfirmedContext);
    expect(unconfirmedContext.calls).toHaveLength(2);

    const recommendOnly = make({ enableApi: "false", enableBggInternal: "true" });
    const recommendContext = makeContext({ recommend: EMPTY_RECOMMEND });
    expect(await recommendOnly.execute("zzz nothing", recommendContext)).toEqual(EMPTY);
    expect(kinds(recommendContext)).toEqual(["rg"]);
    await recommendOnly.execute("zzz nothing", recommendContext);
    expect(recommendContext.calls).toHaveLength(1);

    const noMatch = make({ enableApi: "false", enableBggInternal: "true" });
    const noMatchContext = makeContext();
    expect(await noMatch.execute("completely different", noMatchContext)).toEqual(EMPTY);
    expect(kinds(noMatchContext)).toEqual(["rg"]);
  });

  test("the candidate ids of a failed XML details request are handed on to the website API", async () => {
    const slot = make({ enableRecommendGames: "false", enableBggInternal: "true" });
    const context = makeContext({ respond: (kind) => (kind === "bgg-thing" ? html5xx() : undefined) });
    let out;
    await capture(async () => {
      out = await slot.execute("starfall", context);
    });
    expect(kinds(context)).toEqual(["bgg-search", "bgg-thing", "geekitems", "dynamicinfo"]);
    expect(context.calls[2].url).toContain("objectid=900001");
    expect(sourceOf(out)).toBe("bgg-internal");
    expect(count(context, "wd-search")).toBe(0);
  });

  test("hints skip Wikidata and cost at most two detail fetches", async () => {
    const internal = (hints) => {
      const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
      const context = makeContext();
      return { slot, context, run: () => slot.sources.internal.lookup({ term: "starfall", intent: false, context, deadline: Date.now() + 60_000, hints }) };
    };
    const missing = internal({ ids: ["900009", "900008", "900001"] });
    expect(await missing.run()).toEqual({ status: "ok", game: null });
    expect(kinds(missing.context)).toEqual(["geekitems", "geekitems"]);

    const second = internal({ ids: ["900003", "900001", "900008"] });
    const found = await second.run();
    expect(found.game.id).toBe("900001");
    expect(kinds(second.context)).toEqual(["geekitems", "geekitems", "dynamicinfo"]);

    const ignored = internal({ ids: ["bad", "../1", "900001"] });
    expect((await ignored.run()).game.id).toBe("900001");
    expect(kinds(ignored.context).filter((kind) => kind === "geekitems")).toHaveLength(1);
  });

  test("the sources keep separate pauses, budgets and limits", async () => {
    const slot = make({ enableBggInternal: "true", dailyRequestLimit: "7", recommendGamesDailyLimit: "8", internalDailyLimit: "9" });
    expect([slot.sources.api.budget.cap, slot.sources.recommend.budget.cap, slot.sources.internal.budget.cap]).toEqual([7, 8, 9]);
    const context = makeContext({ respond: (kind) => (kind === "bgg-search" ? new Response("slow", { status: 429, headers: { "retry-after": "60" } }) : undefined) });
    await capture(() => slot.execute("starfall", context));
    expect(slot.sources.api.upstream.paused).toBe(true);
    expect(slot.sources.recommend.upstream.paused).toBe(false);
    expect(slot.sources.internal.upstream.paused).toBe(false);
    expect(slot.sources.api.budget.used).toBe(1);
    expect(slot.sources.recommend.budget.used).toBe(1);
    expect(slot.sources.internal.budget.used).toBe(0);
    for (const bad of ["abc", "-1", ""]) {
      const defaults = make({ dailyRequestLimit: bad, recommendGamesDailyLimit: bad, internalDailyLimit: bad });
      expect([defaults.sources.api.budget.cap, defaults.sources.recommend.budget.cap, defaults.sources.internal.budget.cap]).toEqual([300, 500, 100]);
    }
    const unlimited = make({ dailyRequestLimit: "0", recommendGamesDailyLimit: "0", internalDailyLimit: "0" });
    expect(unlimited.sources.api.budget.cap + unlimited.sources.recommend.budget.cap + unlimited.sources.internal.budget.cap).toBe(0);
  });

  test("the website API counts Wikidata against its own limit, and a spent limit makes it unavailable", async () => {
    const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true", internalDailyLimit: "3" });
    const context = makeContext();
    let out;
    const lines = await capture(async () => {
      out = await slot.execute("starfall", context);
    });
    expect(kinds(context)).toEqual(["wd-search", "wd-entities", "geekitems"]);
    expect(out).toEqual(EMPTY);
    expect(slot.sources.internal.budget.used).toBe(3);
    expect(lines).toEqual(["[board-games] the daily BGG's website API request limit is reached; paused for 60 min"]);
    expect(slot.trigger("starfall")).toBe(false);
  });

  test("trigger is true when at least one enabled source is usable", () => {
    expect(make().trigger("starfall")).toBe(true);
    expect(make({ enableRecommendGames: "false" }).trigger("starfall")).toBe(true);
    expect(make({ enableApi: "false" }).trigger("starfall")).toBe(true);
    expect(make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" }).trigger("starfall")).toBe(true);
    expect(make({ enableApi: "false", enableRecommendGames: "false" }).trigger("starfall")).toBe(false);
    return withEnv({ BGG_API_TOKEN: undefined }, () => {
      expect(make({ apiToken: "", enableRecommendGames: "false" }).trigger("starfall")).toBe(false);
      expect(make({ apiToken: "" }).trigger("starfall")).toBe(true);
      const paused = make({ enableBggInternal: "true" });
      const warn = console.warn;
      console.warn = () => {};
      for (const source of paused.chain) source.upstream.pause(60_000, "pause");
      console.warn = warn;
      expect(paused.trigger("starfall")).toBe(false);
      const budgetless = make({ enableBggInternal: "true" });
      for (const source of budgetless.chain) source.budget = new Budget({ cap: 1, now: () => budgetless.now() }), source.budget.spend();
      expect(budgetless.trigger("starfall")).toBe(false);
    });
  });

  test("the usual gating still applies to every source", async () => {
    const slot = make({ enableBggInternal: "true" });
    const context = makeContext();
    for (const query of ["weather", "how to beat skyrim", "skyrim walkthrough", "starfall ps5", "what is a meeple", "x"]) {
      expect(slot.trigger(query)).toBe(false);
      expect(await slot.execute(query, context)).toEqual(EMPTY);
    }
    expect(context.calls).toHaveLength(0);
    const strict = make({ requireBoardGameWord: "true" });
    expect(strict.trigger("starfall")).toBe(false);
    expect(strict.trigger("starfall board game")).toBe(true);
  });

  test("an expansion is never shown, whichever source is used", async () => {
    const onlyExpansion = JSON.stringify({ count: 1, results: [recommendFixture.results[1]] });
    const slot = make({ enableApi: "false" });
    const context = makeContext({ recommend: onlyExpansion });
    expect(await slot.execute("starfall nebula expansion", context)).toEqual(EMPTY);
    expect(await slot.execute("starfall nebula", context)).toEqual(EMPTY);
    expect(count(context, "rg")).toBe(1);
  });

  test("popularity for recommend.games is its vote count", async () => {
    const few = JSON.stringify({ results: [{ ...recommendFixture.results[0], num_votes: 150 }] });
    const slot = make({ enableApi: "false" });
    expect(await slot.execute("starfall", makeContext({ recommend: few }))).toEqual(EMPTY);
    const enough = JSON.stringify({ results: [{ ...recommendFixture.results[0], num_votes: 200 }] });
    const other = make({ enableApi: "false" });
    expect((await other.execute("starfall", makeContext({ recommend: enough }))).title).toBe("Starfall");
    const ambiguous = make({ enableApi: "false" });
    expect((await ambiguous.execute("starfall board game", makeContext({ recommend: few }))).title).toBe("Starfall");
  });

  test("the website API applies the same confidence rules, with the vote count from its statistics", async () => {
    const weak = { item: { ...dynamicinfo.item, stats: { ...dynamicinfo.item.stats, usersrated: "150" } } };
    const calls = (dynamic) =>
      make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" }).execute(
        "starfall",
        {
          ...makeContext(),
          fetch: async (url, init) => (kindOf(url) === "dynamicinfo" ? Response.json(dynamic) : makeContext().fetch(url, init)),
        },
      );
    expect(await calls(weak)).toEqual(EMPTY);
    expect((await calls(dynamicinfo)).title).toBe("Starfall");
  });

  test("the website API does not show expansions, and a missing dynamicinfo is unavailable and not cached", async () => {
    const expansion = { item: { ...geekitem.item, subtype: "boardgameexpansion" } };
    const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    const context = {
      ...makeContext(),
      fetch: async (url, init) => (kindOf(url) === "geekitems" ? Response.json(expansion) : makeContext().fetch(url, init)),
    };
    expect(await slot.execute("starfall", context)).toEqual(EMPTY);

    const broken = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    let attempts = 0;
    const brokenContext = {
      ...makeContext(),
      fetch: async (url, init) => (kindOf(url) === "dynamicinfo" ? (attempts++, new Response("not json")) : makeContext().fetch(url, init)),
    };
    expect(await broken.execute("starfall", brokenContext)).toEqual(EMPTY);
    expect(await broken.execute("starfall", brokenContext)).toEqual(EMPTY);
    expect(attempts).toBe(2);
    expect(broken.sources.internal.upstream.paused).toBe(false);
  });

  test("a mismatched geekitems reply is not used", async () => {
    const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    const wrong = { item: { ...geekitem.item, objectid: 5 } };
    const context = { ...makeContext(), fetch: async (url, init) => (kindOf(url) === "geekitems" ? Response.json(wrong) : makeContext().fetch(url, init)) };
    expect(await slot.execute("starfall", context)).toEqual(EMPTY);
    expect(count(context, "dynamicinfo")).toBe(0);
  });

  test("the website API remembers a term without a Wikidata match", async () => {
    const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    const context = makeContext({ wdSearch: { query: { search: [] } } });
    expect(await slot.execute("zzz nothing", context)).toEqual(EMPTY);
    expect(kinds(context)).toEqual(["wd-search"]);
    await slot.execute("zzz nothing", context);
    expect(context.calls).toHaveLength(1);
  });

  test("a Wikidata failure makes the website API unavailable, but hints bypass Wikidata", async () => {
    const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    const context = makeContext({ respond: (kind) => (kind === "wd-search" ? new Response("slow", { status: 429 }) : undefined) });
    await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
    expect(slot.sources.internal.wikidata.upstream.paused).toBe(true);
    expect(slot.sources.internal.upstream.paused).toBe(false);
    expect(slot.sources.internal.usable()).toBe(true);
    const hinted = await slot.sources.internal.lookup({ term: "starfall", intent: false, context: makeContext(), deadline: Date.now() + 60_000, hints: { ids: ["900001"] } });
    expect(hinted.game.id).toBe("900001");
  });

  test("a Cloudflare challenge from the website API pauses it for 30 minutes with one quiet warning", async () => {
    for (const respond of [() => cloudflarePage(403), () => cloudflarePage(503), () => new Response("<!DOCTYPE html><html><title>Just a moment...</title>", { status: 200 })]) {
      const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
      const context = makeContext({ respond: (kind) => (kind === "geekitems" ? respond() : undefined) });
      const lines = await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
      expect(kinds(context)).toEqual(["wd-search", "wd-entities", "geekitems"]);
      expect(slot.sources.internal.upstream.paused).toBe(true);
      expect(slot.sources.internal.upstream.pausedUntil - slot.now()).toBeGreaterThan(29 * 60_000);
      expect(lines).toEqual(["[board-games] BGG's website API blocked the request; paused for 30 min"]);
      expect(slot.sources.internal.usable()).toBe(false);
      expect(slot.trigger("starfall")).toBe(false);
    }
  });

  test("the whole chain respects the time budget", async () => {
    const slot = make({ enableBggInternal: "true" });
    let now = 10_000_000;
    slot.now = () => now;
    slot.sleep = async (ms) => {
      now += ms;
    };
    const context = makeContext({
      respond: (kind) => {
        if (kind === "bgg-search") {
          now += 8000;
          return html5xx();
        }
        return undefined;
      },
    });
    await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
    expect(kinds(context)).toEqual(["bgg-search"]);

    const slow = make({ enableBggInternal: "true" });
    slow.spacingMs = 1000;
    slow.startWindowMs = 1500;
    let clock = 20_000_000;
    slow.now = () => clock;
    slow.sleep = async (ms) => {
      clock += ms;
    };
    const slowContext = makeContext({
      respond: (kind) => {
        clock += 800;
        return kind === "bgg-search" ? undefined : undefined;
      },
    });
    const out = await slow.execute("starfall", slowContext);
    // The search ran, the spacing wait for the details request did not fit, so the next source was asked instead.
    expect(kinds(slowContext)[0]).toBe("bgg-search");
    expect(count(slowContext, "bgg-thing")).toBe(0);
    expect(sourceOf(out)).toBe("recommend-games");
  });

  test("requests are kept apart per source", async () => {
    const slot = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    slot.spacingMs = 1000;
    let now = 30_000_000;
    const sleeps = [];
    slot.now = () => now;
    slot.sleep = async (ms) => {
      sleeps.push(ms);
      now += ms;
    };
    const out = await slot.execute("starfall", makeContext());
    expect(sourceOf(out)).toBe("bgg-internal");
    expect(sleeps).toEqual([1000, 1000]);
  });

  test("the BGG token is only ever sent to the BGG XML API", async () => {
    const slot = make({ enableBggInternal: "true" });
    const scenarios = [
      makeContext(),
      makeContext({ respond: (kind) => (kind === "bgg-search" ? html5xx() : undefined) }),
      makeContext({ respond: (kind) => (kind === "bgg-search" || kind === "rg" ? html5xx() : undefined) }),
    ];
    for (const context of scenarios) {
      const fresh = make({ enableBggInternal: "true" });
      await capture(() => fresh.execute("starfall", context));
      for (const call of context.calls) {
        const carriesToken = JSON.stringify(call.init).includes(TOKEN);
        expect(carriesToken).toBe(call.kind === "bgg-search" || call.kind === "bgg-thing");
        expect(call.url).not.toContain(TOKEN);
      }
    }
    expect(slot.sources.api.token).toBe(TOKEN);
  });

  test("no token, address or id ever reaches a log line, whichever source fails", async () => {
    const lines = [];
    const outputs = [];
    const failures = [
      (kind) => (kind === "bgg-search" ? new Response(`denied ${TOKEN}`, { status: 401 }) : undefined),
      (kind) => (["bgg-search", "rg"].includes(kind) ? new Response(`slow ${TOKEN}`, { status: 429 }) : undefined),
      (kind) => (["bgg-search", "rg", "wd-search"].includes(kind) ? html5xx() : undefined),
      (kind) => (kind === "geekitems" || kind === "bgg-search" || kind === "rg" ? cloudflarePage() : undefined),
      () => {
        throw new Error(`down https://bgg.test/xmlapi2/search Bearer ${TOKEN}`);
      },
    ];
    for (const respond of failures) {
      const slot = make({ enableBggInternal: "true" });
      const context = makeContext({ respond });
      lines.push(...(await capture(async () => outputs.push(await slot.execute("starfall", context)))));
    }
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toStartWith("[board-games] ");
      for (const forbidden of [TOKEN, "http", "bgg.test", "rg.test", "geekdo.test", "wikidata.test", "900001", "Bearer"]) expect(line).not.toContain(forbidden);
    }
    expect(JSON.stringify(outputs)).not.toContain(TOKEN);
  });

  test("uses degoog's cache with one pair of namespaces per source", async () => {
    const run = async (settings, query = "starfall") => {
      const slot = make(settings);
      const stores = {};
      const lifetimes = {};
      const base = makeContext();
      const context = {
        ...base,
        useCache: (name, ttl) => {
          stores[name] ??= new Map();
          lifetimes[name] = ttl;
          return { get: async (key) => stores[name].get(key) ?? null, set: async (key, value) => void stores[name].set(key, value) };
        },
      };
      await slot.execute(query, context);
      const first = base.calls.length;
      await slot.execute(query, context);
      expect(base.calls).toHaveLength(first);
      return { stores, lifetimes };
    };
    const DAY = 24 * 3_600_000;
    const api = await run({});
    expect(api.lifetimes).toEqual({ "ext:board-games:bgg-api:search": DAY, "ext:board-games:bgg-api:details": 7 * DAY });
    const recommend = await run({ enableApi: "false" });
    expect(recommend.lifetimes).toEqual({ "ext:board-games:recommend-games:search": DAY });
    expect([...recommend.stores["ext:board-games:recommend-games:search"].keys()]).toEqual(["starfall"]);
    const internal = await run({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    expect(internal.lifetimes).toEqual({ "ext:board-games:bgg-internal:search": 7 * DAY, "ext:board-games:bgg-internal:details": 7 * DAY });
    expect([...internal.stores["ext:board-games:bgg-internal:search"].values()]).toEqual([{ id: "900001" }]);
    expect([...internal.stores["ext:board-games:bgg-internal:details"].keys()]).toEqual(["900001"]);
  });

  test("simultaneous identical queries share their requests in every source", async () => {
    const api = make();
    const apiContext = makeContext();
    await Promise.all([api.execute("starfall", apiContext), api.execute("starfall", apiContext), api.execute("Starfall board game", apiContext)]);
    expect(kinds(apiContext)).toEqual(["bgg-search", "bgg-thing"]);
    const recommend = make({ enableApi: "false" });
    const recommendContext = makeContext();
    await Promise.all([recommend.execute("starfall", recommendContext), recommend.execute("starfall", recommendContext)]);
    expect(kinds(recommendContext)).toEqual(["rg"]);
    const internal = make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" });
    const internalContext = makeContext();
    await Promise.all([internal.execute("starfall", internalContext), internal.execute("starfall", internalContext)]);
    expect(kinds(internalContext)).toEqual(["wd-search", "wd-entities", "geekitems", "dynamicinfo"]);
  });
});

// ---- settings ----

describe("settings", () => {
  const schema = new BoardGamesSlot().settingsSchema;
  const field = (key) => schema.find((entry) => entry.key === key);

  test("the fields are grouped, and the limits are advanced", () => {
    for (const key of ["enableApi", "apiToken", "enableRecommendGames", "enableBggInternal"]) expect(field(key).fieldset).toBe("Sources");
    for (const key of ["requireBoardGameWord", "showDescription"]) expect(field(key).fieldset).toBe("Display");
    for (const key of ["dailyRequestLimit", "recommendGamesDailyLimit", "internalDailyLimit"]) {
      expect(field(key).fieldset).toBe("Limits");
      expect(field(key).advanced).toBe(true);
      expect(field(key).type).toBe("number");
    }
    expect(field("dailyRequestLimit").label).toBe("BGG API daily request limit");
    expect([field("dailyRequestLimit").default, field("recommendGamesDailyLimit").default, field("internalDailyLimit").default]).toEqual(["300", "500", "100"]);
  });

  test("the toggles have the right defaults, and nothing is required so the environment fallback works", () => {
    expect([field("enableApi").default, field("enableRecommendGames").default, field("enableBggInternal").default]).toEqual(["true", "true", "false"]);
    for (const key of ["enableApi", "enableRecommendGames", "enableBggInternal", "requireBoardGameWord", "showDescription"]) expect(field(key).type).toBe("toggle");
    expect(schema.some((entry) => entry.required)).toBe(false);
    expect(field("apiToken").secret).toBe(true);
    expect(field("apiToken").type).toBe("password");
    expect(field("enableBggInternal").description).toContain("unlicensed");
    expect(field("enableBggInternal").description).toContain("decide for yourself");
  });

  test("a limit is only shown while its source is on", () => {
    expect(field("apiToken").visibleWhen).toEqual({ key: "enableApi", equals: "true" });
    expect(field("dailyRequestLimit").visibleWhen).toEqual({ key: "enableApi", equals: "true" });
    expect(field("recommendGamesDailyLimit").visibleWhen).toEqual({ key: "enableRecommendGames", equals: "true" });
    expect(field("internalDailyLimit").visibleWhen).toEqual({ key: "enableBggInternal", equals: "true" });
  });

  test("toggles accept strings and booleans", () => {
    const slot = make({ enableApi: false, enableRecommendGames: "false", enableBggInternal: true });
    expect([slot.sources.api.enabled, slot.sources.recommend.enabled, slot.sources.internal.enabled]).toEqual([false, false, true]);
    const defaults = new BoardGamesSlot();
    defaults.configure({});
    expect([defaults.sources.api.enabled, defaults.sources.recommend.enabled, defaults.sources.internal.enabled]).toEqual([true, true, false]);
  });

  test("each source has its own usage file, with environment overrides", async () => {
    await withEnv({ DEGOOG_BGG_USAGE_FILE: undefined, DEGOOG_RGAMES_USAGE_FILE: undefined, DEGOOG_GEEKDO_USAGE_FILE: undefined }, () => {
      expect(usageFile("data")).toBe(join("data", "bgg", "usage.json"));
      expect(recommendGamesUsageFile("data")).toBe(join("data", "bgg", "usage-recommend-games.json"));
      expect(geekdoUsageFile("data")).toBe(join("data", "bgg", "usage-geekdo.json"));
    });
    await withEnv({ DEGOOG_BGG_USAGE_FILE: "/tmp/a.json", DEGOOG_RGAMES_USAGE_FILE: "/tmp/b.json", DEGOOG_GEEKDO_USAGE_FILE: "/tmp/c.json" }, () => {
      expect([usageFile("data"), recommendGamesUsageFile("data"), geekdoUsageFile("data")]).toEqual(["/tmp/a.json", "/tmp/b.json", "/tmp/c.json"]);
    });
  });

  test("the base urls come from the environment", async () => {
    await withEnv(
      {
        DEGOOG_BGG_API_BASE: "http://m:1/xmlapi2",
        DEGOOG_RECOMMEND_GAMES_BASE: "http://m:1/recommend",
        DEGOOG_GEEKDO_BASE: "http://m:1/geekdo/api",
        DEGOOG_WIKIDATA_API: "http://m:1/wikidata/w/api.php",
      },
      () => {
        const slot = new BoardGamesSlot();
        expect(slot.sources.api.base).toBe("http://m:1/xmlapi2");
        expect(slot.sources.recommend.base).toBe("http://m:1/recommend");
        expect(slot.sources.internal.base).toBe("http://m:1/geekdo/api");
        expect(slot.sources.internal.wikidata.base).toBe("http://m:1/wikidata/w/api.php");
      },
    );
  });

  test("a usage count is kept per source on disk", async () => {
    const folder = tempFolder();
    const files = { DEGOOG_BGG_USAGE_FILE: join(folder, "a.json"), DEGOOG_RGAMES_USAGE_FILE: join(folder, "b.json"), DEGOOG_GEEKDO_USAGE_FILE: join(folder, "c.json") };
    await withEnv(files, async () => {
      const slot = new BoardGamesSlot();
      slot.spacingMs = 0;
      slot.sources.api.base = "https://bgg.test/xmlapi2";
      slot.sources.recommend.base = "https://rg.test";
      slot.configure({ ...SOURCE_SETTINGS });
      const context = makeContext({ respond: (kind) => (kind === "bgg-search" ? html5xx() : undefined) });
      await capture(() => slot.execute("starfall", context));
      expect(JSON.parse(await Bun.file(files.DEGOOG_BGG_USAGE_FILE).text()).used).toBe(1);
      expect(JSON.parse(await Bun.file(files.DEGOOG_RGAMES_USAGE_FILE).text()).used).toBe(1);
      expect(await Bun.file(files.DEGOOG_GEEKDO_USAGE_FILE).exists()).toBe(false);
    });
  });
});

// ---- rendering across sources ----

describe("rendering for every source", () => {
  const signProxy = (url) => `/proxy?u=${encodeURIComponent(url)}`;
  const fromApi = parseRecommendGames(recommendText)[0];
  const fromWebsite = compactGeekdo(geekitem, dynamicinfo);

  test("the attribution depends on the source", () => {
    expect(attributionHtml("bgg-api")).toBe('<a class="board-games-credit" href="https://boardgamegeek.com" target="_blank" rel="noopener">Powered by BGG</a>');
    expect(attributionHtml("recommend-games")).toBe(
      'Data from <a href="https://recommend.games" target="_blank" rel="noopener">recommend.games</a> (originally from <a href="https://boardgamegeek.com" target="_blank" rel="noopener">BoardGameGeek</a>)',
    );
    expect(attributionHtml("bgg-internal")).toBe('Data from <a href="https://boardgamegeek.com" target="_blank" rel="noopener">BoardGameGeek</a>');
    expect(attributionHtml("something else")).toContain("Powered by BGG");
    expect(attributionHtml(undefined)).toContain("Powered by BGG");
  });

  test("the badges, the link and the card marker are the same for every source", () => {
    for (const [game, source] of [[fromApi, "recommend-games"], [fromWebsite, "bgg-internal"], [blankGame("bgg-api", { id: "900001", name: "X", rating: 7, rank: 3, weight: 2 }), "bgg-api"]]) {
      const html = buildPanel({ game, signProxy });
      expect(html).toContain(`<div class="board-games-card" data-source="${source}">`);
      for (const label of ["BGG rating", "BGG rank", "Weight / 5"]) expect(html).toContain(label);
      expect(html).toContain('href="https://boardgamegeek.com/boardgame/900001"');
      expect(html.match(/data-source/g)).toHaveLength(1);
    }
  });

  test("rows the game has no data for are left out", () => {
    const rg = buildPanel({ game: fromApi, signProxy });
    expect(rg).not.toContain("Publishers");
    expect(rg).not.toContain("expansions on BGG");
    expect(rg).toContain("Designers");
    expect(rg).toContain("Best with 2–3");
    expect(rg).toContain("Recommended 1–4");
    const site = buildPanel({ game: fromWebsite, signProxy });
    expect(site).toContain("Publishers");
    expect(site).toContain("2 expansions on BGG");
    const bare = buildPanel({ game: blankGame("recommend-games", { id: "5", name: "Bare" }) });
    for (const row of ["Players", "Playing time", "Age", "Designers", "Publishers", "Categories", "Mechanics", "Expansions"]) expect(bare).not.toContain(`<dt>${row}</dt>`);
    expect(bare).not.toContain("<dl");
    expect(bare).not.toContain("board-games-scores");
  });

  test("covers are signed through the proxy, whatever the source", () => {
    expect(buildPanel({ game: fromApi, signProxy })).toContain(encodeURIComponent("https://cf.geekdo-images.com/placeholder-starfall/small/img/small-900001.jpg"));
    expect(buildPanel({ game: fromWebsite, signProxy })).toContain(encodeURIComponent("previewthumb-900001.jpg"));
    expect(buildPanel({ game: { ...fromWebsite, image: "https://evil.test/x.jpg" }, signProxy })).not.toContain("<img");
  });

  test("a hostile source value cannot break out of the attribute", () => {
    const html = buildPanel({ game: { ...fromApi, source: '"><script>alert(1)</script>' } });
    expect(html).not.toContain("<script");
    expect(html).toContain("data-source=\"&quot;&gt;&lt;script&gt;");
    expect(html).toContain("Powered by BGG");
  });
});
