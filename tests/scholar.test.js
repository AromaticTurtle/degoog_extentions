import { describe, expect, test } from "bun:test";
import {
  authorLine,
  buildSnippet,
  citationLabel,
  cleanText,
  doiUrl,
  isoDay,
  truncate,
} from "../engines/openalex/text.js";
import { buildHeaders, buildSearchUrl, dateFilters } from "../engines/openalex/request.js";
import { pauseFromHeaders } from "../engines/openalex/budget.js";
import { parseWorks, reconstructAbstract } from "../engines/openalex/parse.js";
import { Limiter } from "../engines/openalex/limiter.js";
import OpenAlexEngine, { type as openAlexType } from "../engines/openalex/index.js";
import {
  buildHeaders as coreHeaders,
  buildSearchUrl as coreUrl,
} from "../engines/core/request.js";
import { parseWorks as parseCore } from "../engines/core/parse.js";
import CoreEngine, { type as coreType } from "../engines/core/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const openAlexFixture = await read("./fixtures/openalex-search.json").json();
const coreFixture = await read("./fixtures/core-search.json").json();

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

const json = (body, init = {}) => () => new Response(JSON.stringify(body), { status: 200, ...init });

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

const fastLimiter = () => new Limiter({ minIntervalMs: 0 });

describe("shared copies stay identical", () => {
  test("limiter.js is the same in every engine", async () => {
    const [a, b, c] = await Promise.all(
      ["marginalia", "openalex", "core"].map((name) => read(`../engines/${name}/limiter.js`).text()),
    );
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test("text.js and author.json match between the scholar engines", async () => {
    for (const file of ["text.js", "author.json"]) {
      const [a, b] = await Promise.all(["openalex", "core"].map((name) => read(`../engines/${name}/${file}`).text()));
      expect(b).toBe(a);
    }
  });
});

describe("text helpers", () => {
  test("cleanText strips tags, decodes entities and collapses spaces", () => {
    expect(cleanText("A <b>CORE</b> &amp; \n more  text")).toBe("A CORE & more text");
    expect(cleanText(null)).toBe("");
  });

  test("truncate cuts on a word boundary", () => {
    expect(truncate("short", 20)).toBe("short");
    expect(truncate("one two three four", 10)).toBe("one two…");
  });

  test("doiUrl normalises and rejects junk", () => {
    expect(doiUrl("https://doi.org/10.1038/NATURE14539")).toBe("https://doi.org/10.1038/nature14539");
    expect(doiUrl("doi: 10.1234/abc")).toBe("https://doi.org/10.1234/abc");
    expect(doiUrl("10.1234/abc")).toBe("https://doi.org/10.1234/abc");
    expect(doiUrl("not a doi")).toBe("");
    expect(doiUrl(null)).toBe("");
  });

  test("citationLabel, authorLine, isoDay, buildSnippet", () => {
    expect(citationLabel(0)).toBe("");
    expect(citationLabel(1)).toBe("1 citation");
    expect(citationLabel(7)).toBe("7 citations");
    expect(authorLine(["A", "B"])).toBe("A, B");
    expect(authorLine(["A", "B", "C", "D"])).toBe("A, B, C et al.");
    expect(authorLine([])).toBe("");
    expect(isoDay("2019-06-01T00:00:00")).toBe("2019-06-01");
    expect(isoDay("2020-03")).toBeUndefined();
    expect(buildSnippet(["a", "", "b"], "text")).toBe("a · b — text");
    expect(buildSnippet([], "text")).toBe("text");
    expect(buildSnippet(["a"], "")).toBe("a");
  });
});

describe("OpenAlex request", () => {
  test("page 1 has no page param and asks for few fields", () => {
    const params = new URL(buildSearchUrl("dna", 1, { perPage: 10 })).searchParams;
    expect(params.get("search")).toBe("dna");
    expect(params.get("per_page")).toBe("10");
    expect(params.has("page")).toBe(false);
    expect(params.has("filter")).toBe(false);
    expect(params.get("select")).toContain("abstract_inverted_index");
    expect(params.get("select")).not.toContain("referenced_works");
    expect(new URL(buildSearchUrl("dna", 3, { perPage: 10 })).searchParams.get("page")).toBe("3");
  });

  test("filters combine and an invalid language is ignored", () => {
    const filter = (options) => new URL(buildSearchUrl("q", 1, { perPage: 10, ...options })).searchParams.get("filter");
    expect(filter({ openAccessOnly: true, language: "EN", dateFilters: ["from_publication_date:2026-01-01"] })).toBe(
      "is_oa:true,language:en,from_publication_date:2026-01-01",
    );
    expect(filter({ language: "english" })).toBeNull();
  });

  test("a very long query is truncated", () => {
    const search = new URL(buildSearchUrl("x".repeat(5000), 1, { perPage: 10 })).searchParams.get("search");
    expect(search).toHaveLength(1000);
  });

  test("dateFilters maps the time filter", () => {
    const now = Date.UTC(2026, 9, 25);
    expect(dateFilters("week", {}, now)).toEqual(["from_publication_date:2026-10-18"]);
    expect(dateFilters("any", {}, now)).toEqual([]);
    expect(dateFilters("custom", { dateFrom: "2020-01-01", dateTo: "2020-12-31" }, now)).toEqual([
      "from_publication_date:2020-01-01",
      "to_publication_date:2020-12-31",
    ]);
  });

  test("the key is sent as a bearer token only when set", () => {
    expect(buildHeaders("k").Authorization).toBe("Bearer k");
    expect(buildHeaders("").Authorization).toBeUndefined();
  });
});

describe("OpenAlex budget", () => {
  test("an exhausted budget pauses until reset, capped at six hours", () => {
    expect(pauseFromHeaders(200, new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "3600" }))).toBe(3_600_000);
    expect(pauseFromHeaders(429, new Headers({ "x-ratelimit-remaining": "0" }))).toBe(3_600_000);
    expect(pauseFromHeaders(200, new Headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "99999" }))).toBe(21_600_000);
  });

  test("a healthy response does not pause, a 429 does", () => {
    expect(pauseFromHeaders(200, new Headers({ "x-ratelimit-remaining": "5" }))).toBe(0);
    expect(pauseFromHeaders(200, new Headers())).toBe(0);
    expect(pauseFromHeaders(429, new Headers({ "retry-after": "20" }))).toBe(20_000);
    expect(pauseFromHeaders(429, new Headers())).toBe(10_000);
  });
});

describe("OpenAlex parsing", () => {
  test("rebuilds an abstract from the inverted index", () => {
    expect(reconstructAbstract({ Deep: [0], learning: [1], allows: [2], "R&amp;D": [3] })).toBe("Deep learning allows R&D");
    expect(reconstructAbstract(null)).toBe("");
    expect(reconstructAbstract({ a: [99999999] })).toBe("");
  });

  test("keeps two valid works and skips the rest", () => {
    const results = parseWorks(openAlexFixture, "OpenAlex");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "Deep learning",
      url: "https://doi.org/10.1038/nature14539",
      snippet:
        "Yann LeCun, Yoshua Bengio, Geoffrey Hinton et al. · Nature · 2015 · 60000 citations · Open access — Deep learning allows R&D",
      source: "OpenAlex",
      publishedAt: "2015-05-28",
    });
    expect(results[1].title).toBe("Fallback title");
    expect(results[1].url).toBe("https://openalex.org/W2");
    expect(results[1].snippet).toBe("2020 · 1 citation");
    expect(results[1].publishedAt).toBeUndefined();
  });

  test("returns null for an unrecognised layout", () => {
    expect(parseWorks({}, "OpenAlex")).toBeNull();
    expect(parseWorks(null, "OpenAlex")).toBeNull();
  });
});

describe("OpenAlexEngine", () => {
  const make = (settings = {}) => {
    const engine = new OpenAlexEngine();
    engine.limiter = fastLimiter();
    engine.configure(settings);
    return engine;
  };

  test("declares the scholar tab", () => {
    expect(openAlexType).toBe("scholar");
  });

  test("works without a key and sends no Authorization header", async () => {
    await withEnv("OPENALEX_API_KEY", undefined, async () => {
      const ctx = makeContext(json(openAlexFixture));
      const results = await make().executeSearch("deep learning", 1, "any", ctx);
      expect(results).toHaveLength(2);
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0].init.headers.Authorization).toBeUndefined();
    });
  });

  test("a key goes in the header, never in the URL", async () => {
    const ctx = makeContext(json(openAlexFixture));
    await make({ apiKey: "secret-key-1" }).executeSearch("q", 1, "any", ctx);
    expect(ctx.calls[0].init.headers.Authorization).toBe("Bearer secret-key-1");
    expect(ctx.calls[0].url).not.toContain("secret-key-1");
  });

  test("passes language and time filters through", async () => {
    const ctx = makeContext(json(openAlexFixture), { lang: "de" });
    await make({ openAccessOnly: "true" }).executeSearch("q", 2, "year", ctx);
    const url = new URL(ctx.calls[0].url);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("filter")).toContain("is_oa:true");
    expect(url.searchParams.get("filter")).toContain("language:de");
    expect(url.searchParams.get("filter")).toContain("from_publication_date:");
  });

  test("an exhausted daily budget stops further requests", async () => {
    const ctx = makeContext(() => new Response("{}", { status: 429, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "7200" } }));
    const engine = make();
    await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toThrow();
    expect(engine.limiter.blockedFor()).toBeGreaterThan(7_000_000);
    await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a rejected key is reported as blocked", async () => {
    const ctx = makeContext(() => new Response("{}", { status: 403 }));
    await expect(make({ apiKey: "k" }).executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "blocked" });
  });

  test("bad JSON is a parse error and an empty query makes no request", async () => {
    const bad = makeContext(() => new Response("nope", { status: 200 }));
    await expect(make().executeSearch("q", 1, "any", bad)).rejects.toMatchObject({ status: "parse_error" });
    const ctx = makeContext(json(openAlexFixture));
    expect(await make().executeSearch("   ", 1, "any", ctx)).toEqual([]);
    expect(ctx.calls).toHaveLength(0);
  });

  test("configure clamps, and the env key is a fallback", async () => {
    await withEnv("OPENALEX_API_KEY", "env-key", async () => {
      const engine = new OpenAlexEngine();
      engine.configure({ perPage: "500" });
      expect(engine.perPage).toBe(50);
      expect(engine.apiKey).toBe("env-key");
      engine.configure({ apiKey: "ui-key", perPage: "abc" });
      expect(engine.apiKey).toBe("ui-key");
      expect(engine.perPage).toBe(10);
    });
  });
});

describe("CORE request", () => {
  test("offset is derived from the page and the key is a bearer token", () => {
    const first = new URL(coreUrl("dna", 1, { perPage: 10 })).searchParams;
    expect(first.get("q")).toBe("dna");
    expect(first.get("limit")).toBe("10");
    expect(first.has("offset")).toBe(false);
    expect(new URL(coreUrl("dna", 3, { perPage: 10 })).searchParams.get("offset")).toBe("20");
    expect(coreUrl("dna", 1, { perPage: 10 })).toContain("/v3/search/works/?");
    expect(coreHeaders("k").Authorization).toBe("Bearer k");
  });
});

describe("CORE parsing", () => {
  test("keeps two usable works, ignores fullText", () => {
    const results = parseCore(coreFixture, "CORE");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "A CORE paper",
      url: "https://doi.org/10.1234/abc.5",
      snippet:
        "Ada Lovelace, Alan Turing · Journal of Tests · 2019 · 5 citations · Full text — An abstract with spacing & entities.",
      source: "CORE",
      publishedAt: "2019-06-01",
    });
    expect(results[1].url).toBe("https://core.ac.uk/works/789");
    expect(results[1].snippet).toBe("2021");
    expect(JSON.stringify(results)).not.toContain("huge in real responses");
  });

  test("returns null for an unrecognised layout", () => {
    expect(parseCore({}, "CORE")).toBeNull();
  });
});

describe("CoreEngine", () => {
  const make = (settings = { apiKey: "core-key-1" }) => {
    const engine = new CoreEngine();
    engine.limiter = fastLimiter();
    engine.configure(settings);
    return engine;
  };

  test("declares the scholar tab and paces itself to CORE's quota", () => {
    expect(coreType).toBe("scholar");
    expect(new CoreEngine().limiter.minIntervalMs).toBeGreaterThanOrEqual(2000);
  });

  test("without a key it does nothing", async () => {
    await withEnv("CORE_API_KEY", undefined, async () => {
      const ctx = makeContext(json(coreFixture));
      expect(await make({}).executeSearch("q", 1, "any", ctx)).toEqual([]);
      expect(ctx.calls).toHaveLength(0);
    });
  });

  test("one request per search with the key in the header only", async () => {
    const ctx = makeContext(json(coreFixture));
    const results = await make().executeSearch("q", 1, "any", ctx);
    expect(results).toHaveLength(2);
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0].init.headers.Authorization).toBe("Bearer core-key-1");
    expect(ctx.calls[0].url).not.toContain("core-key-1");
  });

  test("a 429 pauses the engine", async () => {
    const ctx = makeContext(() => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    const engine = make();
    await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toThrow();
    await expect(engine.executeSearch("q", 1, "any", ctx)).rejects.toMatchObject({ status: "rate_limited" });
    expect(ctx.calls).toHaveLength(1);
  });

  test("a rejected key is blocked and bad JSON is a parse error", async () => {
    const denied = makeContext(() => new Response("", { status: 401 }));
    await expect(make().executeSearch("q", 1, "any", denied)).rejects.toMatchObject({ status: "blocked" });
    const bad = makeContext(() => new Response("nope", { status: 200 }));
    await expect(make().executeSearch("q", 1, "any", bad)).rejects.toMatchObject({ status: "parse_error" });
  });

  test("configure clamps and the env key is a fallback", async () => {
    await withEnv("CORE_API_KEY", "env-core", async () => {
      const engine = new CoreEngine();
      engine.configure({ perPage: "5" });
      expect(engine.perPage).toBe(10);
      expect(engine.apiKey).toBe("env-core");
      engine.configure({ perPage: "500", apiKey: "ui-core" });
      expect(engine.perPage).toBe(50);
      expect(engine.apiKey).toBe("ui-core");
    });
  });
});
