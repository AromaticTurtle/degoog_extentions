import { describe, expect, test } from "bun:test";
import { buildApiHeaders, buildApiUrl } from "../engines/unsplash/request.js";
import { parsePhotos, profileLabel } from "../engines/unsplash/parse.js";
import { Limiter } from "../engines/unsplash/limiter.js";
import UnsplashEngine, { filters, type } from "../engines/unsplash/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const fixture = await read("./fixtures/unsplash-search.json").json();
const OPTIONS = { perPage: 20 };
const KEY = "access-key-1";

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });

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

const make = (settings = { accessKey: KEY }) => {
  const engine = new UnsplashEngine();
  engine.limiter = new Limiter({ minIntervalMs: 0 });
  engine.apiBase = "https://api.test";
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

describe("the engine only ever talks to the official API", () => {
  test("no source file mentions the website endpoint or a bot-check workaround", async () => {
    const files = ["index.js", "request.js", "parse.js", "settings.js"];
    const sources = await Promise.all(files.map((name) => read(`../engines/unsplash/${name}`).text()));
    const joined = sources.join("\n");
    expect(joined).not.toContain("napi");
    expect(joined.toLowerCase()).not.toContain("anubis");
    expect(joined).not.toContain("webFallback");
  });
});

describe("request building", () => {
  test("carries the query, page size and mapped filters", () => {
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

  test("headers use the Client-ID scheme", () => {
    expect(buildApiHeaders("k").Authorization).toBe("Client-ID k");
    expect(buildApiHeaders("k")["Accept-Version"]).toBe("v1");
  });

  test("a very long query is truncated", () => {
    expect(new URL(buildApiUrl("x".repeat(2000), 1, OPTIONS)).searchParams.get("query")).toHaveLength(500);
  });
});

describe("parsing", () => {
  test("keeps three valid photos with the credit and photographer profile", () => {
    const results = parsePhotos(fixture, "Unsplash");
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "body of water near mountains",
      url: "https://unsplash.com/photos/a1",
      snippet: "Photo by Jane Doe (unsplash.com/@janedoe) on Unsplash — A quiet lake at dawn",
      source: "Unsplash",
      thumbnail: "https://images.unsplash.com/photo-1?ixid=AAA&w=400",
      imageUrl: "https://images.unsplash.com/photo-1?ixid=AAA&w=1080",
    });
  });

  test("builds the profile from the username, upgrades http, falls back to the full image", () => {
    const [, second, third] = parsePhotos(fixture, "Unsplash");
    expect(second.url).toBe("https://unsplash.com/photos/b2");
    expect(second.thumbnail).toBe("https://images.unsplash.com/photo-2?w=400");
    expect(second.imageUrl).toBe("https://images.unsplash.com/photo-2?q=75&fm=jpg");
    expect(second.title).toBe("Photo by Joe");
    expect(second.snippet).toBe("Photo by Joe (unsplash.com/@joe) on Unsplash");
    expect(third.snippet).toBe("Photo on Unsplash");
  });

  test("profileLabel accepts only sane, unsplash.com profile paths", () => {
    expect(profileLabel({ links: { html: "http://unsplash.com/@ugmonk" } })).toBe("unsplash.com/@ugmonk");
    expect(profileLabel({ username: "a_b.c-d" })).toBe("unsplash.com/@a_b.c-d");
    expect(profileLabel({ username: "bad name<script>" })).toBe("");
    expect(profileLabel({ links: { html: "https://evil.example/@x" }, username: "ok" })).toBe("unsplash.com/@ok");
    expect(profileLabel(null)).toBe("");
  });

  test("the ixid image parameter is preserved and foreign hosts are rejected", () => {
    const results = parsePhotos(fixture, "Unsplash");
    expect(results[0].imageUrl).toContain("ixid=AAA");
    const urls = results.flatMap((r) => [r.url, r.thumbnail, r.imageUrl]);
    expect(urls.some((u) => u.includes("evil.example"))).toBe(false);
  });

  test("an unrecognised layout is null", () => {
    expect(parsePhotos({}, "Unsplash")).toBeNull();
    expect(parsePhotos(null, "Unsplash")).toBeNull();
  });
});

describe("UnsplashEngine", () => {
  test("declares the images type and its filters", () => {
    expect(type).toBe("images");
    expect(Object.keys(filters)).toEqual(["layout", "color", "nsfw"]);
    expect(new UnsplashEngine().challenges).toBeUndefined();
  });

  test("with a key it uses the API and keeps the key out of the URL", async () => {
    const ctx = makeContext(ok);
    const results = await make().executeSearch("lake", 1, "any", ctx);
    expect(results).toHaveLength(3);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].url).toStartWith("https://api.test/search/photos?");
    expect(ctx.calls[0].init.headers.Authorization).toBe(`Client-ID ${KEY}`);
    expect(ctx.calls[0].url).not.toContain(KEY);
  });

  test("without a key it does nothing and makes no request", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", undefined, async () => {
      const ctx = makeContext(ok);
      expect(await make({}).executeSearch("lake", 1, "any", ctx)).toEqual([]);
      expect(ctx.calls).toHaveLength(0);
    });
  });

  test("an empty query makes no request", async () => {
    const ctx = makeContext(ok);
    expect(await make().executeSearch("   ", 1, "any", ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(0);
  });

  test("a spent quota (429) is an error, and later searches make no request", async () => {
    const ctx = makeContext(status(429));
    const engine = make();
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a 403 saying the rate limit was exceeded counts as the quota", async () => {
    const ctx = makeContext(status(403, "Rate Limit Exceeded"));
    const engine = make();
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(engine.limiter.blockedFor()).toBeGreaterThan(9 * 60 * 1000);
  });

  test("another 403 is reported as blocked and does not pause the engine", async () => {
    const ctx = makeContext(status(403, "Forbidden"));
    const engine = make();
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
    expect(engine.limiter.blockedFor()).toBe(0);
  });

  test("a rejected key is reported as blocked", async () => {
    const ctx = makeContext(status(401));
    await expect(make().executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
  });

  test("an empty quota header on a good response pauses the next search", async () => {
    const withHeader = () => new Response(JSON.stringify(fixture), { status: 200, headers: { "x-ratelimit-remaining": "0" } });
    const ctx = makeContext(withHeader);
    const engine = make();
    expect(await engine.executeSearch("lake", 1, "any", ctx)).toHaveLength(3);
    await expect(engine.executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a body that is not JSON is a parse error", async () => {
    const ctx = makeContext(() => new Response("<html>nope</html>", { status: 200 }));
    await expect(make().executeSearch("lake", 1, "any", ctx)).rejects.toMatchObject({ status: "parse_error" });
  });

  test("the image filter reaches the request", async () => {
    const ctx = makeContext(ok, { imageFilter: { layout: "tall" } });
    await make().executeSearch("lake", 1, "any", ctx);
    expect(new URL(ctx.calls[0].url).searchParams.get("orientation")).toBe("portrait");
  });

  test("configure clamps and uses the env key as a fallback, with the setting winning", async () => {
    await withEnv("UNSPLASH_ACCESS_KEY", "env-key", async () => {
      const engine = new UnsplashEngine();
      engine.configure({ perPage: "500" });
      expect(engine.perPage).toBe(30);
      expect(engine.accessKey).toBe("env-key");
      engine.configure({ perPage: "2", accessKey: "ui-key" });
      expect(engine.perPage).toBe(10);
      expect(engine.accessKey).toBe("ui-key");
    });
  });
});
