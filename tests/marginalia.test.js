import { describe, expect, test } from "bun:test";
import { buildSearchUrl, clampInt } from "../engines/marginalia/request.js";
import { parseResults } from "../engines/marginalia/parse.js";
import { Limiter, retryAfterMs } from "../engines/marginalia/limiter.js";
import MarginaliaEngine from "../engines/marginalia/index.js";

const fixture = await Bun.file(new URL("./fixtures/marginalia-search.json", import.meta.url)).json();
const OPTIONS = { count: 20, maxPerDomain: 2, reduceExplicit: false };
const KEY = "test-key-123";

const fakeClock = () => {
  let t = 0;
  return {
    now: () => t,
    wait: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
};

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

const okResponse = () => new Response(JSON.stringify(fixture), { status: 200 });

const makeEngine = (settings = { apiKey: KEY }) => {
  const engine = new MarginaliaEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
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

describe("buildSearchUrl", () => {
  test("page 1 has no page param, later pages do", () => {
    expect(new URL(buildSearchUrl("a", 1, OPTIONS)).searchParams.has("page")).toBe(false);
    expect(new URL(buildSearchUrl("a", 3, OPTIONS)).searchParams.get("page")).toBe("3");
  });

  test("dc only when maxPerDomain > 0, nsfw only when reduceExplicit", () => {
    const plain = new URL(buildSearchUrl("a", 1, { ...OPTIONS, maxPerDomain: 0 })).searchParams;
    expect(plain.has("dc")).toBe(false);
    expect(plain.has("nsfw")).toBe(false);
    const full = new URL(buildSearchUrl("a", 1, { ...OPTIONS, reduceExplicit: true })).searchParams;
    expect(full.get("dc")).toBe("2");
    expect(full.get("nsfw")).toBe("1");
    expect(full.get("count")).toBe("20");
  });

  test("encodes the query and tolerates a trailing slash on the base", () => {
    const url = buildSearchUrl("c++ & more", 1, OPTIONS, "https://x.test///");
    expect(url.startsWith("https://x.test/search?")).toBe(true);
    expect(new URL(url).searchParams.get("query")).toBe("c++ & more");
  });
});

describe("clampInt", () => {
  test("clamps and falls back", () => {
    expect(clampInt("500", 1, 100, 20)).toBe(100);
    expect(clampInt("0", 1, 100, 20)).toBe(1);
    expect(clampInt("abc", 1, 100, 20)).toBe(20);
    expect(clampInt(undefined, 0, 100, 2)).toBe(2);
  });
});

describe("parseResults", () => {
  test("keeps two valid results and cleans text", () => {
    const results = parseResults(fixture, "Marginalia");
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe("Linear B & Mycenaean Greek");
    expect(results[0].snippet).toBe("An overview of the script 'Linear B'.");
    expect(results[0].source).toBe("Marginalia");
  });

  test("returns null for an unrecognised layout", () => {
    expect(parseResults({}, "Marginalia")).toBeNull();
    expect(parseResults(null, "Marginalia")).toBeNull();
  });
});

describe("Limiter", () => {
  test("spaces consecutive requests", async () => {
    const clock = fakeClock();
    const limiter = new Limiter({ minIntervalMs: 1000, maxWaitMs: 5000, ...clock });
    expect(await limiter.acquire()).toBe(true);
    expect(clock.now()).toBe(0);
    expect(await limiter.acquire()).toBe(true);
    expect(clock.now()).toBe(1000);
    expect(await limiter.acquire()).toBe(true);
    expect(clock.now()).toBe(2000);
  });

  test("refuses when the wait would be too long", async () => {
    const limiter = new Limiter({ minIntervalMs: 1000, maxWaitMs: 5000, now: () => 0, wait: async () => {} });
    for (let i = 0; i < 6; i++) expect(await limiter.acquire()).toBe(true);
    expect(await limiter.acquire()).toBe(false);
  });

  test("penalty blocks and then decays", () => {
    const clock = fakeClock();
    const limiter = new Limiter({ now: clock.now });
    expect(limiter.blockedFor()).toBe(0);
    limiter.penalize(30_000);
    expect(limiter.blockedFor()).toBe(30_000);
    clock.advance(10_000);
    expect(limiter.blockedFor()).toBe(20_000);
    clock.advance(25_000);
    expect(limiter.blockedFor()).toBe(0);
  });

  test("retryAfterMs parses seconds, falls back, and caps", () => {
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("garbage")).toBe(60_000);
    expect(retryAfterMs(undefined)).toBe(60_000);
    expect(retryAfterMs("0")).toBe(60_000);
    expect(retryAfterMs("99999")).toBe(600_000);
  });
});

describe("MarginaliaEngine", () => {
  test("without a key it returns nothing and makes no request", async () => {
    await withEnv("MARGINALIA_API_KEY", undefined, async () => {
      const ctx = makeContext(okResponse);
      const engine = makeEngine({});
      expect(await engine.executeSearch("linear b", 1, "any", ctx)).toEqual([]);
      expect(ctx.calls).toHaveLength(0);
    });
  });

  test("one request per search, key only in the header", async () => {
    const ctx = makeContext(okResponse);
    const results = await makeEngine().executeSearch("linear b", 1, "any", ctx);
    expect(results).toHaveLength(2);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].init.headers["API-Key"]).toBe(KEY);
    expect(ctx.calls[0].url).not.toContain(KEY);
  });

  test("a 429 pauses the engine and later searches make no request", async () => {
    const ctx = makeContext(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    const engine = makeEngine();
    await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toThrow();
    expect(ctx.calls).toHaveLength(1);
    expect(engine.limiter.blockedFor()).toBeGreaterThan(25_000);
    await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a body that is not JSON is a parse error", async () => {
    const ctx = makeContext(() => new Response("not json", { status: 200 }));
    await expect(makeEngine().executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "parse_error" });
  });

  test("configure clamps and falls back", async () => {
    await withEnv("MARGINALIA_API_KEY", undefined, async () => {
      const engine = new MarginaliaEngine();
      engine.configure({ count: "500", maxPerDomain: "abc", reduceExplicit: "true" });
      expect(engine.count).toBe(100);
      expect(engine.maxPerDomain).toBe(2);
      expect(engine.reduceExplicit).toBe(true);
    });
  });

  test("MARGINALIA_API_KEY is used when the setting is empty, and the setting wins", async () => {
    await withEnv("MARGINALIA_API_KEY", "env-key-456", async () => {
      const engine = new MarginaliaEngine();
      engine.configure({ apiKey: "" });
      expect(engine.apiKey).toBe("env-key-456");
      engine.configure({ apiKey: "ui-key-789" });
      expect(engine.apiKey).toBe("ui-key-789");
    });
  });
});
