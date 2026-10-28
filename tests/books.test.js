// Tests for the books slot plugin (Hardcover).
//
// NOTE: tests/fixtures/hardcover-search.json is HAND-WRITTEN to the layout in Hardcover's docs. It is NOT a real
// recording: the books ("The Glass Orchard" and friends), authors, ids (9001001...), texts and numbers are invented.
// The cover field and some document fields are unverified until a real search is recorded with
// HARDCOVER_API_TOKEN=... bun ./tests/record-hardcover-fixtures.js "dune" in your own terminal.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget, usageFile } from "../plugins/books/budget.js";
import {
  DEFAULT_API_URL,
  PER_PAGE,
  SEARCH_QUERY,
  bookPage,
  buildHeaders,
  buildRequestBody,
  imageUrl,
  isSlug,
  normalizeToken,
  parseRateLimit,
  readText,
  retryAfterMs,
  sanitizeTerm,
} from "../plugins/books/request.js";
import { cleanDescription, compactBook, extractDocuments, parseSearchReply } from "../plugins/books/shape.js";
import {
  BARS,
  INTENT_LOOSE_MIN_POPULARITY,
  INTENT_MIN_POPULARITY,
  SERIES_SIMILARITY,
  STRIPPED_TITLE_SIMILARITY,
  SUBTITLE_EXACT,
  cacheKey,
  evaluate,
  extractTerm,
  formatExplanation,
  hasBookWord,
  hasOtherMediaWord,
  isConfident,
  isOtherMediaQuery,
  judge,
  looksLikeATitleSearch,
  normalizeTitle,
  parseQuery,
  pickBook,
  popularity,
  scoreBook,
  specificity,
  stripDecorations,
  subtitles,
  titlePart,
  titleSimilarity,
} from "../plugins/books/match.js";
import { buildPanel, esc, formatsText, summarize } from "../plugins/books/render.js";
import { SETTINGS_SCHEMA } from "../plugins/books/settings.js";
import { BooksSlot, slot as defaultSlot } from "../plugins/books/index.js";

const fixtureText = await Bun.file(new URL("./fixtures/hardcover-search.json", import.meta.url)).text();
const fixture = JSON.parse(fixtureText);
const BOOKS = parseSearchReply(fixtureText).books;
const [GLASS, SALT, COLLECTION, CARTOGRAPHER, RIVERS, LANE] = BOOKS;

const TOKEN = "test-hardcover-token-9c4e7a1b";
const folders = [];
afterEach(() => {
  while (folders.length) rmSync(folders.pop(), { recursive: true, force: true });
});
const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "books-"));
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

const sentTerm = (call) => JSON.parse(call.init.body).variables.q;

// A fake degoog context. `respond(request)` may return a Response to override the default one.
const makeContext = ({ reply = fixture, respond, token = TOKEN } = {}) => {
  const calls = [];
  return {
    calls,
    signProxyUrl: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init, at: Date.now() });
      const override = respond?.({ url: String(url), init });
      if (override) return override;
      if (init.headers?.authorization !== `Bearer ${token}`) return Response.json({ error: "invalid_token" }, { status: 401 });
      return Response.json(reply);
    },
  };
};

const make = (settings = { apiToken: TOKEN }) => {
  const slot = new BooksSlot();
  slot.apiUrl = "https://hc.test/v1/graphql";
  slot.spacingMs = 0;
  slot.budget = new Budget({ file: "", cap: 10_000, now: () => slot.now() });
  slot.configure(settings);
  return slot;
};

const EMPTY = { title: "", html: "" };
const empty = { data: { search: { results: { found: 0, hits: [] } } } };
const book = (title, saved, extra = {}) => ({ id: "1", title, subtitle: "", alternatives: [], authors: [], year: 2000, saved, compilation: false, ...extra });
const parsed = (query) => parseQuery(query);

describe("request building", () => {
  test("the term is a GraphQL variable and the query asks for one search of books", () => {
    const body = JSON.parse(buildRequestBody("dune"));
    expect(body.query).toBe(SEARCH_QUERY);
    expect(body.variables).toEqual({ q: "dune" });
    expect(SEARCH_QUERY).toContain('search(query: $q, query_type: "Book", per_page: 8, page: 1) { results }');
    expect(PER_PAGE).toBe(8);
    expect(SEARCH_QUERY.match(/search\(/g)).toHaveLength(1);
    const hostile = JSON.parse(buildRequestBody('a" } { b \\ ${x}'));
    expect(hostile.query).toBe(SEARCH_QUERY);
    expect(hostile.variables.q).toBe('a" } { b \\ ${x}');
    expect(JSON.parse(buildRequestBody("x".repeat(500))).variables.q).toHaveLength(100);
  });

  test("terms lose control characters and are capped", () => {
    expect(sanitizeTerm("  a\u0000b\n c\u007f  ")).toBe("a b c");
    expect(sanitizeTerm(null)).toBe("");
    expect(sanitizeTerm("x".repeat(500))).toHaveLength(100);
  });

  test("the token goes only into the authorization header, with an honest user agent", () => {
    const headers = buildHeaders(TOKEN);
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe("degoog-books/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)");
    expect(buildRequestBody("dune")).not.toContain(TOKEN);
    expect(DEFAULT_API_URL).toBe("https://api.hardcover.app/v1/graphql");
  });

  test("tokens are cleaned, a leading Bearer is accepted, anything odd is refused", () => {
    expect(normalizeToken("  abc.def-123_XYZ ")).toBe("abc.def-123_XYZ");
    expect(normalizeToken("Bearer abc123")).toBe("abc123");
    expect(normalizeToken("bearer    abc123")).toBe("abc123");
    expect(buildHeaders(normalizeToken("Bearer abc123")).authorization).toBe("Bearer abc123");
    for (const bad of ["", "   ", "Bearer ", "a b", "ab\ncd", "tøken", null, undefined, "x\u0000y"]) expect(normalizeToken(bad)).toBe("");
  });

  test("links and cover images are built from validated values only", () => {
    expect(bookPage("the-glass-orchard")).toBe("https://hardcover.app/books/the-glass-orchard");
    for (const bad of ["", "Has Caps", "a/b", "a?b", "../x", null, undefined, 5, "x".repeat(201)]) {
      expect(isSlug(bad)).toBe(false);
      expect(bookPage(bad)).toBe("");
    }
    expect(imageUrl("https://assets.hardcover.app/a/b.jpg")).toBe("https://assets.hardcover.app/a/b.jpg");
    expect(imageUrl("https://hardcover.app/a.jpg")).toBe("https://hardcover.app/a.jpg");
    for (const bad of [
      "http://assets.hardcover.app/a.jpg",
      "https://evil.test/hardcover.app/a.jpg",
      "https://hardcover.app.evil.test/a.jpg",
      "https://evilhardcover.app/a.jpg",
      "https://user:pw@assets.hardcover.app/a.jpg",
      "javascript:alert(1)",
      "//assets.hardcover.app/a.jpg",
      "",
      null,
      undefined,
      5,
    ]) {
      expect(imageUrl(bad)).toBe("");
    }
  });

  test("retry-after is bounded, rate limit headers are read, replies are read up to a limit", async () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("999999")).toBe(3_600_000);
    expect(retryAfterMs(undefined)).toBe(60_000);
    expect(retryAfterMs("-5")).toBe(60_000);
    expect(parseRateLimit('"Free";r=8;t=0, "daily";r=4231;t=51234')).toEqual({ free: { r: 8, t: 0 }, daily: { r: 4231, t: 51234 } });
    expect(parseRateLimit('"daily";r=0;t=100')).toEqual({ daily: { r: 0, t: 100 } });
    for (const bad of ["", null, undefined, "nonsense", '"x";r=a;t=b']) expect(parseRateLimit(bad)).toEqual({});
    expect(await readText(new Response("x".repeat(5000)), 100)).toHaveLength(101);
    expect(await readText(new Response("short"), 100)).toBe("short");
    expect(await readText({ body: null, text: async () => "plain" }, 100)).toBe("plain");
    expect(await readText({ get body() { throw new Error("no"); } }, 100)).toBe("");
  });
});

describe("shaping Hardcover documents", () => {
  test("the fixture gives six compact books with only catalog fields and aggregate numbers", () => {
    expect(BOOKS.map((entry) => entry.id)).toEqual(["9001001", "9001002", "9001003", "9001004", "9001005", "9001006"]);
    expect(GLASS).toEqual({
      id: "9001001",
      slug: "the-glass-orchard",
      title: "The Glass Orchard",
      subtitle: "",
      alternatives: ["Der Glasgarten"],
      authors: ["Mara Fenwick"],
      year: 2014,
      pages: 412,
      description: expect.stringContaining("A mapmaker inherits an orchard"),
      genres: ["Fantasy", "Magical Realism", "Adventure", "Mystery", "Coming of Age"],
      moods: ["mysterious", "reflective", "hopeful", "adventurous"],
      series: "Orchard Cycle #1",
      rating: 4.31,
      ratingsCount: 3100,
      readers: 4200,
      saved: 5400,
      listsCount: 800,
      reviewsCount: 900,
      seriesName: "Orchard Cycle",
      seriesNames: ["Orchard Cycle"],
      seriesPosition: 1,
      compilation: false,
      hasAudiobook: true,
      hasEbook: true,
      audioHours: 12.5,
      isbn: "9780000000011",
      image: "https://assets.hardcover.app/books/9001001/cover.jpg",
    });
    expect(GLASS.description).not.toContain("\n");
  });

  test("user-owned data in a document is never copied", () => {
    const everything = JSON.stringify(BOOKS);
    for (const forbidden of ["invented_reader", "Invented Reader", "Invented private review", "list_owner", "Invented list", "user_books", "content_warnings", "Loss of a parent"]) {
      expect(everything).not.toContain(forbidden);
    }
    expect(Object.keys(GLASS).sort()).toEqual(
      ["alternatives", "audioHours", "authors", "compilation", "description", "genres", "hasAudiobook", "hasEbook", "id", "image", "isbn", "listsCount", "moods", "pages", "rating", "ratingsCount", "readers", "reviewsCount", "saved", "series", "seriesName", "seriesNames", "seriesPosition", "slug", "subtitle", "title", "year"].sort(),
    );
  });

  test("variants of the same fields are coerced: strings, single values, nested objects", () => {
    expect(SALT).toMatchObject({ id: "9001002", series: "Orchard Cycle #2", image: "https://assets.hardcover.app/books/9001002/cover.jpg", hasEbook: true, hasAudiobook: false });
    expect(COLLECTION).toMatchObject({ compilation: true, series: "Orchard Cycle", year: 2019 });
    expect(CARTOGRAPHER).toMatchObject({ series: "Brass Cartographer #2.5", image: "" });
    expect(RIVERS).toMatchObject({ id: "9001005", authors: ["Odell Marsh"], genres: ["Literary Fiction"], pages: 256, rating: 3.8, ratingsCount: 212, saved: 310, readers: 260, year: 2008, hasAudiobook: false, hasEbook: true, isbn: "9780000000042", image: "" });
    expect(LANE.image).toBe("https://assets.hardcover.app/books/9001006/cover.jpg");
    expect(compactBook({ id: 17.0, title: "T" }).id).toBe("17");
    expect(compactBook({ id: "abc", title: "T" }).id).toBe("");
    expect(compactBook({ id: "1/../2", title: "T" }).id).toBe("");
  });

  test("lists are capped, de-duplicated and may hold objects", () => {
    const many = Array.from({ length: 12 }, (_, i) => `Item ${i}`);
    const shaped = compactBook({ id: 1, title: "T", author_names: many, genres: many, moods: many, alternative_titles: many });
    expect([shaped.authors.length, shaped.genres.length, shaped.moods.length, shaped.alternatives.length]).toEqual([4, 5, 4, 10]);
    expect(compactBook({ id: 1, title: "T", genres: [{ name: "A" }, { tag: "B" }, "A", null, 5, {}, { label: "C" }] }).genres).toEqual(["A", "B", "5", "C"]);
    expect(compactBook({ id: 1, title: "T", author_names: [], contributions: [{ author: { name: "From Contribution" } }, null, {}] }).authors).toEqual(["From Contribution"]);
  });

  test("series, year, isbn, audio hours and ratings are read carefully", () => {
    const series = (extra) => compactBook({ id: 1, title: "T", ...extra }).series;
    expect(series({ featured_series: { series: { name: "Deep" }, position: 3 } })).toBe("Deep #3");
    expect(series({ featured_series: { name: "Flat" }, featured_series_position: "4" })).toBe("Flat #4");
    expect(series({ series_names: ["Only Names"] })).toBe("Only Names");
    expect(series({ series_names: ["N"], featured_series_position: 0 })).toBe("N");
    expect(series({ series_names: ["N"], featured_series_position: -2 })).toBe("N");
    expect(series({ featured_series_position: 3 })).toBe("");
    expect(series({ featured_series: "oops", series_names: "Single" })).toBe("Single");
    const year = (extra) => compactBook({ id: 1, title: "T", ...extra }).year;
    expect(year({ release_year: "1999" })).toBe(1999);
    expect(year({ release_date_i: 20140311 })).toBe(2014);
    for (const bad of [{ release_year: 0, release_date_i: 1700000000 }, { release_year: 99999 }, { release_year: "soon" }, {}]) expect(year(bad)).toBe(0);
    const isbn = (isbns) => compactBook({ id: 1, title: "T", isbns }).isbn;
    expect(isbn(["0000000011", "9780000000011"])).toBe("9780000000011");
    expect(isbn(["000000001X"])).toBe("000000001X");
    expect(isbn(["978-0-00-000001-1"])).toBe("9780000000011");
    for (const bad of [[], ["abc"], ["123"], null, "9780000000011", [null, 5]]) expect(isbn(bad)).toBe("");
    const hours = (audio_seconds) => compactBook({ id: 1, title: "T", audio_seconds }).audioHours;
    expect([hours(45000), hours("3600"), hours(0), hours("abc"), hours(-5), hours(null)]).toEqual([12.5, 1, 0, 0, 0, 0]);
    const rating = (value) => compactBook({ id: 1, title: "T", rating: value }).rating;
    expect([rating(4.333), rating("3.8"), rating(7), rating(-1), rating("x"), rating(null), rating(5)]).toEqual([4.33, 3.8, 0, 0, 0, 0, 5]);
  });

  test("descriptions are plain text: tags go, entities are decoded, whitespace collapses", () => {
    expect(cleanDescription("a<br>b<br/>c</p><p>d&nbsp;e")).toBe("a b c d e");
    expect(cleanDescription("<script>alert(1)</script>hi <img src=x onerror=1>")).toBe("alert(1) hi");
    expect(cleanDescription("Tom &amp; Jerry&#10;&rsquo;s &ldquo;x&rdquo; &hellip; &bogus;")).toBe("Tom & Jerry ’s “x” … &bogus;");
    expect(cleanDescription("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(cleanDescription("&lt;b&gt;bold&lt;/b&gt;")).toBe("bold");
    expect(cleanDescription("w ".repeat(10_000)).length).toBeLessThanOrEqual(2000);
    const started = Date.now();
    expect(cleanDescription("<a ".repeat(100_000)).length).toBeLessThanOrEqual(2000);
    expect(Date.now() - started).toBeLessThan(200);
    for (const bad of [null, undefined, 5, {}, []]) expect(cleanDescription(bad)).toBe("");
  });

  test("missing, null and odd documents never throw", () => {
    const blank = compactBook({});
    expect(blank).toMatchObject({ id: "", title: "", authors: [], year: 0, pages: 0, rating: 0, saved: 0, readers: 0, image: "", isbn: "", series: "", compilation: false, hasAudiobook: false, audioHours: 0 });
    for (const bad of [null, undefined, "x", 5, [], true]) expect(compactBook(bad)).toEqual(blank);
    const odd = compactBook({ id: {}, title: ["x"], author_names: { a: 1 }, genres: 7, pages: {}, rating: [], image: { url: 5 }, isbns: {}, featured_series: [], description: {} });
    expect(odd.title).toBe("");
    expect(odd.genres).toEqual(["7"]);
    expect(odd.image).toBe("");
  });

  test("the cover comes from image.url, a plain image string or cached_image, on Hardcover hosts only", () => {
    const image = (extra) => compactBook({ id: 1, title: "T", ...extra }).image;
    expect(image({ image: { url: "https://assets.hardcover.app/a.jpg" } })).toBe("https://assets.hardcover.app/a.jpg");
    expect(image({ image: "https://assets.hardcover.app/b.jpg" })).toBe("https://assets.hardcover.app/b.jpg");
    expect(image({ cached_image: { url: "https://assets.hardcover.app/c.jpg" } })).toBe("https://assets.hardcover.app/c.jpg");
    expect(image({ cached_image: "https://assets.hardcover.app/d.jpg" })).toBe("https://assets.hardcover.app/d.jpg");
    expect(image({ image: { url: "https://evil.test/x.jpg" }, cached_image: { url: "https://assets.hardcover.app/e.jpg" } })).toBe("https://assets.hardcover.app/e.jpg");
    for (const bad of [{ image: { url: "http://assets.hardcover.app/x.jpg" } }, { image: "javascript:alert(1)" }, { image: null }, { image: 5 }, { image: { url: "https://hardcover.app.evil.test/x" } }]) {
      expect(image(bad)).toBe("");
    }
  });

  test("the search results are found in a Typesense response and its defensive variants", () => {
    const docs = [{ id: 1, title: "A" }, { id: 2, title: "B" }];
    const hits = docs.map((document) => ({ document, text_match: 1 }));
    expect(extractDocuments({ found: 2, hits })).toEqual(docs);
    expect(extractDocuments(hits)).toEqual(docs);
    expect(extractDocuments(docs)).toEqual(docs);
    expect(extractDocuments(JSON.stringify({ hits }))).toEqual(docs);
    expect(extractDocuments({ results: [{ hits }] })).toEqual(docs);
    expect(extractDocuments({ hits: [] })).toEqual([]);
    expect(extractDocuments({ hits: [null, 5, {}, "x", { document: null }] })).toEqual([]);
    for (const bad of [null, undefined, 5, "nope", {}, { hits: "x" }, { results: [] }]) expect(extractDocuments(bad)).toBeNull();
    expect(extractDocuments({ hits: Array.from({ length: 60 }, (_, i) => ({ document: { id: i + 1, title: "T" } })) })).toHaveLength(25);
  });

  test("a GraphQL reply is parsed, errors and non-search replies are told apart", () => {
    expect(parseSearchReply(fixtureText).books).toHaveLength(6);
    expect(parseSearchReply(JSON.stringify(empty))).toEqual({ books: [] });
    expect(parseSearchReply(JSON.stringify({ errors: [{ message: "x" }], data: null }))).toEqual({ error: "errors" });
    expect(parseSearchReply(JSON.stringify({ errors: [{ message: "x" }], data: fixture.data }))).toEqual({ error: "errors" });
    for (const bad of ["", "hello", "<html>", "[]", "{}", '{"data":null}', '{"data":{"search":null}}', '{"data":{"search":{"results":5}}}']) {
      expect(parseSearchReply(bad)).toEqual({ error: "invalid" });
    }
    expect(parseSearchReply(JSON.stringify({ errors: [] , data: fixture.data })).books).toHaveLength(6);
    const noTitles = { data: { search: { results: { hits: [{ document: { id: 1 } }, { document: { title: "No id" } }] } } } };
    expect(parseSearchReply(JSON.stringify(noTitles))).toEqual({ books: [] });
    const many = { data: { search: { results: { hits: Array.from({ length: 20 }, (_, i) => ({ document: { id: i + 1, title: `T${i}` } })) } } } };
    expect(parseSearchReply(JSON.stringify(many)).books).toHaveLength(8);
  });
});

describe("query gating", () => {
  test("short title-like queries pass, questions and addresses do not", () => {
    for (const query of ["dune", "Project Hail Mary", "dune novel", "the glass orchard by mara fenwick"]) expect(looksLikeATitleSearch(query)).toBe(true);
    for (const query of ["", "a", "how to read faster", "what is a novella", "https://hardcover.app", "example.com", "2 + 2", "x ".repeat(40), "one two three four five six seven eight nine", "weather"]) {
      expect(looksLikeATitleSearch(query)).toBe(false);
    }
  });

  test("book words are recognised as whole words, and 'by <author>' is intent", () => {
    for (const query of [
      "dune book",
      "dune books",
      "dune novel",
      "dune novels",
      "dune author",
      "dune paperback",
      "dune hardcover",
      "dune audiobook",
      "dune ebook",
      "dune e-book",
      "dune isbn",
      "dune series",
      "dune trilogy",
      "dune sequel",
      "dune prequel",
      "dune summary",
      "dune synopsis",
      "dune chapters",
      "dune reading order",
      "dune read",
      "DUNE NOVEL",
    ]) {
      expect(hasBookWord(query)).toBe(true);
    }
    for (const query of ["dune", "bookish", "novelty", "reader", "ebooks4u", "hardcovered"]) expect(hasBookWord(query)).toBe(false);
    expect(parseQuery("dune by frank herbert").intent).toBe(true);
    expect(parseQuery("dune novel").intent).toBe(true);
    expect(parseQuery("dune").intent).toBe(false);
    expect(parseQuery("dune frank herbert").intent).toBe(false);
  });

  test("video game and board game words mean another medium, unless the query says book", () => {
    for (const query of ["skyrim walkthrough", "elden ring ps5", "doom steam", "starfall pc", "starfall dlc", "starfall mods", "catan board game", "azul tabletop", "wingspan card game", "catan bgg", "dune switch"]) {
      expect(hasOtherMediaWord(query)).toBe(true);
      expect(isOtherMediaQuery(query)).toBe(true);
    }
    expect(isOtherMediaQuery("dune novel")).toBe(false);
    expect(isOtherMediaQuery("dune book pc")).toBe(false);
    expect(isOtherMediaQuery("dune audiobook")).toBe(false);
    expect(isOtherMediaQuery("project hail mary")).toBe(false);
    expect(isOtherMediaQuery("the board game book")).toBe(false);
  });

  test("only trailing book words are removed from the title", () => {
    expect(extractTerm("dune novel")).toBe("dune");
    expect(extractTerm("project hail mary book")).toBe("project hail mary");
    expect(extractTerm("foundation series")).toBe("foundation");
    expect(extractTerm("dune novel summary")).toBe("dune");
    expect(extractTerm("harry potter reading order")).toBe("harry potter");
    expect(extractTerm("The Book Thief")).toBe("The Book Thief");
    expect(extractTerm("read dune")).toBe("read dune");
    expect(extractTerm("dune")).toBe("dune");
  });

  test("'<title> by <author>' splits on the last by, and the search text holds both", () => {
    expect(parseQuery("dune by frank herbert")).toEqual({ term: "dune by frank herbert", title: "dune", author: "frank herbert", search: "dune frank herbert", intent: true });
    expect(parseQuery("stand by me by stephen king")).toMatchObject({ title: "stand by me", author: "stephen king", search: "stand by me stephen king" });
    expect(parseQuery("dune by frank herbert novel")).toMatchObject({ title: "dune", author: "frank herbert" });
    expect(parseQuery("Dune BY Frank Herbert")).toMatchObject({ title: "Dune", author: "Frank Herbert" });
    for (const plain of ["dune", "dune frank herbert", "dune by", "by frank herbert", "stand by"]) {
      const result = parseQuery(plain);
      expect([result.title, result.author]).toEqual(["", ""]);
      expect(result.search).toBe(result.term);
    }
  });

  test("the cache key ignores case, accents, punctuation and a leading 'the'", () => {
    expect(cacheKey("The Glass Orchard")).toBe(cacheKey("glass orchard"));
    expect(cacheKey("Pokémon")).toBe(cacheKey("pokemon"));
    expect(normalizeTitle("Dune (1965)")).toBe("dune");
  });
});

describe("title matching", () => {
  test("similarity", () => {
    expect(titleSimilarity("dune", "Dune")).toBe(1);
    expect(titleSimilarity("dune", "Dune Messiah")).toBe(0.9);
    expect(titleSimilarity("dune messiah", "Dune")).toBe(0.9);
    expect(titleSimilarity("dune 2", "Dune")).toBe(0.5);
    expect(titleSimilarity("dune ii", "Dune")).toBe(0.5);
    expect(titleSimilarity("foundation 3", "Foundation")).toBe(0.5);
    expect(titleSimilarity("hobbit", "The Hobbit")).toBe(1);
    expect(titleSimilarity("cats", "Dogs")).toBe(0);
    expect(titleSimilarity("burgundy castles of", "The Castles of Burgundy")).toBe(0.8);
  });

  test("a short query may match a subtitle", () => {
    expect(subtitles("The Brass Cartographer: Lantern Fires")).toEqual(["lantern fires"]);
    expect(subtitles("Pandemic - Legacy: Season 1")).toEqual(["legacy", "season 1"]);
    expect(subtitles("Dune")).toEqual([]);
    expect(titleSimilarity("lantern fires", "The Brass Cartographer: Lantern Fires")).toBe(SUBTITLE_EXACT);
    expect(SUBTITLE_EXACT).toBe(0.88);
  });

  test("the part of the query that is the title: the book's own authors are taken out", () => {
    expect(titlePart("dune herbert", { authors: ["Frank Herbert"] })).toBe("dune");
    expect(titlePart("frank herbert dune", { authors: ["Frank Herbert"] })).toBe("dune");
    expect(titlePart("dune by frank herbert", { authors: ["Frank Herbert"] })).toBe("dune");
    expect(titlePart("stand by me by stephen king", { authors: ["Stephen King"] })).toBe("stand by me");
    expect(titlePart("frank herbert", { authors: ["Frank Herbert"] })).toBe("");
    expect(titlePart("herbert", { authors: ["Frank Herbert"] })).toBe("");
    expect(titlePart("dune herbert", { authors: ["Someone Else"] })).toBe("dune herbert");
    expect(titlePart("dune", {})).toBe("dune");
    expect(titlePart("dune", null)).toBe("dune");
  });

  test("scoring checks the title, alternative titles and the title without its subtitle", () => {
    expect(scoreBook(parsed("glass orchard"), GLASS).sim).toBe(1);
    expect(scoreBook(parsed("der glasgarten"), GLASS).sim).toBe(1);
    expect(scoreBook(parsed("glass orchard by mara fenwick"), GLASS).sim).toBe(1);
    expect(scoreBook(parsed("mara fenwick"), GLASS)).toMatchObject({ skip: true, sim: 0 });
    expect(scoreBook(parsed("dune"), book("Dune: The Graphic Novel", 500)).sim).toBe(STRIPPED_TITLE_SIMILARITY);
    expect(scoreBook(parsed("dune"), book("Dune", 500)).sim).toBe(1);
    expect(scoreBook(parsed("dune messiah"), book("Messiah", 500, { subtitle: "", title: "Dune", alternatives: [] })).sim).toBe(0.9);
    expect(scoreBook(parsed("the lost isle a pirate tale"), book("The Lost Isle", 500, { subtitle: "A Pirate Tale" })).sim).toBe(1);
  });

  test("confidence needs enough readers, and a book word lowers the bar", () => {
    // A low-specificity (one short word) query keeps the old, strict bars.
    expect([BARS.exact.low, BARS.prefix.low, BARS.subtitle.low, INTENT_MIN_POPULARITY, INTENT_LOOSE_MIN_POPULARITY]).toEqual([1000, 2000, 5000, 3, 60]);
    expect(isConfident(1, 1000, false)).toBe(true);
    expect(isConfident(1, 999, false)).toBe(false);
    expect(isConfident(1, 2, true)).toBe(false);
    expect(isConfident(1, 3, true)).toBe(true);
    expect(isConfident(0.9, 2000, false)).toBe(true);
    expect(isConfident(0.9, 1999, false)).toBe(false);
    expect(isConfident(0.9, 3, true)).toBe(true);
    expect(isConfident(SUBTITLE_EXACT, 5000, false)).toBe(true);
    expect(isConfident(SUBTITLE_EXACT, 4999, false)).toBe(false);
    expect(isConfident(SUBTITLE_EXACT, 60, true)).toBe(true);
    expect(isConfident(SUBTITLE_EXACT, 59, true)).toBe(false);
    expect(isConfident(0.8, 60, true)).toBe(true);
    expect(isConfident(0.8, 59, true)).toBe(false);
    expect(isConfident(0.79, 99999, true)).toBe(false);
  });

  test("popularity is the strongest of several signals, and one missing signal never hides a book", () => {
    expect(popularity({ saved: 12 })).toBe(12);
    expect(popularity({ saved: "x" })).toBe(0);
    expect(popularity(null)).toBe(0);
    expect(popularity({ saved: 0, readers: 0, ratingsCount: 500 })).toBe(1000);
    expect(popularity({ saved: null, readers: undefined, listsCount: 40, reviewsCount: 3 })).toBe(80);
    expect(popularity({ saved: 5000, ratingsCount: 3 })).toBe(5000);
  });

  test("picks the right book from the fixture", () => {
    const pick = (query) => pickBook(parsed(query), BOOKS)?.id ?? null;
    expect(pick("glass orchard")).toBe("9001001");
    expect(pick("the glass orchard")).toBe("9001001");
    expect(pick("der glasgarten")).toBe("9001001");
    expect(pick("salt orchard")).toBe("9001002");
    expect(pick("quiet rivers")).toBe("9001005");
    expect(pick("orchard lane")).toBe("9001006");
    expect(pick("brass cartographer")).toBe("9001004");
    expect(pick("lantern fires")).toBe("9001004");
    expect(pick("zzz")).toBeNull();
    expect(pickBook(parsed("glass orchard"), [])).toBeNull();
    expect(pickBook(parsed("glass orchard"), null)).toBeNull();
    expect(pickBook(parsed("glass orchard"), [null, {}, { id: "1" }, { title: "Glass Orchard" }])).toBeNull();
  });

  test("'<title> by <author>' and '<title> <author>' use the author's name", () => {
    const pick = (query) => pickBook(parsed(query), BOOKS)?.id ?? null;
    expect(pick("salt orchard by mara fenwick")).toBe("9001002");
    expect(pick("the salt orchard mara fenwick")).toBe("9001002");
    expect(pick("mara fenwick salt orchard")).toBe("9001002");
    expect(pick("glass orchard fenwick")).toBe("9001001");
    expect(pick("quiet rivers by odell marsh")).toBe("9001005");
    expect(pick("glass orchard by someone else")).toBe("9001001");
  });

  test("an author-only query shows nothing in this version", () => {
    for (const query of ["mara fenwick", "fenwick", "by mara fenwick", "idris vale", "odell marsh novel", "tess whitcombe author"]) {
      expect(pickBook(parsed(query), BOOKS)).toBeNull();
    }
  });

  test("a trailing number or numeral names another book", () => {
    const dune = [book("Dune", 50_000)];
    expect(pickBook(parsed("dune"), dune)?.title).toBe("Dune");
    expect(pickBook(parsed("dune 2"), dune)).toBeNull();
    expect(pickBook(parsed("dune ii"), dune)).toBeNull();
    expect(pickBook(parsed("dune 2 novel"), dune)).toBeNull();
    expect(pickBook(parsed("dune 2"), [...dune, book("Dune 2", 900, { id: "2" })])?.id).toBe("2");
    expect(pickBook(parsed("glass orchard 2"), BOOKS)).toBeNull();
  });

  test("generic single words need the higher thresholds", () => {
    expect(pickBook(parsed("ring"), [book("Ring", 15)])).toBeNull();
    expect(pickBook(parsed("ring"), [book("Ring", 25)])).toBeNull();
    expect(pickBook(parsed("ring"), [book("Ring", 499)])).toBeNull();
    // the first result of the list that matches exactly needs half of the bar (1000)
    expect(pickBook(parsed("ring"), [book("Ring", 500)])?.title).toBe("Ring");
    expect(pickBook(parsed("ring"), [book("Other", 9), book("Ring", 500)])).toBeNull();
    expect(pickBook(parsed("ring"), [book("Other", 9), book("Ring", 1000)])?.title).toBe("Ring");
    expect(pickBook(parsed("ring"), [book("Ring", 4)])).toBeNull();
    expect(pickBook(parsed("ring novel"), [book("Ring", 4)])?.title).toBe("Ring");
    expect(pickBook(parsed("ring"), [book("Ring of Fire", 900)])).toBeNull();
    expect(pickBook(parsed("ring"), [book("Ring of Fire", 1000)])?.title).toBe("Ring of Fire");
    expect(pickBook(parsed("ring"), [book("The One Ring Companion", 5000)])).toBeNull();
  });

  test("a series name shows the first book of the series, never a compilation first", () => {
    expect(pickBook(parsed("orchard cycle"), BOOKS)?.id).toBe("9001001");
    const plain = book("Dune", 3000, { id: "1" });
    const compilation = book("Dune", 9000, { id: "2", compilation: true });
    expect(pickBook(parsed("dune"), [compilation, plain])?.id).toBe("1");
    expect(pickBook(parsed("dune"), [compilation])?.id).toBe("2");
    expect(pickBook(parsed("dune"), [plain, compilation])?.id).toBe("1");
  });

  test("the closest title wins, then one with a release year, then the most saved", () => {
    const exact = book("Hanabi", 3000, { id: "1" });
    const prefix = book("Hanabi Nights", 90000, { id: "2" });
    expect(pickBook(parsed("hanabi"), [prefix, exact])?.id).toBe("1");
    const noYear = book("Hanabi", 9000, { id: "3", year: 0 });
    const withYear = book("Hanabi", 3000, { id: "4", year: 1990 });
    expect(pickBook(parsed("hanabi"), [noYear, withYear])?.id).toBe("4");
    const popular = book("Hanabi", 9900, { id: "5", year: 1991 });
    expect(pickBook(parsed("hanabi"), [withYear, popular])?.id).toBe("5");
  });

  test("a subtitle shared by several series is ambiguous unless the query names a book", () => {
    const legacy = [book("Night Watch: Legacy", 9000, { id: "1" }), book("Sky Guard: Legacy", 7000, { id: "2" })];
    expect(pickBook(parsed("legacy"), legacy)).toBeNull();
    expect(pickBook(parsed("legacy book"), legacy)?.id).toBe("1");
    expect(pickBook(parsed("night watch legacy"), legacy)?.id).toBe("1");
    const same = [book("Night Watch: Legacy", 9000, { id: "1" }), book("Night Watch - Legacy", 7000, { id: "2" })];
    expect(pickBook(parsed("legacy"), same)?.id).toBe("1");
    expect(pickBook(parsed("lantern fires"), BOOKS)?.id).toBe("9001004");
  });

  test("'stand by me' is still a title, and the author split does not break it", () => {
    const stand = [book("Stand by Me", 500, { id: "1", authors: ["Stephen King"] })];
    expect(pickBook(parsed("stand by me"), stand)?.id).toBe("1");
    expect(pickBook(parsed("stand by me by stephen king"), stand)?.id).toBe("1");
  });
});

describe("rendering", () => {
  const signProxy = (url) => `/proxy?u=${encodeURIComponent(url)}`;
  const full = () => buildPanel({ book: GLASS, signProxy });

  test("shows the labelled badges, the facts, the link and a signed cover", () => {
    const html = full();
    expect(html).toContain("Hardcover rating");
    expect(html).toContain(">4.3<");
    expect(html).toContain("3,100 ratings");
    expect(html).toContain("Readers");
    expect(html).toContain(">4,200<");
    expect(html).toContain("on Hardcover");
    expect(html).toContain("books-score--good");
    expect(html).toContain("Book · 2014 · Orchard Cycle #1");
    expect(html).toContain('<div class="books-authors">by Mara Fenwick</div>');
    expect(html).toContain('href="https://hardcover.app/books/the-glass-orchard"');
    expect(html).toContain(">Hardcover page<");
    expect(html).toContain('Data from <a href="https://hardcover.app" target="_blank" rel="noopener">Hardcover</a>');
    expect(html).toContain("<dt>Pages</dt><dd>412</dd>");
    expect(html).toContain("<dt>Published</dt><dd>2014</dd>");
    expect(html).toContain('<span class="books-chip">Fantasy</span>');
    expect(html).toContain('<span class="books-chip">mysterious</span>');
    expect(html).toContain('<span class="books-nowrap">Audiobook · 12.5 h</span>, <span class="books-nowrap">E-book</span>');
    expect(html).toContain("<dt>ISBN</dt><dd>9780000000011</dd>");
    expect(html).toContain(`/proxy?u=${encodeURIComponent("https://assets.hardcover.app/books/9001001/cover.jpg")}`);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("null");
  });

  test("the description is a cleanly cut preview and can be turned off", () => {
    const on = full();
    expect(on).toContain('<p class="books-desc">A mapmaker inherits an orchard');
    const long = `${"A".repeat(150)}. ${"B".repeat(300)}`;
    expect(buildPanel({ book: { ...GLASS, description: long } })).toContain(`<p class="books-desc">${"A".repeat(150)}.</p>`);
    const off = buildPanel({ book: GLASS, showDescription: false });
    expect(off).not.toContain("books-desc");
    expect(off).not.toContain("A mapmaker");
  });

  test("rating colours follow the bands, and aggregate numbers only appear when there are some", () => {
    const band = (rating) => buildPanel({ book: { ...GLASS, rating } });
    expect(band(4)).toContain("books-score--good");
    expect(band(3.99)).toContain("books-score--mixed");
    expect(band(3.3)).toContain("books-score--mixed");
    expect(band(3.29)).toContain("books-score--bad");
    const none = buildPanel({ book: { ...GLASS, rating: 0, readers: 0 } });
    expect(none).not.toContain("books-scores");
    expect(buildPanel({ book: { ...GLASS, readers: 0 } })).not.toContain("Readers");
    expect(buildPanel({ book: { ...GLASS, rating: 0 } })).not.toContain("Hardcover rating");
    expect(buildPanel({ book: { ...GLASS, ratingsCount: 0 } })).not.toContain("ratings<");
    expect(buildPanel({ book: { ...GLASS, ratingsCount: 1 } })).toContain("1 rating<");
  });

  test("formats are shown only when known", () => {
    expect(formatsText({ hasAudiobook: true, audioHours: 12.5, hasEbook: true })).toBe("Audiobook · 12.5 h, E-book");
    expect(formatsText({ hasAudiobook: true, audioHours: 0, hasEbook: false })).toBe("Audiobook");
    expect(formatsText({ hasAudiobook: false, hasEbook: true })).toBe("E-book");
    expect(formatsText({ hasAudiobook: false, hasEbook: false })).toBe("");
    expect(buildPanel({ book: { ...GLASS, hasAudiobook: false, hasEbook: false } })).not.toContain("Formats");
  });

  test("works with minimal data and always credits Hardcover", () => {
    const html = buildPanel({ book: compactBook({ id: 1, title: "X" }) });
    expect(html).toContain("<h3");
    expect(html).toContain('href="https://hardcover.app"');
    expect(html).toContain("Data from");
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("Hardcover page");
    expect(html).not.toContain("books-cover");
    expect(html).not.toContain("books-authors");
    expect(html).toContain("books-kicker\">Book</div>");
    expect(buildPanel({ book: compactBook({}) })).toContain("Data from");
    // No signing function: the cover is left out rather than linking the image host directly.
    expect(buildPanel({ book: GLASS })).not.toContain("<img");
    expect(buildPanel({ book: { ...GLASS, image: "https://evil.test/x.jpg" }, signProxy })).not.toContain("<img");
  });

  test("escapes every text field and drops unsafe links", () => {
    const evil = {
      ...GLASS,
      slug: 'x"><img src=x onerror=alert(1)>',
      title: '<script>alert("t")</script>',
      authors: ["<b>author</b>", '"><svg onload=alert(1)>'],
      series: "<i>series</i> #1",
      description: "<b>bold</b> & <i>x</i>",
      genres: ["<u>g</u>"],
      moods: ["<s>m</s>"],
      isbn: '"><script>',
      image: 'javascript:alert(1)',
    };
    const html = buildPanel({ book: evil, signProxy });
    for (const forbidden of ["<script", "<b>", "<i>", "<u>", "<s>", "<svg", "<img src=x", "javascript:", "onerror=alert"]) expect(html).not.toContain(forbidden);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;");
    expect(html).not.toContain("Hardcover page");
    expect(html).not.toContain("books-title-link");
    expect(esc('<a href="x">\'&')).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(esc(null)).toBe("");
  });

  test("nothing a user owns can appear, even when the document carried it", () => {
    const html = buildPanel({ book: GLASS, signProxy });
    for (const forbidden of ["invented_reader", "Invented Reader", "Invented private review", "list_owner", "Invented list", "review"]) {
      expect(html.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
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
    await withEnv({ DEGOOG_HARDCOVER_USAGE_FILE: undefined }, () => expect(usageFile("data")).toBe(join("data", "hardcover", "usage.json")));
    await withEnv({ DEGOOG_HARDCOVER_USAGE_FILE: "/tmp/elsewhere.json" }, () => expect(usageFile("data")).toBe("/tmp/elsewhere.json"));
  });

  test("stops at the cap, 0 means no cap", () => {
    const budget = new Budget({ cap: 2 });
    expect([budget.spend(), budget.spend(), budget.spend()]).toEqual([true, true, false]);
    const unlimited = new Budget({ cap: 0 });
    for (let i = 0; i < 1000; i += 1) expect(unlimited.spend()).toBe(true);
  });

  test("the count survives a restart, resets at UTC midnight, and is written atomically", () => {
    const file = join(tempFolder(), "hardcover", "usage.json");
    let now = midnight + 23 * 3_600_000 + 59 * 60_000 + 59_000;
    const first = new Budget({ file, cap: 3, now: () => now });
    first.spend();
    first.spend();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-01-01", used: 2 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    const second = new Budget({ file, cap: 3, now: () => now });
    expect(second.exhausted).toBe(false);
    expect(second.used).toBe(2);
    expect(second.msUntilReset).toBe(1000);
    second.spend();
    expect(second.exhausted).toBe(true);
    now += 2000;
    expect(second.exhausted).toBe(false);
    expect(second.used).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-01-02", used: 0 });
  });
});

describe("the slot", () => {
  test("is a valid knowledge panel slot", () => {
    expect(defaultSlot.position).toBe("knowledge-panel");
    expect(defaultSlot.slotPositions).toEqual(["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"]);
    expect(typeof defaultSlot.trigger).toBe("function");
    expect(typeof defaultSlot.execute).toBe("function");
    expect(defaultSlot.isClientExposed).toBe(false);
    expect(defaultSlot.id).toBe("books");
  });

  test("the token is optional in the schema, a secret, and the description warns about scopes", () => {
    const schema = defaultSlot.settingsSchema;
    const field = (key) => schema.find((entry) => entry.key === key);
    expect(field("apiToken").type).toBe("password");
    expect(field("apiToken").secret).toBe(true);
    expect(field("apiToken").fieldset).toBe("Account");
    expect(schema.some((entry) => entry.required)).toBe(false);
    expect(field("apiToken").description).toContain("read:catalog");
    expect(field("apiToken").description).toContain("ONLY");
    expect(field("apiToken").description).toContain("'all'");
    expect(field("apiToken").description).toContain("HARDCOVER_API_TOKEN");
    expect(field("requireBookWord").default).toBe("false");
    expect(field("showDescription").default).toBe("true");
    expect(field("requireBookWord").fieldset).toBe("Display");
    expect(field("dailyRequestLimit")).toMatchObject({ type: "number", default: "1500", advanced: true, fieldset: "Limits" });
  });

  test("the plugin folder is self-contained", () => {
    const folder = new URL("../plugins/books/", import.meta.url);
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".js"))) {
      expect(readFileSync(new URL(name, folder), "utf8")).not.toMatch(/from\s+["']\.\.\//);
    }
    expect(readFileSync(new URL("template.html", folder), "utf8").trim()).toBe('<div class="command-result books-result">{{content}}</div>');
  });

  test("the API url and the request window come from the environment", async () => {
    await withEnv({ DEGOOG_HARDCOVER_API_URL: "http://mock:4470/v1/graphql", DEGOOG_SLOT_TIMEOUT_MS: undefined }, () => {
      const slot = new BooksSlot();
      expect(slot.apiUrl).toBe("http://mock:4470/v1/graphql");
      expect(slot.startWindowMs).toBe(7000);
    });
    await withEnv({ DEGOOG_HARDCOVER_API_URL: undefined, DEGOOG_SLOT_TIMEOUT_MS: "5000" }, () => {
      const slot = new BooksSlot();
      expect(slot.apiUrl).toBe(DEFAULT_API_URL);
      expect(slot.startWindowMs).toBe(3500);
    });
    await withEnv({ DEGOOG_SLOT_TIMEOUT_MS: "1200" }, () => expect(new BooksSlot().startWindowMs).toBe(1000));
  });

  test("without a token nothing triggers and nothing is requested", async () => {
    await withEnv({ HARDCOVER_API_TOKEN: undefined }, async () => {
      for (const settings of [{}, { apiToken: "   " }, { apiToken: "has spaces" }]) {
        const slot = make(settings);
        const context = makeContext();
        expect(slot.trigger("glass orchard")).toBe(false);
        expect(await slot.execute("glass orchard", context)).toEqual(EMPTY);
        expect(context.calls).toHaveLength(0);
      }
    });
  });

  test("the environment token is used when the setting is empty, and the setting wins", async () => {
    await withEnv({ HARDCOVER_API_TOKEN: "env-token-123" }, async () => {
      expect(make({}).apiToken).toBe("env-token-123");
      expect(make({ apiToken: "  " }).apiToken).toBe("env-token-123");
      expect(make({ apiToken: "ui-token-456" }).apiToken).toBe("ui-token-456");
      expect(make({ apiToken: "Bearer ui-token-456" }).apiToken).toBe("ui-token-456");
      const context = makeContext({ token: "ui-token-456" });
      await make({ apiToken: "Bearer ui-token-456" }).execute("glass orchard", context);
      expect(context.calls[0].init.headers.authorization).toBe("Bearer ui-token-456");
    });
  });

  test("settings accept strings and booleans, and the daily limit falls back to 1500", () => {
    const slot = make({ apiToken: TOKEN, requireBookWord: true, showDescription: "false", dailyRequestLimit: "25" });
    expect([slot.requireBookWord, slot.showDescription, slot.budget.cap]).toEqual([true, false, 25]);
    const defaults = make({ apiToken: TOKEN });
    expect([defaults.requireBookWord, defaults.showDescription, defaults.budget.cap]).toEqual([false, true, 1500]);
    expect(make({ apiToken: TOKEN, dailyRequestLimit: "0" }).budget.cap).toBe(0);
    for (const bad of ["abc", "-4", ""]) expect(make({ apiToken: TOKEN, dailyRequestLimit: bad }).budget.cap).toBe(1500);
  });

  test("the first query is one GraphQL request and renders the panel", async () => {
    const slot = make();
    slot.init({ template: '<div class="x">{{content}}</div>' });
    const context = makeContext();
    const out = await slot.execute("glass orchard", context);
    expect(context.calls).toHaveLength(1);
    expect(out.title).toBe("The Glass Orchard");
    expect(out.html).toStartWith('<div class="x"><div class="books-card">');
    for (const part of ["Hardcover rating", "Readers", "Data from", "hardcover.app/books/the-glass-orchard"]) expect(out.html).toContain(part);
    const [call] = context.calls;
    expect(call.url).toBe("https://hc.test/v1/graphql");
    expect(call.init.method).toBe("POST");
    expect(call.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.init.headers["User-Agent"]).toContain("degoog-books/1.0");
    expect(JSON.parse(call.init.body)).toEqual({ query: SEARCH_QUERY, variables: { q: "glass orchard" } });
    expect(slot.budget.used).toBe(1);
  });

  test("the same book is then served from cache with no requests", async () => {
    const slot = make();
    const context = makeContext();
    const first = await slot.execute("glass orchard", context);
    context.calls.length = 0;
    for (const query of ["Glass Orchard", "the glass orchard novel", "glass orchard  book", "THE GLASS ORCHARD"]) {
      expect((await slot.execute(query, context)).title).toBe("The Glass Orchard");
    }
    expect((await slot.execute("glass orchard", context)).html).toBe(first.html);
    expect(context.calls).toHaveLength(0);
  });

  test("'<title> by <author>' searches for title and author together", async () => {
    const slot = make();
    const context = makeContext();
    const out = await slot.execute("salt orchard by mara fenwick", context);
    expect(out.title).toBe("The Salt Orchard");
    expect(context.calls).toHaveLength(1);
    expect(sentTerm(context.calls[0])).toBe("salt orchard mara fenwick");
    context.calls.length = 0;
    expect((await slot.execute("salt orchard mara fenwick", context)).title).toBe("The Salt Orchard");
    expect(context.calls).toHaveLength(0);
    expect(await slot.execute("mara fenwick", makeContext())).toEqual(EMPTY);
  });

  test("a query with no match costs one request, and is remembered", async () => {
    const slot = make();
    const context = makeContext({ reply: empty });
    expect(await slot.execute("zzz nothing", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(1);
    await slot.execute("zzz nothing", context);
    expect(context.calls).toHaveLength(1);
    const loose = make();
    const looseContext = makeContext();
    expect(await loose.execute("ring", looseContext)).toEqual(EMPTY);
    expect(looseContext.calls).toHaveLength(1);
  });

  test("queries that are not book titles cause no requests at all", async () => {
    const slot = make();
    const context = makeContext();
    for (const query of ["weather", "how to beat skyrim", "skyrim walkthrough", "starfall board game", "elden ring ps5", "what is a novella", "example.com", "x"]) {
      expect(slot.trigger(query)).toBe(false);
      expect(await slot.execute(query, context)).toEqual(EMPTY);
    }
    expect(context.calls).toHaveLength(0);
    expect(slot.trigger("dune novel pc")).toBe(true);
  });

  test("requireBookWord blocks plain queries and allows book ones", async () => {
    const slot = make({ apiToken: TOKEN, requireBookWord: "true" });
    expect(slot.trigger("glass orchard")).toBe(false);
    expect(slot.trigger("glass orchard book")).toBe(true);
    expect(slot.trigger("glass orchard by mara fenwick")).toBe(true);
    const context = makeContext();
    expect(await slot.execute("glass orchard", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
  });

  test("showDescription off hides the description", async () => {
    const out = await make({ apiToken: TOKEN, showDescription: "false" }).execute("glass orchard", makeContext());
    expect(out.html).not.toContain("A mapmaker inherits");
    expect(out.html).toContain("The Glass Orchard");
  });

  test("429 pauses for the retry-after time, a minute by default, an hour at most", async () => {
    const slot = make();
    let now = 1_000_000;
    slot.now = () => now;
    const context = makeContext({ respond: () => new Response("slow", { status: 429, headers: { "retry-after": "30" } }) });
    const lines = await capture(async () => expect(await slot.execute("glass orchard", context)).toEqual(EMPTY));
    expect(context.calls).toHaveLength(1);
    expect(slot.paused).toBe(true);
    expect(lines).toEqual(["[books] Hardcover rate limited this instance; paused for 1 min"]);
    expect(slot.trigger("glass orchard")).toBe(false);
    context.calls.length = 0;
    expect(await slot.execute("salt orchard", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
    now += 29_000;
    expect(slot.paused).toBe(true);
    now += 2_000;
    expect(slot.paused).toBe(false);
    const pauseOf = async (headers) => {
      const other = make();
      await capture(() => other.execute("glass orchard", makeContext({ respond: () => new Response("slow", { status: 429, headers }) })));
      return other._pausedUntil - other.now();
    };
    expect(await pauseOf({})).toBeGreaterThan(59_000);
    expect(await pauseOf({})).toBeLessThanOrEqual(60_000);
    expect(await pauseOf({ "retry-after": "999999" })).toBeLessThanOrEqual(3_600_000);
  });

  test("when the daily bucket is empty it waits for the reset, an hour at most", async () => {
    const pauseOf = async (headers) => {
      const slot = make();
      const lines = await capture(() => slot.execute("glass orchard", makeContext({ respond: () => new Response("slow", { status: 429, headers: { "retry-after": "5", ...headers } }) })));
      expect(lines).toHaveLength(1);
      return { ms: slot._pausedUntil - slot.now(), line: lines[0] };
    };
    const short = await pauseOf({ ratelimit: '"daily";r=0;t=1000' });
    expect(short.ms).toBeGreaterThan(999_000);
    expect(short.ms).toBeLessThanOrEqual(1_000_000);
    expect(short.line).toContain("daily request limit is used up");
    expect((await pauseOf({ ratelimit: '"daily";r=0;t=999999' })).ms).toBeLessThanOrEqual(3_600_000);
    expect((await pauseOf({ ratelimit: '"daily";r=0;t=999999' })).ms).toBeGreaterThan(3_599_000);
    expect((await pauseOf({ "x-ratelimit-daily-remaining": "0" })).ms).toBeGreaterThan(60_000);
    const minute = await pauseOf({ ratelimit: '"Free";r=0;t=30, "daily";r=4000;t=3000' });
    expect(minute.ms).toBeLessThanOrEqual(5000);
    expect(minute.line).toContain("rate limited this instance");
  });

  test("401 pauses for 30 minutes with one short warning", async () => {
    const slot = make();
    const context = makeContext({ respond: () => Response.json({ error: "invalid_token", error_description: `bad ${TOKEN}` }, { status: 401 }) });
    const lines = await capture(async () => expect(await slot.execute("glass orchard", context)).toEqual(EMPTY));
    expect(slot._pausedUntil - slot.now()).toBeGreaterThan(29 * 60_000);
    expect(lines).toEqual(["[books] Hardcover rejected the token (invalid or expired); paused for 30 min"]);
    expect(slot.trigger("glass orchard")).toBe(false);
  });

  test("403 insufficient_scope says the token needs read:catalog, other 403s pause for ten minutes", async () => {
    const scope = make();
    const lines = await capture(() =>
      scope.execute("glass orchard", makeContext({ respond: () => Response.json({ error: "insufficient_scope", error_description: "x", scope: "read:catalog" }, { status: 403 }) })),
    );
    expect(scope._pausedUntil - scope.now()).toBeGreaterThan(29 * 60_000);
    expect(lines).toEqual(["[books] Hardcover refused the token: it needs the read:catalog scope; paused for 30 min"]);
    for (const body of [{ error: "unsupported_operation" }, { errors: ["request_exceeds_capacity"] }, "not json"]) {
      const other = make();
      const otherLines = await capture(() => other.execute("glass orchard", makeContext({ respond: () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 403 }) })));
      expect(other._pausedUntil - other.now()).toBeLessThanOrEqual(600_000);
      expect(other._pausedUntil - other.now()).toBeGreaterThan(599_000);
      expect(otherLines).toEqual(["[books] Hardcover refused the request (HTTP 403); paused for 10 min"]);
    }
  });

  test("400, 408, server errors and network failures pause for a minute and never throw or leak the token", async () => {
    for (const respond of [
      () => Response.json({ error: "invalid_request", error_description: "No Authorization header" }, { status: 400 }),
      () => Response.json({ error: "Request timeout" }, { status: 408 }),
      () => new Response("oops", { status: 500 }),
      () => Response.json({ error: "Service temporarily unavailable" }, { status: 503 }),
      () => {
        throw new Error(`down https://hc.test/v1/graphql Bearer ${TOKEN}`);
      },
    ]) {
      const slot = make();
      const context = makeContext({ respond });
      const lines = await capture(async () => expect(await slot.execute("glass orchard", context)).toEqual(EMPTY));
      expect(slot.paused).toBe(true);
      expect(slot._pausedUntil - slot.now()).toBeLessThanOrEqual(60_000);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toStartWith("[books] Hardcover ");
      for (const forbidden of [TOKEN, "http", "hc.test", "Bearer"]) expect(lines[0]).not.toContain(forbidden);
    }
  });

  test("a GraphQL error in an HTTP 200 reply is a failed request: a short pause, nothing cached", async () => {
    const slot = make();
    const reply = { errors: [{ message: `field timed out for ${TOKEN}`, extensions: { code: "timeout" } }], data: null };
    const context = makeContext({ reply });
    const lines = await capture(async () => expect(await slot.execute("glass orchard", context)).toEqual(EMPTY));
    expect(lines).toEqual(["[books] Hardcover answered with a GraphQL error; paused for 1 min"]);
    expect(slot._pausedUntil - slot.now()).toBeLessThanOrEqual(60_000);
    expect(lines.join("")).not.toContain(TOKEN);
    let now = slot.now() + 61_000;
    slot.now = () => now;
    const good = makeContext();
    expect((await slot.execute("glass orchard", good)).title).toBe("The Glass Orchard");
    now += 1;
  });

  test("an unreadable reply is not cached and does not pause", async () => {
    for (const respond of [() => new Response("hello there", { status: 200 }), () => Response.json({ data: { nothing: true } }), () => new Response("x".repeat(1_100_000))]) {
      const slot = make();
      const context = makeContext({ respond });
      expect(await slot.execute("glass orchard", context)).toEqual(EMPTY);
      expect(slot.paused).toBe(false);
      await slot.execute("glass orchard", context);
      expect(context.calls).toHaveLength(2);
    }
  });

  test("the daily limit stops requests, is kept on disk, and starts again at UTC midnight", async () => {
    const file = join(tempFolder(), "hardcover", "usage.json");
    let now = Date.UTC(2026, 0, 1, 23, 59, 0);
    const build = () => {
      const slot = make({ apiToken: TOKEN, dailyRequestLimit: "1" });
      slot.now = () => now;
      slot.budget = new Budget({ file, cap: 1, now: () => now });
      return slot;
    };
    const first = build();
    const context = makeContext();
    expect((await first.execute("glass orchard", context)).title).toBe("The Glass Orchard");
    expect(context.calls).toHaveLength(1);
    expect(first.trigger("salt orchard")).toBe(false);
    context.calls.length = 0;
    expect(await first.execute("salt orchard", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
    expect(build().trigger("salt orchard")).toBe(false);
    now = Date.UTC(2026, 0, 2, 0, 0, 30);
    const restarted = build();
    expect(restarted.trigger("salt orchard")).toBe(true);
    expect(restarted.budget.used).toBe(0);
    expect((await restarted.execute("salt orchard", makeContext())).title).toBe("The Salt Orchard");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ day: "2026-01-02", used: 1 });
  });

  test("running out of requests between the check and the request pauses for at most an hour with one warning", async () => {
    const slot = make({ apiToken: TOKEN, dailyRequestLimit: "1" });
    slot.budget = new Budget({ file: "", cap: 1, now: () => slot.now() });
    slot.budget.spend();
    const context = makeContext();
    let result;
    const lines = await capture(async () => {
      result = await slot._query("glass orchard", context, slot.now() + 60_000);
    });
    expect(result).toBeNull();
    expect(context.calls).toHaveLength(0);
    expect(slot.paused).toBe(true);
    expect(slot._pausedUntil - slot.now()).toBeLessThanOrEqual(3_600_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the daily Hardcover request limit is reached");
    expect(slot.trigger("salt orchard")).toBe(false);
    const unlimited = make({ apiToken: TOKEN, dailyRequestLimit: "0" });
    const unlimitedContext = makeContext();
    for (const query of ["glass orchard", "salt orchard", "quiet rivers"]) await unlimited.execute(query, unlimitedContext);
    expect(unlimited.budget.exhausted).toBe(false);
    expect(unlimited.budget.used).toBe(3);
  });

  test("requests keep a second apart, and are skipped when the wait does not fit in the slot time", async () => {
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
    await slot.execute("glass orchard", context);
    await slot.execute("salt orchard", context);
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
    expect((await tight.execute("glass orchard", tightContext)).title).toBe("The Glass Orchard");
    expect(await tight.execute("quiet rivers", tightContext)).toEqual(EMPTY);
    expect(tightContext.calls).toHaveLength(1);
    expect(tight.paused).toBe(false);
    expect(tight.budget.used).toBe(1);
  });

  test("simultaneous requests are serialised, identical ones share a single request", async () => {
    const slot = make();
    slot.spacingMs = 60;
    slot.startWindowMs = 10_000;
    const context = makeContext();
    await Promise.all([slot.execute("glass orchard", context), slot.execute("salt orchard", context), slot.execute("quiet rivers", context)]);
    expect(context.calls).toHaveLength(3);
    for (let i = 1; i < context.calls.length; i += 1) expect(context.calls[i].at - context.calls[i - 1].at).toBeGreaterThanOrEqual(55);
    const shared = make();
    const sharedContext = makeContext();
    const outs = await Promise.all([shared.execute("glass orchard", sharedContext), shared.execute("glass orchard", sharedContext), shared.execute("Glass Orchard novel", sharedContext)]);
    expect(outs.every((out) => out.title === "The Glass Orchard")).toBe(true);
    expect(sharedContext.calls).toHaveLength(1);
  });

  test("uses degoog's cache with the documented namespace and lifetime", async () => {
    const slot = make();
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
    await slot.execute("glass orchard", context);
    expect(Object.keys(stores)).toEqual(["ext:books:search"]);
    expect(lifetimes).toEqual({ "ext:books:search": 24 * 3_600_000 });
    expect([...stores["ext:books:search"].keys()]).toEqual(["glass orchard"]);
    expect(stores["ext:books:search"].get("glass orchard").books).toHaveLength(6);
    expect(base.calls).toHaveLength(1);
    await slot.execute("glass orchard", context);
    expect(base.calls).toHaveLength(1);
  });
});

describe("secrets", () => {
  test("the token never reaches a log line, the html, a request address or a body", async () => {
    const scenarios = [
      makeContext(),
      makeContext({ respond: () => Response.json({ error: `denied ${TOKEN}` }, { status: 401 }) }),
      makeContext({ respond: () => Response.json({ error: "insufficient_scope", scope: TOKEN }, { status: 403 }) }),
      makeContext({ respond: () => new Response(`slow ${TOKEN}`, { status: 429 }) }),
      makeContext({ reply: { errors: [{ message: TOKEN }] } }),
      { ...makeContext(), fetch: async (url) => { throw new Error(`down ${url} ${TOKEN}`); } },
    ];
    const everything = [];
    for (const context of scenarios) {
      const slot = make();
      const lines = await capture(async () => {
        const out = await slot.execute("glass orchard", context);
        everything.push(out.html, out.title);
      });
      everything.push(...lines);
      for (const call of context.calls ?? []) everything.push(call.url, String(call.init.body ?? ""));
    }
    expect(everything.join("\n")).not.toContain(TOKEN);
  });

  test("the token only ever appears in the authorization header", async () => {
    const slot = make();
    const context = makeContext();
    await slot.execute("glass orchard", context);
    for (const call of context.calls) {
      const { authorization, ...others } = call.init.headers;
      expect(authorization).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(others)).not.toContain(TOKEN);
      expect(call.url).not.toContain(TOKEN);
      expect(String(call.init.body)).not.toContain(TOKEN);
    }
  });
});

// --- Decision quality: regression tests (invented titles, shaped like the real "popular series, book 1" case) ---

// A Hardcover document for an invented series "Cellar Delver Ned" by an invented author.
const delver = (extra = {}) =>
  compactBook({
    id: 7100001,
    title: "Cellar Delver Ned",
    author_names: ["Pip Hollow"],
    release_year: 2020,
    pages: 440,
    users_count: 60_000,
    users_read_count: 30_000,
    ratings_count: 40_000,
    featured_series: { series: { name: "Cellar Delver Ned" }, position: 1 },
    featured_series_position: 1,
    series_names: ["Cellar Delver Ned"],
    ...extra,
  });
const pickIds = (query, books) => pickBook(parseQuery(query), books)?.id ?? null;

describe("specificity bands and suffix normalisation", () => {
  test("one short word is low, one long word or two words medium, three words or 14+ characters high", () => {
    expect(specificity("dune")).toBe("low");
    expect(specificity("carl")).toBe("low");
    expect(specificity("root")).toBe("low");
    expect(specificity("wingspan")).toBe("medium");
    expect(specificity("the road")).toBe("medium");
    expect(specificity("gone girl")).toBe("medium");
    expect(specificity("project hail mary")).toBe("high");
    expect(specificity("cellar delver ned")).toBe("high");
    expect(specificity("extraordinarily")).toBe("high");
    expect(specificity("Dune (Dune, #1)")).toBe("low");
    expect(specificity("")).toBe("low");
  });

  test("series markers and edition marks are ignored on both sides", () => {
    expect(stripDecorations("Cellar Delver Ned (Cellar Delver Ned, #1)")).toBe("Cellar Delver Ned");
    expect(stripDecorations("Dune: A Novel")).toBe("Dune");
    expect(stripDecorations("Title, Book One")).toBe("Title");
    expect(stripDecorations("Title #1")).toBe("Title");
    expect(stripDecorations("Title #3")).toBe("Title #3"); // another book of the series is not the bare title
    expect(stripDecorations("Title (Special Edition)")).toBe("Title");
    expect(stripDecorations("Title: Anniversary Edition")).toBe("Title");
    expect(stripDecorations("Title Remastered")).toBe("Title");
    expect(stripDecorations("(Just Brackets)")).toBe("(Just Brackets)");
    expect(stripDecorations("")).toBe("");
    expect(titleSimilarity("cellar delver ned", "Cellar Delver Ned (Cellar Delver Ned, #1)")).toBe(1);
    expect(titleSimilarity("cellar delver ned (book 1)", "Cellar Delver Ned")).toBe(1);
    expect(titleSimilarity("dune a novel", "Dune")).toBe(1);
    expect(titleSimilarity("dune deluxe edition", "Dune")).toBe(1);
    expect(titleSimilarity("dune", "Dune (Deluxe Edition)")).toBe(1);
  });

  test("the numeral rule still holds after stripping", () => {
    expect(titleSimilarity("dune 2", "Dune")).toBeLessThan(0.9);
    expect(titleSimilarity("dune #2", "Dune")).toBeLessThan(0.9);
    expect(titleSimilarity("cellar delver ned 2", "Cellar Delver Ned")).toBeLessThan(0.9);
  });

  test("specificity lowers the popularity needed for an exact title", () => {
    expect(BARS.exact.high).toBeLessThan(BARS.exact.medium);
    expect(BARS.exact.medium).toBeLessThan(BARS.exact.low);
    expect(isConfident(1, BARS.exact.high, false, "high")).toBe(true);
    expect(isConfident(1, BARS.exact.high - 1, false, "high")).toBe(false);
    expect(isConfident(1, BARS.exact.medium, false, "medium")).toBe(true);
    expect(isConfident(1, BARS.exact.medium - 1, false, "medium")).toBe(false);
    expect(isConfident(1, BARS.exact.low, false, "low")).toBe(true);
    expect(isConfident(1, BARS.exact.low - 1, false, "low")).toBe(false);
    expect(judge({ sim: 1, pop: 1, intent: false, band: "low" }).rule).toBe("needs pop>=1000, has 1");
  });

  test("the first result that matches closely needs half the popularity, never a non-matching one", () => {
    expect(judge({ sim: 1, pop: 500, intent: false, band: "low", rank: 0 }).accepted).toBe(true);
    expect(judge({ sim: 1, pop: 500, intent: false, band: "low", rank: 1 }).accepted).toBe(false);
    expect(judge({ sim: 1, pop: 499, intent: false, band: "low", rank: 0 }).accepted).toBe(false);
    expect(judge({ sim: 0.5, pop: 99999, intent: false, band: "low", rank: 0 }).accepted).toBe(false);
    expect(judge({ sim: 0.85, pop: 99999, intent: false, band: "high", rank: 0 }).accepted).toBe(false);
  });
});

describe("a popular series, typed without a keyword (the 'dungeon crawler carl' case)", () => {
  const QUERIES = ["cellar delver ned", "cellar delver ned books", "cellar delver ned novel", "cellar delver ned series"];

  test("A: the plain title shows, with and without a book word", () => {
    for (const query of QUERIES) expect(pickIds(query, [delver()])).toBe("7100001");
  });

  test("B: a '(Series, #1)' title suffix does not hide it", () => {
    const books = [delver({ title: "Cellar Delver Ned (Cellar Delver Ned, #1)" })];
    for (const query of QUERIES) expect(pickIds(query, books)).toBe("7100001");
  });

  test("C: a subtitle variant shows", () => {
    const books = [delver({ title: "Cellar Delver Ned: A LitRPG Adventure" })];
    for (const query of QUERIES) expect(pickIds(query, books)).toBe("7100001");
  });

  test("D: a missing users_count does not hide a book that the other signals show to be popular", () => {
    const books = [delver({ users_count: undefined })];
    expect(books[0].saved).toBe(0);
    for (const query of QUERIES) expect(pickIds(query, books)).toBe("7100001");
    const onlyLists = [delver({ users_count: null, users_read_count: null, ratings_count: null, reviews_count: null, lists_count: 5000 })];
    expect(pickIds("cellar delver ned", onlyLists)).toBe("7100001");
  });

  test("E: a small users_count gives the same answer with and without a book word", () => {
    const books = [delver({ users_count: 12, users_read_count: 4, ratings_count: 3, lists_count: 1, reviews_count: 0 })];
    // A distinctive three-word title only needs a minimal signal; the keyword makes no difference any more.
    expect(pickIds("cellar delver ned", books)).toBe("7100001");
    expect(pickIds("cellar delver ned books", books)).toBe("7100001");
  });

  test("F: an audiobook edition listed first does not stop the book", () => {
    const audio = delver({ id: 7100009, pages: 0, audio_seconds: 90_000, has_audiobook: true });
    expect(pickIds("cellar delver ned", [audio, delver()])).toBe("7100001");
  });

  test("G: a box set listed first does not stop the book", () => {
    const box = delver({ id: 7100008, title: "Cellar Delver Ned Boxed Set: Books 1-3", compilation: true });
    expect(pickIds("cellar delver ned", [box, delver()])).toBe("7100001");
  });

  test("H: only later books returned: the series name picks book 1 (or the lowest position that came back)", () => {
    const two = delver({ id: 7100002, title: "The Flooded Stairwell", featured_series: { series: { name: "Cellar Delver Ned" }, position: 2 }, featured_series_position: 2 });
    const three = delver({ id: 7100003, title: "Ned and the Lantern Crown", featured_series: { series: { name: "Cellar Delver Ned" }, position: 3 }, featured_series_position: 3 });
    expect(pickIds("cellar delver ned", [three, two])).toBe("7100002");
    const one = delver({ id: 7100001, title: "The Collapsed Larder", featured_series: { series: { name: "Cellar Delver Ned" }, position: 1 }, featured_series_position: 1 });
    expect(pickIds("cellar delver ned", [three, one, two])).toBe("7100001");
    expect(pickIds("cellar delver ned series", [three, one, two])).toBe("7100001");
  });

  test("series-name queries never pick a compilation or an audiobook-only entry while a real book exists", () => {
    const box = delver({ id: 1, title: "The Collapsed Larder Box Set", compilation: true, featured_series_position: 1 });
    const audio = delver({ id: 2, title: "The Collapsed Larder (Audiobook)", pages: 0, audio_seconds: 3600, featured_series_position: 1 });
    const text = delver({ id: 3, title: "The Collapsed Larder", featured_series: { series: { name: "Cellar Delver Ned" }, position: 1 } });
    expect(pickIds("cellar delver ned", [box, audio, text])).toBe("3");
  });

  test("the series name must equal the query: partial overlaps and generic words never match", () => {
    const books = [delver({ title: "The Collapsed Larder" })];
    for (const query of ["ned", "delver", "cellar", "carl", "cellar ned", "delver ned"]) expect(pickIds(query, books)).toBeNull();
    expect(pickIds("cellar delver", books)).toBeNull();
    // a one-word series name is low specificity: it needs a lot of popularity
    const oneWord = delver({ title: "The Collapsed Larder", featured_series: { series: { name: "Ned" }, position: 1 }, series_names: ["Ned"], users_count: 30, users_read_count: 10, ratings_count: 10 });
    expect(pickIds("ned", [oneWord])).toBeNull();
  });

  test("a series entry with no position at all is still found when it is the only candidate", () => {
    const loose = delver({ title: "Odd Name Entirely", featured_series_position: undefined, featured_series: { series: { name: "Cellar Delver Ned" } } });
    expect(loose.seriesPosition).toBe(0);
    expect(pickIds("cellar delver ned", [loose])).toBe("7100001");
  });

  test("the series name is shown as a fact, once, and escaped", () => {
    const html = buildPanel({ book: delver() });
    expect(html).toContain("<dt>Series</dt><dd>Cellar Delver Ned</dd>");
    expect(buildPanel({ book: delver({ featured_series: undefined, series_names: undefined }) })).not.toContain("<dt>Series</dt>");
    expect(buildPanel({ book: { ...delver(), seriesName: '<img src=x onerror="1">' } })).not.toContain("<img src=x");
  });
});

describe("generic words stay quiet", () => {
  test("'weather', 'root', 'risk', 'carl' and 'dune'-like words need real popularity", () => {
    expect(looksLikeATitleSearch("weather")).toBe(false);
    expect(looksLikeATitleSearch("weather today")).toBe(false);
    const modest = (title) => compactBook({ id: 5, title, author_names: ["X Y"], users_count: 150, ratings_count: 60, users_read_count: 80, release_year: 2001 });
    for (const word of ["root", "risk", "carl", "dune", "ring"]) {
      expect(pickIds(word, [modest(word[0].toUpperCase() + word.slice(1))])).toBeNull();
    }
    const huge = compactBook({ id: 6, title: "Dune", author_names: ["F H"], users_count: 90_000, ratings_count: 50_000, users_read_count: 60_000, release_year: 1965 });
    expect(pickIds("dune", [huge])).toBe("6");
  });

  test("a one-word query never picks a book that merely contains the word, or a series that contains it", () => {
    const books = [delver(), delver({ id: 2, title: "Carl's Long Walk Home" })];
    expect(pickIds("carl", books)).toBeNull();
    expect(pickIds("ned", books)).toBeNull();
    expect(pickIds("delver", books)).toBeNull();
  });

  test("an alternative title only counts a little for a short query", () => {
    const books = [delver({ title: "Something Else Entirely", alternative_titles: ["Carl"] })];
    expect(scoreBook(parseQuery("carl"), books[0], "low").sim).toBeLessThanOrEqual(0.85);
    expect(pickIds("carl", books)).toBeNull();
  });
});

describe("popularity signals", () => {
  test("a missing, null or non-numeric signal never zeroes the others", () => {
    for (const bad of [undefined, null, "", "x", NaN, -5, {}, []]) {
      expect(popularity({ saved: bad, readers: 100 })).toBe(100);
      expect(popularity({ saved: 100, readers: bad, ratingsCount: bad, listsCount: bad, reviewsCount: bad })).toBe(100);
    }
    expect(popularity({})).toBe(0);
    expect(popularity(undefined)).toBe(0);
  });

  test("documents with every popularity field as strings, nulls or missing", () => {
    const strings = compactBook({ id: "5", title: "T", users_count: "1200", ratings_count: "300", lists_count: "20", reviews_count: "9", users_read_count: "800" });
    expect([strings.saved, strings.ratingsCount, strings.listsCount, strings.reviewsCount, strings.readers]).toEqual([1200, 300, 20, 9, 800]);
    expect(popularity(strings)).toBe(1200);
    const nulls = compactBook({ id: "5", title: "T", users_count: null, ratings_count: null, lists_count: null });
    expect(popularity(nulls)).toBe(0);
  });
});

describe("explaining decisions (debugMatching)", () => {
  test("formatExplanation lists candidates with signals, verdicts and the outcome, on separate lines", () => {
    const books = [delver({ users_count: 12, users_read_count: 4, ratings_count: 3, lists_count: 1 }), compactBook({ id: 2, title: "Other Tale", users_count: 5 })];
    const query = parseQuery("cellar delver ned");
    const text = formatExplanation("cellar delver ned", query, evaluate(query, books, { explain: true }));
    const lines = text.split("\n");
    expect(lines[0]).toBe('[books] "cellar delver ned" term="cellar delver ned" intent=false specificity=high source=hardcover');
    expect(lines[1]).toMatch(/^ {2}#1 "Cellar Delver Ned" sim=1\.00 signals\[.*saved=12.*\] pop=12 -> accepted by exact title, high specificity/);
    expect(lines[2]).toMatch(/^ {2}#2 "Other Tale" sim=0\.\d\d .* -> rejected: /);
    expect(lines.at(-1)).toMatch(/^ {2}=> panel: "Cellar Delver Ned" \(/);
  });

  test("a rejection says what is missing, and 'no panel' closes the block", () => {
    const query = parseQuery("dune");
    const text = formatExplanation("dune", query, evaluate(query, [book("Dune", 12)], { explain: true }));
    expect(text).toContain("rejected: needs pop>=500 (first result), has 12");
    expect(text.split("\n").at(-1)).toMatch(/^ {2}=> no panel/);
    const none = formatExplanation("zzz", parseQuery("zzz"), evaluate(parseQuery("zzz"), [], { explain: true }));
    expect(none).toContain("(no candidates)");
  });

  test("at most six candidates, one line each, even with hostile titles", () => {
    const many = Array.from({ length: 8 }, (_, i) => book(`Title ${i}\n[injected] ${"x".repeat(300)}`, 5, { id: String(i + 1) }));
    const query = parseQuery("title");
    const lines = formatExplanation("ti\ntle", query, evaluate(query, many, { explain: true })).split("\n");
    expect(lines.filter((line) => line.startsWith("  #"))).toHaveLength(6);
    expect(lines.every((line) => !line.startsWith("[injected]"))).toBe(true);
    expect(lines).toHaveLength(8);
  });

  test("the slot logs the block only when debugMatching is on, and never the token", async () => {
    const off = make({ apiToken: TOKEN });
    expect((await capture(() => off.execute("glass orchard", makeContext()))).length).toBe(0);
    const on = make({ apiToken: TOKEN, debugMatching: "true" });
    const lines = await capture(() => on.execute("glass orchard", makeContext()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('[books] "glass orchard" term="glass orchard"');
    expect(lines[0]).toContain("=> panel:");
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain("http");
  });

  test("a title-like query the gating rejects gets one line naming the rule, only in debug mode", async () => {
    const on = make({ apiToken: TOKEN, debugMatching: true });
    const lines = await capture(async () => {
      expect(on.trigger("skyrim walkthrough")).toBe(false);
      expect(on.trigger("how to bake bread")).toBe(false);
    });
    expect(lines).toEqual(['[books] "skyrim walkthrough" skipped: the query has a video game or board game word and no book word']);
    const off = make({ apiToken: TOKEN });
    expect(await capture(async () => expect(off.trigger("skyrim walkthrough")).toBe(false))).toEqual([]);
    const strict = make({ apiToken: TOKEN, debugMatching: true, requireBookWord: true });
    expect(await capture(async () => expect(strict.trigger("glass orchard")).toBe(false))).toHaveLength(1);
  });

  test("the setting is advanced, off by default, and in its own fieldset", () => {
    const field = SETTINGS_SCHEMA.find((entry) => entry.key === "debugMatching");
    expect(field).toMatchObject({ type: "toggle", default: "false", advanced: true });
    expect(field.required).toBeUndefined();
    expect(field.fieldset).toBeTruthy();
  });
});
