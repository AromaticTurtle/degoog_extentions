import { describe, expect, test } from "bun:test";
import { buildHeaders, buildSearchUrl, cacheKey } from "../engines/mwmbl/request.js";
import { dropMashedText, parseResults } from "../engines/mwmbl/parse.js";
import { Limiter } from "../engines/mwmbl/limiter.js";
import MwmblEngine from "../engines/mwmbl/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const fixture = await read("./fixtures/mwmbl-search.json").json();
const KEY = "mwmbl-key-123";

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });

const makeContext = (makeResponse) => {
  const calls = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return makeResponse();
    },
    sentinel: (res, name) => {
      if (!res.ok) throw breach(res.status === 429 ? "rate_limited" : "blocked", `${name} ${res.status}`);
    },
    engineError: (status, message) => breach(status, message),
  };
};

const ok = () => new Response(JSON.stringify(fixture), { status: 200 });

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

const make = (settings = {}) => {
  const engine = new MwmblEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
  engine.apiBase = "https://api.test";
  engine.configure(settings);
  return engine;
};

describe("shared copies stay identical", () => {
  test("text.js, limiter.js and author.json match the OpenAlex copies", async () => {
    for (const file of ["text.js", "limiter.js", "author.json"]) {
      const [a, b] = await Promise.all(["openalex", "mwmbl"].map((name) => read(`../engines/${name}/${file}`).text()));
      expect(b).toBe(a);
    }
  });
});

describe("request building", () => {
  test("uses the v2 search endpoint", () => {
    expect(buildSearchUrl("linear b")).toBe("https://api.mwmbl.org/api/v2/search/?q=linear+b");
    expect(buildSearchUrl("x", "https://api.test///")).toBe("https://api.test/api/v2/search/?q=x");
    expect(new URL(buildSearchUrl("x".repeat(2000))).searchParams.get("q")).toHaveLength(500);
  });

  test("the key is sent as a header only when set", () => {
    expect(buildHeaders(KEY)["X-API-Key"]).toBe(KEY);
    expect(buildHeaders("")["X-API-Key"]).toBeUndefined();
  });

  test("the cache key ignores case and spacing", () => {
    expect(cacheKey("  Linear   B ")).toBe(cacheKey("linear b"));
  });
});

describe("parsing the real Mwmbl excerpt", () => {
  const results = parseResults(fixture, "Mwmbl");

  test("keeps every result with a title and a link", () => {
    expect(results).toHaveLength(6);
    expect(results.every((r) => r.source === "Mwmbl")).toBe(true);
    expect(results[0].title).toBe("Linear B");
    expect(results[0].url).toBe("https://en.wikipedia.org/wiki/Linear_B");
    expect(results[0].snippet).toStartWith("contains Linear B Unicode characters");
  });

  test("mashed text with the spaces stripped is cut off where the damage starts", () => {
    const linear = results.find((r) => r.url === "https://linear.app/");
    expect(linear.snippet).toBe("Linear is a purpose-built tool for planning and building…");
  });

  test("results Mwmbl has no description for keep an empty snippet", () => {
    const empty = results.filter((r) => r.snippet === "");
    expect(empty.map((r) => r.url)).toEqual([
      "https://el.wikipedia.org/wiki/Linear_B",
      "https://no.wikipedia.org/wiki/Linear_B",
    ]);
  });

  test("bad links, missing titles and duplicates are dropped; a bad layout is null", () => {
    const parsed = parseResults(
      {
        results: [
          { url: "ftp://x.test/a", title: "ftp", content: "" },
          { url: "https://x.test/b", title: "", content: "no title" },
          { url: "https://x.test/c", title: "Fine &amp; good", content: "ok" },
          { url: "https://x.test/c", title: "Duplicate", content: "dropped" },
          null,
        ],
      },
      "Mwmbl",
    );
    expect(parsed).toEqual([{ title: "Fine & good", url: "https://x.test/c", snippet: "ok", source: "Mwmbl" }]);
    expect(parseResults({}, "Mwmbl")).toBeNull();
    expect(parseResults(null, "Mwmbl")).toBeNull();
  });

  test("dropMashedText leaves normal text, links and long words with separators alone", () => {
    expect(dropMashedText("An ordinary sentence about things.")).toBe("An ordinary sentence about things.");
    expect(dropMashedText("see https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa now")).toContain("https://example.com");
    expect(dropMashedText("short words only and a well-known-long-hyphenated-compound ok")).toContain("compound");
    expect(dropMashedText("abcdefghijklmnopqrstuvwxyzabcdefghij is all junk")).toBe("");
  });
});

describe("MwmblEngine", () => {
  test("works without a key and sends no key header", async () => {
    await withEnv("MWMBL_API_KEY", undefined, async () => {
      const ctx = makeContext(ok);
      const results = await make().executeSearch("linear b", 1, "any", ctx);
      expect(results).toHaveLength(6);
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0].url).toBe("https://api.test/api/v2/search/?q=linear+b");
      expect(ctx.calls[0].init.headers["X-API-Key"]).toBeUndefined();
    });
  });

  test("a key goes in the header, never in the URL", async () => {
    const ctx = makeContext(ok);
    await make({ apiKey: KEY }).executeSearch("linear b", 1, "any", ctx);
    expect(ctx.calls[0].init.headers["X-API-Key"]).toBe(KEY);
    expect(ctx.calls[0].url).not.toContain(KEY);
  });

  test("later pages come from the cached response, not new requests", async () => {
    const ctx = makeContext(ok);
    const engine = make({ perPage: "5" });
    const page1 = await engine.executeSearch("linear b", 1, "any", ctx);
    const page2 = await engine.executeSearch("linear b", 2, "any", ctx);
    const page3 = await engine.executeSearch("linear b", 3, "any", ctx);
    expect(page1).toHaveLength(5);
    expect(page2).toHaveLength(1);
    expect(page3).toEqual([]);
    expect(ctx.calls).toHaveLength(1);
    expect(await engine.executeSearch("  Linear   B ", 1, "any", ctx)).toHaveLength(5);
    expect(ctx.calls).toHaveLength(1);
  });

  test("a different query makes a new request, and the cache expires after ten minutes", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    let t = 1_000_000;
    engine.now = () => t;
    await engine.executeSearch("linear b", 1, "any", ctx);
    await engine.executeSearch("something else", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(2);
    t += 9 * 60_000;
    await engine.executeSearch("linear b", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(2);
    t += 2 * 60_000;
    await engine.executeSearch("linear b", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(3);
  });

  test("identical simultaneous searches share one request", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    await Promise.all([1, 2, 3].map(() => engine.executeSearch("linear b", 1, "any", ctx)));
    expect(ctx.calls).toHaveLength(1);
  });

  test("the cache stays bounded", async () => {
    const ctx = makeContext(ok);
    const engine = make();
    for (let i = 0; i < 60; i++) await engine.executeSearch(`query ${i}`, 1, "any", ctx);
    expect(engine._cache.size).toBeLessThanOrEqual(50);
  });

  test("hiding results without a description", async () => {
    const ctx = makeContext(ok);
    const results = await make({ requireSnippet: "true" }).executeSearch("linear b", 1, "any", ctx);
    expect(results).toHaveLength(4);
    expect(results.every((r) => r.snippet)).toBe(true);
  });

  test("a per-second rate limit pauses the engine for about a minute", async () => {
    const ctx = makeContext(() => new Response("Rate limit exceeded: maximum 5 requests per second.", { status: 429 }));
    const engine = make();
    await expect(engine.executeSearch("one", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(engine.limiter.blockedFor()).toBeGreaterThan(55_000);
    expect(engine.limiter.blockedFor()).toBeLessThanOrEqual(60_000);
    await expect(engine.executeSearch("two", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a spent monthly quota pauses the engine for hours and says so", async () => {
    const body = "Monthly quota exceeded: your account allows 2,000 requests per month and you have used 2,000.";
    const ctx = makeContext(() => new Response(body, { status: 429 }));
    const engine = make({ apiKey: KEY });
    await expect(engine.executeSearch("one", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(engine.limiter.blockedFor()).toBeGreaterThan(5 * 3_600_000);
    await expect(engine.executeSearch("two", 1, "any", ctx)).rejects.toThrow(/monthly quota/);
    expect(ctx.calls).toHaveLength(1);
  });

  test("a rejected key is reported as blocked", async () => {
    const ctx = makeContext(() => new Response("Invalid API key.", { status: 401 }));
    await expect(make({ apiKey: KEY }).executeSearch("one", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
  });

  test("bad responses are parse errors and are not cached", async () => {
    const bad = makeContext(() => new Response("<html>", { status: 200 }));
    const engine = make();
    await expect(engine.executeSearch("one", 1, "any", bad)).rejects.toMatchObject({ status: "parse_error" });
    const wrongShape = makeContext(() => new Response(JSON.stringify({ nope: true }), { status: 200 }));
    await expect(engine.executeSearch("one", 1, "any", wrongShape)).rejects.toMatchObject({ status: "parse_error" });
    const good = makeContext(ok);
    expect(await engine.executeSearch("one", 1, "any", good)).toHaveLength(6);
  });

  test("an empty query makes no request", async () => {
    const ctx = makeContext(ok);
    expect(await make().executeSearch("   ", 1, "any", ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(0);
  });

  test("configure clamps, and the env key is a fallback with the setting winning", async () => {
    await withEnv("MWMBL_API_KEY", "env-key", async () => {
      const engine = new MwmblEngine();
      engine.configure({ perPage: "500" });
      expect(engine.perPage).toBe(50);
      expect(engine.apiKey).toBe("env-key");
      engine.configure({ perPage: "1", apiKey: "ui-key", requireSnippet: "true" });
      expect(engine.perPage).toBe(5);
      expect(engine.apiKey).toBe("ui-key");
      expect(engine.requireSnippet).toBe(true);
    });
  });
});
