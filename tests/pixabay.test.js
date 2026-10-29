// Tests for the Pixabay image engine. The reply fixture (tests/fixtures/pixabay-search.json) is HAND-WRITTEN in the documented layout
// with invented photographers, tags and numbers; no real response is recorded. The key in these tests is a made-up string.
import { afterEach, describe, expect, test } from "bun:test";
import { Limiter } from "../engines/pixabay/limiter.js";
import { Budget, windowEnd, windowKey } from "../engines/pixabay/budget.js";
import { ResultCache } from "../engines/pixabay/cache.js";
import { answerWindowMs, deadlineSignal, slotTimeoutMs, startWindowMs } from "../engines/pixabay/timing.js";
import { MAX_HITS, buildHeaders, buildRequest, languageOf, redact } from "../engines/pixabay/request.js";
import { parseHits, profileLabel, totalOf } from "../engines/pixabay/parse.js";
import { SETTINGS_SCHEMA } from "../engines/pixabay/settings.js";
import PixabayEngine, { filters, type } from "../engines/pixabay/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const fixture = await read("./fixtures/pixabay-search.json").json();
const KEY = "k3y-invented-0123456789abcdef";

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

const make = (settings = { apiKey: KEY }) => {
  const engine = new PixabayEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
  engine.apiBase = "https://api.test/api";
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

describe("shared copies stay identical", () => {
  test("text.js, limiter.js, budget.js, cache.js, timing.js and author.json match across the image engines", async () => {
    for (const file of ["text.js", "limiter.js", "author.json", "budget.js", "cache.js", "timing.js"]) {
      const copies = await Promise.all(["pixabay", "openverse", "pexels"].map((name) => read(`../engines/${name}/${file}`).text()));
      expect(copies[1], file).toBe(copies[0]);
      expect(copies[2], file).toBe(copies[0]);
    }
    const [a, b] = await Promise.all(["unsplash", "pixabay"].map((name) => read(`../engines/${name}/text.js`).text()));
    expect(b).toBe(a);
  });
});

describe("building the request", () => {
  const options = { perPage: 30, order: "popular", safe: true, imageType: "all", orientation: "all", language: "" };

  test("the documented parameters, the key as the key parameter", () => {
    const { url } = buildRequest(KEY, "yellow flower", 1, options, "https://pixabay.com/api");
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe("https://pixabay.com/api/");
    expect(parsed.searchParams.get("key")).toBe(KEY);
    expect(parsed.searchParams.get("q")).toBe("yellow flower");
    expect(parsed.searchParams.get("per_page")).toBe("30");
    expect(parsed.searchParams.get("order")).toBe("popular");
    expect(parsed.searchParams.get("safesearch")).toBe("true");
    expect(parsed.searchParams.has("page")).toBe(false);
    expect(parsed.searchParams.has("image_type")).toBe(false);
    expect(parsed.searchParams.has("orientation")).toBe(false);
  });

  test("the cache key is the same address without the key", () => {
    const { url, cacheKey } = buildRequest(KEY, "yellow flower", 2, options, "https://pixabay.com/api");
    expect(url).toContain(KEY);
    expect(cacheKey).not.toContain(KEY);
    expect(cacheKey).not.toMatch(/key=/);
    expect(cacheKey).toContain("page=2");
    expect(buildRequest("another-key", "yellow flower", 2, options).cacheKey).toBe(buildRequest(KEY, "yellow flower", 2, options).cacheKey);
  });

  test("a key with special characters is encoded", () => {
    const { url } = buildRequest("a&b=c d", "q", 1, options);
    expect(new URL(url).searchParams.get("key")).toBe("a&b=c d");
    expect(url).not.toContain("a&b=c d");
  });

  test("paging, filters from degoog and from settings", () => {
    const p = (opts, page = 1) => new URL(buildRequest(KEY, "x", page, { ...options, ...opts }).url).searchParams;
    expect(p({}, 3).get("page")).toBe("3");
    expect(p({ imageType: "photo" }).get("image_type")).toBe("photo");
    expect(p({ imageType: "vector" }).get("image_type")).toBe("vector");
    expect(p({ orientation: "vertical" }).get("orientation")).toBe("vertical");
    expect(p({ order: "latest" }).get("order")).toBe("latest");
    // degoog's filters win over the settings
    expect(p({ imageType: "vector", imageFilter: { type: "photo" } }).get("image_type")).toBe("photo");
    expect(p({ imageFilter: { type: "clipart" } }).get("image_type")).toBe("illustration");
    expect(p({ imageFilter: { type: "lineart" } }).get("image_type")).toBe("vector");
    expect(p({ orientation: "vertical", imageFilter: { layout: "wide" } }).get("orientation")).toBe("horizontal");
    expect(p({ imageFilter: { layout: "tall" } }).get("orientation")).toBe("vertical");
    expect(p({ imageFilter: { layout: "square" } }).has("orientation")).toBe(false);
    expect(p({ imageFilter: { color: "teal" } }).get("colors")).toBe("turquoise");
    expect(p({ imageFilter: { color: "purple" } }).get("colors")).toBe("lilac");
    expect(p({ imageFilter: { color: "monochrome" } }).get("colors")).toBe("grayscale");
    expect(p({ imageFilter: { color: "any" } }).has("colors")).toBe(false);
  });

  test("safe search and language", () => {
    const p = (opts) => new URL(buildRequest(KEY, "x", 1, { ...options, ...opts }).url).searchParams;
    expect(p({ safe: false }).get("safesearch")).toBe("false");
    expect(p({ language: "de" }).get("lang")).toBe("de");
    expect(p({ language: "en" }).has("lang")).toBe(false);
    expect(p({ language: "xx" }).has("lang")).toBe(false);
    expect(languageOf("de-AT")).toBe("de");
    expect(languageOf("nb-NO")).toBe("no");
    expect(languageOf("zz")).toBe("");
    expect(languageOf(undefined)).toBe("");
  });

  test("the query is cut at 100 characters, by character", () => {
    const q = new URL(buildRequest(KEY, "é".repeat(150), 1, options).url).searchParams.get("q");
    expect(Array.from(q)).toHaveLength(100);
  });

  test("headers: honest User-Agent, no credential", () => {
    const headers = buildHeaders();
    expect(headers["User-Agent"]).toMatch(/^degoog-pixabay-engine\/1\.0 \(\+https:\/\/github\.com\/AromaticTurtle\//);
    expect(JSON.stringify(headers)).not.toContain(KEY);
    expect(headers.Authorization).toBeUndefined();
  });

  test("redact removes the key in every form", () => {
    expect(redact(`GET https://x/api/?key=${KEY}&q=a failed`, KEY)).not.toContain(KEY);
    expect(redact(`fetch failed for ${encodeURIComponent("a&b c")}`, "a&b c")).not.toContain("a%26b");
    expect(redact("https://x/?q=a&key=whatever&z=1", "")).toBe("https://x/?q=a&key=***&z=1");
    expect(redact(undefined, KEY)).toBe("");
  });
});

describe("parsing the reply", () => {
  const results = parseHits(fixture, "Pixabay");

  test("keeps the images with a page, a thumbnail and an image on pixabay.com", () => {
    expect(results.map((r) => r.url)).toEqual([
      "https://pixabay.com/photos/quillfern-meadow-900001/",
      "https://pixabay.com/illustrations/florbit-bell-900002/",
      "https://pixabay.com/vectors/lake-dawn-900003/",
      "https://pixabay.com/photos/plain-http-900007/",
      "https://pixabay.com/photos/no-user-900008/",
    ]);
  });

  test("the thumbnail is the 640 px webformat, the image the 1280 px one; full-access fields are never used", () => {
    expect(results[0].thumbnail).toBe("https://pixabay.com/get/aa900001_640.jpg");
    expect(results[0].imageUrl).toBe("https://pixabay.com/get/bb900001_1280.jpg");
    for (const r of results) {
      expect(r.imageUrl).not.toMatch(/cc900001|dd900001|ee900001|1920|\.svg$/);
    }
  });

  test("a hit with only a preview uses it for both", () => {
    expect(results[2].thumbnail).toBe("https://cdn.pixabay.com/photo/2026/01/03/00/00/lake-900003_150.png");
    expect(results[2].imageUrl).toBe(results[2].thumbnail);
  });

  test("http addresses are upgraded to https", () => {
    expect(results[3].url).toBe("https://pixabay.com/photos/plain-http-900007/");
    expect(results[3].thumbnail).toBe("https://pixabay.com/get/aa900007_640.jpg");
  });

  test("credit: contributor, profile address, 'via Pixabay', type and size", () => {
    expect(results[0].snippet).toBe("Photo by Test_Photographer (pixabay.com/users/Test_Photographer-4801) via Pixabay · 4000×2667");
    expect(results[1].snippet).toBe("Illustration by Invented-Artist (pixabay.com/users/Invented-Artist-4802) via Pixabay");
    expect(results[4].snippet).toBe("Image via Pixabay");
    for (const r of results) expect(r.snippet).toContain("Pixabay");
  });

  test("titles: the tags and the credit (degoog's image preview shows the title, not the snippet), with fallbacks", () => {
    expect(results[0].title).toBe("Quillfern, meadow, green — by Test_Photographer via Pixabay");
    expect(results[1].title).toBe("Florbit, bell, invented — by Invented-Artist via Pixabay");
    expect(results[2].title).toBe("Vector graphic by Some One via Pixabay");
    expect(results[3].title).toBe("Bold & tags — via Pixabay");
    expect(results[4].title).toBe("Image via Pixabay");
    for (const r of results) expect(r.title).toContain("via Pixabay");
    expect(results[3].snippet).toBe("Photo via Pixabay");
  });

  test("a profile label needs a safe name and a numeric id", () => {
    expect(profileLabel({ user: "a b", user_id: 1 })).toBe("");
    expect(profileLabel({ user: "ok", user_id: "7" })).toBe("");
    expect(profileLabel({ user: "ok", user_id: 7 })).toBe("pixabay.com/users/ok-7");
    expect(profileLabel(null)).toBe("");
  });

  test("result shape matches what Unsplash returns", () => {
    for (const r of results) expect(Object.keys(r).sort()).toEqual(["imageUrl", "snippet", "source", "thumbnail", "title", "url"]);
  });

  test("layout problems: null, no hits, empty list", () => {
    expect(parseHits(null, "Pixabay")).toBeNull();
    expect(parseHits({}, "Pixabay")).toBeNull();
    expect(parseHits({ hits: "nope" }, "Pixabay")).toBeNull();
    expect(parseHits({ total: 0, totalHits: 0, hits: [] }, "Pixabay")).toEqual([]);
    expect(parseHits({ hits: [null, 5, {}, { pageURL: 3 }] }, "Pixabay")).toEqual([]);
  });

  test("addresses of a mock host are kept only when it is listed", () => {
    const hit = { pageURL: "http://mock.local/p/1", webformatURL: "http://mock.local/i/1.jpg", user: "u", user_id: 1, tags: "t" };
    expect(parseHits({ hits: [hit] }, "Pixabay")).toEqual([]);
    expect(parseHits({ hits: [hit] }, "Pixabay", ["mock.local"])[0].thumbnail).toBe("http://mock.local/i/1.jpg");
  });

  test("totals", () => {
    expect(totalOf({ totalHits: 500, total: 4692 })).toBe(500);
    expect(totalOf({ total: 12 })).toBe(12);
    expect(totalOf({})).toBeUndefined();
  });
});

describe("the engine", () => {
  test("is an image engine with filters and the documented identity", () => {
    expect(type).toBe("images");
    expect(filters.layout).toEqual(["wide", "tall"]);
    const engine = make();
    expect(engine.name).toBe("Pixabay");
    expect(engine.bangShortcut).toBe("pixabay");
    expect(engine.settingsSchema).toBe(SETTINGS_SCHEMA);
  });

  test("makes one request with the key in the address, nothing in headers", async () => {
    const engine = make();
    const context = makeContext(ok());
    const results = await engine.executeSearch("quillfern", 1, "any", context);
    expect(results).toHaveLength(5);
    expect(context.calls).toHaveLength(1);
    const { url, init } = context.calls[0];
    expect(new URL(url).searchParams.get("key")).toBe(KEY);
    expect(new URL(url).searchParams.get("safesearch")).toBe("true");
    expect(JSON.stringify(init.headers)).not.toContain(KEY);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("no key: nothing is asked, quietly; the reason appears only with debugMatching", async () => {
    await withEnv("PIXABAY_API_KEY", undefined, async () => {
      const engine = make({});
      const context = makeContext(ok());
      const silent = await capture(async () => expect(await engine.executeSearch("x", 1, "any", context)).toEqual([]));
      expect(silent).toEqual([]);
      expect(context.calls).toHaveLength(0);
      const loud = make({ debugMatching: "true" });
      const lines = await capture(async () => expect(await loud.executeSearch("x", 1, "any", context)).toEqual([]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("no api key");
      expect(context.calls).toHaveLength(0);
    });
  });

  test("the key can come from PIXABAY_API_KEY; the setting wins", async () => {
    await withEnv("PIXABAY_API_KEY", "env-key-0123456789", async () => {
      const fromEnv = make({});
      const context = makeContext(ok());
      await fromEnv.executeSearch("x", 1, "any", context);
      expect(new URL(context.calls[0].url).searchParams.get("key")).toBe("env-key-0123456789");
      const both = make({ apiKey: KEY });
      const second = makeContext(ok());
      await both.executeSearch("x", 1, "any", second);
      expect(new URL(second.calls[0].url).searchParams.get("key")).toBe(KEY);
    });
  });

  test("an empty query asks nothing", async () => {
    const context = makeContext(ok());
    expect(await make().executeSearch("   ", 1, "any", context)).toEqual([]);
    expect(await make().executeSearch(undefined, 1, "any", context)).toEqual([]);
    expect(context.calls).toHaveLength(0);
  });

  test("the API base can be overridden from the environment", async () => {
    await withEnv("DEGOOG_PIXABAY_API_BASE", "http://mock.local:4470/pixabay/api", async () => {
      const engine = new PixabayEngine();
      expect(engine.apiBase).toBe("http://mock.local:4470/pixabay/api");
    });
    await withEnv("DEGOOG_PIXABAY_EXTRA_HOSTS", "mock.local, other.local", async () => {
      expect(new PixabayEngine().extraHosts).toEqual(["mock.local", "other.local"]);
    });
  });

  test("paging: the page parameter, and nothing asked beyond the 500 images Pixabay serves", async () => {
    const engine = make({ apiKey: KEY, perPage: "100" });
    const context = makeContext(ok());
    await engine.executeSearch("x", 3, "any", context);
    expect(new URL(context.calls[0].url).searchParams.get("page")).toBe("3");
    expect(await engine.executeSearch("x", 6, "any", context)).toEqual([]);
    expect(context.calls).toHaveLength(1);
    expect(MAX_HITS).toBe(500);
    // a bad page number is page 1
    await engine.executeSearch("y", "nonsense", "any", context);
    expect(new URL(context.calls[1].url).searchParams.has("page")).toBe(false);
  });

  test("Pixabay's 400 for a page out of range is an empty page, not an error", async () => {
    const engine = make();
    const context = makeContext(status(400, '[ERROR 400] "page" is out of valid range.'));
    expect(await engine.executeSearch("x", 2, "any", context)).toEqual([]);
  });

  test("pagination total is reported to degoog", async () => {
    const totals = [];
    await make().executeSearch("x", 1, "any", makeContext(ok(), { pagination: (info) => totals.push(info.total) }));
    expect(totals).toEqual([500]);
  });

  describe("safe search", () => {
    const sent = async (settings, imageFilter) => {
      const context = makeContext(ok(), { imageFilter });
      await make({ apiKey: KEY, ...settings }).executeSearch(`q${Math.random()}`, 1, "any", context);
      return new URL(context.calls[0].url).searchParams.get("safesearch");
    };
    test("always on by default, whatever degoog says", async () => {
      expect(await sent({}, undefined)).toBe("true");
      expect(await sent({}, { nsfw: "off" })).toBe("true");
      expect(await sent({ safeSearch: "always" }, { nsfw: "any" })).toBe("true");
    });
    test("'follow' asks for it when degoog's safe mode is on or moderate", async () => {
      expect(await sent({ safeSearch: "follow" }, { nsfw: "on" })).toBe("true");
      expect(await sent({ safeSearch: "follow" }, { nsfw: "moderate" })).toBe("true");
      expect(await sent({ safeSearch: "follow" }, { nsfw: "off" })).toBe("false");
      expect(await sent({ safeSearch: "follow" }, undefined)).toBe("false");
    });
  });

  describe("the 24 hour cache (Pixabay's terms)", () => {
    test("the same search again costs nothing; after 24 hours it asks again", async () => {
      const engine = make();
      let now = 1_000_000;
      engine.now = () => now;
      engine.cache = new ResultCache({ ttlMs: 24 * 3_600_000, max: 300, now: () => now });
      const context = makeContext(ok());
      await engine.executeSearch("quillfern", 1, "any", context);
      await engine.executeSearch("quillfern", 1, "any", context);
      expect(context.calls).toHaveLength(1);
      now += 24 * 3_600_000 - 1;
      await engine.executeSearch("quillfern", 1, "any", context);
      expect(context.calls).toHaveLength(1);
      now += 2;
      await engine.executeSearch("quillfern", 1, "any", context);
      expect(context.calls).toHaveLength(2);
    });

    test("the engine's own cache lives for 24 hours", () => {
      expect(make().cache.ttlMs).toBe(24 * 3_600_000);
    });

    test("another page, filter or setting is another entry", async () => {
      const engine = make();
      const context = makeContext(ok());
      await engine.executeSearch("a", 1, "any", context);
      await engine.executeSearch("a", 2, "any", context);
      await engine.executeSearch("a", 1, "any", { ...context, imageFilter: { layout: "wide" } });
      expect(context.calls).toHaveLength(3);
    });

    test("concurrent identical searches share one request", async () => {
      const engine = make();
      const context = makeContext(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify(fixture), { status: 200 });
      });
      const [a, b] = await Promise.all([engine.executeSearch("x", 1, "any", context), engine.executeSearch("x", 1, "any", context)]);
      expect(context.calls).toHaveLength(1);
      expect(a).toEqual(b);
    });

    test("a failed request is not cached", async () => {
      const engine = make();
      let fail = true;
      const context = makeContext(() => (fail ? new Response("x", { status: 200 }) : new Response(JSON.stringify(fixture))));
      await expect(engine.executeSearch("x", 1, "any", context)).rejects.toThrow();
      fail = false;
      expect(await engine.executeSearch("x", 1, "any", context)).toHaveLength(5);
    });

    test("cache keys never hold the key", async () => {
      const engine = make();
      await engine.executeSearch("x", 1, "any", makeContext(ok()));
      expect([...engine.cache.entries.keys()].length).toBe(1);
      for (const key of engine.cache.entries.keys()) expect(key).not.toContain(KEY);
    });
  });

  describe("failures and pauses", () => {
    test("429 pauses for the reset time with one warning, then asks nothing", async () => {
      const engine = make();
      const context = makeContext(status(429, "API rate limit exceeded", { "x-ratelimit-reset": "42", "x-ratelimit-remaining": "0" }));
      const lines = await capture(async () => {
        await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
      });
      expect(context.calls).toHaveLength(1);
      expect(engine.limiter.blockedFor()).toBeGreaterThan(40_000);
      expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(42_000);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("pauses for 42 s");
    });

    test("429 without a reset header pauses a minute; a huge reset is capped at five minutes", async () => {
      const engine = make();
      await capture(() => expect(engine.executeSearch("a", 1, "any", makeContext(status(429)))).rejects.toThrow());
      expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(60_000);
      const other = make();
      await capture(() => expect(other.executeSearch("a", 1, "any", makeContext(status(429, "", { "x-ratelimit-reset": "99999" })))).rejects.toThrow());
      expect(other.limiter.blockedFor()).toBeLessThanOrEqual(300_000);
    });

    test("a successful reply that says no requests remain pauses until the reset", async () => {
      const engine = make();
      expect(await engine.executeSearch("a", 1, "any", makeContext(ok({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "30" })))).toHaveLength(5);
      expect(engine.limiter.blockedFor()).toBeGreaterThan(0);
      await expect(engine.executeSearch("b", 1, "any", makeContext(ok()))).rejects.toMatchObject({ status: "rate_limited" });
    });

    test("401, 403 and the 400 for an unknown key: blocked, paused half an hour, one warning, the key never named", async () => {
      for (const code of [status(401, "unauthorized"), status(403, "forbidden"), status(400, "[ERROR 400] Invalid API key")]) {
        const engine = make();
        const context = makeContext(code);
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

    test("a plain 400 is an error without a pause", async () => {
      const engine = make();
      await expect(engine.executeSearch("a", 1, "any", makeContext(status(400, "something else")))).rejects.toMatchObject({ status: "network" });
      expect(engine.limiter.blockedFor()).toBe(0);
    });

    test("5xx pauses a minute", async () => {
      const engine = make();
      const context = makeContext(status(503));
      await capture(() => expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "network" }));
      await capture(() => expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
      expect(context.calls).toHaveLength(1);
    });

    test("not JSON, and a layout nobody expects, are parse errors", async () => {
      await expect(make().executeSearch("a", 1, "any", makeContext(() => new Response("<html>")))).rejects.toMatchObject({ status: "parse_error" });
      await expect(make().executeSearch("b", 1, "any", makeContext(() => new Response("{}")))).rejects.toMatchObject({ status: "parse_error" });
    });

    test("without degoog's helpers, plain errors are thrown", async () => {
      const engine = make();
      const context = { fetch: async () => new Response("x", { status: 500 }) };
      await capture(() => expect(engine.executeSearch("a", 1, "any", context)).rejects.toThrow("HTTP 500"));
    });

    test("without a context the global fetch is used (not called here: no key)", async () => {
      await withEnv("PIXABAY_API_KEY", undefined, async () => expect(await make({}).executeSearch("a", 1, "any")).toEqual([]));
    });
  });

  describe("the key never leaks", () => {
    const hostile = (url) => {
      throw new Error(`fetch failed: ${url}`);
    };

    test("a network error naming the address: the message, the log and the debug lines are clean", async () => {
      const engine = make({ apiKey: KEY, debugMatching: "true" });
      const context = makeContext(hostile);
      let caught;
      const lines = await capture(async () => {
        caught = await engine.executeSearch("quillfern", 1, "any", context).catch((error) => error);
      });
      expect(caught.status).toBe("network");
      expect(caught.message).not.toContain(KEY);
      expect(String(caught.stack ?? "")).not.toContain(KEY);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain(KEY);
        expect(line).not.toMatch(/https?:\/\//);
        expect(line).not.toContain("quillfern");
      }
    });

    test("every message for every status is clean", async () => {
      for (const make_response of [status(401), status(403), status(429), status(500), status(400, `Invalid API key ${KEY}`), ok(), () => new Response("{}"), () => new Response("not json")]) {
        const engine = make({ apiKey: KEY, debugMatching: "true" });
        const context = makeContext(make_response);
        const seen = [];
        const lines = await capture(async () => {
          try {
            seen.push(JSON.stringify(await engine.executeSearch("quillfern", 1, "any", context)));
          } catch (error) {
            seen.push(String(error.message));
          }
        });
        for (const text of [...seen, ...lines, ...[...engine.cache.entries.keys()]]) expect(text).not.toContain(KEY);
      }
    });

    test("results carry no key and the settings description says why", async () => {
      const results = await make().executeSearch("x", 1, "any", makeContext(ok()));
      expect(JSON.stringify(results)).not.toContain(KEY);
      expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey")).toMatchObject({ type: "password", secret: true });
      expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey").description).toContain("Without a key this engine does nothing");
    });
  });

  describe("budget and time rule", () => {
    test("the per-minute cap stops requests and says so", async () => {
      const engine = make({ apiKey: KEY, requestsPerMinute: "2" });
      const context = makeContext(ok());
      await engine.executeSearch("a", 1, "any", context);
      await engine.executeSearch("b", 1, "any", context);
      await capture(() => expect(engine.executeSearch("c", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" }));
      expect(context.calls).toHaveLength(2);
    });

    test("the cap can be turned off, and is clamped to 100", () => {
      const engine = make({ apiKey: KEY, requestsPerMinute: "0" });
      expect(engine.budget.windows[0].limit).toBe(0);
      expect(make({ apiKey: KEY, requestsPerMinute: "5000" }).budget.windows[0].limit).toBe(100);
      expect(make({ apiKey: KEY, requestsPerMinute: "x" }).budget.windows[0].limit).toBe(80);
    });

    test("the budget windows roll over", () => {
      let now = Date.UTC(2026, 9, 28, 12, 0, 30);
      const budget = new Budget({ windows: [{ name: "minute", unit: "minute", limit: 1 }, { name: "month", unit: "month", limit: 3 }], now: () => now });
      expect(budget.spend()).toBe(true);
      expect(budget.spend()).toBe(false);
      expect(budget.waitMs()).toBe(30_000);
      now += 31_000;
      expect(budget.spend()).toBe(true);
      expect(windowKey("month", now)).toBe("2026-10");
      expect(windowEnd("month", now)).toBe(Date.UTC(2026, 10, 1));
    });

    test("spacing: a request that would wait past 70 % of the slot is skipped", async () => {
      await withEnv("DEGOOG_SLOT_TIMEOUT_MS", "2000", async () => {
        const engine = make();
        engine.limiter = new Limiter({ minIntervalMs: 5000, maxWaitMs: 5000 });
        const context = makeContext(ok());
        await engine.executeSearch("a", 1, "any", context);
        await expect(engine.executeSearch("b", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
        expect(context.calls).toHaveLength(1);
      });
    });

    test("the window helpers: 70 % to start, 95 % to answer", () => {
      expect(slotTimeoutMs({})).toBe(10_000);
      expect(startWindowMs({})).toBe(7000);
      expect(answerWindowMs({})).toBe(9500);
      expect(startWindowMs({ DEGOOG_SLOT_TIMEOUT_MS: "20000" })).toBe(14000);
      expect(answerWindowMs({ DEGOOG_SLOT_TIMEOUT_MS: "20000" })).toBe(19000);
      expect(slotTimeoutMs({ DEGOOG_SLOT_TIMEOUT_MS: "junk" })).toBe(10_000);
      const outer = new AbortController();
      const signal = deadlineSignal(10_000, outer.signal);
      expect(signal.aborted).toBe(false);
      outer.abort();
      expect(signal.aborted).toBe(true);
    });

    test("a slow upstream is given up at the deadline with a timeout error", async () => {
      await withEnv("DEGOOG_SLOT_TIMEOUT_MS", "1000", async () => {
        const engine = make();
        const context = makeContext((url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })))));
        const started = Date.now();
        await expect(engine.executeSearch("a", 1, "any", context)).rejects.toMatchObject({ status: "timeout" });
        expect(Date.now() - started).toBeLessThan(2500);
        expect(engine.limiter.blockedFor()).toBe(0);
      });
    });
  });

  describe("settings", () => {
    test("defaults and clamping", () => {
      const engine = make({ apiKey: KEY, perPage: "1000", imageType: "bogus", orientation: "bogus", order: "bogus", safeSearch: "bogus" });
      expect(engine.perPage).toBe(100);
      expect(engine.imageType).toBe("all");
      expect(engine.orientation).toBe("all");
      expect(engine.order).toBe("popular");
      expect(engine.safeAlways).toBe(true);
      expect(make({ apiKey: KEY, perPage: "1" }).perPage).toBe(3);
      expect(make({ apiKey: KEY, perPage: "abc" }).perPage).toBe(30);
      expect(make({ apiKey: KEY, safeSearch: "follow" }).safeAlways).toBe(false);
    });

    test("the schema: a secret key field, safe search default on, advanced troubleshooting", () => {
      const keys = SETTINGS_SCHEMA.map((f) => f.key);
      expect(keys).toEqual(["apiKey", "safeSearch", "imageType", "orientation", "order", "language", "perPage", "requestsPerMinute", "debugMatching"]);
      expect(SETTINGS_SCHEMA.find((f) => f.key === "safeSearch").default).toBe("always");
      expect(SETTINGS_SCHEMA.find((f) => f.key === "debugMatching")).toMatchObject({ advanced: true, default: "false", type: "toggle" });
      expect(SETTINGS_SCHEMA.find((f) => f.key === "apiKey").default).toBeUndefined();
      for (const field of SETTINGS_SCHEMA) expect(field.description.length).toBeGreaterThan(20);
    });

    test("debugMatching writes one line per search: cache hit or request, count, no query, no key", async () => {
      const engine = make({ apiKey: KEY, debugMatching: "true" });
      const context = makeContext(ok());
      const lines = await capture(async () => {
        await engine.executeSearch("quillfern", 1, "any", context);
        await engine.executeSearch("quillfern", 1, "any", context);
      });
      expect(lines).toEqual(["[pixabay] page 1: requested, 5 images", "[pixabay] page 1: cache hit, 5 images"]);
    });
  });
});

afterEach(() => {});
