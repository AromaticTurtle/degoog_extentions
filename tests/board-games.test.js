// Tests for the board-games slot plugin (BoardGameGeek).
//
// NOTE: tests/fixtures/bgg-search.xml and bgg-thing.xml are HAND-WRITTEN to BoardGameGeek's documented XML layout.
// They are NOT real recordings: the games ("Starfall" and friends), ids (900001...), texts and numbers are invented.
// The XML layout itself is unverified until real fixtures are recorded with
// BGG_API_TOKEN=... bun ./tests/record-bgg-fixtures.js "wingspan" in your own terminal.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, usageFile } from "../plugins/board-games/budget.js";
import {
  DEFAULT_API_BASE,
  bggPage,
  buildHeaders,
  buildSearchUrl,
  buildThingUrl,
  imageUrl,
  isId,
  looksBlocked,
  normalizeToken,
  readText,
  retryAfterMs,
  sanitizeTerm,
} from "../plugins/board-games/request.js";
import { attrOf, childrenOf, decodeEntities, decodeHtmlEntities, firstChild, parseXml, scanXml } from "../plugins/board-games/xml.js";
import { cleanDescription, compactThing, formatPlayerList, parseThings, scanSearch } from "../plugins/board-games/shape.js";
import {
  CANDIDATE_MIN_SIMILARITY,
  EXACT_MIN_RATINGS,
  INTENT_LOOSE_MIN_RATINGS,
  INTENT_MIN_RATINGS,
  PREFIX_MIN_RATINGS,
  SUBTITLE_EXACT,
  SUBTITLE_MIN_RATINGS,
  cacheKey,
  extractTerm,
  hasBoardGameWord,
  hasVideoGameWord,
  isAcceptedType,
  isConfidentMatch,
  isVideoGameQuery,
  looksLikeATitleSearch,
  normalizeTitle,
  pickGame,
  popularity,
  rankCandidates,
  subtitles,
  titleSimilarity,
} from "../plugins/board-games/match.js";
import { buildPanel, esc, playTimeText, playersText, summarize } from "../plugins/board-games/render.js";
import { BoardGamesSlot, slot as defaultSlot } from "../plugins/board-games/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url)).text();
const searchXml = await read("./fixtures/bgg-search.xml");
const thingXml = await read("./fixtures/bgg-thing.xml");
const SCAN = scanSearch(searchXml);
const THINGS = parseThings(thingXml);
const [STARFALL, DUEL, LEGACY] = THINGS;

const TOKEN = "test-bgg-token-5d7e1b9c2a";
const folders = [];
afterEach(() => {
  while (folders.length) rmSync(folders.pop(), { recursive: true, force: true });
});
const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "board-games-"));
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

const xmlResponse = (body, status = 200, headers = {}) => new Response(body, { status, headers: { "content-type": "text/xml", ...headers } });
const itemBlocks = thingXml.match(/<item\b[\s\S]*?<\/item>/g);
const thingFor = (url) => {
  const ids = new Set((new URL(url).searchParams.get("id") ?? "").split(","));
  const blocks = itemBlocks.filter((block) => ids.has(/\bid="(\d+)"/.exec(block)?.[1]));
  return `<?xml version="1.0"?><items>${blocks.join("")}</items>`;
};
const EMPTY_SEARCH = '<?xml version="1.0"?><items total="0"></items>';

const kindOf = (url) => (new URL(url).pathname.endsWith("/thing") ? "thing" : "search");
const kinds = (context) => context.calls.map((call) => kindOf(call.url));

// A fake degoog context. `respond(kind, { url, init })` may return a Response to override the default one.
const makeContext = ({ search = searchXml, respond, token = TOKEN } = {}) => {
  const calls = [];
  return {
    calls,
    signProxyUrl: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init, at: Date.now() });
      const kind = kindOf(url);
      const override = respond?.(kind, { url: String(url), init });
      if (override) return override;
      if (init.headers?.Authorization !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
      return xmlResponse(kind === "search" ? search : thingFor(url));
    },
  };
};

const make = (settings = { apiToken: TOKEN }) => {
  const slot = new BoardGamesSlot();
  slot.apiBase = "https://bgg.test/xmlapi2";
  slot.spacingMs = 0;
  slot.budget = new Budget({ file: "", cap: 1000, now: () => slot.now() });
  slot.configure(settings);
  return slot;
};

const EMPTY = { title: "", html: "" };
const rated = (id, name, ratingCount, extra = {}) => ({ id: String(id), name, alternates: [], itemType: "boardgame", ratingCount, ...extra });

describe("request building", () => {
  test("the search url encodes the query and asks for board games only", () => {
    const url = new URL(buildSearchUrl("star fall", "https://api.test/xmlapi2/"));
    expect(url.origin + url.pathname).toBe("https://api.test/xmlapi2/search");
    expect(url.searchParams.get("query")).toBe("star fall");
    expect(url.searchParams.get("type")).toBe("boardgame");
    const tricky = buildSearchUrl("a&b=c?d#e", "https://api.test/xmlapi2");
    expect(new URL(tricky).searchParams.get("query")).toBe("a&b=c?d#e");
    expect(tricky).toContain("a%26b%3Dc%3Fd%23e");
    expect(buildSearchUrl("x").startsWith(`${DEFAULT_API_BASE}/search?`)).toBe(true);
    expect(DEFAULT_API_BASE).toBe("https://boardgamegeek.com/xmlapi2");
  });

  test("terms lose control characters and are capped", () => {
    expect(sanitizeTerm("  a\u0000b\n c\u007f  ")).toBe("a b c");
    expect(sanitizeTerm("x".repeat(500))).toHaveLength(100);
    expect(sanitizeTerm(null)).toBe("");
  });

  test("the thing url holds only unique digit ids, at most eight", () => {
    expect(buildThingUrl(["1", "x", "2; drop", "3", "3", 4], "https://api.test/xmlapi2")).toBe("https://api.test/xmlapi2/thing?id=1,3,4&stats=1");
    const many = Array.from({ length: 20 }, (_, i) => String(i + 1));
    const url = buildThingUrl(many, "https://api.test/xmlapi2");
    expect(new URL(url).searchParams.get("id").split(",")).toHaveLength(8);
    expect(new URL(url).searchParams.get("stats")).toBe("1");
    for (const bad of [[], ["x"], null, undefined, "12", [""], ["1234567890"]]) expect(buildThingUrl(bad)).toBe("");
    expect(isId("900001")).toBe(true);
    expect(isId("../1")).toBe(false);
  });

  test("the token goes only into the Authorization header, with an honest user agent", () => {
    const headers = buildHeaders(TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.Accept).toBe("application/xml");
    expect(headers["User-Agent"]).toBe("degoog-board-games/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)");
    expect(buildSearchUrl("starfall")).not.toContain(TOKEN);
    expect(buildThingUrl(["1", "2"])).not.toContain(TOKEN);
  });

  test("tokens are cleaned and anything odd is refused", () => {
    expect(normalizeToken("  abc-123_XYZ ")).toBe("abc-123_XYZ");
    expect(normalizeToken("Bearer abc123")).toBe("abc123");
    expect(normalizeToken("bearer   abc123")).toBe("abc123");
    for (const bad of ["", "   ", "a b", "ab\ncd", "tøken", null, undefined, "x\u0000y"]) expect(normalizeToken(bad)).toBe("");
  });

  test("links and cover images are built from validated values only", () => {
    expect(bggPage("900001")).toBe("https://boardgamegeek.com/boardgame/900001");
    for (const bad of ["", "12a", "../1", "1/2", null, undefined]) expect(bggPage(bad)).toBe("");
    expect(imageUrl("https://cf.geekdo-images.com/a/b.jpg")).toBe("https://cf.geekdo-images.com/a/b.jpg");
    expect(imageUrl("https://geekdo-images.com/a.jpg")).toBe("https://geekdo-images.com/a.jpg");
    for (const bad of [
      "http://cf.geekdo-images.com/a.jpg",
      "https://evil.test/geekdo-images.com/a.jpg",
      "https://geekdo-images.com.evil.test/a.jpg",
      "https://evilgeekdo-images.com/a.jpg",
      "https://user:pw@cf.geekdo-images.com/a.jpg",
      "javascript:alert(1)",
      "//cf.geekdo-images.com/a.jpg",
      "",
      null,
      undefined,
      5,
    ]) {
      expect(imageUrl(bad)).toBe("");
    }
  });

  test("retry-after is bounded, replies are read up to a limit, and block pages are recognised", async () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("999999")).toBe(3_600_000);
    expect(retryAfterMs(undefined)).toBe(600_000);
    expect(retryAfterMs("-5")).toBe(600_000);
    expect(await readText(new Response("x".repeat(5000)), 100)).toHaveLength(101);
    expect(await readText(new Response("short"), 100)).toBe("short");
    expect(await readText({ body: null, text: async () => "plain" }, 100)).toBe("plain");
    expect(await readText({ get body() { throw new Error("no"); } }, 100)).toBe("");
    expect(looksBlocked("<!DOCTYPE html><html><title>Just a moment...</title>")).toBe(true);
    expect(looksBlocked("  <html lang='en'>")).toBe(true);
    expect(looksBlocked("<?xml version='1.0'?><items/>")).toBe(false);
  });
});

describe("the XML reader", () => {
  test("reads tags, attributes in both quote styles, text, CDATA and self-closing tags", () => {
    const root = parseXml(`<?xml version="1.0" encoding="utf-8"?>
      <!-- a comment <with> tags -->
      <?pi ignored?>
      <items total='2' note="it's &quot;ok&quot;" bare=1>
        <item id="1"><name value="A &amp; B"/><d><![CDATA[<b>raw & text</b>]]></d></item>
        <item id = "2" />
        <t>one &lt; two &#65;&#x42;</t>
      </items>`);
    expect(root.tag).toBe("items");
    expect(attrOf(root, "total")).toBe("2");
    expect(attrOf(root, "note")).toBe('it\'s "ok"');
    expect(attrOf(root, "bare")).toBe("1");
    expect(childrenOf(root, "item")).toHaveLength(2);
    expect(attrOf(firstChild(childrenOf(root, "item")[0], "name"), "value")).toBe("A & B");
    expect(firstChild(childrenOf(root, "item")[0], "d").text).toBe("<b>raw & text</b>");
    expect(firstChild(root, "t").text).toBe("one < two AB");
    expect(attrOf(childrenOf(root, "item")[1], "id")).toBe("2");
    expect(attrOf(root, "missing")).toBe("");
    expect(attrOf(null, "x")).toBe("");
    expect(childrenOf(null, "x")).toEqual([]);
  });

  test("decodes the five named entities and numeric references, and nothing else", () => {
    expect(decodeEntities("&amp;&lt;&gt;&quot;&apos;&#65;&#x41;&#x1F600;")).toBe("&<>\"'AA😀");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&custom; &nbsp; &foo")).toBe("&custom; &nbsp; &foo");
    expect(decodeEntities("&#0;&#1;&#xD800;&#x110000;")).toBe("");
    expect(decodeEntities(null)).toBe("");
    expect(decodeHtmlEntities("a&nbsp;b &mdash; &#10;&hellip; &unknown;")).toBe("a b — \n… &unknown;");
  });

  test("never expands custom or external entities (billion laughs, XXE)", () => {
    const bomb = `<?xml version="1.0"?>
      <!DOCTYPE lolz [
        <!ENTITY lol "lol">
        <!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
        <!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;">
        <!ENTITY lol9 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
      ]>
      <items><item id="1"><name value="&lol9;"/></item><t>&lol9;</t></items>`;
    const started = Date.now();
    const root = parseXml(bomb);
    expect(Date.now() - started).toBeLessThan(200);
    expect(attrOf(firstChild(firstChild(root, "item"), "name"), "value")).toBe("&lol9;");
    expect(firstChild(root, "t").text).toBe("&lol9;");
    const xxe = parseXml('<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>');
    expect(xxe.text).toBe("&xxe;");
    expect(JSON.stringify(xxe)).not.toContain("root:");
    expect(parseXml('<!DOCTYPE x [<!ENTITY a "x>y">]><a>1</a>').text).toBe("1");
  });

  test("garbage, unterminated and badly nested input gives null and never throws", () => {
    for (const bad of [
      "",
      "not xml at all",
      "<a><b>",
      "<a",
      '<a b="x',
      "<a b=",
      "<!-- never closed",
      "<a><![CDATA[ never closed",
      "<a><?pi never closed",
      "<!DOCTYPE a [ never closed",
      "<a></b>",
      "<a></a><b></b>",
      "<a/><a/>",
      "<>",
      "< a>",
      "<1a/>",
      "</a>",
      "<a>&#xZZ;<",
      null,
      undefined,
      5,
      {},
    ]) {
      expect(parseXml(bad)).toBeNull();
    }
    expect(parseXml("<a/>")).not.toBeNull();
    expect(parseXml("  <a>text</a>  ")).not.toBeNull();
  });

  test("huge and hostile inputs are rejected quickly", () => {
    const started = Date.now();
    expect(parseXml(`<a>${"x".repeat(5_000_000)}</a>`)).toBeNull();
    expect(parseXml("<a>".repeat(100_000))).toBeNull();
    expect(parseXml(`${"<a>".repeat(33)}${"</a>".repeat(33)}`)).toBeNull();
    expect(parseXml(`${"<a>".repeat(30)}${"</a>".repeat(30)}`)).not.toBeNull();
    expect(parseXml("<a ".repeat(500_000))).toBeNull();
    expect(parseXml("<".repeat(1_000_000))).toBeNull();
    expect(parseXml(`<a ${'x="1" '.repeat(100_000)}/>`)).not.toBeNull();
    expect(parseXml(`<r>${"<i/>".repeat(300_000)}</r>`, { maxNodes: 1000 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("attribute names cannot pollute prototypes and are capped", () => {
    const root = parseXml('<a __proto__="x" constructor="y" polluted="1"/>');
    expect(attrOf(root, "polluted")).toBe("1");
    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(root.attrs)).toBeNull();
    const capped = parseXml(`<a ${Array.from({ length: 200 }, (_, i) => `k${i}="v"`).join(" ")}/>`);
    expect(Object.keys(capped.attrs)).toHaveLength(64);
    expect(attrOf(parseXml(`<a v="${"y".repeat(50_000)}"/>`), "v")).toHaveLength(20_000);
  });

  test("the streaming scanner reports how it ended and can be stopped", () => {
    expect(scanXml("<a/>")).toBe("done");
    expect(scanXml("<a>")).toBe("done");
    expect(scanXml("<a", {})).toBe("bad");
    expect(scanXml(`<a>${"x".repeat(100)}</a>`, {}, { maxChars: 50 })).toBe("truncated");
    expect(scanXml("<a/><b/><c/>", { open: (tag) => tag !== "b" })).toBe("stopped");
    expect(scanXml("<a/>".repeat(100), {}, { maxTokens: 10 })).toBe("bad");
    const seen = [];
    scanXml("<a><b/>x</a>", { open: (tag) => seen.push(`<${tag}`), close: (tag) => seen.push(`/${tag}`), text: (value) => seen.push(value) });
    expect(seen).toEqual(["<a", "<b", "/b", "x", "/a"]);
  });
});

describe("search scanning", () => {
  test("keeps ids, names, alternate names and years, and skips expansions", () => {
    expect(SCAN.valid).toBe(true);
    expect(SCAN.items.map((item) => item.id)).toEqual(["900001", "900003", "900004", "900005", "900006"]);
    expect(SCAN.items[0]).toEqual({ id: "900001", name: "Starfall", alternates: ["Sternenfall", "Chute d'étoiles"], year: 2019 });
    expect(SCAN.items[1].alternates).toEqual(["Duel of Starfall"]);
  });

  test("is robust against odd items", () => {
    const odd = scanSearch(`<items>
      <item id="12x"><name type="primary" value="bad id"/></item>
      <item id="5"><name type="primary" value=""/></item>
      <item id="6"/>
      <item id="7"><name type="alternate" value="Only alternate"/></item>
      <item id="8" type="boardgameaccessory"><name type="primary" value="Accessory"/></item>
      <item id="9"><name value="No type"/><yearpublished value="soon"/></item>
    </items>`);
    expect(odd.items.map((item) => [item.id, item.name, item.year])).toEqual([
      ["7", "Only alternate", 0],
      ["9", "No type", 0],
    ]);
  });

  test("a reply that is not an items document is not valid", () => {
    for (const bad of ["", "hello", "<html><body>Just a moment</body></html>", "<items><item id=\"1\"", null, undefined]) {
      expect(scanSearch(bad).valid).toBe(false);
    }
    expect(scanSearch('<items total="0"></items>')).toEqual({ items: [], valid: true });
  });

  test("handles thousands of results without building a tree, and caps them", () => {
    const item = (i) => `<item type="boardgame" id="${i + 1}"><name type="primary" value="Game number ${i}"/><name type="alternate" value="Alt ${i}"/><yearpublished value="2000"/></item>`;
    const big = `<items total="10000">${Array.from({ length: 10_000 }, (_, i) => item(i)).join("")}</items>`;
    const started = Date.now();
    const scanned = scanSearch(big);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(scanned.valid).toBe(true);
    expect(scanned.items).toHaveLength(4000);
    expect(scanned.items[0].id).toBe("1");
    expect(scanSearch(big, { maxItems: 10 }).items).toHaveLength(10);
    // Larger than the size cap: the readable part is still used.
    const huge = `<items>${Array.from({ length: 30_000 }, (_, i) => item(i)).join("")}</items>`;
    expect(huge.length).toBeGreaterThan(1_500_000);
    const partial = scanSearch(huge, { maxItems: 100_000 });
    expect(partial.valid).toBe(true);
    expect(partial.items.length).toBeGreaterThan(1000);
    expect(partial.items.length).toBeLessThan(30_000);
    // Names that look like markup and floods of unterminated tags stay cheap.
    const floodStarted = Date.now();
    const flood = scanSearch(`<items>${"<item id=\"1\" ".repeat(50_000)}`);
    expect(flood.valid).toBe(false);
    expect(Date.now() - floodStarted).toBeLessThan(1000);
  });

  test("ranks candidates by title similarity, then BGG's order, at most eight", () => {
    expect(rankCandidates("starfall", SCAN.items)).toEqual(["900001", "900003", "900004"]);
    expect(rankCandidates("sternenfall", SCAN.items)).toEqual(["900001"]);
    expect(rankCandidates("duel of starfall", SCAN.items)).toEqual(["900003"]);
    expect(rankCandidates("starfall duel", SCAN.items)).toEqual(["900003", "900001"]);
    expect(rankCandidates("zzz nothing", SCAN.items)).toEqual([]);
    expect(rankCandidates("starfall", [])).toEqual([]);
    expect(rankCandidates("starfall", null)).toEqual([]);
    const twins = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), name: "Twin", alternates: [] }));
    expect(rankCandidates("twin", twins)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(rankCandidates("risk", [{ id: "1", name: "Risk Legacy", alternates: [] }, { id: "2", name: "Risk", alternates: [] }])).toEqual(["2", "1"]);
    expect(CANDIDATE_MIN_SIMILARITY).toBe(0.8);
  });
});

describe("shaping thing replies", () => {
  test("a full item keeps the fields the panel uses", () => {
    expect(THINGS.map((game) => game.id)).toEqual(["900001", "900003", "900004"]);
    expect(STARFALL).toMatchObject({
      id: "900001",
      itemType: "boardgame",
      name: "Starfall",
      alternates: ["Sternenfall", "Chute d'étoiles"],
      year: 2019,
      image: "https://cf.geekdo-images.com/placeholder-starfall/img/full-900001.jpg",
      thumbnail: "https://cf.geekdo-images.com/placeholder-starfall/img/thumb-900001.jpg",
      minPlayers: 1,
      maxPlayers: 4,
      playingTime: 120,
      minPlayTime: 60,
      maxPlayTime: 120,
      minAge: 12,
      bestWith: "2–3",
      recommendedWith: "1–4",
      designers: ["Ada Quill", "Bo Marlowe"],
      publishers: ["Lantern & Oak Games", "Harbor Lights Publishing"],
      categories: ["Economic", "Science Fiction", "Space Exploration"],
      mechanics: ["Cooperative Game", "Hand Management", "Route Planning", "Solo / Solitaire Game"],
      expansions: 3,
      rating: 8.52,
      ratingCount: 24310,
      rank: 12,
      weight: 3.91,
      weightCount: 4210,
    });
    expect(Object.keys(STARFALL)).toHaveLength(26);
  });

  test("the description is decoded, stripped of tags and collapsed", () => {
    expect(STARFALL.description).toStartWith("Starfall is a cooperative game for one to four players");
    expect(STARFALL.description).toContain("rival AI crew — handy");
    expect(STARFALL.description).toContain("stray tag and an & sign.");
    expect(STARFALL.description).not.toMatch(/[<>]|&#|&amp;|&mdash;/);
    expect(STARFALL.description).not.toContain("\n");
    expect(cleanDescription("a<br/>b<br />c</p>d")).toBe("a b c d");
    expect(cleanDescription("x &nbsp; y &#x41; &bogus; &amp;")).toBe("x y A &bogus; &");
    expect(cleanDescription("<script>alert(1)</script>hi <img src=x onerror=1>")).toBe("alert(1) hi");
    expect(cleanDescription("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(cleanDescription("w ".repeat(10_000)).length).toBeLessThanOrEqual(2000);
    expect(cleanDescription(null)).toBe("");
    const flood = Date.now();
    expect(cleanDescription("<a ".repeat(100_000)).length).toBeLessThanOrEqual(2000);
    expect(Date.now() - flood).toBeLessThan(200);
  });

  test("without BGG's own summary the player counts come from the poll votes", () => {
    expect(DUEL).toMatchObject({ bestWith: "2", recommendedWith: "2", minPlayers: 2, maxPlayers: 2, rank: 640, weight: 1.8, rating: 7.1, ratingCount: 3200 });
    expect(LEGACY).toMatchObject({ bestWith: "", recommendedWith: "" });
  });

  test("both spellings of the recommended summary are accepted, and only well formed text is kept", () => {
    const summary = (name, value) =>
      parseThings(`<items><item type="boardgame" id="5"><name type="primary" value="X"/><poll-summary name="suggested_numplayers"><result name="${name}" value="${value}"/></poll-summary></item></items>`)[0];
    expect(summary("recommmendedwith", "Recommended with 2–5 players").recommendedWith).toBe("2–5");
    expect(summary("recommendedwith", "Recommended with 3 players").recommendedWith).toBe("3");
    expect(summary("bestwith", "Best with 3–4 players").bestWith).toBe("3–4");
    expect(summary("bestwith", "Best with <b>3</b> players").bestWith).toBe("3");
    expect(summary("bestwith", "Best with 4+ players").bestWith).toBe("4+");
    expect(summary("bestwith", "nonsense").bestWith).toBe("");
    expect(summary("other", "Best with 3 players").bestWith).toBe("");
  });

  test("player lists become ranges", () => {
    expect(formatPlayerList(["1", "2", "3", "5"])).toBe("1–3, 5");
    expect(formatPlayerList(["2", "4+"])).toBe("2, 4+");
    expect(formatPlayerList(["3", "3", "2"])).toBe("2–3");
    expect(formatPlayerList(["x", "", "2a", "1000"])).toBe("");
    expect(formatPlayerList([])).toBe("");
  });

  test("Not Ranked and missing statistics become zero", () => {
    expect(LEGACY).toMatchObject({ rank: 0, weight: 0, weightCount: 0, minAge: 0, playingTime: 0, image: "", rating: 7.9, ratingCount: 85 });
    expect(LEGACY.thumbnail).toContain("thumb-900004");
    const bare = parseThings('<items><item type="boardgame" id="9"><name type="primary" value="Bare"/></item></items>')[0];
    expect(bare).toMatchObject({ rating: 0, ratingCount: 0, rank: 0, weight: 0, expansions: 0, description: "", image: "" });
    const ranked = (value) =>
      parseThings(`<items><item id="9"><name type="primary" value="R"/><statistics><ratings><ranks><rank type="subtype" name="boardgame" value="${value}"/><rank type="family" name="strategygames" value="3"/></ranks></ratings></statistics></item></items>`)[0].rank;
    expect(ranked("1234")).toBe(1234);
    expect(ranked("Not Ranked")).toBe(0);
    expect(ranked("-5")).toBe(0);
    expect(ranked("12abc")).toBe(0);
  });

  test("only expansions that this game owns are counted", () => {
    const game = parseThings(
      '<items><item id="9"><name type="primary" value="G"/><link type="boardgameexpansion" id="1" value="A"/><link type="boardgameexpansion" id="2" value="B" inbound="true"/></item></items>',
    )[0];
    expect(game.expansions).toBe(1);
  });

  test("missing and null fields never throw", () => {
    const empty = compactThing(null);
    expect(empty).toMatchObject({ id: "", name: "", rating: 0, rank: 0, designers: [], alternates: [] });
    expect(compactThing(undefined).id).toBe("");
    expect(compactThing({ tag: "item", attrs: {}, children: [], text: "" }).name).toBe("");
    expect(parseThings("garbage")).toBeNull();
    expect(parseThings(null)).toBeNull();
    expect(parseThings("<other/>")).toBeNull();
    expect(parseThings("<items/>")).toEqual([]);
    expect(parseThings('<items><item id="x"><name type="primary" value="No id"/></item><item id="3"/></items>')).toEqual([]);
    const odd = parseThings('<items><item id="4"><name type="primary" value="Odd"/><minplayers value="many"/><average value="x"/><link type="boardgamecategory"/><yearpublished/></item></items>')[0];
    expect(odd).toMatchObject({ minPlayers: 0, year: 0, categories: [] });
  });

  test("cover images must be https on geekdo-images.com", () => {
    const withImages = (image, thumbnail) =>
      parseThings(`<items><item id="4"><name type="primary" value="I"/><image>${image}</image><thumbnail>${thumbnail}</thumbnail></item></items>`)[0];
    const evil = withImages("https://evil.test/x.jpg", "http://cf.geekdo-images.com/t.jpg");
    expect([evil.image, evil.thumbnail]).toEqual(["", ""]);
    expect(withImages("https://cf.geekdo-images.com/a.jpg", "javascript:alert(1)")).toMatchObject({ image: "https://cf.geekdo-images.com/a.jpg", thumbnail: "" });
  });

  test("lists are capped", () => {
    const links = (type, count) => Array.from({ length: count }, (_, i) => `<link type="${type}" id="${i}" value="${type} ${i}"/>`).join("");
    const names = Array.from({ length: 12 }, (_, i) => `<name type="alternate" value="Alt ${i}"/>`).join("");
    const game = parseThings(
      `<items><item id="4"><name type="primary" value="Many"/>${names}${links("boardgamedesigner", 9)}${links("boardgamepublisher", 9)}${links("boardgamecategory", 9)}${links("boardgamemechanic", 9)}</item></items>`,
    )[0];
    expect([game.alternates.length, game.designers.length, game.publishers.length, game.categories.length, game.mechanics.length]).toEqual([8, 4, 3, 6, 6]);
  });
});

describe("query gating", () => {
  test("short title-like queries pass, questions and addresses do not", () => {
    for (const query of ["wingspan", "Starfall", "starfall board game", "the legend of the five rings"]) expect(looksLikeATitleSearch(query)).toBe(true);
    for (const query of ["", "a", "how to play wingspan", "what is a meeple", "https://boardgamegeek.com", "example.com", "2 + 2", "x ".repeat(40), "one two three four five six seven eight nine", "weather"]) {
      expect(looksLikeATitleSearch(query)).toBe(false);
    }
  });

  test("board game words are recognised as whole words", () => {
    for (const query of [
      "starfall board game",
      "starfall board games",
      "starfall boardgame",
      "starfall tabletop",
      "starfall bgg",
      "starfall boardgamegeek",
      "starfall meeple",
      "starfall rulebook",
      "starfall rules",
      "starfall setup",
      "starfall expansion",
      "starfall solo variant",
      "starfall worker placement",
      "starfall deck builder",
      "starfall deckbuilder",
      "starfall coop board",
      "starfall co-op board",
      "starfall card game",
      "starfall dice game",
      "starfall how to play",
      "starfall player count",
      "Starfall RULES",
    ]) {
      expect(hasBoardGameWord(query)).toBe(true);
    }
    for (const query of ["starfall", "rulesmith", "setups", "starfall gameplay", "bggx"]) expect(hasBoardGameWord(query)).toBe(false);
  });

  test("video game words are recognised, unless the query also says board game", () => {
    for (const query of ["skyrim walkthrough", "elden ring ps5", "starfall xbox", "doom steam", "starfall pc", "starfall switch", "starfall dlc", "starfall mods", "starfall speedrun", "starfall gameplay", "starfall controller"]) {
      expect(hasVideoGameWord(query)).toBe(true);
      expect(isVideoGameQuery(query)).toBe(true);
    }
    expect(isVideoGameQuery("starfall pc board game")).toBe(false);
    expect(isVideoGameQuery("starfall")).toBe(false);
    expect(isVideoGameQuery("catan board game")).toBe(false);
  });

  test("only trailing board game words are removed from the title", () => {
    expect(extractTerm("wingspan board game")).toBe("wingspan");
    expect(extractTerm("catan rules")).toBe("catan");
    expect(extractTerm("catan rules setup")).toBe("catan");
    expect(extractTerm("Catan Board Game Rules")).toBe("Catan");
    expect(extractTerm("dominion deck builder")).toBe("dominion");
    expect(extractTerm("pandemic how to play")).toBe("pandemic");
    expect(extractTerm("pandemic legacy expansion")).toBe("pandemic legacy");
    expect(extractTerm("rules of play")).toBe("rules of play");
    expect(extractTerm("board game geek night")).toBe("board game geek night");
    expect(extractTerm("wingspan")).toBe("wingspan");
  });

  test("the cache key ignores case, accents, punctuation and a leading 'the'", () => {
    expect(cacheKey("The Castles of Burgundy")).toBe(cacheKey("castles of burgundy"));
    expect(cacheKey("Pokémon")).toBe(cacheKey("pokemon"));
    expect(normalizeTitle("Catan: Cities & Knights")).toBe("catan cities and knights");
  });
});

describe("title matching", () => {
  test("similarity", () => {
    expect(titleSimilarity("wingspan", "Wingspan")).toBe(1);
    expect(titleSimilarity("gloomhaven", "Gloomhaven: Jaws of the Lion")).toBe(0.9);
    expect(titleSimilarity("gloomhaven jaws of the lion", "Gloomhaven: Jaws of the Lion")).toBe(1);
    expect(titleSimilarity("gloomhaven jaws of the lion", "Gloomhaven")).toBe(0.9);
    expect(titleSimilarity("azul 2", "Azul")).toBe(0.5);
    expect(titleSimilarity("catan ii", "Catan")).toBe(0.5);
    expect(titleSimilarity("azul game", "Azul")).toBe(0.9);
    expect(titleSimilarity("cats", "Dogs")).toBe(0);
    expect(titleSimilarity("burgundy castles of", "The Castles of Burgundy")).toBe(0.8);
  });

  test("a short query may match a subtitle", () => {
    expect(subtitles("Gloomhaven: Jaws of the Lion")).toEqual(["jaws of the lion"]);
    expect(subtitles("Pandemic - Legacy: Season 1")).toEqual(["legacy", "season 1"]);
    expect(subtitles("Wingspan")).toEqual([]);
    expect(titleSimilarity("jaws of the lion", "Gloomhaven: Jaws of the Lion")).toBe(SUBTITLE_EXACT);
    expect(SUBTITLE_EXACT).toBe(0.88);
  });

  test("confidence needs enough ratings, and a board game word lowers the bar", () => {
    expect(EXACT_MIN_RATINGS).toBe(200);
    expect(PREFIX_MIN_RATINGS).toBe(1500);
    expect(SUBTITLE_MIN_RATINGS).toBe(3000);
    const exact = (n) => rated(1, "Risk", n);
    expect(isConfidentMatch("risk", exact(200), false)).toBe(true);
    expect(isConfidentMatch("risk", exact(199), false)).toBe(false);
    expect(isConfidentMatch("risk", exact(49), true)).toBe(false);
    expect(isConfidentMatch("risk", exact(INTENT_MIN_RATINGS), true)).toBe(true);
    const prefix = (n) => rated(1, "Risk: Legacy", n);
    expect(isConfidentMatch("risk", prefix(1500), false)).toBe(true);
    expect(isConfidentMatch("risk", prefix(1499), false)).toBe(false);
    expect(isConfidentMatch("risk", prefix(50), true)).toBe(true);
    expect(isConfidentMatch("risk", prefix(49), true)).toBe(false);
    const subtitle = (n) => rated(1, "Gloomhaven: Jaws of the Lion", n);
    expect(isConfidentMatch("jaws of the lion", subtitle(3000), false)).toBe(true);
    expect(isConfidentMatch("jaws of the lion", subtitle(2999), false)).toBe(false);
    expect(isConfidentMatch("jaws of the lion", subtitle(INTENT_LOOSE_MIN_RATINGS), true)).toBe(true);
    expect(isConfidentMatch("jaws of the lion", subtitle(INTENT_LOOSE_MIN_RATINGS - 1), true)).toBe(false);
    expect(isConfidentMatch("risk", null, true)).toBe(false);
    expect(popularity({ ratingCount: 12 })).toBe(12);
    expect(popularity({ ratingCount: "x" })).toBe(0);
    expect(popularity(null)).toBe(0);
  });

  test("picks the right Starfall from the fixture", () => {
    expect(pickGame("starfall", THINGS, false).id).toBe("900001");
    expect(pickGame("starfall duel", THINGS, false).id).toBe("900003");
    expect(pickGame("sternenfall", THINGS, false).id).toBe("900001");
    expect(pickGame("chute d'étoiles", THINGS, false).id).toBe("900001");
    expect(pickGame("duel of starfall", THINGS, false).id).toBe("900003");
    expect(pickGame("zzz", THINGS, false)).toBeNull();
  });

  test("a game with few ratings needs a board game word", () => {
    const obscure = [rated(1, "Obscure Game", 150)];
    expect(pickGame("obscure game", obscure, false)).toBeNull();
    expect(pickGame("obscure game", obscure, true).id).toBe("1");
    expect(pickGame("obscure game", [rated(1, "Obscure Game", 49)], true)).toBeNull();
    // Without a board game word the popular base game stands in for an unpopular exact title; with one, the exact title wins.
    expect(pickGame("starfall legacy", THINGS, false).id).toBe("900001");
    expect(pickGame("starfall legacy", THINGS, true).id).toBe("900004");
  });

  test("expansions and other item types are never the answer", () => {
    expect(isAcceptedType("boardgame")).toBe(true);
    expect(isAcceptedType("")).toBe(true);
    expect(isAcceptedType(undefined)).toBe(true);
    for (const type of ["boardgameexpansion", "boardgameaccessory", "rpgitem", "videogame"]) expect(isAcceptedType(type)).toBe(false);
    const root = [rated(1, "Root", 40_000), rated(2, "Root: The Marauder Expansion", 9000, { itemType: "boardgameexpansion" })];
    expect(pickGame("root", root, false).id).toBe("1");
    expect(pickGame("root the marauder expansion", root, false).id).toBe("1");
    expect(pickGame("root the marauder expansion", [root[1]], false)).toBeNull();
    expect(pickGame("root marauder", [root[1]], true)).toBeNull();
  });

  test("a trailing number or numeral names another game", () => {
    const azul = [rated(1, "Azul", 40_000)];
    expect(pickGame("azul", azul, false).id).toBe("1");
    expect(pickGame("azul 2", azul, false)).toBeNull();
    expect(pickGame("azul ii", azul, false)).toBeNull();
    expect(pickGame("azul 2", azul, true)).toBeNull();
    expect(pickGame("azul 2", [...azul, rated(2, "Azul 2", 900)], false).id).toBe("2");
  });

  test("generic single words need the higher thresholds", () => {
    expect(pickGame("risk", [rated(1, "Risk", 150)], false)).toBeNull();
    expect(pickGame("risk", [rated(1, "Risk", 250)], false).id).toBe("1");
    expect(pickGame("risk", [rated(1, "Risk", 60)], true).id).toBe("1");
    expect(pickGame("risk", [rated(1, "Risk Legacy", 1000)], false)).toBeNull();
    expect(pickGame("risk", [rated(1, "Risk Legacy", 2000)], false).id).toBe("1");
  });

  test("series and subtitles: gloomhaven versus its spin-off", () => {
    const things = [rated(1, "Gloomhaven", 50_000), rated(2, "Gloomhaven: Jaws of the Lion", 30_000)];
    expect(pickGame("gloomhaven", things, false).id).toBe("1");
    expect(pickGame("gloomhaven jaws of the lion", things, false).id).toBe("2");
    expect(pickGame("jaws of the lion", things, false).id).toBe("2");
  });

  test("a subtitle shared by several series is ambiguous unless the query says board game", () => {
    const legacy = [rated(1, "Pandemic: Legacy", 9000), rated(2, "Risk: Legacy", 7000)];
    expect(pickGame("legacy", legacy, false)).toBeNull();
    expect(pickGame("legacy", legacy, true).id).toBe("1");
    expect(pickGame("pandemic legacy", legacy, false).id).toBe("1");
    const same = [rated(1, "Pandemic: Legacy", 9000), rated(2, "Pandemic - Legacy", 7000)];
    expect(pickGame("legacy", same, false).id).toBe("1");
  });

  test("the closest title wins, then the most rated, and odd input is tolerated", () => {
    const twins = [rated(1, "Hanabi", 300), rated(2, "Hanabi", 9000)];
    expect(pickGame("hanabi", twins, false).id).toBe("2");
    expect(pickGame("hanabi", [], false)).toBeNull();
    expect(pickGame("hanabi", null, false)).toBeNull();
    expect(pickGame("hanabi", [null, {}, { id: "1" }, { name: "Hanabi" }], false)).toBeNull();
  });
});

describe("rendering", () => {
  const signProxy = (url) => `/proxy?u=${encodeURIComponent(url)}`;
  const full = () => buildPanel({ game: STARFALL, signProxy });

  test("shows the labelled badges, the facts, the link and a signed cover", () => {
    const html = full();
    expect(html).toContain("BGG rating");
    expect(html).toContain(">8.5<");
    expect(html).toContain("24,310 ratings");
    expect(html).toContain("BGG rank");
    expect(html).toContain("#12");
    expect(html).toContain("Weight / 5");
    expect(html).toContain(">3.9<");
    expect(html).toContain('title="BGG community complexity rating"');
    expect(html).toContain("board-games-score--good");
    expect(html).toContain("Board game · 2019");
    expect(html).toContain('href="https://boardgamegeek.com/boardgame/900001"');
    expect(html).toContain(">BGG page<");
    expect(html).toContain(
      '<span class="board-games-nowrap">1–4</span> · <span class="board-games-nowrap">Best with 2–3</span> · <span class="board-games-nowrap">Recommended 1–4</span>',
    );
    expect(html).toContain("60–120 min");
    expect(html).toContain("12+");
    expect(html).toContain("Ada Quill, Bo Marlowe");
    expect(html).toContain("Lantern &amp; Oak Games, Harbor Lights Publishing");
    expect(html).toContain('<span class="board-games-chip">Economic</span>');
    expect(html).toContain('<span class="board-games-chip">Cooperative Game</span>');
    expect(html).toContain("3 expansions on BGG");
    expect(html).toContain(`/proxy?u=${encodeURIComponent("https://cf.geekdo-images.com/placeholder-starfall/img/full-900001.jpg")}`);
    expect(html).toContain('<a class="board-games-credit" href="https://boardgamegeek.com" target="_blank" rel="noopener">Powered by BGG</a>');
    expect(html).not.toContain("<details");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("null");
  });

  test("the description is a cleanly cut preview", () => {
    const html = full();
    expect(html).toContain('<p class="board-games-desc">Starfall is a cooperative game');
    expect(html).not.toContain("invented for tests");
    expect(buildPanel({ game: STARFALL, showDescription: false })).not.toContain("board-games-desc");
    expect(buildPanel({ game: STARFALL, showDescription: false })).not.toContain("cooperative game for one");
  });

  test("rating colours follow the bands", () => {
    const band = (rating) => buildPanel({ game: { ...STARFALL, rating } });
    expect(band(7.5)).toContain("board-games-score--good");
    expect(band(7.49)).toContain("board-games-score--mixed");
    expect(band(6)).toContain("board-games-score--mixed");
    expect(band(5.99)).toContain("board-games-score--bad");
  });

  test("Not Ranked has no rank badge, and missing data leaves out its parts", () => {
    const legacy = buildPanel({ game: LEGACY, signProxy });
    expect(legacy).not.toContain("BGG rank");
    expect(legacy).not.toContain("#0");
    expect(legacy).not.toContain("Weight / 5");
    expect(legacy).toContain("BGG rating");
    expect(legacy).toContain("85 ratings");
    expect(legacy).toContain("thumb-900004");
    expect(legacy).not.toContain("Playing time");
    expect(legacy).not.toContain("Age<");
    expect(legacy).not.toContain("expansion");
    expect(legacy).not.toContain("Designers");
    const nothing = buildPanel({ game: { ...LEGACY, rating: 0, ratingCount: 0 } });
    expect(nothing).not.toContain("board-games-scores");
    expect(buildPanel({ game: { ...STARFALL, ratingCount: 0 } })).not.toContain("ratings<");
    expect(buildPanel({ game: { ...STARFALL, expansions: 1 } })).toContain("1 expansion on BGG");
  });

  test("works with minimal data and always credits BGG", () => {
    const html = buildPanel({ game: compactThing(null) });
    expect(html).toContain("Powered by BGG");
    expect(html).toContain('href="https://boardgamegeek.com"');
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("BGG page");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("undefined");
    expect(html).toContain("Board game</div>");
    // No signing function: the cover is left out rather than linking the image host directly.
    expect(buildPanel({ game: STARFALL })).not.toContain("<img");
  });

  test("escapes every text field and drops unsafe links and images", () => {
    const evil = {
      ...STARFALL,
      id: '1"><script>alert(1)</script>',
      name: '<script>alert("n")</script>',
      description: "<b>bold</b> & <i>x</i>",
      image: "javascript:alert(1)",
      thumbnail: 'https://cf.geekdo-images.com/x.jpg"onerror="alert(1)',
      designers: ["<u>d</u>"],
      publishers: ['"><svg onload=alert(1)>'],
      categories: ["<b>c</b>"],
      mechanics: ["<i>m</i>"],
      bestWith: "<s>3</s>",
      recommendedWith: "<s>4</s>",
    };
    const html = buildPanel({ game: evil, signProxy });
    for (const forbidden of ["<script", "<b>", "<i>", "<u>", "<s>", "<svg", "javascript:", "boardgame/1\"", 'onerror="alert']) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;");
    expect(html).not.toContain("BGG page");
    expect(html).not.toContain("board-games-title-link");
    expect(esc('<a href="x">\'&')).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(esc(null)).toBe("");
  });

  test("players and playing time read naturally", () => {
    const players = (minPlayers, maxPlayers, extra = {}) => playersText({ minPlayers, maxPlayers, bestWith: "", recommendedWith: "", ...extra });
    expect(players(1, 4)).toBe("1–4");
    expect(players(2, 2)).toBe("2");
    expect(players(0, 4)).toBe("4");
    expect(players(0, 0)).toBe("");
    expect(players(2, 5, { bestWith: "4" })).toBe("2–5 · Best with 4");
    expect(players(2, 5, { recommendedWith: "3–5" })).toBe("2–5 · Recommended 3–5");
    expect(players(0, 0, { bestWith: "3" })).toBe("Best with 3");
    const time = (minPlayTime, maxPlayTime, playingTime = 0) => playTimeText({ minPlayTime, maxPlayTime, playingTime });
    expect(time(60, 120)).toBe("60–120 min");
    expect(time(30, 30)).toBe("30 min");
    expect(time(0, 0, 90)).toBe("90 min");
    expect(time(0, 45)).toBe("45 min");
    expect(time(0, 0, 0)).toBe("");
  });

  test("summaries cut at a sentence after 40 %, else at a word with an ellipsis", () => {
    expect(summarize("  Short   text\n here. ", 300)).toBe("Short text here.");
    expect(summarize(null)).toBe("");
    expect(summarize("x".repeat(300), 300)).toBe("x".repeat(300));
    expect(summarize(`${"A".repeat(150)}. ${"B".repeat(300)}`, 300)).toBe(`${"A".repeat(150)}.`);
    const cut = summarize(`${"A".repeat(50)}. ${"word ".repeat(100)}`, 300);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(301);
    expect(summarize("x".repeat(400), 300)).toBe(`${"x".repeat(300)}…`);
  });
});

describe("the daily request budget", () => {
  const midnight = Date.UTC(2026, 0, 1, 0, 0, 0);

  test("the file lives under the data dir and can be overridden by the environment", async () => {
    await withEnv({ DEGOOG_BGG_USAGE_FILE: undefined }, () => expect(usageFile("data")).toBe(join("data", "bgg", "usage.json")));
    await withEnv({ DEGOOG_BGG_USAGE_FILE: "/tmp/elsewhere.json" }, () => expect(usageFile("data")).toBe("/tmp/elsewhere.json"));
  });

  test("stops at the cap, 0 means no cap", () => {
    const budget = new Budget({ cap: 2 });
    expect([budget.spend(), budget.spend(), budget.spend()]).toEqual([true, true, false]);
    expect(budget.exhausted).toBe(true);
    const unlimited = new Budget({ cap: 0 });
    for (let i = 0; i < 1000; i += 1) expect(unlimited.spend()).toBe(true);
    expect(unlimited.exhausted).toBe(false);
  });

  test("the count survives a restart, resets at UTC midnight, and is written atomically", () => {
    const file = join(tempFolder(), "bgg", "usage.json");
    let now = midnight + 23 * 3_600_000 + 59 * 60_000 + 59_000;
    const first = new Budget({ file, cap: 3, now: () => now });
    first.spend();
    first.spend();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-01-01", used: 2 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const second = new Budget({ file, cap: 3, now: () => now });
    expect(second.used).toBe(0);
    expect(second.exhausted).toBe(false);
    expect(second.used).toBe(2);
    expect(second.msUntilReset).toBe(1000);
    second.spend();
    expect(second.exhausted).toBe(true);
    now += 2000;
    expect(second.exhausted).toBe(false);
    expect(second.used).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-01-02", used: 0 });
    expect(new Budget({ file, cap: 3, now: () => now }).exhausted).toBe(false);
  });

  test("an unreadable count file starts from zero", () => {
    const folder = tempFolder();
    const file = join(folder, "usage.json");
    writeFileSync(file, "not json");
    expect(new Budget({ file, cap: 3, now: () => midnight }).exhausted).toBe(false);
  });
});

describe("the slot", () => {
  test("is a valid knowledge panel slot", () => {
    expect(defaultSlot.position).toBe("knowledge-panel");
    expect(defaultSlot.slotPositions).toEqual(["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"]);
    expect(typeof defaultSlot.trigger).toBe("function");
    expect(typeof defaultSlot.execute).toBe("function");
    expect(defaultSlot.isClientExposed).toBe(false);
    expect(defaultSlot.id).toBe("board-games");
  });

  test("the token is optional in the schema so the environment fallback works, and it is a secret", () => {
    const schema = defaultSlot.settingsSchema;
    const field = (key) => schema.find((entry) => entry.key === key);
    expect(field("apiToken").type).toBe("password");
    expect(field("apiToken").secret).toBe(true);
    expect(schema.some((entry) => entry.required)).toBe(false);
    expect(field("requireBoardGameWord").type).toBe("toggle");
    expect(field("requireBoardGameWord").default).toBe("false");
    expect(field("showDescription").default).toBe("true");
    expect(field("dailyRequestLimit").type).toBe("number");
    expect(field("dailyRequestLimit").default).toBe("300");
    expect(field("apiToken").description).toContain("boardgamegeek.com/applications");
  });

  test("the plugin folder is self-contained", () => {
    const folder = new URL("../plugins/board-games/", import.meta.url);
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".js"))) {
      expect(readFileSync(new URL(name, folder), "utf8")).not.toMatch(/from\s+["']\.\.\//);
    }
    expect(readFileSync(new URL("template.html", folder), "utf8").trim()).toBe('<div class="command-result board-games-result">{{content}}</div>');
  });

  test("the API base and the request window come from the environment", async () => {
    await withEnv({ DEGOOG_BGG_API_BASE: "http://mock:4469/xmlapi2", DEGOOG_SLOT_TIMEOUT_MS: undefined }, () => {
      const slot = new BoardGamesSlot();
      expect(slot.apiBase).toBe("http://mock:4469/xmlapi2");
      expect(slot.startWindowMs).toBe(7000);
    });
    await withEnv({ DEGOOG_BGG_API_BASE: undefined, DEGOOG_SLOT_TIMEOUT_MS: "5000" }, () => {
      const slot = new BoardGamesSlot();
      expect(slot.apiBase).toBe(DEFAULT_API_BASE);
      expect(slot.startWindowMs).toBe(2000);
    });
    await withEnv({ DEGOOG_SLOT_TIMEOUT_MS: "1200" }, () => expect(new BoardGamesSlot().startWindowMs).toBe(1000));
  });

  test("without a token nothing triggers and nothing is requested", async () => {
    await withEnv({ BGG_API_TOKEN: undefined }, async () => {
      for (const settings of [{}, { apiToken: "   " }, { apiToken: "has spaces" }]) {
        const slot = make(settings);
        const context = makeContext();
        expect(slot.trigger("starfall")).toBe(false);
        expect(await slot.execute("starfall", context)).toEqual(EMPTY);
        expect(context.calls).toHaveLength(0);
      }
    });
  });

  test("the environment token is used when the setting is empty, and the setting wins", async () => {
    await withEnv({ BGG_API_TOKEN: "env-token-123" }, async () => {
      expect(make({}).apiToken).toBe("env-token-123");
      expect(make({ apiToken: "  " }).apiToken).toBe("env-token-123");
      expect(make({ apiToken: "ui-token-456" }).apiToken).toBe("ui-token-456");
      expect(make({ apiToken: "Bearer ui-token-456" }).apiToken).toBe("ui-token-456");
      const context = makeContext({ token: "ui-token-456" });
      await make({ apiToken: "ui-token-456" }).execute("starfall", context);
      expect(context.calls[0].init.headers.Authorization).toBe("Bearer ui-token-456");
    });
  });

  test("settings accept strings and booleans, and the daily limit falls back to 300", () => {
    const slot = make({ apiToken: TOKEN, requireBoardGameWord: true, showDescription: "false", dailyRequestLimit: "25" });
    expect([slot.requireBoardGameWord, slot.showDescription, slot.budget.cap]).toEqual([true, false, 25]);
    const defaults = make({ apiToken: TOKEN });
    expect([defaults.requireBoardGameWord, defaults.showDescription, defaults.budget.cap]).toEqual([false, true, 300]);
    expect(make({ apiToken: TOKEN, dailyRequestLimit: "0" }).budget.cap).toBe(0);
    for (const bad of ["abc", "-4", ""]) expect(make({ apiToken: TOKEN, dailyRequestLimit: bad }).budget.cap).toBe(300);
  });

  test("the first query costs one search and one thing request, and renders the panel", async () => {
    const slot = make();
    slot.init({ template: '<div class="x">{{content}}</div>' });
    const context = makeContext();
    const out = await slot.execute("starfall", context);
    expect(kinds(context)).toEqual(["search", "thing"]);
    expect(out.title).toBe("Starfall");
    expect(out.html).toStartWith('<div class="x"><div class="board-games-card">');
    for (const part of ["BGG rating", "BGG rank", "#12", "Weight / 5", "Powered by BGG", "boardgamegeek.com/boardgame/900001"]) expect(out.html).toContain(part);
    const [search, thing] = context.calls;
    expect(search.url).toBe("https://bgg.test/xmlapi2/search?query=starfall&type=boardgame");
    expect(thing.url).toBe("https://bgg.test/xmlapi2/thing?id=900001,900003,900004&stats=1");
    for (const call of context.calls) {
      expect(call.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.init.headers.Accept).toBe("application/xml");
      expect(call.init.headers["User-Agent"]).toContain("degoog-board-games/1.0");
      expect(call.url).not.toContain(TOKEN);
    }
    expect(slot.budget.used).toBe(2);
  });

  test("the same game is then served from cache with no requests", async () => {
    const slot = make();
    const context = makeContext();
    const first = await slot.execute("starfall", context);
    context.calls.length = 0;
    for (const query of ["Starfall", "starfall board game", "The Starfall rules", "starfall  "]) {
      expect((await slot.execute(query, context)).html).toBe(first.html);
    }
    expect(context.calls).toHaveLength(0);
  });

  test("a neighbouring query reuses the cached details and costs only a search", async () => {
    const slot = make();
    const context = makeContext();
    await slot.execute("starfall", context);
    context.calls.length = 0;
    const out = await slot.execute("starfall duel", context);
    expect(out.title).toBe("Starfall Duel");
    expect(kinds(context)).toEqual(["search"]);
  });

  test("a query with no close title costs one search and no thing request, and is remembered", async () => {
    const slot = make();
    const context = makeContext();
    expect(await slot.execute("completely different", context)).toEqual(EMPTY);
    expect(kinds(context)).toEqual(["search"]);
    await slot.execute("completely different", context);
    expect(context.calls).toHaveLength(1);
    const none = make();
    const noneContext = makeContext({ search: EMPTY_SEARCH });
    expect(await none.execute("zzz nothing", noneContext)).toEqual(EMPTY);
    expect(kinds(noneContext)).toEqual(["search"]);
  });

  test("a candidate that BGG does not return details for shows no panel", async () => {
    const slot = make();
    const context = makeContext();
    expect(await slot.execute("starfield", context)).toEqual(EMPTY);
    expect(kinds(context)).toEqual(["search", "thing"]);
    expect(slot.paused).toBe(false);
  });

  test("an unconfident match shows nothing unless the query names board games", async () => {
    const slot = make();
    const context = makeContext();
    expect((await slot.execute("starfall legacy", context)).title).toBe("Starfall");
    expect((await slot.execute("starfall legacy board game", context)).title).toBe("Starfall Legacy");

  });

  test("queries that are not board game titles cause no requests at all", async () => {
    const slot = make();
    const context = makeContext();
    for (const query of ["weather", "how to beat skyrim", "skyrim walkthrough", "starfall ps5", "starfall pc", "starfall dlc", "what is a meeple", "example.com", "x"]) {
      expect(slot.trigger(query)).toBe(false);
      expect(await slot.execute(query, context)).toEqual(EMPTY);
    }
    expect(context.calls).toHaveLength(0);
    expect(slot.trigger("starfall pc board game")).toBe(true);
  });

  test("requireBoardGameWord blocks plain queries and allows board game ones", async () => {
    const slot = make({ apiToken: TOKEN, requireBoardGameWord: "true" });
    expect(slot.trigger("starfall")).toBe(false);
    expect(slot.trigger("starfall board game")).toBe(true);
    expect(slot.trigger("starfall rules")).toBe(true);
    const context = makeContext();
    expect(await slot.execute("starfall", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
  });

  test("showDescription off hides the description", async () => {
    const out = await make({ apiToken: TOKEN, showDescription: "false" }).execute("starfall", makeContext());
    expect(out.html).not.toContain("cooperative game for one");
    expect(out.html).toContain("Starfall");
  });

  test("401 and 403 pause for 30 minutes with one short warning", async () => {
    for (const status of [401, 403]) {
      const slot = make();
      const context = makeContext({ respond: () => new Response(`no ${TOKEN}`, { status }) });
      const lines = await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
      expect(kinds(context)).toEqual(["search"]);
      expect(slot.paused).toBe(true);
      expect(slot._pausedUntil - slot.now()).toBeGreaterThan(29 * 60_000);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("BGG rejected the API token or blocked the request");
      for (const secretish of [TOKEN, "http", "bgg.test", "Bearer"]) expect(lines[0]).not.toContain(secretish);
      expect(slot.trigger("starfall")).toBe(false);
      context.calls.length = 0;
      expect(await slot.execute("catan", context)).toEqual(EMPTY);
      expect(context.calls).toHaveLength(0);
    }
  });

  test("a Cloudflare style HTML page is treated as blocked", async () => {
    const slot = make();
    const context = makeContext({ respond: () => new Response("<!DOCTYPE html><html><title>Just a moment...</title></html>", { status: 200, headers: { "content-type": "text/html" } }) });
    const lines = await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
    expect(slot._pausedUntil - slot.now()).toBeGreaterThan(29 * 60_000);
    expect(lines).toHaveLength(1);
    expect(lines.join("")).not.toContain("http");
    const challenge = make();
    await capture(() => challenge.execute("starfall", makeContext({ respond: () => new Response("<html>x</html>", { status: 403 }) })));
    expect(challenge.paused).toBe(true);
  });

  test("429 pauses for the retry-after time, ten minutes by default, an hour at most", async () => {
    const slot = make();
    let now = 1_000_000;
    slot.now = () => now;
    const context = makeContext({ respond: () => new Response("slow", { status: 429, headers: { "retry-after": "30" } }) });
    await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
    expect(kinds(context)).toEqual(["search"]);
    expect(slot.paused).toBe(true);
    now += 29_000;
    expect(slot.paused).toBe(true);
    now += 2_000;
    expect(slot.paused).toBe(false);
    const fallback = make();
    await capture(() => fallback.execute("starfall", makeContext({ respond: () => new Response("slow", { status: 429 }) })));
    expect(fallback._pausedUntil - fallback.now()).toBeGreaterThan(9 * 60_000);
    expect(fallback._pausedUntil - fallback.now()).toBeLessThanOrEqual(10 * 60_000);
    const long = make();
    await capture(() => long.execute("starfall", makeContext({ respond: () => new Response("slow", { status: 429, headers: { "retry-after": "999999" } }) })));
    expect(long._pausedUntil - long.now()).toBeLessThanOrEqual(3_600_000);
  });

  test("server errors, 202 and network failures pause for a minute and never throw or leak the token", async () => {
    for (const respond of [
      () => new Response("oops", { status: 502 }),
      () => new Response("queued", { status: 202 }),
      () => {
        throw new Error(`down https://bgg.test/xmlapi2/search Bearer ${TOKEN}`);
      },
    ]) {
      const slot = make();
      const context = makeContext({ respond });
      const lines = await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
      expect(slot.paused).toBe(true);
      expect(slot._pausedUntil - slot.now()).toBeLessThanOrEqual(60_000);
      expect(lines).toHaveLength(1);
      expect(lines.join("")).not.toContain(TOKEN);
      expect(lines.join("")).not.toContain("http");
    }
  });

  test("a failed details request keeps the search, and the next query only repeats the details", async () => {
    const slot = make();
    let now = 5_000_000;
    slot.now = () => now;
    let failing = true;
    const context = makeContext({ respond: (kind) => (kind === "thing" && failing ? new Response("oops", { status: 503 }) : undefined) });
    await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
    expect(kinds(context)).toEqual(["search", "thing"]);
    now += 61_000;
    failing = false;
    context.calls.length = 0;
    expect((await slot.execute("starfall", context)).title).toBe("Starfall");
    expect(kinds(context)).toEqual(["thing"]);
  });

  test("a reply that is not XML is not cached and does not pause", async () => {
    const slot = make();
    const context = makeContext({ search: "hello there" });
    expect(await slot.execute("starfall", context)).toEqual(EMPTY);
    expect(slot.paused).toBe(false);
    await slot.execute("starfall", context);
    expect(kinds(context)).toEqual(["search", "search"]);
    const broken = make();
    const brokenContext = makeContext({ search: '<items total="1"><item id="1"' });
    await broken.execute("starfall", brokenContext);
    await broken.execute("starfall", brokenContext);
    expect(kinds(brokenContext)).toEqual(["search", "search"]);
    const html = make();
    const htmlContext = makeContext({ respond: (kind) => (kind === "thing" ? xmlResponse("<items><oops></items>") : undefined) });
    expect(await html.execute("starfall", htmlContext)).toEqual(EMPTY);
    expect(html.paused).toBe(false);
  });

  test("the daily limit stops requests, is kept on disk, and starts again at UTC midnight", async () => {
    const file = join(tempFolder(), "bgg", "usage.json");
    const midnight = Date.UTC(2026, 0, 1, 23, 59, 0);
    const build = () => {
      const slot = make({ apiToken: TOKEN, dailyRequestLimit: "2" });
      slot.now = () => now;
      slot.budget = new Budget({ file, cap: 2, now: () => now });
      return slot;
    };
    let now = midnight;
    const first = build();
    const context = makeContext();
    expect((await first.execute("starfall", context)).title).toBe("Starfall");
    expect(context.calls).toHaveLength(2);
    expect(first.trigger("catan")).toBe(false);
    context.calls.length = 0;
    expect(await first.execute("catan", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
    // While the limit is used up the plugin stays quiet, even for games it has cached.
    expect(await first.execute("starfall", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
    // A restart still knows the count.
    const restarted = build();
    expect(restarted.trigger("catan")).toBe(false);
    now = Date.UTC(2026, 0, 2, 0, 0, 30);
    expect(restarted.trigger("catan")).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-01-02", used: 0 });
  });

  test("running out of requests mid-way pauses for at most an hour with one warning", async () => {
    const slot = make({ apiToken: TOKEN, dailyRequestLimit: "1" });
    slot.budget = new Budget({ file: "", cap: 1, now: () => slot.now() });
    const context = makeContext();
    const lines = await capture(async () => expect(await slot.execute("starfall", context)).toEqual(EMPTY));
    expect(kinds(context)).toEqual(["search"]);
    expect(slot.paused).toBe(true);
    expect(slot._pausedUntil - slot.now()).toBeLessThanOrEqual(3_600_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("daily BGG request limit");
    expect(slot.trigger("starfall")).toBe(false);
  });

  test("a daily limit of 0 means no limit", async () => {
    const slot = make({ apiToken: TOKEN, dailyRequestLimit: "0" });
    const context = makeContext();
    for (const query of ["starfall", "starfall duel", "starfall legacy board game"]) await slot.execute(query, context);
    expect(slot.budget.exhausted).toBe(false);
    expect(slot.budget.used).toBeGreaterThan(0);
  });

  test("requests keep at least a second apart, and are skipped when the wait does not fit in the slot time", async () => {
    const slot = make();
    slot.spacingMs = 1000;
    let now = 10_000_000;
    const sleeps = [];
    slot.now = () => now;
    slot.sleep = async (ms) => {
      sleeps.push(ms);
      now += ms;
    };
    const context = makeContext();
    expect((await slot.execute("starfall", context)).title).toBe("Starfall");
    expect(sleeps).toEqual([1000]);

    const tight = make();
    tight.spacingMs = 1000;
    tight.startWindowMs = 500;
    let clock = 20_000_000;
    tight.now = () => clock;
    tight.sleep = async (ms) => {
      clock += ms;
    };
    const tightContext = makeContext();
    expect(await tight.execute("starfall", tightContext)).toEqual(EMPTY);
    expect(kinds(tightContext)).toEqual(["search"]);
    expect(tight.paused).toBe(false);
    expect(tight.budget.used).toBe(1);
    clock += 5000;
    expect((await tight.execute("starfall", tightContext)).title).toBe("Starfall");
    expect(kinds(tightContext)).toEqual(["search", "thing"]);
  });

  test("simultaneous requests are serialised with a pause between them", async () => {
    const slot = make();
    slot.spacingMs = 60;
    slot.startWindowMs = 10_000;
    const context = makeContext();
    await Promise.all([slot.execute("starfall", context), slot.execute("starfall duel", context), slot.execute("starfall legacy board game", context)]);
    expect(context.calls.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < context.calls.length; i += 1) expect(context.calls[i].at - context.calls[i - 1].at).toBeGreaterThanOrEqual(55);
  });

  test("simultaneous identical queries share their requests", async () => {
    const slot = make();
    const context = makeContext();
    const outs = await Promise.all([slot.execute("starfall", context), slot.execute("starfall", context), slot.execute("Starfall board game", context)]);
    expect(outs.every((out) => out.title === "Starfall")).toBe(true);
    expect(kinds(context)).toEqual(["search", "thing"]);
  });

  test("uses degoog's cache with the documented namespaces and lifetimes", async () => {
    const slot = make();
    const stores = {};
    const lifetimes = {};
    const base = makeContext();
    const context = {
      ...base,
      useCache: (name, ttl) => {
        stores[name] ??= new Map();
        lifetimes[name] = ttl;
        return {
          get: async (key) => stores[name].get(key) ?? null,
          set: async (key, value) => void stores[name].set(key, value),
        };
      },
    };
    await slot.execute("starfall", context);
    expect(Object.keys(stores).sort()).toEqual(["ext:board-games:search", "ext:board-games:thing"]);
    expect(lifetimes).toEqual({ "ext:board-games:search": 24 * 3_600_000, "ext:board-games:thing": 7 * 24 * 3_600_000 });
    expect([...stores["ext:board-games:search"].values()]).toEqual([{ ids: ["900001", "900003", "900004"] }]);
    expect([...stores["ext:board-games:thing"].keys()].sort()).toEqual(["900001", "900003", "900004"]);
    expect(base.calls).toHaveLength(2);
    await slot.execute("starfall", context);
    expect(base.calls).toHaveLength(2);
  });
});

describe("secrets", () => {
  test("the token never reaches a log line, the html or a request address", async () => {
    const scenarios = [
      makeContext(),
      makeContext({ respond: () => new Response(`denied ${TOKEN}`, { status: 401 }) }),
      makeContext({ respond: () => new Response(`denied ${TOKEN}`, { status: 403 }) }),
      makeContext({ respond: () => new Response(`slow ${TOKEN}`, { status: 429 }) }),
      makeContext({ respond: (kind) => (kind === "thing" ? new Response("oops", { status: 500 }) : undefined) }),
      { ...makeContext(), fetch: async (url) => { throw new Error(`down ${url} ${TOKEN}`); } },
    ];
    const everything = [];
    for (const context of scenarios) {
      const slot = make();
      const lines = await capture(async () => {
        const out = await slot.execute("starfall", context);
        everything.push(out.html, out.title);
      });
      everything.push(...lines);
      for (const call of context.calls ?? []) everything.push(call.url, call.init.body ?? "");
    }
    expect(everything.join("\n")).not.toContain(TOKEN);
  });

  test("the token only ever appears in the Authorization header", async () => {
    const slot = make();
    const context = makeContext();
    await slot.execute("starfall", context);
    for (const call of context.calls) {
      const { Authorization, ...others } = call.init.headers;
      expect(Authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(others)).not.toContain(TOKEN);
      expect(call.url).not.toContain(TOKEN);
    }
  });
});
