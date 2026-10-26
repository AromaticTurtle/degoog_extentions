import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Budget } from "../plugins/rawg/budget.js";
import { buildDetailUrl, buildHeaders, buildSearchUrl, rawgGamePage, resizedImage, retryAfterMs } from "../plugins/rawg/request.js";
import { cacheKey, extractTerm, hasGameWord, isConfidentMatch, looksLikeATitleSearch, pickGame, titleSimilarity } from "../plugins/rawg/match.js";
import { cleanDescription, compactDetail, compactSearchResult } from "../plugins/rawg/shape.js";
import { buildPanel, esc, formatDate, safeUrl, splitDescription } from "../plugins/rawg/render.js";
import { RawgSlot, slot as defaultSlot } from "../plugins/rawg/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const searchFixture = await read("./fixtures/rawg-search.json").json();
const detailFixture = await read("./fixtures/rawg-detail.json").json();
const KEY = "secret-rawg-key-123";
const folders = [];
afterEach(() => {
  while (folders.length) rmSync(folders.pop(), { recursive: true, force: true });
});

const makeContext = ({ search = searchFixture, detail = detailFixture, status = 200 } = {}) => {
  const calls = [];
  return {
    calls,
    signProxyUrl: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (status !== 200) return new Response("no", { status, headers: { "retry-after": "30" } });
      const body = new URL(url).pathname.endsWith("/games") ? search : detail;
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
};

const make = (settings = { apiKey: KEY }) => {
  const slot = new RawgSlot();
  slot.budget = new Budget({ file: "", cap: 1000 });
  slot.apiBase = "https://api.test";
  slot.configure(settings);
  return slot;
};

describe("request building", () => {
  test("search asks for a few precise results", () => {
    const url = new URL(buildSearchUrl("elden ring", KEY, "https://api.test/"));
    expect(url.origin + url.pathname).toBe("https://api.test/games");
    expect(url.searchParams.get("search")).toBe("elden ring");
    expect(url.searchParams.get("search_precise")).toBe("true");
    expect(url.searchParams.get("page_size")).toBe("5");
    expect(url.searchParams.get("key")).toBe(KEY);
  });

  test("detail url encodes the id and carries the key", () => {
    expect(buildDetailUrl(326243, KEY, "https://api.test")).toBe(`https://api.test/games/326243?key=${KEY}`);
    expect(buildDetailUrl("../x", KEY, "https://api.test")).toContain("/games/..%2Fx?");
  });

  test("headers carry an app name and never the key", () => {
    const headers = buildHeaders();
    expect(headers["User-Agent"]).toContain("degoog-rawg-slot");
    expect(JSON.stringify(headers)).not.toContain(KEY);
  });

  test("cover images use RAWG's crop path, other urls are left alone", () => {
    expect(resizedImage("https://media.rawg.io/media/games/456/abc.jpg")).toBe("https://media.rawg.io/media/crop/600/400/games/456/abc.jpg");
    expect(resizedImage("https://media.rawg.io/media/crop/600/400/games/456/abc.jpg")).toBe("https://media.rawg.io/media/crop/600/400/games/456/abc.jpg");
    expect(resizedImage("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
    expect(resizedImage(null)).toBe("");
  });

  test("game page link and retry-after parsing", () => {
    expect(rawgGamePage("elden-ring")).toBe("https://rawg.io/games/elden-ring");
    expect(rawgGamePage("")).toBe("");
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("999999")).toBe(3_600_000);
    expect(retryAfterMs(undefined)).toBe(600_000);
  });
});

describe("query gating", () => {
  test("short title-like queries pass, questions and addresses do not", () => {
    for (const query of ["elden ring", "Hades", "elden ring walkthrough", "the legend of zelda breath of the wild"]) {
      expect(looksLikeATitleSearch(query)).toBe(true);
    }
    for (const query of ["", "a", "how to beat malenia", "what is a roguelike", "https://store.steampowered.com", "example.com", "2 + 2", "x ".repeat(40), "one two three four five six seven eight nine"]) {
      expect(looksLikeATitleSearch(query)).toBe(false);
    }
  });

  test("only trailing game words are removed from the title", () => {
    expect(extractTerm("elden ring game")).toBe("elden ring");
    expect(extractTerm("elden ring ps5 review")).toBe("elden ring");
    expect(extractTerm("Dark Souls III system requirements")).toBe("Dark Souls III");
    expect(extractTerm("game dev tycoon")).toBe("game dev tycoon");
    expect(extractTerm("hades")).toBe("hades");
  });

  test("game words are recognised", () => {
    expect(hasGameWord("elden ring walkthrough")).toBe(true);
    expect(hasGameWord("steam deck games")).toBe(true);
    expect(hasGameWord("elden ring")).toBe(false);
  });

  test("the cache key ignores case, accents, punctuation and a leading 'the'", () => {
    expect(cacheKey("The Witcher 3: Wild Hunt")).toBe(cacheKey("witcher 3 wild hunt"));
    expect(cacheKey("Pokémon")).toBe(cacheKey("pokemon"));
  });
});

describe("title matching", () => {
  test("similarity", () => {
    expect(titleSimilarity("elden ring", "Elden Ring")).toBe(1);
    expect(titleSimilarity("doom", "DOOM (2016)")).toBe(1);
    expect(titleSimilarity("elden ring", "Elden Ring: Shadow of the Erdtree")).toBe(0.9);
    expect(titleSimilarity("zelda breath of the wild", "The Legend of Zelda: Breath of the Wild")).toBe(0.8);
    expect(titleSimilarity("cats", "Dogs")).toBe(0);
    expect(titleSimilarity("hades 2", "Hades")).toBe(0.5);
    expect(titleSimilarity("final fantasy vii", "Final Fantasy")).toBe(0.5);
    expect(titleSimilarity("hades game", "Hades")).toBe(0.9);
  });

  test("an exact title needs some popularity, an unknown fan game does not qualify", () => {
    expect(isConfidentMatch("elden ring", { name: "Elden Ring", added: 15800 }, false)).toBe(true);
    expect(isConfidentMatch("elden ring", { name: "Elden Ring", added: 2 }, false)).toBe(false);
    expect(isConfidentMatch("elden ring", { name: "Elden Ring", added: 2 }, true)).toBe(true);
  });

  test("picks the closest title, then the most added", () => {
    const results = searchFixture.results.map(compactSearchResult);
    expect(pickGame("elden ring", results, false).id).toBe(326243);
    const twins = [
      { id: 1, name: "Hades", added: 100 },
      { id: 2, name: "Hades", added: 9000 },
    ];
    expect(pickGame("hades", twins, false).id).toBe(2);
    expect(pickGame("zzz", results, false)).toBeNull();
    expect(pickGame("elden ring nightreign", results, false).id).toBe(997548);
    expect(pickGame("elden ring shadow of the erdtree", results, false).id).toBe(977470);
    // The exact "Elden Ring Test" entry has no players, so the real game is shown instead of the junk one.
    expect(pickGame("elden ring test", results, false).id).toBe(326243);
    expect(pickGame("elden ring build", results, false).id).toBe(326243);
    expect(pickGame("elden ring", [], false)).toBeNull();
    expect(pickGame("elden ring", null, false)).toBeNull();
  });

  test("a generic one-word query does not trigger on a loosely similar game", () => {
    expect(pickGame("ring", searchFixture.results.map(compactSearchResult), false)).toBeNull();
  });
});

describe("shaping RAWG data", () => {
  const game = compactSearchResult(searchFixture.results[0]);
  const detail = compactDetail(detailFixture);

  test("search result keeps only used fields", () => {
    expect(game).toMatchObject({ id: 326243, slug: "elden-ring", name: "Elden Ring", released: "2022-02-25", metacritic: 95, esrb: "Mature" });
    expect(game.added).toBeGreaterThan(1000);
    expect(game.ratingsCount).toBeGreaterThan(100);
    expect(game.playtime).toBeGreaterThan(0);
    expect(game.rating).toBeGreaterThan(4);
    expect(game.platforms).toEqual(["PC", "PlayStation", "Xbox"]);
    expect(game.genres).toEqual(["Action", "RPG"]);
    expect(game.stores).toContain("Steam");
    expect(game.image).toStartWith("https://media.rawg.io/media/games/");
  });

  test("missing and null fields become empty values, not errors", () => {
    const bare = compactSearchResult({ id: 1, name: "X", released: null, background_image: null, metacritic: null, esrb_rating: null, parent_platforms: [], genres: [], stores: [] });
    expect(bare).toMatchObject({ metacritic: 0, image: "", released: "", esrb: "", platforms: [], genres: [], stores: [] });
    expect(compactSearchResult(searchFixture.results[1]).metacritic).toBe(0);
    expect(compactSearchResult(null).name).toBe("");
    expect(compactDetail(undefined).developers).toEqual([]);
  });

  test("falls back to individual platforms when there are no families", () => {
    expect(compactSearchResult({ platforms: [{ platform: { name: "Dreamcast" } }] }).platforms).toEqual(["Dreamcast"]);
  });

  test("detail keeps description, people and links", () => {
    expect(detail.developers).toEqual(["FromSoftware"]);
    expect(detail.publishers).toContain("Bandai Namco Entertainment");
    expect(detail.website).toStartWith("https://");
    expect(detail.reddit).toBe("https://www.reddit.com/r/Eldenring/");
    expect(detail.description).toStartWith("The Golden Order has been broken.");
    expect(detail.playtime).toBeGreaterThan(0);
  });

  test("a Spanish copy after an Español line is cut, and long text is capped", () => {
    expect(cleanDescription("English text.\nEspañol\nTexto en español.")).toBe("English text.");
    expect(cleanDescription("Only English.\n\nSecond paragraph.")).toBe("Only English.\n\nSecond paragraph.");
    expect(cleanDescription(null)).toBe("");
    expect(cleanDescription("x".repeat(5000))).toHaveLength(1800);
  });
});

describe("rendering", () => {
  const game = compactSearchResult(searchFixture.results[0]);
  const detail = compactDetail(detailFixture);
  const signProxy = (url) => `/proxy?u=${encodeURIComponent(url)}`;

  test("shows the facts, the scores and a signed, resized cover", () => {
    const html = buildPanel({ game, detail, signProxy, locale: "en-US" });
    expect(html).toContain("Elden Ring");
    expect(html).toContain("Video game · 2022");
    expect(html).toContain("rawg-score--good");
    expect(html).toContain(">95<");
    expect(html).toContain("4.4");
    expect(html).toContain("Mature");
    expect(html).toContain("Feb 25, 2022");
    expect(html).toContain("FromSoftware");
    expect(html).toContain("Bandai Namco Entertainment");
    expect(html).toContain("about 62 h");
    expect(html).toContain("Read more");
    expect(html).toContain(encodeURIComponent("https://media.rawg.io/media/crop/600/400/games/b29/"));
    expect(html).not.toContain('src="https://media.rawg.io');
  });

  test("always carries a working RAWG backlink, even with minimal data", () => {
    const minimal = buildPanel({ game: compactSearchResult({ id: 1, slug: "x", name: "X" }), detail: null, signProxy: null });
    expect(minimal).toContain('<a href="https://rawg.io/" target="_blank" rel="noopener">RAWG</a>');
    expect(minimal).toContain("https://rawg.io/games/x");
    expect(minimal).not.toContain("<img");
    expect(minimal).not.toContain("rawg-facts");
  });

  test("escapes every text field", () => {
    const evil = compactSearchResult({ id: 1, slug: "a", name: '<img src=x onerror=alert(1)>"', genres: [{ name: "<b>g</b>" }], background_image: 'https://media.rawg.io/media/games/a/b.jpg"onload="x' });
    const html = buildPanel({ game: evil, detail: { description: "<script>alert(1)</script>", developers: ["<i>dev</i>"], publishers: [], website: "javascript:alert(1)", reddit: "" }, signProxy });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>g");
    expect(html).not.toContain("<i>dev");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('"onload=');
    expect(esc('<&>"\'')).toBe("&lt;&amp;&gt;&quot;&#39;");
    expect(esc(undefined)).toBe("");
  });

  test("score colours follow the Metacritic bands", () => {
    const html = (metacritic) => buildPanel({ game: { ...game, metacritic }, detail: null, signProxy });
    expect(html(80)).toContain("rawg-score--good");
    expect(html(60)).toContain("rawg-score--mixed");
    expect(html(30)).toContain("rawg-score--bad");
    expect(html(0)).not.toContain("Metacritic");
  });

  test("helpers", () => {
    expect(safeUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(safeUrl("ftp://a.example")).toBe("");
    expect(safeUrl("not a url")).toBe("");
    expect(formatDate("2022-02-25", "en-US")).toBe("Feb 25, 2022");
    expect(formatDate("garbage")).toBe("");
    expect(splitDescription("short text")).toEqual({ preview: "short text", rest: "" });
    const long = splitDescription("word ".repeat(200));
    expect(long.preview.endsWith("…")).toBe(true);
    expect(long.preview.length).toBeLessThan(340);
    expect(long.rest.length).toBeGreaterThan(100);
    const paragraphs = splitDescription(`${"First paragraph sentence. ".repeat(8).trim()}\n\n${"Second paragraph sentence. ".repeat(20)}`);
    expect(paragraphs.preview.endsWith("sentence.")).toBe(true);
    expect(paragraphs.preview).not.toContain("Second");
    expect(paragraphs.rest).toStartWith("Second paragraph");
    const sentences = splitDescription("A sentence here. ".repeat(40));
    expect(sentences.preview.endsWith("here.")).toBe(true);
  });
});

describe("monthly request budget", () => {
  const folder = () => {
    const path = mkdtempSync(join(tmpdir(), "rawg-budget-"));
    folders.push(path);
    return join(path, "rawg", "usage.json");
  };

  test("stops at the cap, 0 means no cap", () => {
    const budget = new Budget({ cap: 2 });
    expect([budget.spend(), budget.spend(), budget.spend()]).toEqual([true, true, false]);
    expect(budget.exhausted).toBe(true);
    const unlimited = new Budget({ cap: 0 });
    for (let i = 0; i < 50; i += 1) expect(unlimited.spend()).toBe(true);
  });

  test("the count survives a restart and resets in a new month", () => {
    const file = folder();
    let now = Date.UTC(2026, 9, 26);
    const first = new Budget({ file, cap: 10, now: () => now });
    first.spend();
    first.spend();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ month: "2026-10", used: 2 });
    const second = new Budget({ file, cap: 10, now: () => now });
    second.spend();
    expect(second.used).toBe(3);
    now = Date.UTC(2026, 10, 1);
    expect(second.exhausted).toBe(false);
    second.spend();
    expect(second.used).toBe(1);
  });
});

describe("the slot", () => {
  test("is a valid knowledge panel slot", () => {
    expect(defaultSlot.position).toBe("knowledge-panel");
    expect(defaultSlot.slotPositions).toContain("knowledge-panel");
    expect(defaultSlot.slotPositions).toContain(defaultSlot.position);
    expect(typeof defaultSlot.trigger).toBe("function");
    expect(typeof defaultSlot.execute).toBe("function");
    expect(defaultSlot.isClientExposed).toBe(false);
  });

  test("the key field is a secret and not required, so the environment fallback works", () => {
    const field = defaultSlot.settingsSchema.find((entry) => entry.key === "apiKey");
    expect(field.secret).toBe(true);
    expect(field.type).toBe("password");
    expect(field.required).toBeUndefined();
  });

  test("without a key nothing triggers and nothing is requested", async () => {
    const previous = process.env.RAWG_API_KEY;
    delete process.env.RAWG_API_KEY;
    try {
      const slot = make({});
      const context = makeContext();
      expect(slot.trigger("elden ring")).toBe(false);
      expect(await slot.execute("elden ring", context)).toEqual({ title: "", html: "" });
      expect(context.calls).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.RAWG_API_KEY = previous;
    }
  });

  test("the environment key is used when the setting is empty", () => {
    const previous = process.env.RAWG_API_KEY;
    process.env.RAWG_API_KEY = "env-key";
    try {
      expect(make({}).apiKey).toBe("env-key");
      expect(make({ apiKey: "ui-key" }).apiKey).toBe("ui-key");
    } finally {
      if (previous === undefined) delete process.env.RAWG_API_KEY;
      else process.env.RAWG_API_KEY = previous;
    }
  });

  test("a confident match makes a search then a details request and renders a panel", async () => {
    const slot = make();
    slot.init({ template: '<div class="x">{{content}}</div>' });
    const context = makeContext();
    const out = await slot.execute("elden ring", context);
    expect(out.title).toBe("Elden Ring");
    expect(out.html).toStartWith('<div class="x"><div class="rawg-card">');
    expect(out.html).toContain("FromSoftware");
    expect(context.calls).toHaveLength(2);
    expect(context.calls[0].url).toContain("/games?");
    expect(context.calls[1].url).toContain("/games/326243?");
    expect(JSON.stringify(context.calls.map((call) => call.init))).not.toContain(KEY);
    expect(out.html).not.toContain(KEY);
  });

  test("the same game is then served from cache with no requests", async () => {
    const slot = make();
    const context = makeContext();
    await slot.execute("elden ring", context);
    context.calls.length = 0;
    const again = await slot.execute("Elden  Ring game", context);
    expect(again.title).toBe("Elden Ring");
    expect(context.calls).toHaveLength(0);
  });

  test("a query with no match costs one request, and is remembered", async () => {
    const slot = make();
    const context = makeContext({ search: { results: [] } });
    expect(await slot.execute("zzz nothing", context)).toEqual({ title: "", html: "" });
    expect(context.calls).toHaveLength(1);
    await slot.execute("zzz nothing", context);
    expect(context.calls).toHaveLength(1);
  });

  test("a loose match is rejected without a details request", async () => {
    const slot = make();
    const context = makeContext();
    expect((await slot.execute("ring", context)).html).toBe("");
    expect(context.calls).toHaveLength(1);
  });

  test("details can be switched off, leaving one request", async () => {
    const slot = make({ apiKey: KEY, showDetails: "false" });
    const context = makeContext();
    const out = await slot.execute("elden ring", context);
    expect(out.html).toContain("Elden Ring");
    expect(out.html).not.toContain("FromSoftware");
    expect(context.calls).toHaveLength(1);
  });

  test("requireGameWord blocks plain queries and allows game ones", async () => {
    const slot = make({ apiKey: KEY, requireGameWord: "true" });
    expect(slot.trigger("elden ring")).toBe(false);
    expect(slot.trigger("elden ring game")).toBe(true);
  });

  test("a failed details request still shows the panel", async () => {
    const slot = make();
    let n = 0;
    const context = {
      ...makeContext(),
      fetch: async () => (++n === 1 ? new Response(JSON.stringify(searchFixture)) : new Response("gone", { status: 404 })),
    };
    const out = await slot.execute("elden ring", context);
    expect(out.html).toContain("Elden Ring");
    expect(out.html).toContain("RAWG");
    expect(slot.paused).toBe(false);
  });

  test("429 pauses all further requests for the retry-after time", async () => {
    const slot = make();
    let now = 1_000_000;
    slot.now = () => now;
    const context = makeContext({ status: 429 });
    expect((await slot.execute("elden ring", context)).html).toBe("");
    expect(context.calls).toHaveLength(1);
    expect(slot.paused).toBe(true);
    expect(slot.trigger("hades")).toBe(false);
    now += 29_000;
    expect(slot.paused).toBe(true);
    now += 2_000;
    expect(slot.paused).toBe(false);
  });

  test("a rejected key pauses for 30 minutes without printing the key", async () => {
    const slot = make();
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      await slot.execute("elden ring", makeContext({ status: 401 }));
    } finally {
      console.warn = original;
    }
    expect(slot.paused).toBe(true);
    expect(slot._pausedUntil - slot.now()).toBeGreaterThan(29 * 60_000);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(KEY);
    expect(warnings[0]).not.toContain("http");
  });

  test("network failures and server errors pause briefly and never throw", async () => {
    const slot = make();
    const context = { ...makeContext(), fetch: async () => { throw new Error(`boom https://api.test/games?key=${KEY}`); } };
    const original = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
      expect(await slot.execute("elden ring", context)).toEqual({ title: "", html: "" });
    } finally {
      console.warn = original;
    }
    expect(slot.paused).toBe(true);
    expect(warnings.join("")).not.toContain(KEY);
  });

  test("the monthly cap stops requests", async () => {
    const slot = make({ apiKey: KEY, monthlyBudget: "1" });
    const context = makeContext();
    await slot.execute("elden ring", context);
    expect(context.calls).toHaveLength(1);
    expect(slot.paused).toBe(true);
  });

  test("simultaneous identical searches share one request", async () => {
    const slot = make({ apiKey: KEY, showDetails: "false" });
    const context = makeContext();
    await Promise.all([slot.execute("elden ring", context), slot.execute("elden ring", context), slot.execute("elden ring", context)]);
    expect(context.calls).toHaveLength(1);
  });

  test("uses degoog's cache when it is provided", async () => {
    const slot = make();
    const stores = {};
    const context = {
      ...makeContext(),
      useCache: (name) => {
        stores[name] ??= new Map();
        return {
          get: async (key) => stores[name].get(key) ?? null,
          set: async (key, value) => void stores[name].set(key, value),
        };
      },
    };
    await slot.execute("elden ring", context);
    expect(Object.keys(stores).sort()).toEqual(["ext:rawg:detail", "ext:rawg:search"]);
    expect(context.calls).toHaveLength(2);
    await slot.execute("elden ring", context);
    expect(context.calls).toHaveLength(2);
  });
});
