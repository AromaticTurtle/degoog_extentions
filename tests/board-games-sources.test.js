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
import { SETTINGS_SCHEMA } from "../plugins/board-games/settings.js";
import { BARS, evaluate, formatExplanation, judge, pickGame, scoreGame, specificity, stripDecorations, titleSimilarity } from "../plugins/board-games/match.js";
import { BoardGamesSlot, LOOKUP_KEY, VIDEO_LOOKUP_KEY, videoWaitFromSetting } from "../plugins/board-games/index.js";
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
  // the two plugins register lookup functions on globalThis in init(); one test must not see another's
  delete globalThis[Symbol.for("degoog-extentions.board-games.lookup")];
  delete globalThis[Symbol.for("degoog-extentions.game-info.lookup")];
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
    // an explicit ordering by votes: the default ordering makes the server take 15 to 20 s for the same search
    expect(url.searchParams.get("ordering")).toBe("-num_votes");
    expect([...url.searchParams.keys()].sort()).toEqual(["ordering", "search"]);
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

  test("popularity for recommend.games is its vote count; a close first result needs half of the bar", async () => {
    const withVotes = (votes) => JSON.stringify({ results: [{ ...recommendFixture.results[0], num_votes: votes }] });
    const few = withVotes(49);
    const slot = make({ enableApi: "false" });
    expect(await slot.execute("starfall", makeContext({ recommend: few }))).toEqual(EMPTY);
    // "starfall" is medium specificity (exact bar 100); it is the first result, so 50 votes are enough
    expect((await make({ enableApi: "false" }).execute("starfall", makeContext({ recommend: withVotes(50) }))).title).toBe("Starfall");
    // not the first result: the full bar applies
    const second = JSON.stringify({ results: [{ ...recommendFixture.results[0], bgg_id: 1, name: "Unrelated Game", alt_name: [], num_votes: 5 }, { ...recommendFixture.results[0], num_votes: 99 }] });
    expect(await make({ enableApi: "false" }).execute("starfall", makeContext({ recommend: second }))).toEqual(EMPTY);
    // with a board game word the intent bar (50) applies
    expect((await make({ enableApi: "false" }).execute("starfall board game", makeContext({ recommend: few }))).title).toBe("");
    expect((await make({ enableApi: "false" }).execute("starfall board game", makeContext({ recommend: second }))).title).toBe("Starfall");
  });

  test("the website API applies the same confidence rules, with the vote count from its statistics", async () => {
    const weak = { item: { ...dynamicinfo.item, stats: { ...dynamicinfo.item.stats, usersrated: "99" } } };
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

// ---- Decision quality: regression tests. Invented games shaped like a real, hugely popular title that is ----
// ---- also a video game, answered by recommend.games with several expansions and a translated standalone. ----

// A recommend.games result in the real layout, with invented content.
const rgResult = (id, name, votes, extra = {}) => ({
  bgg_id: id,
  name,
  alt_name: [],
  year: 2019,
  description: "An invented description for tests.",
  min_players: 1,
  max_players: 5,
  min_players_rec: 1,
  max_players_rec: 5,
  min_players_best: 2,
  max_players_best: 4,
  min_age: 10,
  min_time: 40,
  max_time: 70,
  bgg_rank: 38,
  num_votes: votes,
  avg_rating: 8.1,
  bayes_rating: 7.9,
  complexity: 2.4,
  designer_name: ["Invented Designer"],
  category_name: ["Animals"],
  mechanic_name: ["Hand Management"],
  image_url: ["https://cf.geekdo-images.com/original/img/x.jpg", "https://cf.geekdo-images.com/small/img/x.jpg"],
  url: `https://boardgamegeek.com/boardgame/${id}`,
  ...extra,
});
const SKYREACH_REPLY = JSON.stringify({
  count: 6,
  next: null,
  previous: null,
  results: [
    rgResult(910002, "Skyreach: Northern Expansion", 9000, { category_name: ["Expansion for Base-game", "Animals"] }),
    rgResult(910001, "Skyreach", 115_000),
    rgResult(910003, "Skyreach: Southern Expansion", 7000, { category_name: ["Expansion for Base-game"] }),
    rgResult(910004, "Skyreach Asia", 4000, { alt_name: ["Skyreach Ασία", "Skyreach Asien"], category_name: ["Expansion for Base-game"] }),
    rgResult(910005, "Skyreach Oceania", 6000, { alt_name: ["Skyreach Ωκεανία"], category_name: ["Expansion for Base-game"] }),
    rgResult(910006, "Skyreach Duel", 3200, { alt_name: ["Skyreach Ωκεανία"] }),
  ],
});

describe("an exact, popular title shows without a keyword (the 'wingspan' case)", () => {
  test("recommend.games: expansions are dropped and the base game is picked, with or without a board game word", async () => {
    for (const query of ["skyreach", "skyreach board game", "the skyreach"]) {
      const slot = make({ enableApi: "false" });
      const out = await slot.execute(query, makeContext({ recommend: SKYREACH_REPLY }));
      expect(out.title).toBe("Skyreach");
      expect(sourceOf(out)).toBe("recommend-games");
    }
    const games = parseRecommendGames(SKYREACH_REPLY);
    expect(games.map((game) => game.id)).toEqual(["910001", "910006"]);
  });

  test("a translated alternate name in another script never makes a different game look exact", () => {
    const duel = parseRecommendGames(SKYREACH_REPLY).find((game) => game.id === "910006");
    expect(duel.alternates).toContain("Skyreach Ωκεανία");
    // the Greek letters would vanish when normalised and leave "skyreach": only Latin names are compared
    expect(scoreGame("skyreach", duel).sim).toBeLessThan(1);
    const withAsia = [rgResult(910004, "Skyreach Asia", 4000, { alt_name: ["Skyreach Ασία"] }), rgResult(910001, "Skyreach", 115_000)].map((raw) => parseRecommendGames(JSON.stringify({ results: [raw] }))[0]);
    expect(pickGame("skyreach", withAsia, false).id).toBe("910001");
    expect(scoreGame("skyreach", withAsia[0]).sim).toBe(0.9); // "Skyreach Asia" only starts with the query
  });

  test("the same title in several editions: the closest, most rated one wins", () => {
    const games = [
      { id: "1", name: "Skyreach (Second Edition)", alternates: [], ratingCount: 900 },
      { id: "2", name: "Skyreach", alternates: [], ratingCount: 50_000 },
      { id: "3", name: "Skyreach: Digital Edition", alternates: [], ratingCount: 3000 },
    ];
    expect(pickGame("skyreach", games, false).id).toBe("2");
    expect(pickGame("skyreach second edition", games, false).id).toBe("1");
    expect(titleSimilarity("skyreach", "Skyreach (Second Edition)")).toBe(1);
    expect(titleSimilarity("skyreach digital edition", "Skyreach")).toBe(1);
  });
});

describe("specificity, edition marks and the rank bonus", () => {
  test("bands", () => {
    expect(specificity("risk")).toBe("low");
    expect(specificity("root")).toBe("low");
    expect(specificity("carl")).toBe("low");
    expect(specificity("wingspan")).toBe("medium");
    expect(specificity("the crew")).toBe("medium");
    expect(specificity("ticket to ride")).toBe("high");
    expect(specificity("gloomhaven jaws of the lion")).toBe("high");
    expect(specificity("Catan (Second Edition)")).toBe("low");
  });

  test("edition marks and parentheticals are cut off on both sides, the numeral rule stays", () => {
    expect(stripDecorations("Catan (Second Edition)")).toBe("Catan");
    expect(stripDecorations("Pandemic: Revised Edition")).toBe("Pandemic");
    expect(stripDecorations("Azul (2017)")).toBe("Azul (2017)".replace(/\s*\(2017\)$/, ""));
    expect(stripDecorations("")).toBe("");
    expect(titleSimilarity("azul 2", "Azul")).toBeLessThan(0.9);
    expect(titleSimilarity("azul 2", "Azul (Second Edition)")).toBeLessThan(0.9);
    expect(pickGame("azul 2", [{ id: "1", name: "Azul", alternates: [], ratingCount: 90_000 }], false)).toBeNull();
  });

  test("bars fall as specificity rises", () => {
    expect(BARS.exact.high).toBeLessThan(BARS.exact.medium);
    expect(BARS.exact.medium).toBeLessThan(BARS.exact.low);
    for (const band of ["low", "medium", "high"]) {
      expect(judge({ sim: 1, pop: BARS.exact[band], intent: false, band }).accepted).toBe(true);
      expect(judge({ sim: 1, pop: BARS.exact[band] - 1, intent: false, band }).accepted).toBe(false);
    }
  });

  test("a close first result of a relevance-ordered source needs half the ratings; a non-match never passes", () => {
    expect(judge({ sim: 1, pop: 200, intent: false, band: "low", rank: 0 }).accepted).toBe(true);
    expect(judge({ sim: 1, pop: 200, intent: false, band: "low", rank: 1 }).accepted).toBe(false);
    expect(judge({ sim: 1, pop: 200, intent: false, band: "low" }).accepted).toBe(false);
    expect(judge({ sim: 0.5, pop: 999_999, intent: false, band: "high", rank: 0 }).accepted).toBe(false);
    const list = [{ id: "1", name: "Risk", alternates: [], ratingCount: 200 }];
    expect(evaluate("risk", list, false, { rankBonus: true }).pick?.id).toBe("1");
    expect(evaluate("risk", list, false).pick).toBeNull();
  });

  test("generic words stay quiet", () => {
    expect(looksBlocked("")).toBe(false);
    for (const word of ["risk", "root", "carl", "weather"]) {
      const list = [{ id: "1", name: word[0].toUpperCase() + word.slice(1), alternates: [], ratingCount: 150 }];
      expect(pickGame(word, list, false)).toBeNull();
    }
  });
});

describe("a slow first lookup (recommend.games can take 15 s or more)", () => {
  test("the late reply is cached, so the next search is instant and costs no request", async () => {
    const slot = make({ enableApi: "false" });
    slot.answerWindowMs = 30;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const context = makeContext({ recommend: SKYREACH_REPLY });
    const realFetch = context.fetch;
    let started = 0;
    context.fetch = async (url, init) => {
      if (kindOf(url) === "rg") {
        started += 1;
        await gate;
      }
      return realFetch(url, init);
    };
    const first = await slot.execute("skyreach", context);
    expect(first).toEqual(EMPTY); // degoog would have given up on this search too
    expect(started).toBe(1);
    // a second search while the request is still running shares it instead of starting another
    const joined = slot.execute("skyreach", context);
    release();
    expect((await joined).title).toBe("Skyreach");
    expect(started).toBe(1);
    // and later searches come from the cache
    expect((await slot.execute("skyreach", context)).title).toBe("Skyreach");
    expect(count(context, "rg")).toBe(1);
  });

  test("the reply that arrives after the window is still cached", async () => {
    const slot = make({ enableApi: "false" });
    slot.answerWindowMs = 20;
    const context = makeContext({ recommend: SKYREACH_REPLY });
    const realFetch = context.fetch;
    context.fetch = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return realFetch(url, init);
    };
    expect(await slot.execute("skyreach", context)).toEqual(EMPTY);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect((await slot.execute("skyreach", context)).title).toBe("Skyreach");
    expect(count(context, "rg")).toBe(1);
  });

  test("the window is a little shorter than degoog's slot timeout and follows it", async () => {
    await withEnv({ DEGOOG_SLOT_TIMEOUT_MS: undefined }, () => expect(new BoardGamesSlot().answerWindowMs).toBe(9500));
    await withEnv({ DEGOOG_SLOT_TIMEOUT_MS: "20000" }, () => expect(new BoardGamesSlot().answerWindowMs).toBe(19000));
  });

  test("a timed-out search says so in the log only when debugMatching is on", async () => {
    const slow = (settings) => {
      const slot = make({ enableApi: "false", ...settings });
      slot.answerWindowMs = 10;
      const context = makeContext({ recommend: SKYREACH_REPLY });
      const realFetch = context.fetch;
      context.fetch = async (url, init) => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return realFetch(url, init);
      };
      return { slot, context };
    };
    const quiet = slow({});
    expect(await capture(() => quiet.slot.execute("skyreach", quiet.context))).toEqual([]);
    const loud = slow({ debugMatching: "true" });
    const lines = await capture(async () => {
      await loud.slot.execute("skyreach", loud.context);
      // the late reply is still processed (and explained) after the window
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(lines[0]).toContain('"skyreach" is still being looked up');
    expect(lines.some((line) => line.includes("=> panel:"))).toBe(true);
  });
});

describe("explaining decisions (debugMatching)", () => {
  test("formatExplanation: header with the source, candidates, verdicts and the outcome", () => {
    const games = parseRecommendGames(SKYREACH_REPLY);
    const text = formatExplanation("skyreach", "skyreach", false, evaluate("skyreach", games, false, { explain: true, rankBonus: true }), "recommend-games");
    const lines = text.split("\n");
    expect(lines[0]).toBe('[board-games] "skyreach" term="skyreach" intent=false specificity=medium source=recommend-games');
    expect(lines[1]).toMatch(/^ {2}#1 "Skyreach" sim=1\.00 signals\[ratings=115000\] pop=115000 -> accepted by exact title, medium specificity \(first result\)/);
    expect(lines.at(-1)).toMatch(/^ {2}=> panel: "Skyreach" \(exact title/);
    const rejected = formatExplanation("risk", "risk", false, evaluate("risk", [{ id: "1", name: "Risk", alternates: [], ratingCount: 40 }], false, { explain: true }), "bgg-api");
    expect(rejected).toContain("rejected: needs pop>=400, has 40");
    expect(rejected.split("\n").at(-1)).toMatch(/^ {2}=> no panel/);
    expect(formatExplanation("x", "x", false, evaluate("x", [], false, { explain: true }), "bgg-api")).toContain("(no candidates)");
  });

  test("the slot logs one block per lookup, only when debugMatching is on, and never the token", async () => {
    const quiet = make({ enableApi: "false" });
    expect(await capture(() => quiet.execute("skyreach", makeContext({ recommend: SKYREACH_REPLY })))).toEqual([]);
    const loud = make({ debugMatching: "true" });
    const lines = await capture(() => loud.execute("starfall", makeContext()));
    // the explain block, then one line saying that no game info plugin is there
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('[board-games] "starfall" term="starfall"');
    expect(lines[0]).toContain("source=bgg-api");
    expect(lines[0]).toContain("=> panel:");
    expect(lines[1]).toBe('[board-games] "starfall" board game shown: the game info plugin is not available');
    for (const bad of [TOKEN, "http", "Bearer"]) for (const line of lines) expect(line).not.toContain(bad);
  });

  test("a title-like query that the gating rejects gets one line naming the rule, only in debug mode", async () => {
    const loud = make({ debugMatching: true });
    const lines = await capture(async () => {
      expect(loud.trigger("starfall ps5")).toBe(false);
      expect(loud.trigger("how to bake bread")).toBe(false);
    });
    expect(lines).toEqual(['[board-games] "starfall ps5" skipped: the query has a video game word and no board game word']);
    expect(await capture(async () => expect(make().trigger("starfall ps5")).toBe(false))).toEqual([]);
    const none = make({ debugMatching: true, enableApi: "false", enableRecommendGames: "false" });
    expect(await capture(async () => expect(none.trigger("starfall")).toBe(false))).toHaveLength(1);
  });

  test("the setting is advanced, off by default and never required", () => {
    const field = SETTINGS_SCHEMA.find((entry) => entry.key === "debugMatching");
    expect(field).toMatchObject({ type: "toggle", default: "false", advanced: true });
    expect(field.required).toBeUndefined();
  });
});

// ---- The contract with the game-info plugin: lookupTitle(), registered under a global symbol ----

describe("the lookup contract (lookupTitle)", () => {
  const ask = (slot, term, context, deadlineMs = 2500) => slot.lookupTitle({ term, deadlineMs, context });

  test("init registers the function under a well-known symbol, a second init replaces it, a reloaded module clears it", async () => {
    expect(LOOKUP_KEY).toBe(Symbol.for("degoog-extentions.board-games.lookup"));
    const first = make();
    first.init({});
    expect(typeof globalThis[LOOKUP_KEY]).toBe("function");
    const before = globalThis[LOOKUP_KEY];
    first.init({});
    expect(globalThis[LOOKUP_KEY]).toBe(before); // the same instance keeps one stable function
    const second = make();
    second.init({});
    expect(globalThis[LOOKUP_KEY]).not.toBe(before);
    // the registered function answers like the method
    second.configure({ ...SOURCE_SETTINGS, enableApi: "false" });
    expect((await globalThis[LOOKUP_KEY]({ term: "starfall", deadlineMs: 1000, context: makeContext() })).status).toBe("match");
    // a module that is evaluated again (degoog reloads plugins) drops the registration; only init brings it back
    await import("../plugins/board-games/index.js?reloaded=1");
    expect(globalThis[LOOKUP_KEY]).toBeUndefined();
    first.init({});
    expect(typeof globalThis[LOOKUP_KEY]).toBe("function");
    delete globalThis[LOOKUP_KEY];
  });

  test("match, none and unknown", async () => {
    const slot = make();
    expect(await ask(slot, "starfall", makeContext())).toEqual({ status: "match", name: "Starfall", id: "900001", year: 2019 });
    expect(await ask(make(), "zzz nothing here", makeContext())).toEqual({ status: "none" });
    // a working source that finds no confident match is final: nothing else is asked
    const context = makeContext();
    expect(await ask(make(), "zzz nothing here", context)).toEqual({ status: "none" });
    expect(count(context, "rg")).toBe(0);
  });

  test("unknown, with no request at all, when no source is usable, the plugin is disabled, or the gating would refuse the term", async () => {
    const nothing = makeContext();
    expect(await ask(make({ enableApi: "false", enableRecommendGames: "false" }), "starfall", nothing)).toEqual({ status: "unknown" });
    expect(await ask(make({ apiToken: "", enableRecommendGames: "false" }), "starfall", nothing)).toEqual({ status: "unknown" });
    expect(await ask(make({ disabled: "true" }), "starfall", nothing)).toEqual({ status: "unknown" });
    expect(await ask(make({ requireBoardGameWord: "true" }), "starfall", nothing)).toEqual({ status: "unknown" });
    expect(await ask(make(), "starfall ps5", nothing)).toEqual({ status: "unknown" });
    expect(await ask(make(), "how to bake bread", nothing)).toEqual({ status: "unknown" });
    expect(await ask(make(), "x", nothing)).toEqual({ status: "unknown" });
    expect(nothing.calls).toHaveLength(0);
    // a paused source is not usable either
    const paused = make({ enableRecommendGames: "false" });
    await capture(async () => paused.sources.api.upstream.pause(60_000, "test pause"));
    expect(await ask(paused, "starfall", nothing)).toEqual({ status: "unknown" });
    expect(nothing.calls).toHaveLength(0);
  });

  test("a source that failed is unknown, and the chain still falls back", async () => {
    const context = makeContext({ respond: (kind) => (kind === "bgg-search" ? html5xx() : undefined) });
    const broken = makeContext({ respond: (kind) => (kind === "bgg-search" || kind === "rg" ? html5xx() : undefined) });
    await capture(async () => {
      // recommend.games takes over, exactly as for execute()
      expect(await ask(make(), "starfall", context)).toEqual({ status: "match", name: "Starfall", id: "900001", year: 2019 });
      expect(await ask(make(), "starfall", broken)).toEqual({ status: "unknown" });
    });
  });

  test("it shares requests with execute(): one upstream request each, concurrent or later", async () => {
    const slot = make();
    const context = makeContext();
    const [panel, outcome] = await Promise.all([slot.execute("starfall", context), ask(slot, "starfall", context)]);
    expect(panel.title).toBe("Starfall");
    expect(outcome.status).toBe("match");
    expect(count(context, "bgg-search")).toBe(1);
    expect(count(context, "bgg-thing")).toBe(1);
    // a later lookup and a later execute cost nothing
    context.calls.length = 0;
    expect((await ask(slot, "starfall", context)).status).toBe("match");
    expect((await slot.execute("starfall", context)).title).toBe("Starfall");
    expect(context.calls).toHaveLength(0);
    // and the other way round: lookup first, execute afterwards
    const other = make();
    const again = makeContext();
    expect((await ask(other, "starfall", again)).status).toBe("match");
    expect((await other.execute("starfall", again)).title).toBe("Starfall");
    expect(count(again, "bgg-search")).toBe(1);
    expect(count(again, "bgg-thing")).toBe(1);
  });

  test("a cached 'no match' costs nothing either", async () => {
    const slot = make();
    const context = makeContext();
    expect((await ask(slot, "zzz nothing here", context)).status).toBe("none");
    const used = context.calls.length;
    expect((await ask(slot, "zzz nothing here", context)).status).toBe("none");
    expect(context.calls).toHaveLength(used);
  });

  test("it waits at most deadlineMs, and the late reply still fills the cache", async () => {
    const slot = make({ enableApi: "false" });
    const context = makeContext({ recommend: SKYREACH_REPLY });
    const realFetch = context.fetch;
    context.fetch = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return realFetch(url, init);
    };
    const started = Date.now();
    expect(await ask(slot, "skyreach", context, 25)).toEqual({ status: "unknown" });
    expect(Date.now() - started).toBeLessThan(100);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await ask(slot, "skyreach", context, 25)).toMatchObject({ status: "match", name: "Skyreach" });
    expect((await slot.execute("skyreach", context)).title).toBe("Skyreach");
    expect(count(context, "rg")).toBe(1);
  });

  test("after execute() gave up on a slow title, the lookup does not promise a board game panel that will not come", async () => {
    const slot = make({ enableApi: "false" });
    slot.answerWindowMs = 20;
    const context = makeContext({ recommend: SKYREACH_REPLY });
    const realFetch = context.fetch;
    context.fetch = async (url, init) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return realFetch(url, init);
    };
    expect(await slot.execute("skyreach", context)).toEqual(EMPTY); // too slow for this search
    // the reply would arrive inside the wait below, but the panel is already gone for this search
    expect(await ask(slot, "skyreach", context, 1000)).toEqual({ status: "unknown" });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect((await ask(slot, "skyreach", context, 1000)).status).toBe("match"); // the next search gets it from the cache
    expect((await slot.execute("skyreach", context)).title).toBe("Skyreach");
    expect(count(context, "rg")).toBe(1);
  });

  test("a deadline of zero or less makes no request, and the default wait is the slot's start window", async () => {
    const context = makeContext();
    expect(await ask(make(), "starfall", context, 0)).toEqual({ status: "unknown" });
    expect(await ask(make(), "starfall", context, -5)).toEqual({ status: "unknown" });
    expect(context.calls).toHaveLength(0);
    expect((await make().lookupTitle({ term: "starfall", context })).status).toBe("match");
  });

  test("it never throws, whatever it is given", async () => {
    const slot = make();
    for (const request of [undefined, null, {}, { term: null }, { term: 5 }, { term: {} }, { term: "starfall", deadlineMs: "soon" }, { term: "x".repeat(5000) }]) {
      const outcome = await slot.lookupTitle(request);
      expect(["match", "none", "unknown"]).toContain(outcome.status);
    }
    const throwing = { ...makeContext(), fetch: async () => { throw new Error("down"); } };
    await capture(async () => expect(await ask(make(), "starfall", throwing)).toEqual({ status: "unknown" }));
    const boom = make();
    boom._find = async () => { throw new Error("boom"); };
    expect(await ask(boom, "starfall", makeContext())).toEqual({ status: "unknown" });
  });

  test("the answers are frozen values and carry no urls or secrets", async () => {
    const outcome = await ask(make(), "starfall", makeContext());
    expect(Object.keys(outcome).sort()).toEqual(["id", "name", "status", "year"]);
    expect(Number.isInteger(outcome.year)).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("http");
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(Object.isFrozen(await ask(make(), "zzz nothing here", makeContext()))).toBe(true);
  });

  test("debugMatching logs one line per question, without secrets or addresses", async () => {
    const loud = make({ debugMatching: "true" });
    const lines = await capture(async () => {
      await ask(loud, "starfall", makeContext());
      await ask(loud, "starfall", makeContext());
    });
    expect(lines.filter((line) => line.includes("asked about by game-info"))).toEqual([
      '[board-games] "starfall" asked about by game-info: match "Starfall" 2019',
      '[board-games] "starfall" asked about by game-info: match "Starfall" 2019',
    ]);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("http");
    }
    expect(await capture(() => ask(make(), "starfall", makeContext()))).toEqual([]);
  });

  test("the title is cleaned like a query: a trailing 'game' is dropped, 'the game' is not", async () => {
    const context = makeContext();
    expect((await ask(make(), "starfall game", context)).status).toBe("match");
    const slot = make();
    const panel = await slot.execute("starfall game", makeContext());
    expect(panel.title).toBe("Starfall");
  });
});

describe("the recommend.games request is the fast one", () => {
  test("a cold search sends the vote ordering, one request, and the answer is matched as before", async () => {
    const slot = make({ enableApi: "false" });
    const context = makeContext({ recommend: SKYREACH_REPLY });
    expect((await slot.execute("skyreach", context)).title).toBe("Skyreach");
    const calls = context.calls.filter((call) => call.kind === "rg");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/games/");
    expect(url.searchParams.get("search")).toBe("skyreach");
    expect(url.searchParams.get("ordering")).toBe("-num_votes");
    expect(context.calls.filter((call) => call.kind !== "rg")).toHaveLength(0); // no Wikidata or website API call
  });

  test("the ordering also applies to the lookup that game-info asks for", async () => {
    const slot = make({ enableApi: "false" });
    const context = makeContext({ recommend: SKYREACH_REPLY });
    expect(await slot.lookupTitle({ term: "skyreach", deadlineMs: 1000, context })).toMatchObject({ status: "match", name: "Skyreach" });
    expect(new URL(context.calls[0].url).searchParams.get("ordering")).toBe("-num_votes");
  });

  test("the vote ordering puts the best known game first, which earns the first-result bonus", async () => {
    const reply = JSON.stringify({
      results: [rgResult(910001, "Skyreach", 60), rgResult(910006, "Skyreach Duel", 30)],
    });
    // 60 votes: "skyreach" is a medium query (exact bar 100), halved for a first result = 50, so it shows
    expect((await make({ enableApi: "false" }).execute("skyreach", makeContext({ recommend: reply }))).title).toBe("Skyreach");
  });
});

// ---- When both match: whichever came first, seen from board-games ----

describe("the year in the lookup answer, from each source", () => {
  const ask = (slot, term, context) => slot.lookupTitle({ term, deadlineMs: 2500, context });

  test("BGG XML API", async () => {
    expect(await ask(make({ enableRecommendGames: "false" }), "starfall", makeContext())).toMatchObject({ status: "match", year: 2019 });
  });

  test("recommend.games", async () => {
    expect(await ask(make({ enableApi: "false" }), "starfall", makeContext())).toMatchObject({ status: "match", year: 2019 });
    const reply = JSON.stringify({ results: [rgResult(910001, "Skyreach", 115_000, { year: 2020 })] });
    expect(await ask(make({ enableApi: "false" }), "skyreach", makeContext({ recommend: reply }))).toMatchObject({ status: "match", year: 2020 });
  });

  test("BGG website API (with Wikidata)", async () => {
    expect(await ask(make({ enableApi: "false", enableRecommendGames: "false", enableBggInternal: "true" }), "starfall", makeContext())).toMatchObject({ status: "match", year: 2019 });
  });

  test("the year is an integer, 0 when the source has none or garbage", async () => {
    for (const year of [null, undefined, "", "soon", -5, 0]) {
      const reply = JSON.stringify({ results: [rgResult(910001, "Skyreach", 115_000, { year })] });
      const outcome = await ask(make({ enableApi: "false" }), "skyreach", makeContext({ recommend: reply }));
      expect(outcome.status).toBe("match");
      expect(outcome.year).toBe(0);
    }
    const asString = JSON.stringify({ results: [rgResult(910001, "Skyreach", 115_000, { year: "1995" })] });
    expect((await ask(make({ enableApi: "false" }), "skyreach", makeContext({ recommend: asString }))).year).toBe(1995);
  });
});

describe("whichever came first, seen from board-games", () => {
  const video = (answer) => {
    const calls = [];
    return { calls, lookup: async (request) => { calls.push(request); return typeof answer === "function" ? answer(request) : answer; } };
  };
  const run = async (query, answer, settings = {}) => {
    const fake = video(answer);
    const slot = make(settings);
    slot.videoLookup = () => fake.lookup;
    const out = await slot.execute(query, makeContext());
    return { out, calls: fake.calls, shown: Boolean(out.html) };
  };
  // the board game "Starfall" is from 2019
  const match = (year, extra = {}) => ({ status: "match", name: "Starfall (video game)", id: "990001", year, mode: "oldest", ...extra });

  test("the symbol is the documented one and the default lookup reads the global", async () => {
    expect(VIDEO_LOOKUP_KEY).toBe(Symbol.for("degoog-extentions.game-info.lookup"));
    const slot = make();
    expect(slot.videoLookup()).toBeUndefined();
    const lookup = async () => ({ status: "none" });
    globalThis[VIDEO_LOOKUP_KEY] = lookup;
    try {
      expect(slot.videoLookup()).toBe(lookup);
    } finally {
      delete globalThis[VIDEO_LOOKUP_KEY];
    }
  });

  test("a video game released before the board game (2019) hides the board game", async () => {
    const { shown, calls } = await run("starfall", match(2016));
    expect(shown).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].term).toBe("starfall");
    expect((await run("starfall", match(2018))).shown).toBe(false);
  });

  test("a video game released after the board game leaves the board game", async () => {
    expect((await run("starfall", match(2021))).shown).toBe(true);
  });

  test("a tie, an unknown or an invalid year goes to the board game", async () => {
    for (const year of [2019, 0, undefined, null, "", "soon", -3, NaN]) expect((await run("starfall", match(year))).shown).toBe(true);
  });

  test("the mode is game-info's, carried in the answer: board-game and both show the board game, video-game hides it", async () => {
    expect((await run("starfall", match(2000, { mode: "board-game" }))).shown).toBe(true);
    expect((await run("starfall", match(2000, { mode: "both" }))).shown).toBe(true);
    expect((await run("starfall", match(2030, { mode: "video-game" }))).shown).toBe(false);
    // no local setting changes it
    expect((await run("starfall", match(2030, { mode: "video-game" }), { whenBothMatch: "board-game", preferBoardGames: "true" })).shown).toBe(false);
    // a missing or unknown mode is the default rule
    expect((await run("starfall", match(2000, { mode: undefined }))).shown).toBe(false);
    expect((await run("starfall", match(2000, { mode: "nonsense" }))).shown).toBe(false);
    expect((await run("starfall", match(2030, { mode: "nonsense" }))).shown).toBe(true);
  });

  test("none, unknown, anything odd, a throw, a hang and an absent plugin show the board game", async () => {
    for (const answer of [{ status: "none" }, { status: "unknown" }, undefined, null, "match", 5, {}]) expect((await run("starfall", answer)).shown).toBe(true);
    const throwing = make();
    throwing.videoLookup = () => async () => { throw new Error("boom"); };
    expect((await throwing.execute("starfall", makeContext())).title).toBe("Starfall");
    const hanging = make();
    hanging.videoLookup = () => () => new Promise(() => {});
    hanging.startWindowMs = 600;
    const started = Date.now();
    expect((await hanging.execute("starfall", makeContext())).title).toBe("Starfall");
    expect(Date.now() - started).toBeLessThan(1500);
    expect((await make().execute("starfall", makeContext())).title).toBe("Starfall");
  });

  test("a board game word means game-info does not trigger: nothing is asked; a video word means this plugin does not trigger", async () => {
    for (const query of ["starfall board game", "starfall rules", "starfall tabletop", "starfall bgg", "starfall expansion"]) {
      const result = await run(query, match(1990));
      expect(result.shown).toBe(true);
      expect(result.calls).toHaveLength(0);
    }
    for (const query of ["starfall ps5", "starfall steam", "starfall walkthrough"]) {
      const result = await run(query, match(1990));
      expect(result.shown).toBe(false);
      expect(result.calls).toHaveLength(0);
    }
  });

  test("an ambiguous word is dropped from the term that is sent", async () => {
    const { calls } = await run("starfall game", { status: "none" });
    expect(calls[0].term).toBe("starfall");
  });

  test("the wait: videoGameWaitSeconds clamped to 1..8, 3 by default, capped by what is left of 70 % of the slot timeout", async () => {
    expect(videoWaitFromSetting("3")).toBe(3000);
    expect(videoWaitFromSetting(undefined)).toBe(3000);
    expect(videoWaitFromSetting("0")).toBe(1000);
    expect(videoWaitFromSetting("-4")).toBe(1000);
    expect(videoWaitFromSetting("0.3")).toBe(1000);
    expect(videoWaitFromSetting("2.5")).toBe(2500);
    expect(videoWaitFromSetting("8")).toBe(8000);
    expect(videoWaitFromSetting("99")).toBe(8000);
    for (const bad of ["", "soon", null, NaN, Infinity, {}]) expect(videoWaitFromSetting(bad)).toBe(3000);
    expect(make().videoWaitMs).toBe(3000);
    const field = SETTINGS_SCHEMA.find((entry) => entry.key === "videoGameWaitSeconds");
    expect(field).toMatchObject({ type: "number", default: "3", advanced: true });
    expect(field.required).toBeUndefined();
    expect(SETTINGS_SCHEMA.some((entry) => entry.key === "whenBothMatch")).toBe(false); // game-info is the one place for it

    const wait = async (settings, startWindowMs = 8000) => {
      const fake = video({ status: "none" });
      const slot = make(settings);
      slot.startWindowMs = startWindowMs;
      slot.videoLookup = () => fake.lookup;
      await slot.execute("starfall", makeContext());
      return fake.calls[0]?.deadlineMs;
    };
    expect(await wait({})).toBeLessThanOrEqual(3000);
    expect(await wait({})).toBeGreaterThan(2500);
    expect(await wait({ videoGameWaitSeconds: "6" })).toBeLessThanOrEqual(6000);
    expect(await wait({ videoGameWaitSeconds: "6" })).toBeGreaterThan(5500);
    expect(await wait({ videoGameWaitSeconds: "1" })).toBeLessThanOrEqual(1000);
    expect(await wait({ videoGameWaitSeconds: "99" })).toBeLessThanOrEqual(8000);
    expect(await wait({ videoGameWaitSeconds: "6" }, 1500)).toBeLessThanOrEqual(1500); // the slot budget is the limit
  });

  test("when almost nothing of the slot time is left the video game is not asked", async () => {
    const fake = video(match(1990));
    const slot = make();
    slot.videoLookup = () => fake.lookup;
    let ticks = 0;
    slot.now = () => 1_000_000 + (ticks += 4000); // every reading is 4 s later than the previous one
    const out = await slot.execute("starfall", makeContext());
    expect(fake.calls).toHaveLength(0);
    // the pipeline itself ran out of time too, so there may be no panel: either way no question was asked
    expect(["Starfall", ""]).toContain(out.title);
  });

  test("this plugin's own lookup never calls the video game lookup: no recursion", async () => {
    const fake = video(match(1990));
    const slot = make();
    slot.videoLookup = () => fake.lookup;
    for (const term of ["starfall", "zzz nothing"]) await slot.lookupTitle({ term, deadlineMs: 1000, context: makeContext() });
    expect(fake.calls).toHaveLength(0);
  });

  test("debug lines: both match, and why the board game stayed; no secrets", async () => {
    const lines = await capture(() => run("starfall", match(2016), { debugMatching: "true" }));
    expect(lines.filter((line) => line.includes("both match"))).toEqual(['[board-games] "starfall" both match: board "Starfall" 2019 vs video "Starfall (video game)" 2016, mode=oldest -> showing video']);
    const board = await capture(() => run("starfall", match(2021), { debugMatching: "true" }));
    expect(board.some((line) => line.endsWith("-> showing board"))).toBe(true);
    const both = await capture(() => run("starfall", match(2016, { mode: "both" }), { debugMatching: "true" }));
    expect(both.some((line) => line.includes("mode=both -> showing both"))).toBe(true);
    const unknown = await capture(() => run("starfall", { status: "unknown" }, { debugMatching: "true" }));
    expect(unknown).toContain('[board-games] "starfall" board game shown: video game lookup unknown or too slow');
    const hostile = await capture(() => run("starfall", match(2016, { name: `Bad\n[injected] ${"x".repeat(300)}` }), { debugMatching: "true" }));
    const line = hostile.find((entry) => entry.includes("both match"));
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBeLessThan(300);
    for (const entry of [...lines, ...board, ...both, ...unknown, ...hostile]) for (const bad of [TOKEN, "http", "Bearer"]) expect(entry).not.toContain(bad);
    expect(await capture(() => run("starfall", match(2016)))).toEqual([]);
  });

  test("a hidden board game is still cached, so a later search costs no request", async () => {
    const fake = video(match(2016));
    const slot = make();
    slot.videoLookup = () => fake.lookup;
    const context = makeContext();
    expect(await slot.execute("starfall", context)).toEqual(EMPTY);
    const used = context.calls.length;
    expect(await slot.execute("starfall", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(used);
    fake.lookup = async () => ({ status: "none" });
    slot.videoLookup = () => fake.lookup;
    expect((await slot.execute("starfall", context)).title).toBe("Starfall");
    expect(context.calls).toHaveLength(used);
  });
});
