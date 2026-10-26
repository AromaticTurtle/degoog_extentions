import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILES, DirectoryStore } from "../engines/selfhst/data.js";
import { buildSnippet, decodeApps, starsLabel, toResult } from "../engines/selfhst/parse.js";
import { alternativeTarget, searchApps } from "../engines/selfhst/search.js";
import SelfhstEngine, { type } from "../engines/selfhst/index.js";

const fixtureDir = new URL("./fixtures/selfhst/", import.meta.url);
const raw = {};
for (const name of FILES) raw[name] = await Bun.file(new URL(`${name}.json`, fixtureDir)).json();
const apps = decodeApps(raw);
const byName = (name) => apps.find((app) => app.name === name);
const names = (list) => list.map((app) => app.name);

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhst-test-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });

const makeServer = () => {
  const server = { calls: [], fail: 0, version: "v1", bodies: {} };
  server.fetch = async (url, init) => {
    const name = url.split("/").pop().replace(".json", "");
    server.calls.push({ name, url, headers: init?.headers ?? {} });
    if (server.fail) return new Response("error", { status: server.fail });
    const etag = `"${server.version}-${name}"`;
    if (init?.headers?.["If-None-Match"] === etag) return new Response(null, { status: 304 });
    const body = server.bodies[name] ?? raw[name];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { etag } });
  };
  return server;
};

const clock = (start = 1_000_000) => {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => (state.t += ms) };
};
const HOUR = 3_600_000;

describe("shared copies stay identical", () => {
  test("text.js and author.json match the OpenAlex copies", async () => {
    for (const file of ["text.js", "author.json"]) {
      const [a, b] = await Promise.all(
        ["openalex", "selfhst"].map((name) => Bun.file(new URL(`../engines/${name}/${file}`, import.meta.url)).text()),
      );
      expect(b).toBe(a);
    }
  });
});

describe("decoding the real selfh.st layout", () => {
  test("decodes every fixture row", () => {
    expect(apps).toHaveLength(12);
  });

  test("n8n has its licence, language, tags, alternatives and links", () => {
    const n8n = byName("n8n");
    expect(n8n).toMatchObject({
      license: "Custom",
      language: "TypeScript",
      stars: 204052,
      forks: 60640,
      updated: "2026-09-12",
      activity: "G",
      tags: ["Workflow Automation"],
      alternatives: ["IFTTT", "Zapier"],
      website: "https://n8n.io/",
      repo: "https://github.com/n8n-io/n8n",
      icon: "n8n",
      closed: false,
    });
  });

  test("an icon override, a missing scheme, and a closed app without dates or icon", () => {
    expect(byName("Radarr").icon).toBe("radarr-light-hybrid");
    expect(byName("WatchYourLAN").website).toBe("https://github.com/aceberg/WatchYourLAN");
    const webcap = byName("Webcap");
    expect(webcap).toMatchObject({ closed: true, repo: "", website: "https://rubyup.dev/webcap", updated: "", icon: "", license: "", language: "" });
    expect(byName("Panora").icon).toBe("");
  });

  test("malformed, duplicate and linkless rows are skipped, bad indexes are safe", () => {
    const good = ["9", "Okay", "okay", "okay.dev", "", "desc", "GitHub", "99", "99", "None", "", "", "", "5", "1", "2026-01-01", "G", [], [], "", "", "", ""];
    const noLinks = ["8", "NoLinks", "nolinks", "", "", "desc", "GitHub", "", "", "None", "", "", "", "5", "1", "2026-01-01", "G", [], [], "", "", "", ""];
    const result = decodeApps({ ...raw, software: [["1"], null, "text", noLinks, good, [...good]] });
    expect(names(result)).toEqual(["Okay"]);
    expect(result[0].license).toBe("");
    expect(decodeApps({ software: "nope" })).toEqual([]);
  });
});

describe("formatting", () => {
  test("starsLabel", () => {
    expect(starsLabel(0)).toBe("");
    expect(starsLabel(999)).toBe("999");
    expect(starsLabel(1034)).toBe("1k");
    expect(starsLabel(7621)).toBe("7.6k");
    expect(starsLabel(79267)).toBe("79.3k");
    expect(starsLabel(204052)).toBe("204k");
  });

  test("n8n result", () => {
    expect(toResult(byName("n8n"), "selfh.st")).toEqual({
      title: "n8n",
      url: "https://n8n.io/",
      snippet:
        "Workflow automation tool — TypeScript · Custom · ★ 204k · updated 2026-09-12 · Tags: Workflow Automation · Alternative to IFTTT, Zapier",
      source: "selfh.st",
      thumbnail: "https://raw.githubusercontent.com/selfhst/icons/main/png/n8n.png",
    });
  });

  test("a closed app has no thumbnail and says so", () => {
    const result = toResult(byName("Webcap"), "selfh.st");
    expect(result.thumbnail).toBeUndefined();
    expect(result.snippet).toBe("Web archiving and change detection — closed source · Tags: Archive, Monitoring");
    expect(buildSnippet(byName("Webcap"))).toBe(result.snippet);
  });
});

describe("searching", () => {
  test("alternative phrasing is understood", () => {
    expect(alternativeTarget("alternative to Google Photos")).toBe("google photos");
    expect(alternativeTarget("zapier alternatives")).toBe("zapier");
    expect(alternativeTarget("replace dropbox")).toBe("dropbox");
    expect(alternativeTarget("best self-hosted zapier alternative")).toBe("best zapier");
    expect(alternativeTarget("plain query")).toBe("");
  });

  test("alternatives are matched against selfh.st's own lists", () => {
    expect(names(searchApps(apps, "zapier alternative"))).toEqual(["n8n"]);
    expect(names(searchApps(apps, "alternatives to netflix"))).toEqual(["Jellyfin"]);
    expect(names(searchApps(apps, "alternative to firebase"))).toEqual(["code-server", "Panora"]);
    expect(names(searchApps(apps, "best self-hosted zapier alternative"))).toEqual(["n8n"]);
  });

  test("an unknown alternative target falls back to a normal search", () => {
    expect(names(searchApps(apps, "alternative to home automation"))).toEqual(["Home Assistant"]);
  });

  test("names, tags and descriptions are searched, an exact name wins", () => {
    expect(names(searchApps(apps, "n8n"))).toEqual(["n8n"]);
    expect(names(searchApps(apps, "home automation"))).toEqual(["Home Assistant"]);
    expect(names(searchApps(apps, "self-hosted media"))).toEqual(["Jellyfin", "Sonarr", "Radarr"]);
    expect(names(searchApps(apps, "Nginx Proxý"))).toEqual(["Nginx Proxy Manager"]);
  });

  test("every word must match, and nothing matches nonsense", () => {
    expect(searchApps(apps, "sonarr jellyfin")).toEqual([]);
    expect(searchApps(apps, "zzzz")).toEqual([]);
    expect(searchApps(apps, "   ")).toEqual([]);
  });

  test("the activity and open-source filters", () => {
    expect(names(searchApps(apps, "monitoring")).sort()).toEqual(["Webcap", "WatchYourLAN"].sort());
    expect(searchApps(apps, "monitoring", { activeOnly: true })).toEqual([]);
    expect(names(searchApps(apps, "monitoring", { openSourceOnly: true }))).toEqual(["WatchYourLAN"]);
  });
});

describe("DirectoryStore", () => {
  test("downloads the five files once, then serves from memory", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DirectoryStore({ now: time.now });
    expect((await store.get(server.fetch)).length).toBe(12);
    expect(server.calls.map((call) => call.name)).toEqual(FILES);
    await store.get(server.fetch);
    time.advance(HOUR);
    await store.get(server.fetch);
    expect(server.calls).toHaveLength(5);
  });

  test("concurrent searches share one download", async () => {
    const server = makeServer();
    const store = new DirectoryStore({});
    await Promise.all([store.get(server.fetch), store.get(server.fetch), store.get(server.fetch)]);
    expect(server.calls).toHaveLength(5);
  });

  test("after the refresh interval it revalidates with ETags and keeps unchanged data", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DirectoryStore({ now: time.now });
    const first = await store.get(server.fetch);
    time.advance(25 * HOUR);
    const second = await store.get(server.fetch);
    expect(server.calls).toHaveLength(10);
    expect(server.calls.slice(5).every((call) => call.headers["If-None-Match"])).toBe(true);
    expect(second).toBe(first);
  });

  test("changed upstream data replaces the list", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DirectoryStore({ now: time.now });
    await store.get(server.fetch);
    server.version = "v2";
    server.bodies.software = raw.software.filter((row) => row[1] !== "Webcap");
    time.advance(25 * HOUR);
    expect((await store.get(server.fetch)).length).toBe(11);
  });

  test("a failed refresh serves the old list and backs off", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DirectoryStore({ now: time.now });
    await store.get(server.fetch);
    server.fail = 503;
    time.advance(25 * HOUR);
    expect((await store.get(server.fetch)).length).toBe(12);
    const callsAfterFailure = server.calls.length;
    await store.get(server.fetch);
    expect(server.calls).toHaveLength(callsAfterFailure);
    time.advance(16 * 60_000);
    server.fail = 0;
    await store.get(server.fetch);
    expect(server.calls.length).toBeGreaterThan(callsAfterFailure);
  });

  test("a suspiciously small replacement is rejected", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DirectoryStore({ now: time.now });
    await store.get(server.fetch);
    server.version = "v2";
    server.bodies.software = raw.software.slice(0, 2);
    time.advance(25 * HOUR);
    expect((await store.get(server.fetch)).length).toBe(12);
    expect(store.state.raw.software).toHaveLength(12);
  });

  test("with no data yet, failures are errors with a status and later calls wait", async () => {
    const server = makeServer();
    server.fail = 500;
    const time = clock();
    const store = new DirectoryStore({ now: time.now });
    await expect(store.get(server.fetch)).rejects.toMatchObject({ status: "network" });
    const calls = server.calls.length;
    await expect(store.get(server.fetch)).rejects.toMatchObject({ status: "network" });
    expect(server.calls).toHaveLength(calls);

    const limited = makeServer();
    limited.fail = 429;
    await expect(new DirectoryStore({}).get(limited.fetch)).rejects.toMatchObject({ status: "rate_limited" });

    const broken = makeServer();
    broken.bodies.software = "not json";
    await expect(new DirectoryStore({}).get(broken.fetch)).rejects.toMatchObject({ status: "parse_error" });
    const notList = makeServer();
    notList.bodies.tags = { not: "a list" };
    await expect(new DirectoryStore({}).get(notList.fetch)).rejects.toMatchObject({ status: "parse_error" });
  });

  test("the disk cache survives a restart and keeps its ETags", async () => {
    const dir = tempDir();
    const server = makeServer();
    const time = clock();
    const first = new DirectoryStore({ cacheDir: dir, now: time.now });
    await first.get(server.fetch);
    for (const name of [...FILES.map((file) => `${file}.json`), "meta.json"]) expect(existsSync(join(dir, name))).toBe(true);

    const second = new DirectoryStore({ cacheDir: dir, now: time.now });
    expect((await second.get(server.fetch)).length).toBe(12);
    expect(server.calls).toHaveLength(5);

    time.advance(25 * HOUR);
    const third = new DirectoryStore({ cacheDir: dir, now: time.now });
    await third.get(server.fetch);
    expect(server.calls).toHaveLength(10);
    expect(server.calls.slice(5).every((call) => call.headers["If-None-Match"])).toBe(true);
  });

  test("a corrupt disk cache is ignored and an unwritable folder does not break searching", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "meta.json"), "{broken");
    const server = makeServer();
    expect((await new DirectoryStore({ cacheDir: dir }).get(server.fetch)).length).toBe(12);

    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    const store = new DirectoryStore({ cacheDir: join(blocker, "sub") });
    expect((await store.get(makeServer().fetch)).length).toBe(12);
  });
});

describe("SelfhstEngine", () => {
  const make = (server = makeServer(), time = clock()) => {
    const engine = new SelfhstEngine();
    engine.store = new DirectoryStore({ now: time.now });
    engine.configure({});
    const context = {
      fetch: server.fetch,
      engineError: (status, message) => breach(status, message),
    };
    return { engine, context, server, time };
  };

  test("declares the apps tab", () => {
    expect(type).toBe("apps");
  });

  test("searches locally after one download", async () => {
    const { engine, context, server } = make();
    const results = await engine.executeSearch("zapier alternative", 1, "any", context);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: "n8n", url: "https://n8n.io/", source: "selfh.st" });
    expect(server.calls).toHaveLength(5);
    await engine.executeSearch("jellyfin", 1, "any", context);
    await engine.executeSearch("home automation", 1, "any", context);
    expect(server.calls).toHaveLength(5);
  });

  test("an empty query does nothing", async () => {
    const { engine, context, server } = make();
    expect(await engine.executeSearch("  ", 1, "any", context)).toEqual([]);
    expect(server.calls).toHaveLength(0);
  });

  test("paging and the per-page setting", async () => {
    const { engine, context } = make();
    engine.configure({ perPage: "5" });
    const all = searchApps(apps, "n");
    expect(all.length).toBeGreaterThan(5);
    const page1 = await engine.executeSearch("n", 1, "any", context);
    const page2 = await engine.executeSearch("n", 2, "any", context);
    expect(page1.map((r) => r.title)).toEqual(names(all.slice(0, 5)));
    expect(page2.map((r) => r.title)).toEqual(names(all.slice(5, 10)));
    expect(await engine.executeSearch("n", 99, "any", context)).toEqual([]);
  });

  test("settings reach the search and the refresh interval", async () => {
    const { engine, context } = make();
    engine.configure({ activeOnly: "true", openSourceOnly: "true", refreshHours: "1", perPage: "500" });
    expect(engine.store.ttlMs).toBe(6 * HOUR);
    expect(engine.perPage).toBe(50);
    expect(await engine.executeSearch("monitoring", 1, "any", context)).toEqual([]);
  });

  test("download failures surface as engine errors with the right status", async () => {
    const server = makeServer();
    server.fail = 429;
    const { engine, context } = make(server);
    await expect(engine.executeSearch("n8n", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
  });

  test("a transport's own breach is passed through untouched", async () => {
    const { engine, context } = make();
    context.fetch = async () => {
      throw breach("interstitial", "blocked");
    };
    await expect(engine.executeSearch("n8n", 1, "any", context)).rejects.toMatchObject({ status: "interstitial" });
  });
});
