// Tests for the Openverse image engine. tests/fixtures/openverse-images.json and openverse-token.json are HAND-WRITTEN in the
// documented layout with invented creators, titles and *.example.test addresses; no real response is recorded. The client secret and
// the token in these tests are made-up strings.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Limiter } from "../engines/openverse/limiter.js";
import { Budget } from "../engines/openverse/budget.js";
import { TokenSource } from "../engines/openverse/auth.js";
import { buildHeaders, buildRequest, listOf, redact, tokenBody, tokenHeaders, tokenUrl } from "../engines/openverse/request.js";
import { licenseLabel, parseImages, sourceLabel, totalOf } from "../engines/openverse/parse.js";
import { SETTINGS_SCHEMA } from "../engines/openverse/settings.js";
import OpenverseEngine, { filters, type } from "../engines/openverse/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const fixture = await read("./fixtures/openverse-images.json").json();
const tokenFixture = await read("./fixtures/openverse-token.json").json();
const SECRET = "ov-invented-secret-0123456789";
const ID = "ov-invented-client-id";
const TOKEN = tokenFixture.access_token;

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });
// Answers the token endpoint with the token fixture and everything else with makeResponse
const makeContext = (makeResponse, { token = () => new Response(JSON.stringify(tokenFixture), { status: 200 }) } = {}) => {
  const calls = [];
  return {
    calls,
    searches: () => calls.filter((call) => !call.url.includes("/auth_tokens/")),
    tokenCalls: () => calls.filter((call) => call.url.includes("/auth_tokens/")),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return url.includes("/auth_tokens/") ? token(url, init) : makeResponse(url, init);
    },
    sentinel: (res, name) => {
      if (!res.ok) throw breach(res.status === 429 ? "rate_limited" : "blocked", `${name} ${res.status}`);
    },
    engineError: (status, message) => breach(status, message),
  };
};
const ok = (headers = {}) => () => new Response(JSON.stringify(fixture), { status: 200, headers });
const status = (code, body = "", headers = {}) => () => new Response(body, { status: code, headers });

const capture = async (work) => {
  const lines = [];
  const original = { info: console.info, warn: console.warn, log: console.log, error: console.error };
  for (const level of ["info", "warn", "log", "error"]) console[level] = (...args) => lines.push(args.join(" "));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const make = (settings = {}) => {
  const engine = new OpenverseEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
  engine.budget.file = "";
  engine.apiBase = "https://api.test/v1";
  engine.configure(settings);
  return engine;
};
const registered = { clientId: ID, clientSecret: SECRET };

const withEnv = async (name, value, fn) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
};

describe("shared copies stay identical", () => {
  for (const file of ["text.js", "limiter.js", "budget.js", "cache.js", "timing.js", "author.json"]) {
    test(file, async () => {
      const copies = await Promise.all(["pixabay", "openverse", "pexels"].map((name) => read(`../engines/${name}/${file}`).text()));
      expect(copies[0], file).toBe(copies[1]);
      expect(copies[2], file).toBe(copies[1]);
    });
  }
});

describe("building the request", () => {
  const options = { pageSize: 20, licenseType: "all", category: "any", source: "", extension: "", includeMature: false };
  const params = (opts = {}, page = 1, q = "forest") => new URL(buildRequest(q, page, { ...options, ...opts }, "https://api.openverse.org/v1").url).searchParams;

  test("the documented endpoint and parameters", () => {
    const { url } = buildRequest("forest lake", 1, options, "https://api.openverse.org/v1/");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.openverse.org/v1/images/");
    expect(parsed.searchParams.get("q")).toBe("forest lake");
    expect(parsed.searchParams.get("page_size")).toBe("20");
    expect(parsed.searchParams.get("mature")).toBe("false");
    expect(parsed.searchParams.has("page")).toBe(false);
    expect(parsed.searchParams.has("license_type")).toBe(false);
  });

  test("paging: the page parameter from page 2 on", () => {
    expect(params({}, 1).has("page")).toBe(false);
    expect(params({}, 2).get("page")).toBe("2");
    expect(params({}, 7).get("page")).toBe("7");
  });

  test("licence type and category settings", () => {
    expect(params({ licenseType: "commercial" }).get("license_type")).toBe("commercial");
    expect(params({ licenseType: "modification" }).get("license_type")).toBe("modification");
    expect(params({ licenseType: "all-cc" }).get("license_type")).toBe("all-cc");
    expect(params({ licenseType: "bogus" }).has("license_type")).toBe(false);
    expect(params({ category: "illustration" }).get("category")).toBe("illustration");
    expect(params({ category: "bogus" }).has("category")).toBe(false);
  });

  test("degoog's image filters win over the settings", () => {
    const p = params({ category: "digitized_artwork", imageFilter: { type: "photo", layout: "wide", size: "large" } });
    expect(p.get("category")).toBe("photograph");
    expect(p.get("aspect_ratio")).toBe("wide");
    expect(p.get("size")).toBe("large");
    expect(params({ imageFilter: { type: "clipart" } }).get("category")).toBe("illustration");
    expect(params({ imageFilter: { layout: "square" } }).get("aspect_ratio")).toBe("square");
    expect(params({ imageFilter: { layout: "tall" } }).get("aspect_ratio")).toBe("tall");
  });

  test("source and extension lists are cleaned", () => {
    expect(listOf(" Flickr, wikimedia ;; NASA,flickr ")).toBe("flickr,wikimedia,nasa");
    expect(listOf("jpg png <b>")).toBe("jpg,png");
    expect(listOf("")).toBe("");
    expect(params({ source: "flickr, met", extension: "JPG,png" }).get("source")).toBe("flickr,met");
    expect(params({ extension: "JPG,png" }).get("extension")).toBe("jpg,png");
    expect(params({ source: "" }).has("source")).toBe(false);
  });

  test("mature content: never asked for unless the setting is on AND degoog's safe mode is off", () => {
    expect(params({ includeMature: false }).get("mature")).toBe("false");
    expect(params({ includeMature: true }).get("mature")).toBe("true");
    expect(params({ includeMature: true, imageFilter: { nsfw: "on" } }).get("mature")).toBe("false");
    expect(params({ includeMature: true, imageFilter: { nsfw: "moderate" } }).get("mature")).toBe("false");
    expect(params({ includeMature: true, imageFilter: { nsfw: "off" } }).get("mature")).toBe("true");
    expect(params({ includeMature: false, imageFilter: { nsfw: "off" } }).get("mature")).toBe("false");
  });

  test("the query is cut at 200 characters and stays one parameter", () => {
    expect(params({}, 1, "x".repeat(300)).get("q")).toHaveLength(200);
    expect(params({}, 1, "a&b=c#d").get("q")).toBe("a&b=c#d");
  });

  test("the cache key is stable regardless of option order and differs per page", () => {
    const a = buildRequest("forest", 1, options, "https://api.test/v1").cacheKey;
    const b = buildRequest("forest", 1, { ...options }, "https://api.test/v1").cacheKey;
    expect(a).toBe(b);
    expect(buildRequest("forest", 2, options, "https://api.test/v1").cacheKey).not.toBe(a);
  });

  test("headers: honest User-Agent, a bearer token only when there is one", () => {
    expect(buildHeaders()["User-Agent"]).toBe("degoog-openverse-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)");
    expect(buildHeaders().Authorization).toBeUndefined();
    expect(buildHeaders(TOKEN).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  test("the token request: documented endpoint, form body, no secret in the address", () => {
    expect(tokenUrl("https://api.openverse.org/v1/")).toBe("https://api.openverse.org/v1/auth_tokens/token/");
    const body = new URLSearchParams(tokenBody(ID, SECRET));
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe(ID);
    expect(body.get("client_secret")).toBe(SECRET);
    expect(tokenHeaders()["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenUrl()).not.toContain(SECRET);
  });

  test("filters offered to degoog", () => {
    expect(filters.layout).toEqual(["square", "wide", "tall"]);
    expect(type).toBe("images");
  });
});

describe("licence labels", () => {
  test("known codes", () => {
    expect(licenseLabel("by", "4.0")).toBe("CC BY 4.0");
    expect(licenseLabel("by-sa", "3.0")).toBe("CC BY-SA 3.0");
    expect(licenseLabel("by-nc-nd", "2.0")).toBe("CC BY-NC-ND 2.0");
    expect(licenseLabel("cc0", "1.0")).toBe("CC0 1.0");
    expect(licenseLabel("pdm", "1.0")).toBe("Public Domain Mark 1.0");
  });

  test("missing version, unknown codes and junk", () => {
    expect(licenseLabel("by", undefined)).toBe("CC BY");
    expect(licenseLabel("by", "<b>")).toBe("CC BY");
    expect(licenseLabel("odd", "1")).toBe("CC ODD 1");
    expect(licenseLabel("", "4.0")).toBe("");
    expect(licenseLabel(null, null)).toBe("");
    expect(licenseLabel("<script>", "1.0")).toBe("");
  });

  test("source names", () => {
    expect(sourceLabel({ source: "flickr" })).toBe("Flickr");
    expect(sourceLabel({ provider: "wikimedia" })).toBe("Wikimedia Commons");
    expect(sourceLabel({ source: "something_new" })).toBe("something_new");
    expect(sourceLabel({})).toBe("");
  });
});

describe("parsing the reply", () => {
  const results = parseImages(fixture, "Openverse");

  test("keeps the images with a landing page and an image; drops mature, sensitive and duplicate ones", () => {
    expect(results.map((r) => r.url)).toEqual([
      "https://flickr.example.test/photos/jane/1",
      "https://commons.example.test/wiki/File:Florbit.jpg",
      "https://museum.example.test/object/3",
      "https://flickr.example.test/photos/q/8",
    ]);
  });

  test("the snippet shows licence, creator, source and size", () => {
    expect(results[0].snippet).toBe("CC BY 4.0 · Jane Doe · Flickr · 3000×2000");
    expect(results[1].snippet).toBe("CC0 1.0 · creator unknown · Wikimedia Commons · 1200×800");
    expect(results[2].snippet).toBe("CC BY-NC-SA 2.0 · A Curator · The Met");
  });

  test("the result links to the source page; the image and the thumbnail are kept apart", () => {
    expect(results[0].imageUrl).toBe("https://live.staticflickr.example.test/1/a.jpg");
    expect(results[0].thumbnail).toBe("https://api.openverse.org/v1/images/11111111-1111-4111-8111-111111111111/thumb/");
    // no thumbnail: the image itself
    expect(results[2].thumbnail).toBe("https://museum.example.test/3.jpg");
  });

  test("titles: the title (or the tags) and the licence and creator, which degoog's image preview shows (it does not show the snippet)", () => {
    expect(results[0].title).toBe("Quillfern at dawn — CC BY 4.0 · Jane Doe");
    expect(results[1].title).toBe("florbit, bell, invented — CC0 1.0");
    expect(results[2].title).toBe("By-NC-SA sample — CC BY-NC-SA 2.0 · A Curator");
    const bare = { foreign_landing_url: "https://a.test/1", url: "https://a.test/1.jpg" };
    expect(parseImages({ results: [{ ...bare, creator: "Kim", license: "by", license_version: "4.0" }] }, "O")[0].title).toBe("Openverse image — CC BY 4.0 · Kim");
    expect(parseImages({ results: [bare] }, "O")[0].title).toBe("Openverse image — Openly licensed");
    // a long title is cut, the credit never is
    const long = parseImages({ results: [{ ...bare, title: "word ".repeat(80), creator: "Kim", license: "by", license_version: "4.0" }] }, "O")[0].title;
    expect(long.endsWith(" — CC BY 4.0 · Kim")).toBe(true);
    expect(long.length).toBeLessThan(150);
  });

  test("markup in text fields is removed and entities are decoded", () => {
    expect(results[3].title).toBe("Markup & entities — Public Domain Mark 1.0 · Q");
    expect(results[3].snippet).toBe("Public Domain Mark 1.0 · Q · NYPL · 640×480");
  });

  test("a missing licence is said, not invented", () => {
    const [r] = parseImages({ results: [{ foreign_landing_url: "https://a.test/1", url: "https://a.test/1.jpg", creator: "Kim" }] }, "O");
    expect(r.snippet).toBe("Openly licensed · Kim");
  });

  test("result shape matches what Unsplash returns", () => {
    for (const r of results) expect(Object.keys(r).sort()).toEqual(["imageUrl", "snippet", "source", "thumbnail", "title", "url"]);
    expect(results.every((r) => r.source === "Openverse")).toBe(true);
  });

  test("non-http addresses are refused", () => {
    expect(parseImages({ results: [{ foreign_landing_url: "javascript:alert(1)", url: "https://a.test/1.jpg" }] }, "O")).toEqual([]);
    expect(parseImages({ results: [{ foreign_landing_url: "https://a.test/1", url: "data:image/png;base64,AAAA" }] }, "O")).toEqual([]);
  });

  test("unexpected layouts", () => {
    expect(parseImages(null, "O")).toBeNull();
    expect(parseImages({}, "O")).toBeNull();
    expect(parseImages({ results: "no" }, "O")).toBeNull();
    expect(parseImages({ results: [] }, "O")).toEqual([]);
    expect(parseImages({ results: [null, 3, "x", {}] }, "O")).toEqual([]);
  });

  test("the total", () => {
    expect(totalOf(fixture)).toBe(10000);
    expect(totalOf({})).toBeUndefined();
    expect(totalOf({ result_count: -1 })).toBeUndefined();
  });
});

describe("the access token", () => {
  const tokenResponse = (body = tokenFixture, init = { status: 200 }) => () => new Response(JSON.stringify(body), init);
  const fetcher = (responder) => {
    const calls = [];
    return { calls, fetch: async (url, init) => (calls.push({ url, init }), responder(url, init)) };
  };

  test("no credentials: no request and no token", async () => {
    const source = new TokenSource({ base: "https://api.test/v1" });
    source.configure("", "");
    const f = fetcher(tokenResponse());
    expect(source.enabled).toBe(false);
    expect(await source.get(f.fetch)).toBe("");
    expect(f.calls).toHaveLength(0);
    source.configure(ID, "");
    expect(source.enabled).toBe(false);
  });

  test("fetched once, then reused", async () => {
    const source = new TokenSource({ base: "https://api.test/v1" });
    source.configure(ID, SECRET);
    const f = fetcher(tokenResponse());
    expect(await source.get(f.fetch)).toBe(TOKEN);
    expect(await source.get(f.fetch)).toBe(TOKEN);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api.test/v1/auth_tokens/token/");
    expect(f.calls[0].init.method).toBe("POST");
    expect(new URLSearchParams(f.calls[0].init.body).get("client_secret")).toBe(SECRET);
    expect(f.calls[0].url).not.toContain(SECRET);
  });

  test("renewed a minute before it expires", async () => {
    let now = 1_000_000;
    const source = new TokenSource({ base: "https://api.test/v1", now: () => now });
    source.configure(ID, SECRET);
    const f = fetcher(tokenResponse({ ...tokenFixture, expires_in: 600 }));
    await source.get(f.fetch);
    now += 8 * 60_000; // 2 minutes left: still fine
    await source.get(f.fetch);
    expect(f.calls).toHaveLength(1);
    now += 90_000; // 30 seconds left: renew
    await source.get(f.fetch);
    expect(f.calls).toHaveLength(2);
  });

  test("a very short or missing lifetime is clamped to something sensible", async () => {
    let now = 5_000_000;
    const source = new TokenSource({ base: "https://api.test/v1", now: () => now });
    source.configure(ID, SECRET);
    await source.get(fetcher(tokenResponse({ ...tokenFixture, expires_in: 1 })).fetch);
    expect(source.expiresAt - now).toBe(120_000);
    source.invalidate();
    await source.get(fetcher(tokenResponse({ access_token: TOKEN })).fetch);
    expect(source.expiresAt - now).toBe(3_600_000);
  });

  test("concurrent callers share one token request", async () => {
    const source = new TokenSource({ base: "https://api.test/v1" });
    source.configure(ID, SECRET);
    const f = fetcher(async () => {
      await Bun.sleep(10);
      return new Response(JSON.stringify(tokenFixture), { status: 200 });
    });
    const tokens = await Promise.all([source.get(f.fetch), source.get(f.fetch), source.get(f.fetch)]);
    expect(tokens).toEqual([TOKEN, TOKEN, TOKEN]);
    expect(f.calls).toHaveLength(1);
  });

  test("every failure means anonymous for ten minutes, then another try", async () => {
    const failures = [
      () => new Response("{}", { status: 401 }),
      () => new Response("<html>", { status: 200 }),
      () => new Response(JSON.stringify({ access_token: "short" }), { status: 200 }),
      () => new Response(JSON.stringify({}), { status: 200 }),
      () => {
        throw new Error("connection reset");
      },
    ];
    for (const failure of failures) {
      let now = 9_000_000;
      const source = new TokenSource({ base: "https://api.test/v1", now: () => now });
      source.configure(ID, SECRET);
      const f = fetcher(failure);
      expect(await source.get(f.fetch)).toBe("");
      expect(source.lastProblem).not.toBe("");
      expect(source.lastProblem).not.toContain(SECRET);
      expect(await source.get(f.fetch)).toBe("");
      expect(f.calls).toHaveLength(1);
      now += 10 * 60_000 + 1;
      expect(await source.get(fetcher(tokenResponse()).fetch)).toBe(TOKEN);
    }
  });

  test("changed credentials drop the old token and the failure memory", async () => {
    const source = new TokenSource({ base: "https://api.test/v1" });
    source.configure(ID, SECRET);
    await source.get(fetcher(tokenResponse()).fetch);
    source.configure(ID, "another-secret-0123456789");
    expect(source.token).toBe("");
    const f = fetcher(tokenResponse());
    await source.get(f.fetch);
    expect(f.calls).toHaveLength(1);
  });
});

describe("the engine", () => {
  test("exports, name and the settings schema", () => {
    const engine = new OpenverseEngine();
    expect(engine.name).toBe("Openverse");
    expect(engine.bangShortcut).toBe("openverse");
    expect(engine.isClientExposed).toBe(false);
    expect(typeof engine.executeSearch).toBe("function");
  });

  test("anonymous search: no Authorization header, results with licence and creator", async () => {
    const engine = make();
    const context = makeContext(ok());
    const results = await engine.executeSearch("quillfern", 1, "any", context);
    expect(results).toHaveLength(4);
    expect(results[0].snippet).toContain("CC BY 4.0 · Jane Doe");
    expect(context.tokenCalls()).toHaveLength(0);
    expect(context.searches()).toHaveLength(1);
    const { url, init } = context.searches()[0];
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.headers["User-Agent"]).toContain("degoog-openverse-engine/1.0");
    expect(new URL(url).searchParams.get("q")).toBe("quillfern");
  });

  test("anonymous page size is at most 20; registered may ask for more", async () => {
    const anonymous = make({ pageSize: "50" });
    const a = makeContext(ok());
    await anonymous.executeSearch("a", 1, "any", a);
    expect(new URL(a.searches()[0].url).searchParams.get("page_size")).toBe("20");

    const signedIn = make({ ...registered, pageSize: "50" });
    const b = makeContext(ok());
    await signedIn.executeSearch("a", 1, "any", b);
    expect(new URL(b.searches()[0].url).searchParams.get("page_size")).toBe("50");
  });

  test("registered: one token request, then the bearer token on every search", async () => {
    const engine = make(registered);
    const context = makeContext(ok());
    await engine.executeSearch("a", 1, "any", context);
    await engine.executeSearch("b", 1, "any", context);
    expect(context.tokenCalls()).toHaveLength(1);
    expect(context.searches()).toHaveLength(2);
    for (const call of context.searches()) expect(call.init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    for (const call of context.calls) expect(call.url).not.toContain(SECRET);
  });

  test("a failing token request falls back to anonymous, quietly, and does not ask again for ten minutes", async () => {
    let now = Date.now();
    const engine = make(registered);
    engine.now = () => now;
    engine.tokens.now = () => now;
    const context = makeContext(ok(), { token: status(401, "{}") });
    const lines = await capture(async () => {
      const first = await engine.executeSearch("a", 1, "any", context);
      expect(first).toHaveLength(4);
      await engine.executeSearch("b", 1, "any", context);
    });
    expect(context.tokenCalls()).toHaveLength(1);
    expect(context.searches()).toHaveLength(2);
    for (const call of context.searches()) expect(call.init.headers.Authorization).toBeUndefined();
    expect(lines.join("\n")).not.toContain(SECRET);
    now += 11 * 60_000;
    await engine.executeSearch("c", 1, "any", context);
    expect(context.tokenCalls()).toHaveLength(2);
  });

  test("environment credentials are used when the settings are empty", async () => {
    await withEnv("OPENVERSE_CLIENT_ID", ID, () =>
      withEnv("OPENVERSE_CLIENT_SECRET", SECRET, async () => {
        const engine = make({});
        expect(engine.tokens.enabled).toBe(true);
        const context = makeContext(ok());
        await engine.executeSearch("a", 1, "any", context);
        expect(context.tokenCalls()).toHaveLength(1);
      }),
    );
    const none = make({});
    expect(none.tokens.enabled).toBe(false);
  });

  test("the API base can be overridden from the environment", async () => {
    await withEnv("DEGOOG_OPENVERSE_API_BASE", "http://mock.test:4470/openverse/v1", async () => {
      const engine = new OpenverseEngine();
      expect(engine.apiBase).toBe("http://mock.test:4470/openverse/v1");
    });
  });

  test("an empty query asks nothing", async () => {
    const engine = make();
    const context = makeContext(ok());
    expect(await engine.executeSearch("   ", 1, "any", context)).toEqual([]);
    expect(context.calls).toHaveLength(0);
  });

  test("paging maps to the page parameter; the total goes to degoog", async () => {
    const engine = make();
    const totals = [];
    const context = makeContext(ok());
    context.pagination = (value) => totals.push(value);
    await engine.executeSearch("a", 3, "any", context);
    expect(new URL(context.searches()[0].url).searchParams.get("page")).toBe("3");
    expect(totals).toEqual([{ total: 10000 }]);
  });

  test("a page beyond what Openverse serves (HTTP 400 with a pagination message) is an empty page", async () => {
    const engine = make();
    const context = makeContext(status(400, JSON.stringify({ detail: "Pagination depth exceeded" })));
    expect(await engine.executeSearch("a", 99, "any", context)).toEqual([]);
    expect(engine.limiter.blockedFor()).toBe(0);
    const other = makeContext(status(400, JSON.stringify({ detail: "bad parameter" })));
    await expect(make().executeSearch("a", 1, "any", other)).rejects.toMatchObject({ status: "network" });
  });

  test("the safe mode of degoog reaches the request", async () => {
    const engine = make({ includeMature: "true" });
    const strict = makeContext(ok());
    await engine.executeSearch("a", 1, "any", Object.assign(strict, { imageFilter: { nsfw: "on" } }));
    expect(new URL(strict.searches()[0].url).searchParams.get("mature")).toBe("false");
    const open = makeContext(ok());
    await engine.executeSearch("b", 1, "any", Object.assign(open, { imageFilter: { nsfw: "off" } }));
    expect(new URL(open.searches()[0].url).searchParams.get("mature")).toBe("true");
    // the default never asks for mature content
    const defaults = make({});
    const context = makeContext(ok());
    await defaults.executeSearch("c", 1, "any", context);
    expect(new URL(context.searches()[0].url).searchParams.get("mature")).toBe("false");
  });

  describe("the cache", () => {
    test("an hour, per search; concurrent searches share one request", async () => {
      let now = Date.now();
      const engine = make();
      engine.cache.now = () => now;
      const context = makeContext(async () => {
        await Bun.sleep(10);
        return new Response(JSON.stringify(fixture), { status: 200 });
      });
      await Promise.all([engine.executeSearch("a", 1, "any", context), engine.executeSearch("a", 1, "any", context)]);
      expect(context.searches()).toHaveLength(1);
      await engine.executeSearch("a", 1, "any", context);
      expect(context.searches()).toHaveLength(1);
      await engine.executeSearch("a", 2, "any", context);
      expect(context.searches()).toHaveLength(2);
    });

    test("a changed setting clears the cache", async () => {
      const engine = make();
      const context = makeContext(ok());
      await engine.executeSearch("a", 1, "any", context);
      engine.configure({ licenseType: "commercial" });
      await engine.executeSearch("a", 1, "any", context);
      expect(context.searches()).toHaveLength(2);
      expect(new URL(context.searches()[1].url).searchParams.get("license_type")).toBe("commercial");
    });
  });

  describe("budgets (anonymous and registered counted apart, kept on disk)", () => {
    test("the anonymous hourly cap stops requests with a message and the count is persisted", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ov-budget-"));
      try {
        const file = join(dir, "openverse", "usage.json");
        const engine = make({ anonymousHourlyLimit: "2" });
        engine.budget.file = file;
        const context = makeContext(ok());
        await engine.executeSearch("a", 1, "any", context);
        await engine.executeSearch("b", 1, "any", context);
        const lines = await capture(() => expect(engine.executeSearch("c", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
        expect(context.searches()).toHaveLength(2);
        expect(lines.join("\n")).toContain("anonymous request limit is used up");
        expect(existsSync(file)).toBe(true);
        const saved = JSON.parse(readFileSync(file, "utf8"));
        expect(saved["anon-hour"].used).toBe(2);
        expect(saved["anon-day"].used).toBe(2);
        expect(saved["auth-day"]).toBeUndefined();
        // a restarted engine remembers
        const again = new OpenverseEngine();
        again.limiter = new Limiter({ minIntervalMs: 0 });
        again.budget.file = file;
        again.configure({ anonymousHourlyLimit: "2" });
        await capture(() => expect(again.executeSearch("d", 1, "any", makeContext(ok()))).rejects.toMatchObject({ status: "rate_limited" }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the anonymous daily cap", async () => {
      const engine = make({ anonymousHourlyLimit: "0", anonymousDailyLimit: "1" });
      const context = makeContext(ok());
      await engine.executeSearch("a", 1, "any", context);
      await capture(() => expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
      expect(context.searches()).toHaveLength(1);
    });

    test("registered requests do not use up the anonymous budget, and the other way round", async () => {
      const engine = make({ ...registered, anonymousHourlyLimit: "1" });
      const context = makeContext(ok());
      await engine.executeSearch("a", 1, "any", context);
      await engine.executeSearch("b", 1, "any", context);
      expect(engine.budget.used("anon-hour")).toBe(0);
      expect(engine.budget.used("auth-day")).toBe(2);
      expect(engine.budget.used("auth-minute")).toBe(2);
    });

    test("the registered daily cap", async () => {
      const engine = make({ ...registered, registeredDailyLimit: "1" });
      const context = makeContext(ok());
      await engine.executeSearch("a", 1, "any", context);
      await capture(() => expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
      expect(context.searches()).toHaveLength(1);
    });

    test("caps can be turned off and are clamped", () => {
      const engine = make({ anonymousHourlyLimit: "-5", anonymousDailyLimit: "abc", registeredDailyLimit: "999999999999" });
      const limit = (name) => engine.budget.windows.find((w) => w.name === name).limit;
      expect(limit("anon-hour")).toBe(0);
      expect(limit("anon-day")).toBe(100);
      expect(limit("auth-day")).toBe(100_000_000);
      expect(limit("auth-minute")).toBe(100);
    });

    test("the usage file holds counts only: no secret, no token", async () => {
      const dir = mkdtempSync(join(tmpdir(), "ov-budget-"));
      try {
        const file = join(dir, "usage.json");
        const engine = make(registered);
        engine.budget.file = file;
        await engine.executeSearch("a", 1, "any", makeContext(ok()));
        const text = readFileSync(file, "utf8");
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain(TOKEN);
        expect(text).not.toContain(ID);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("an unwritable usage file does not stop the engine", async () => {
      const engine = make();
      engine.budget.file = "/proc/definitely/not/writable/usage.json";
      expect(await engine.executeSearch("a", 1, "any", makeContext(ok()))).toHaveLength(4);
    });
  });

  describe("failures and pauses", () => {
    test("429: Retry-After or 10 minutes (at most 6 hours), one warning, then nothing is asked", async () => {
      const engine = make();
      const context = makeContext(status(429, "{}", { "retry-after": "1800" }));
      const lines = await capture(async () => {
        await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
      });
      expect(context.searches()).toHaveLength(1);
      expect(Math.round(engine.limiter.blockedFor() / 1000)).toBe(1800);
      expect(lines.filter((line) => line.includes("too many requests"))).toHaveLength(1);

      const noHeader = make();
      await expect(noHeader.executeSearch("a", 1, "any", makeContext(status(429)))).rejects.toMatchObject({ status: "rate_limited" });
      expect(Math.round(noHeader.limiter.blockedFor() / 60_000)).toBe(10);
      const huge = make();
      await expect(huge.executeSearch("a", 1, "any", makeContext(status(429, "", { "retry-after": "99999999" })))).rejects.toMatchObject({ status: "rate_limited" });
      expect(Math.round(huge.limiter.blockedFor() / 3_600_000)).toBe(6);
    });

    test("401 and 403 anonymous: blocked, ten minutes, one warning", async () => {
      for (const code of [401, 403]) {
        const engine = make();
        const context = makeContext(status(code));
        const lines = await capture(async () => {
          await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "blocked" });
          await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        });
        expect(context.searches()).toHaveLength(1);
        expect(Math.round(engine.limiter.blockedFor() / 60_000)).toBe(10);
        expect(lines.filter((line) => line.includes("refused"))).toHaveLength(1);
      }
    });

    test("a rejected token drops it: the next token request comes after the pause and not before ten minutes", async () => {
      const engine = make(registered);
      const context = makeContext(status(401));
      const lines = await capture(() => expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "blocked" }));
      expect(engine.tokens.token).toBe("");
      expect(lines.join("\n")).toContain("access token was rejected");
      expect(lines.join("\n")).not.toContain(TOKEN);
      expect(lines.join("\n")).not.toContain(SECRET);
    });

    test("5xx pauses at least a minute and honours a longer Retry-After; a network error too, without passing its message on", async () => {
      const a = make();
      await expect(a.executeSearch("a", 1, "any", makeContext(status(503)))).rejects.toMatchObject({ status: "network" });
      expect(Math.round(a.limiter.blockedFor() / 1000)).toBe(60);

      const b = make();
      await expect(b.executeSearch("a", 1, "any", makeContext(status(504, "{}", { "retry-after": "120" })))).rejects.toMatchObject({ status: "network" });
      expect(Math.round(b.limiter.blockedFor() / 1000)).toBe(120);

      const c = make();
      await expect(c.executeSearch("a", 1, "any", makeContext(status(502, "{}", { "retry-after": "1" })))).rejects.toMatchObject({ status: "network" });
      expect(Math.round(c.limiter.blockedFor() / 1000)).toBe(60);

      const d = make({ ...registered });
      const context = makeContext(() => {
        throw new Error(`socket hang up for Bearer ${TOKEN} client_secret=${SECRET}`);
      });
      const lines = await capture(() => expect(d.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "network" }));
      expect(lines.join("\n")).not.toContain(TOKEN);
      expect(lines.join("\n")).not.toContain(SECRET);
      expect(Math.round(d.limiter.blockedFor() / 1000)).toBe(60);
    });

    test("not JSON and an unexpected layout are parse errors", async () => {
      await expect(make().executeSearch("a", 1, "any", makeContext(status(200, "<html>")))).rejects.toMatchObject({ status: "parse_error" });
      await expect(make().executeSearch("a", 1, "any", makeContext(status(200, JSON.stringify({ detail: "x" }))))).rejects.toMatchObject({ status: "parse_error" });
    });

    test("an empty result list is fine and is cached", async () => {
      const engine = make();
      const context = makeContext(status(200, JSON.stringify({ result_count: 0, results: [] })));
      expect(await engine.executeSearch("nothing", 1, "any", context)).toEqual([]);
      expect(await engine.executeSearch("nothing", 1, "any", context)).toEqual([]);
      expect(context.searches()).toHaveLength(1);
    });
  });

  describe("time rule", () => {
    test("a request that would wait past 70 % of the slot is skipped", async () => {
      await withEnv("DEGOOG_SLOT_TIMEOUT_MS", "2000", async () => {
        const engine = make();
        engine.limiter = new Limiter({ minIntervalMs: 5000, maxWaitMs: 5000 });
        const context = makeContext(ok());
        await engine.executeSearch("a", 1, "any", context);
        await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        expect(context.searches()).toHaveLength(1);
      });
    });

    test("a slow upstream is given up at the deadline", async () => {
      await withEnv("DEGOOG_SLOT_TIMEOUT_MS", "1000", async () => {
        const engine = make();
        const context = makeContext((url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))));
        await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "timeout" });
        expect(engine.limiter.blockedFor()).toBe(0);
      });
    });

    test("a slow token endpoint does not eat the slot: the token request is cut early and the search goes ahead anonymously", async () => {
      await withEnv("DEGOOG_SLOT_TIMEOUT_MS", "4000", async () => {
        const engine = make(registered);
        const context = makeContext(ok(), { token: (url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))) });
        const started = Date.now();
        const results = await engine.executeSearch("a", 1, "any", context);
        expect(results).toHaveLength(4);
        // 40 % of the 3.8 s answer window
        expect(Date.now() - started).toBeLessThan(2000);
        expect(context.searches()[0].init.headers.Authorization).toBeUndefined();
      });
    });
  });

  describe("settings", () => {
    test("clamping and defaults", () => {
      const engine = make({ pageSize: "500", licenseType: "bogus", category: "bogus", source: " flickr ", extension: "jpg", includeMature: "yes" });
      expect(engine.pageSize).toBe(50);
      expect(engine.licenseType).toBe("all");
      expect(engine.category).toBe("any");
      expect(engine.includeMature).toBe(false);
      expect(make({ pageSize: "0" }).pageSize).toBe(1);
      expect(make({ pageSize: "abc" }).pageSize).toBe(20);
      expect(make({ includeMature: "true" }).includeMature).toBe(true);
      expect(make({ includeMature: true }).includeMature).toBe(true);
      expect(make({}).debugMatching).toBe(false);
    });

    test("the schema: optional credentials with a secret, mature off, advanced limits and troubleshooting", () => {
      const byKey = Object.fromEntries(SETTINGS_SCHEMA.map((field) => [field.key, field]));
      expect(byKey.clientSecret.type).toBe("password");
      expect(byKey.clientSecret.secret).toBe(true);
      expect(byKey.clientId.secret).toBeUndefined();
      expect(byKey.includeMature.default).toBe("false");
      expect(byKey.licenseType.options).toEqual(["all", "all-cc", "commercial", "modification"]);
      expect(byKey.licenseType.optionLabels).toHaveLength(4);
      expect(byKey.anonymousHourlyLimit.advanced).toBe(true);
      expect(byKey.debugMatching.advanced).toBe(true);
      expect(byKey.debugMatching.default).toBe("false");
      expect(byKey.clientId.description).toMatch(/optional/i);
    });

    test("debugMatching: one line per search, no query, no secret, no token", async () => {
      const engine = make({ ...registered, debugMatching: "true" });
      const context = makeContext(ok());
      const lines = await capture(async () => {
        await engine.executeSearch("quillfern secret topic", 1, "any", context);
        await engine.executeSearch("quillfern secret topic", 1, "any", context);
      });
      expect(lines).toEqual(["[openverse] page 1: requested, 4 images (with credentials)", "[openverse] page 1: cache hit, 4 images (with credentials)"]);
      expect(lines.join("\n")).not.toContain("quillfern");

      const anonymous = make({ debugMatching: "true" });
      const more = await capture(() => anonymous.executeSearch("x", 1, "any", makeContext(ok())));
      expect(more).toEqual(["[openverse] page 1: requested, 4 images (anonymous)"]);
    });

    test("debugMatching explains a failed token and says it searched anonymously", async () => {
      const engine = make({ ...registered, debugMatching: "true" });
      const lines = await capture(() => engine.executeSearch("x", 1, "any", makeContext(ok(), { token: status(401) })));
      expect(lines.join("\n")).toContain("no access token (the token request was refused (HTTP 401)); searching anonymously");
      expect(lines.join("\n")).not.toContain(SECRET);
    });

    test("nothing is logged with debugMatching off", async () => {
      const engine = make(registered);
      const lines = await capture(() => engine.executeSearch("x", 1, "any", makeContext(ok())));
      expect(lines).toEqual([]);
    });
  });
});

describe("redaction", () => {
  test("removes the secret and the token, raw and URL-encoded, and bearer / client_secret forms", () => {
    const text = `failed: Bearer ${TOKEN} and client_secret=${SECRET} and ${encodeURIComponent("a b&c")} and access_token=abc123`;
    const out = redact(text, [SECRET, TOKEN, "a b&c"]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("a b&c");
    expect(out).not.toContain("a%20b%26c");
    expect(out).not.toContain("abc123");
    expect(redact(undefined, [SECRET])).toBe("");
    expect(redact("plain", ["", null])).toBe("plain");
  });
});
