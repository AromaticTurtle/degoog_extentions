// Tests for the Pexels image engine. tests/fixtures/pexels-search.json is HAND-WRITTEN in the documented layout with invented
// photographers and ids; no real response is recorded. The key in these tests is a made-up string.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Limiter } from "../engines/pexels/limiter.js";
import { Budget } from "../engines/pexels/budget.js";
import { buildHeaders, buildRequest, localeOf } from "../engines/pexels/request.js";
import { parsePhotos, profileLabel, totalOf } from "../engines/pexels/parse.js";
import { SETTINGS_SCHEMA } from "../engines/pexels/settings.js";
import PexelsEngine, { filters, type } from "../engines/pexels/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const fixture = await read("./fixtures/pexels-search.json").json();
const KEY = "pexels-invented-key-0123456789";

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });
const makeContext = (makeResponse, extra = {}) => {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return makeResponse(url, init);
    },
    sentinel: (res, name) => {
      if (!res.ok) throw breach(res.status === 429 ? "rate_limited" : "blocked", `${name} ${res.status}`);
    },
    engineError: (status, message) => breach(status, message),
    ...extra,
  };
};
const quota = (remaining = 19950, reset = Math.floor(Date.now() / 1000) + 86400 * 20) => ({ "x-ratelimit-limit": "20000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(reset) });
const ok = (headers = quota()) => () => new Response(JSON.stringify(fixture), { status: 200, headers });
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

const make = (settings = { apiKey: KEY }) => {
  const engine = new PexelsEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
  engine.budget.file = "";
  engine.apiBase = "https://api.test/v1";
  engine.configure(settings);
  return engine;
};

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

describe("building the request", () => {
  const options = { perPage: 30, orientation: "any", size: "any", locale: "" };
  const params = (opts = {}, page = 1, q = "forest") => new URL(buildRequest(q, page, { ...options, ...opts }, "https://api.pexels.com/v1").url).searchParams;

  test("the documented endpoint and parameters", () => {
    const { url } = buildRequest("forest lake", 1, options, "https://api.pexels.com/v1/");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://api.pexels.com/v1/search");
    expect(parsed.searchParams.get("query")).toBe("forest lake");
    expect(parsed.searchParams.get("per_page")).toBe("30");
    for (const name of ["page", "orientation", "size", "color", "locale"]) expect(parsed.searchParams.has(name)).toBe(false);
  });

  test("paging, filters from degoog and from settings", () => {
    expect(params({}, 4).get("page")).toBe("4");
    expect(params({ orientation: "portrait" }).get("orientation")).toBe("portrait");
    expect(params({ size: "large" }).get("size")).toBe("large");
    expect(params({ orientation: "bogus", size: "bogus" }).has("orientation")).toBe(false);
    expect(params({ orientation: "portrait", imageFilter: { layout: "wide" } }).get("orientation")).toBe("landscape");
    expect(params({ imageFilter: { layout: "tall" } }).get("orientation")).toBe("portrait");
    expect(params({ imageFilter: { layout: "square" } }).get("orientation")).toBe("square");
    expect(params({ size: "small", imageFilter: { size: "large" } }).get("size")).toBe("large");
    expect(params({ imageFilter: { size: "wallpaper" } }).has("size")).toBe(false);
    expect(params({ imageFilter: { color: "teal" } }).get("color")).toBe("turquoise");
    expect(params({ imageFilter: { color: "purple" } }).get("color")).toBe("violet");
    expect(params({ imageFilter: { color: "red" } }).get("color")).toBe("red");
    expect(params({ imageFilter: { color: "transparent" } }).has("color")).toBe(false);
  });

  test("locales", () => {
    expect(localeOf("de")).toBe("de-DE");
    expect(localeOf("pt")).toBe("pt-BR");
    expect(localeOf("zh-TW")).toBe("zh-TW");
    expect(localeOf("en-GB")).toBe("en-US");
    expect(localeOf("nb")).toBe("nb-NO");
    expect(localeOf("xx")).toBe("");
    expect(localeOf("")).toBe("");
    expect(params({ locale: "fr" }).get("locale")).toBe("fr-FR");
  });

  test("the address holds no credential, and cache key equals it", () => {
    const { url, cacheKey } = buildRequest("forest", 2, options);
    expect(url).not.toMatch(/key|token|auth/i);
    expect(cacheKey).toBe(url);
  });

  test("the key goes in the Authorization header as the bare key, with an honest User-Agent", () => {
    const headers = buildHeaders(KEY);
    expect(headers.Authorization).toBe(KEY);
    expect(headers.Authorization).not.toMatch(/^Bearer/i);
    expect(headers["User-Agent"]).toMatch(/^degoog-pexels-engine\/1\.0 \(\+https:\/\/github\.com\/AromaticTurtle\//);
    expect(headers.Accept).toBe("application/json");
  });

  test("the query is cut at 500 characters", () => {
    expect(Array.from(params({}, 1, "é".repeat(800)).get("query"))).toHaveLength(500);
  });
});

describe("parsing the reply", () => {
  const results = parsePhotos(fixture, "Pexels");

  test("keeps the photos with a page, a thumbnail and an image on pexels.com", () => {
    expect(results.map((r) => r.url)).toEqual([
      "https://www.pexels.com/photo/quillfern-in-a-meadow-7000001/",
      "https://www.pexels.com/photo/7000002/",
      "https://www.pexels.com/photo/florbit-bell-7000003/",
      "https://www.pexels.com/photo/plain-http-7000007/",
    ]);
  });

  test("thumbnail: medium; full size: large2x by default, large or original by setting", () => {
    expect(results[0].thumbnail).toBe("https://images.pexels.com/photos/7000001/pexels-photo-7000001.jpeg?auto=compress&cs=tinysrgb&h=350");
    expect(results[0].imageUrl).toContain("dpr=2");
    expect(parsePhotos(fixture, "Pexels", { fullSize: "original" })[0].imageUrl).toBe("https://images.pexels.com/photos/7000001/pexels-photo-7000001.jpeg");
    expect(parsePhotos(fixture, "Pexels", { fullSize: "large" })[0].imageUrl).toContain("h=650&w=940");
    expect(parsePhotos(fixture, "Pexels", { fullSize: "large" })[0].imageUrl).not.toContain("dpr=2");
  });

  test("missing sizes fall back", () => {
    expect(results[2].thumbnail).toBe("https://images.pexels.com/photos/7000003/m.jpeg");
    expect(results[2].imageUrl).toBe("https://images.pexels.com/photos/7000003/l.jpeg");
    expect(results[3].thumbnail).toBe("https://images.pexels.com/photos/7000007/l2.jpeg");
    expect(results[3].imageUrl).toBe("https://images.pexels.com/photos/7000007/l2.jpeg");
  });

  test("attribution: photographer, profile address, 'on Pexels', size; the result links to the Pexels photo page", () => {
    expect(results[0].snippet).toBe("Photo by Ada Invented (pexels.com/@ada-invented) on Pexels · 3024×2016");
    expect(results[1].snippet).toBe("Photo by Ben Made-Up (pexels.com/@ben-madeup) on Pexels · 2000×3000");
    expect(results[2].snippet).toBe("Photo on Pexels · 1000×1000");
    for (const r of results) {
      expect(r.snippet).toContain("Pexels");
      expect(new URL(r.url).hostname).toBe("www.pexels.com");
    }
  });

  test("a photographer name is plain text: markup is removed", () => {
    expect(results[3].snippet).toBe("Photo by Cy x (pexels.com/@cy) on Pexels · 800×600");
    expect(results[3].title).toBe("Plain & http — Photo by Cy x on Pexels");
    expect(JSON.stringify(results)).not.toContain("<script");
  });

  test("titles: the alt text and the credit (degoog's image preview shows the title, not the snippet), with fallbacks", () => {
    expect(results[0].title).toBe("Quillfern growing in a meadow — Photo by Ada Invented on Pexels");
    expect(results[1].title).toBe("Photo by Ben Made-Up on Pexels");
    expect(results[2].title).toBe("A florbit bell — Photo on Pexels");
    expect(parsePhotos({ photos: [{ url: "https://www.pexels.com/photo/9/", src: { medium: "https://images.pexels.com/m.jpg" } }] }, "Pexels")[0].title).toBe("Photo on Pexels");
    for (const r of results) expect(r.title).toContain("Pexels");
  });

  test("a profile label needs a pexels.com address with an @handle", () => {
    expect(profileLabel({ photographer_url: "https://www.pexels.com/@daria" })).toBe("pexels.com/@daria");
    expect(profileLabel({ photographer_url: "https://www.pexels.com/@daria/" })).toBe("pexels.com/@daria");
    expect(profileLabel({ photographer_url: "https://www.pexels.com/user/daria" })).toBe("");
    expect(profileLabel({ photographer_url: "https://evil.example/@daria" })).toBe("");
    expect(profileLabel({})).toBe("");
  });

  test("result shape matches what Unsplash returns", () => {
    for (const r of results) expect(Object.keys(r).sort()).toEqual(["imageUrl", "snippet", "source", "thumbnail", "title", "url"]);
  });

  test("layout problems and totals", () => {
    expect(parsePhotos(null, "Pexels")).toBeNull();
    expect(parsePhotos({}, "Pexels")).toBeNull();
    expect(parsePhotos({ photos: {} }, "Pexels")).toBeNull();
    expect(parsePhotos({ total_results: 0, photos: [] }, "Pexels")).toEqual([]);
    expect(parsePhotos({ photos: [null, 3, {}, { url: 5 }] }, "Pexels")).toEqual([]);
    expect(totalOf({ total_results: 8000 })).toBe(8000);
    expect(totalOf({})).toBeUndefined();
  });

  test("mock hosts are kept only when listed", () => {
    const photo = { url: "http://mock.local/p/1", src: { medium: "http://mock.local/i/1.jpg" } };
    expect(parsePhotos({ photos: [photo] }, "Pexels")).toEqual([]);
    expect(parsePhotos({ photos: [photo] }, "Pexels", { extraHosts: ["mock.local"] })[0].thumbnail).toBe("http://mock.local/i/1.jpg");
  });
});

describe("the engine", () => {
  test("identity, type, filters", () => {
    const engine = make();
    expect(type).toBe("images");
    expect(filters.layout).toEqual(["square", "wide", "tall"]);
    expect(engine.name).toBe("Pexels");
    expect(engine.bangShortcut).toBe("pexels");
  });

  test("the key travels in the Authorization header only: never in the address, the cache key or a result", async () => {
    const engine = make();
    const context = makeContext(ok());
    const results = await engine.executeSearch("forest", 1, "any", context);
    expect(results).toHaveLength(4);
    const { url, init } = context.calls[0];
    expect(url).not.toContain(KEY);
    expect(init.headers.Authorization).toBe(KEY);
    expect(new URL(url).searchParams.has("key")).toBe(false);
    for (const key of engine.cache.entries.keys()) expect(key).not.toContain(KEY);
    expect(JSON.stringify(results)).not.toContain(KEY);
  });

  test("no key: nothing asked, quietly; the reason only with debugMatching", async () => {
    await withEnv("PEXELS_API_KEY", undefined, async () => {
      const context = makeContext(ok());
      const silent = await capture(async () => expect(await make({}).executeSearch("x", 1, "any", context)).toEqual([]));
      expect(silent).toEqual([]);
      const lines = await capture(async () => make({ debugMatching: "true" }).executeSearch("x", 1, "any", context));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("no api key");
      expect(context.calls).toHaveLength(0);
    });
  });

  test("the key can come from PEXELS_API_KEY; the setting wins", async () => {
    await withEnv("PEXELS_API_KEY", "env-key-0123456789", async () => {
      const context = makeContext(ok());
      await make({}).executeSearch("x", 1, "any", context);
      expect(context.calls[0].init.headers.Authorization).toBe("env-key-0123456789");
      const second = makeContext(ok());
      await make({ apiKey: KEY }).executeSearch("x", 1, "any", second);
      expect(second.calls[0].init.headers.Authorization).toBe(KEY);
    });
  });

  test("env overrides for the API base, the mock hosts and the usage file", async () => {
    await withEnv("DEGOOG_PEXELS_API_BASE", "http://mock.local:4470/pexels/v1", async () => expect(new PexelsEngine().apiBase).toBe("http://mock.local:4470/pexels/v1"));
    await withEnv("DEGOOG_PEXELS_EXTRA_HOSTS", "mock.local", async () => expect(new PexelsEngine().extraHosts).toEqual(["mock.local"]));
    await withEnv("DEGOOG_PEXELS_USAGE_FILE", "/tmp/x/usage.json", async () => expect(new PexelsEngine().budget.file).toBe("/tmp/x/usage.json"));
  });

  test("paging maps to the page parameter; the total goes to degoog", async () => {
    const engine = make();
    const totals = [];
    const context = makeContext(ok(), { pagination: (info) => totals.push(info.total) });
    await engine.executeSearch("forest", 3, "any", context);
    expect(new URL(context.calls[0].url).searchParams.get("page")).toBe("3");
    expect(totals).toEqual([8000]);
  });

  test("the cache: an hour, per search; concurrent searches share one request", async () => {
    const engine = make();
    let now = 5_000_000;
    engine.cache.now = () => now;
    const context = makeContext(ok());
    await Promise.all([engine.executeSearch("forest", 1, "any", context), engine.executeSearch("forest", 1, "any", context)]);
    await engine.executeSearch("forest", 1, "any", context);
    expect(context.calls).toHaveLength(1);
    now += 3_600_000 + 1;
    await engine.executeSearch("forest", 1, "any", context);
    expect(context.calls).toHaveLength(2);
    expect(engine.cache.ttlMs).toBe(3_600_000);
  });

  test("a changed setting clears the cache", async () => {
    const engine = make();
    const context = makeContext(ok());
    await engine.executeSearch("forest", 1, "any", context);
    engine.configure({ apiKey: KEY, fullSize: "original" });
    const results = await engine.executeSearch("forest", 1, "any", context);
    expect(context.calls).toHaveLength(2);
    expect(results[0].imageUrl).toBe("https://images.pexels.com/photos/7000001/pexels-photo-7000001.jpeg");
  });

  describe("budgets (hourly and monthly, kept on disk)", () => {
    test("the hourly cap stops requests with a message, and the count is persisted", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pexels-test-"));
      try {
        const file = join(dir, "pexels", "usage.json");
        const engine = make({ apiKey: KEY, hourlyLimit: "2" });
        engine.budget.file = file;
        const context = makeContext(ok());
        await engine.executeSearch("a", 1, "any", context);
        await engine.executeSearch("b", 1, "any", context);
        const lines = await capture(() => expect(engine.executeSearch("c", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
        expect(context.calls).toHaveLength(2);
        expect(lines.join("\n")).toContain("request budget is used up");
        expect(existsSync(file)).toBe(true);
        const saved = JSON.parse(readFileSync(file, "utf8"));
        expect(saved.hour.used).toBe(2);
        expect(readFileSync(file, "utf8")).not.toContain(KEY);
        // a restarted engine remembers
        const again = new PexelsEngine();
        again.limiter = new Limiter({ minIntervalMs: 0 });
        again.budget.file = file;
        again.configure({ apiKey: KEY, hourlyLimit: "2" });
        await capture(() => expect(again.executeSearch("d", 1, "any", makeContext(ok()))).rejects.toMatchObject({ status: "rate_limited" }));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the hourly count starts again in the next hour", () => {
      let now = Date.UTC(2026, 9, 28, 12, 59, 0);
      const budget = new Budget({ windows: [{ name: "hour", unit: "hour", limit: 1 }], now: () => now });
      expect(budget.spend()).toBe(true);
      expect(budget.spend()).toBe(false);
      expect(budget.waitMs()).toBe(60_000);
      now += 61_000;
      expect(budget.spend()).toBe(true);
    });

    test("the monthly count follows the X-Ratelimit headers of successful replies", async () => {
      const engine = make();
      await engine.executeSearch("a", 1, "any", makeContext(ok(quota(150))));
      expect(engine.budget.used("month")).toBe(19850);
      // the request itself is counted, and a later reply that reports fewer used requests never lowers the count
      await engine.executeSearch("b", 1, "any", makeContext(ok(quota(19990))));
      expect(engine.budget.used("month")).toBe(19851);
    });

    test("no requests remaining this month: stop until the reset, with one warning", async () => {
      const engine = make();
      const reset = Math.floor(Date.now() / 1000) + 3 * 86400;
      const lines = await capture(async () => {
        expect(await engine.executeSearch("a", 1, "any", makeContext(ok(quota(0, reset))))).toHaveLength(4);
        await expect(engine.executeSearch("b", 1, "any", makeContext(ok()))).rejects.toMatchObject({ status: "rate_limited" });
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("monthly request quota is used up");
      expect(engine.limiter.blockedFor()).toBeGreaterThan(2.9 * 86400_000);
      expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(3 * 86400_000);
    });

    test("caps can be turned off and are clamped", () => {
      expect(make({ apiKey: KEY, hourlyLimit: "0" }).budget.windows[0].limit).toBe(0);
      expect(make({ apiKey: KEY, hourlyLimit: "abc" }).budget.windows[0].limit).toBe(200);
      expect(make({ apiKey: KEY, monthlyLimit: "5" }).budget.windows[1].limit).toBe(5);
      expect(make({ apiKey: KEY }).budget.windows[1].limit).toBe(20000);
    });

    test("an unwritable usage file does not stop the engine", async () => {
      const engine = make();
      engine.budget.file = "/proc/definitely/not/writable/usage.json";
      expect(await engine.executeSearch("a", 1, "any", makeContext(ok()))).toHaveLength(4);
    });
  });

  describe("failures and pauses", () => {
    test("429: Retry-After or 15 minutes (at most an hour), one warning, then nothing is asked", async () => {
      const engine = make();
      const context = makeContext(status(429, '{"error":"Too many requests"}', { "retry-after": "120" }));
      const lines = await capture(async () => {
        await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
      });
      expect(context.calls).toHaveLength(1);
      expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(120_000);
      expect(lines).toHaveLength(1);
      const plain = make();
      await capture(() => expect(plain.executeSearch("a", 1, "any", makeContext(status(429)))).rejects.toThrow());
      expect(plain.limiter.blockedFor()).toBeGreaterThan(14 * 60_000);
      const huge = make();
      await capture(() => expect(huge.executeSearch("a", 1, "any", makeContext(status(429, "", { "retry-after": "999999" })))).rejects.toThrow());
      expect(huge.limiter.blockedFor()).toBeLessThanOrEqual(3_600_000);
    });

    test("401 and 403: blocked, half an hour, one warning that does not name the key", async () => {
      for (const code of [401, 403]) {
        const engine = make();
        const context = makeContext(status(code, '{"error":"Unauthorized"}'));
        const lines = await capture(async () => {
          await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "blocked" });
          await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        });
        expect(context.calls).toHaveLength(1);
        expect(engine.limiter.blockedFor()).toBeGreaterThan(29 * 60_000);
        expect(lines).toHaveLength(1);
        expect(lines[0]).not.toContain(KEY);
      }
    });

    test("5xx pauses a minute; a network error too, without passing its message on", async () => {
      const engine = make();
      const context = makeContext(status(502));
      await capture(() => expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "network" }));
      await capture(() => expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
      expect(context.calls).toHaveLength(1);
      const down = make();
      let caught;
      await capture(async () => {
        caught = await down.executeSearch("a", 1, "any", makeContext(() => { throw new Error(`getaddrinfo failed ${KEY}`); })).catch((e) => e);
      });
      expect(caught.status).toBe("network");
      expect(caught.message).not.toContain(KEY);
      expect(down.limiter.blockedFor()).toBeGreaterThan(0);
    });

    test("not JSON and an unexpected layout are parse errors", async () => {
      await expect(make().executeSearch("a", 1, "any", makeContext(() => new Response("<html>", { headers: quota() })))).rejects.toMatchObject({ status: "parse_error" });
      await expect(make().executeSearch("b", 1, "any", makeContext(() => new Response('{"videos":[]}')))).rejects.toMatchObject({ status: "parse_error" });
    });

    test("an empty result list is fine and is cached", async () => {
      const engine = make();
      const context = makeContext(() => new Response(JSON.stringify({ total_results: 0, page: 1, per_page: 30, photos: [] }), { headers: quota() }));
      expect(await engine.executeSearch("zzz", 1, "any", context)).toEqual([]);
      expect(await engine.executeSearch("zzz", 1, "any", context)).toEqual([]);
      expect(context.calls).toHaveLength(1);
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
        expect(context.calls).toHaveLength(1);
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
  });

  describe("settings", () => {
    test("clamping and defaults", () => {
      const engine = make({ apiKey: KEY, perPage: "500", orientation: "bogus", size: "bogus", fullSize: "bogus", locale: " de-DE " });
      expect(engine.perPage).toBe(80);
      expect(engine.orientation).toBe("any");
      expect(engine.size).toBe("any");
      expect(engine.fullSize).toBe("large2x");
      expect(engine.locale).toBe("de-DE");
      expect(make({ apiKey: KEY, perPage: "2" }).perPage).toBe(10);
      expect(make({ apiKey: KEY, perPage: "abc" }).perPage).toBe(30);
    });

    test("the schema: a secret key, advanced limits and troubleshooting", () => {
      expect(SETTINGS_SCHEMA.map((f) => f.key)).toEqual(["apiKey", "orientation", "size", "locale", "fullSize", "perPage", "hourlyLimit", "monthlyLimit", "debugMatching"]);
      expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey")).toMatchObject({ type: "password", secret: true });
      expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey").description).toContain("Authorization header");
      expect(SETTINGS_SCHEMA.find((f) => f.key === "hourlyLimit")).toMatchObject({ advanced: true, default: "200" });
      expect(SETTINGS_SCHEMA.find((f) => f.key === "monthlyLimit")).toMatchObject({ advanced: true, default: "20000" });
      expect(SETTINGS_SCHEMA.find((f) => f.key === "debugMatching")).toMatchObject({ advanced: true, default: "false" });
    });

    test("debugMatching: one line per search, no query, no key", async () => {
      const engine = make({ apiKey: KEY, debugMatching: "true" });
      const context = makeContext(ok());
      const lines = await capture(async () => {
        await engine.executeSearch("forest", 1, "any", context);
        await engine.executeSearch("forest", 1, "any", context);
      });
      expect(lines).toEqual(["[pexels] page 1: requested, 4 photos", "[pexels] page 1: cache hit, 4 photos"]);
    });
  });
});
