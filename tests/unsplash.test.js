import { describe, expect, test } from "bun:test";
import {
  buildApiHeaders,
  buildApiUrl,
  buildWebHeaders,
  buildWebUrl,
} from "../engines/unsplash/request.js";
import { parsePhotos } from "../engines/unsplash/parse.js";
import { Limiter } from "../engines/unsplash/limiter.js";
import UnsplashEngine, { filters, type } from "../engines/unsplash/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const fixture = await read("./fixtures/unsplash-search.json").json();
const OPTIONS = { perPage: 20 };

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });

const queue = (...makers) => {
  let index = 0;
  return () => makers[Math.min(index++, makers.length - 1)]();
};

const makeContext = (makeResponse, extra = {}) => {
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
    ...extra,
  };
};

const ok = () => new Response(JSON.stringify(fixture), { status: 200 });
const status = (code, body = "", headers = {}) => () => new Response(body, { status: code, headers });

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

const make = (settings = { accessKey: "access-key-1" }) => {
  const engine = new UnsplashEngine();
  engine.apiLimiter = new Limiter({ minIntervalMs: 0 });
  engine.webLimiter = new Limiter({ minIntervalMs: 0 });
  engine.apiBase = "https://api.test";
  engine.webBase = "https://web.test";
  engine.configure(settings);
  return engine;
};

describe("shared copies stay identical", () => {
  test("text.js, limiter.js and author.json match the OpenAlex copies", async () => {
    for (const file of ["text.js", "limiter.js", "author.json"]) {
      const [a, b] = await Promise.all(["openalex", "unsplash"].map((name) => read(`../engines/${name}/${file}`).text()));
      expect(b).toBe(a);
    }
  });
});

describe("request building", () => {
  test("API url carries the query, page size and mapped filters", () => {
    const url = new URL(buildApiUrl("red panda", 1, { ...OPTIONS, imageFilter: { layout: "wide", color: "pink", nsfw: "on" } }));
    expect(url.origin + url.pathname).toBe("https://api.unsplash.com/search/photos");
    expect(url.searchParams.get("query")).toBe("red panda");
    expect(url.searchParams.get("per_page")).toBe("20");
    expect(url.searchParams.has("page")).toBe(false);
    expect(url.searchParams.get("orientation")).toBe("landscape");
    expect(url.searchParams.get("color")).toBe("magenta");
    expect(url.searchParams.get("content_filter")).toBe("high");
  });

  test("later pages, unknown filters and moderate safe mode", () => {
    const url = new URL(buildApiUrl("x", 3, { ...OPTIONS, imageFilter: { layout: "weird", nsfw: "moderate" } }));
    expect(url.searchParams.get("page")).toBe("3");
    expect(url.searchParams.has("orientation")).toBe(false);
    expect(url.searchParams.has("content_filter")).toBe(false);
  });

  test("the website path differs and carries no key", () => {
    expect(buildWebUrl("x", 1, OPTIONS)).toStartWith("https://unsplash.com/napi/search/photos?");
    expect(buildWebHeaders().Authorization).toBeUndefined();
    expect(buildApiHeaders("k").Authorization).toBe("Client-ID k");
    expect(buildApiHeaders("k")["Accept-Version"]).toBe("v1");
  });

  test("a very long query is truncated", () => {
    expect(new URL(buildApiUrl("x".repeat(2000), 1, OPTIONS)).searchParams.get("query")).toHaveLength(500);
  });
});

describe("parsing", () => {
  test("keeps three valid photos with credit lines", () => {
    const results = parsePhotos(fixture, "Unsplash");
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "body of water near mountains",
      url: "https://unsplash.com/photos/a1",
      snippet: "Photo by Jane Doe on Unsplash — A quiet lake at dawn",
      source: "Unsplash",
      thumbnail: "https://images.unsplash.com/photo-1?ixid=AAA&w=400",
      imageUrl: "https://images.unsplash.com/photo-1?ixid=AAA&w=1080",
    });
  });

  test("upgrades http links, falls back to the full image, and builds a title", () => {
    const [, second, third] = parsePhotos(fixture, "Unsplash");
    expect(second.url).toBe("https://unsplash.com/photos/b2");
    expect(second.thumbnail).toBe("https://images.unsplash.com/photo-2?w=400");
    expect(second.imageUrl).toBe("https://images.unsplash.com/photo-2?q=75&fm=jpg");
    expect(second.title).toBe("Photo by Joe");
    expect(second.snippet).toBe("Photo by Joe on Unsplash");
    expect(third.snippet).toBe("Photo on Unsplash");
  });

  test("the ixid image parameter is preserved", () => {
    expect(parsePhotos(fixture, "Unsplash")[0].imageUrl).toContain("ixid=AAA");
  });

  test("hosts outside unsplash.com are rejected", () => {
    const urls = parsePhotos(fixture, "Unsplash").flatMap((r) => [r.url, r.thumbnail, r.imageUrl]);
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
  });

  test("an unrecognised layout is null", () => {
    expect(parsePhotos({}, "Unsplash")).toBeNull();
    expect(parsePhotos(null, "Unsplash")).toBeNull();
  });
});

describe("UnsplashEngine", () => {
  test("declares the images type, its filters, and the Anubis challenge", () => {
    expect(type).toBe("images");
    expect(Object.keys(filters)).toEqual(["layout", "color", "nsfw"]);
    expect(new UnsplashEngine().challenges).toContain("anubis");
  });

  test("with a key it uses the official API and keeps the key out of the URL", async () => {
    const ctx = makeContext(ok);
    const results = await make().executeSearch("lake", 1, "any", ctx);
    expect(results).toHaveLength(3);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].url).toStartWith("https://api.test/search/photos?");
    expect(ctx.calls[0].init.headers.Authorization).toBe("Client-ID access-key-1");
    expect(ctx.calls[0].url).not.toContain("access-key-1");
  });

  test("without a key it uses the website endpoint and sends no Authorization", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", undefined, async () => {
      const ctx = makeContext(ok);
      const results = await make({}).executeSearch("lake", 1, "any", ctx);
      expect(results).toHaveLength(3);
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0].url).toStartWith("https://web.test/napi/search/photos?");
      expect(ctx.calls[0].init.headers.Authorization).toBeUndefined();
    });
  });

  test("without a key and with the fallback off, it does nothing", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", undefined, async () => {
      const ctx = makeContext(ok);
      expect(await make({ webFallback: "false" }).executeSearch("lake", 1, "any", ctx)).toEqual([]);
      expect(ctx.calls).toHaveLength(0);
    });
  });

  test("when the API quota is hit it falls back within the same search, then stays on the website", async () => {
    const ctx = makeContext(queue(status(429), ok, ok));
    const engine = make();
    expect(await engine.executeSearch("lake", 1, "any", ctx)).toHaveLength(3);
    expect(ctx.calls.map((c) => new URL(c.url).origin)).toEqual(["https://api.test", "https://web.test"]);
    await engine.executeSearch("lake", 1, "any", ctx);
    expect(ctx.calls).toHaveLength(3);
    expect(new URL(ctx.calls[2].url).origin).toBe("https://web.test");
  });

  test("a 403 saying the rate limit was exceeded counts as quota", async () => {
    const ctx = makeContext(queue(status(403, "Rate Limit Exceeded"), ok));
    expect(await make().executeSearch("lake", 1, "any", ctx)).toHaveLength(3);
    expect(ctx.calls).toHaveLength(2);
  });

  test("quota with the fallback off is an error and later searches make no request", async () => {
    const ctx = makeContext(status(429));
    const engine = make({ accessKey: "k", webFallback: "false" });
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a rejected key is reported, not hidden by the fallback", async () => {
    const ctx = makeContext(status(401));
    await expect(make().executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("an empty quota header on a good response routes the next search to the website", async () => {
    const withHeader = () => new Response(JSON.stringify(fixture), { status: 200, headers: { "x-ratelimit-remaining": "0" } });
    const ctx = makeContext(queue(withHeader, ok));
    const engine = make();
    expect(await engine.executeSearch("lake", 1, "any", ctx)).toHaveLength(3);
    await engine.executeSearch("lake", 1, "any", ctx);
    expect(new URL(ctx.calls[1].url).origin).toBe("https://web.test");
  });

  test("a web page instead of JSON is an interstitial error", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", undefined, async () => {
      const ctx = makeContext(() => new Response("<html>checking your browser</html>", { status: 200 }));
      await expect(make({}).executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "interstitial" });
    });
  });

  test("a blocked website pauses further website requests", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", undefined, async () => {
      const ctx = makeContext(status(403));
      const engine = make({});
      await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toThrow();
      await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
      expect(ctx.calls).toHaveLength(1);
    });
  });

  test("the image filter reaches the request", async () => {
    const ctx = makeContext(ok, { imageFilter: { layout: "tall" } });
    await make().executeSearch("lake", 1, "any", ctx);
    expect(new URL(ctx.calls[0].url).searchParams.get("orientation")).toBe("portrait");
  });

  test("configure clamps, parses toggles, and uses the env key as a fallback", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", "env-key", async () => {
      const engine = new UnsplashEngine();
      engine.configure({ perPage: "500", webFallback: "false" });
      expect(engine.perPage).toBe(30);
      expect(engine.webFallback).toBe(false);
      expect(engine.accessKey).toBe("env-key");
      engine.configure({ perPage: "2", accessKey: "ui-key" });
      expect(engine.perPage).toBe(10);
      expect(engine.webFallback).toBe(true);
      expect(engine.accessKey).toBe("ui-key");
    });
  });
});
