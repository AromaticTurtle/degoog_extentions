import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainIconStore, buildDomainMap, lookupIcon, normalizeHost } from "../favicon/selfhst/directory.js";
import SelfhstFaviconProvider, { DEFAULT_ICON_BASE, cleanBaseUrl } from "../favicon/selfhst/index.js";

const software = await Bun.file(new URL("./fixtures/selfhst/software.json", import.meta.url)).json();
const webp = new Uint8Array(await Bun.file(new URL("./fixtures/selfhst-favicon/n8n.webp", import.meta.url)).arrayBuffer());
const map = buildDomainMap(software);

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "selfhst-fav-test-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const row = (id, name, site, { icon = "Icons", iconName = "", stars = 0 } = {}) => [
  String(id), name, name.toLowerCase().replace(/\s+/g, "-"), site, "", "desc", "GitHub", "", "", icon, iconName, "", "", String(stars), "0", "2026-01-01", "G", [], [], "", "", "", "",
];

const makeServer = () => {
  const server = { calls: [], fail: 0, etag: '"v1"', body: software };
  server.fetch = async (url, init) => {
    server.calls.push({ url, headers: init?.headers ?? {} });
    if (server.fail) return new Response("error", { status: server.fail });
    if (init?.headers?.["If-None-Match"] === server.etag) return new Response(null, { status: 304 });
    const body = typeof server.body === "string" ? server.body : JSON.stringify(server.body);
    return new Response(body, { status: 200, headers: { etag: server.etag } });
  };
  return server;
};

const clock = (start = 1_000_000) => {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => (state.t += ms) };
};
const HOUR = 3_600_000;

describe("the bundled icon fixture is something degoog will accept", () => {
  test("a real WebP under the 64 KB limit", () => {
    expect(String.fromCharCode(...webp.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...webp.slice(8, 12))).toBe("WEBP");
    expect(webp.length).toBeLessThan(64 * 1024);
  });

  test("author.json matches the other extensions", async () => {
    const [a, b] = await Promise.all(
      ["engines/openalex", "favicon/selfhst"].map((dir) => Bun.file(new URL(`../${dir}/author.json`, import.meta.url)).text()),
    );
    expect(b).toBe(a);
  });
});

describe("normalizeHost", () => {
  test("cleans hostnames and refuses things that are not public names", () => {
    expect(normalizeHost("WWW.Example.COM.")).toBe("example.com");
    expect(normalizeHost("docs.n8n.io")).toBe("docs.n8n.io");
    for (const bad of ["", "localhost", "192.168.1.1", "a..b.com", "exa_mple.com", ".example.com", null, undefined]) {
      expect(normalizeHost(bad)).toBe("");
    }
  });
});

describe("buildDomainMap from the real selfh.st excerpt", () => {
  test("keeps bare-domain apps that have an icon", () => {
    expect([...map.keys()].sort()).toEqual(
      [
        "akaunting.com",
        "coder.com",
        "home-assistant.io",
        "jellyfin.org",
        "n8n.io",
        "nginxproxymanager.com",
        "openclaw.ai",
        "radarr.video",
        "sonarr.tv",
      ].sort(),
    );
    expect(map.get("n8n.io")).toBe("n8n");
    expect(map.get("radarr.video")).toBe("radarr-light-hybrid");
    expect(map.get("home-assistant.io")).toBe("home-assistant");
  });

  test("apps whose website is a repository path, or that have no icon, are left out", () => {
    expect(map.has("github.com")).toBe(false);
    expect(map.has("rubyup.dev")).toBe(false);
    expect(map.has("panora.dev")).toBe(false);
  });

  test("when several apps share a domain, the one named after the domain wins, then the most starred", () => {
    const shared = buildDomainMap([
      row(1, "code-server", "coder.com", { iconName: "visual-studio-code", stars: 79267 }),
      row(2, "Coder", "coder.com", { iconName: "coder", stars: 14444 }),
      row(3, "Ente Auth", "ente.com", { iconName: "ente-auth", stars: 10 }),
      row(4, "Ente Photos", "ente.com", { iconName: "ente-photos", stars: 99 }),
    ]);
    expect(shared.get("coder.com")).toBe("coder");
    expect(shared.get("ente.com")).toBe("ente-photos");
  });

  test("malformed rows, bad icon names and bad sites are ignored", () => {
    const result = buildDomainMap([
      null,
      ["short"],
      row(1, "Bad Icon", "bad.example.com", { iconName: "../evil" }),
      row(2, "Bad Site", "not a site"),
      row(3, "Fine", "https://www.Fine.Example/", { iconName: "fine" }),
    ]);
    expect([...result.entries()]).toEqual([["fine.example", "fine"]]);
    expect(buildDomainMap("nope").size).toBe(0);
  });
});

describe("lookupIcon", () => {
  test("exact hosts, www, and parent domains", () => {
    expect(lookupIcon(map, "n8n.io")).toBe("n8n");
    expect(lookupIcon(map, "www.n8n.io")).toBe("n8n");
    expect(lookupIcon(map, "docs.n8n.io")).toBe("n8n");
    expect(lookupIcon(map, "a.b.docs.n8n.io")).toBe("n8n");
  });

  test("subdomain matching can be turned off", () => {
    expect(lookupIcon(map, "docs.n8n.io", false)).toBe("");
    expect(lookupIcon(map, "n8n.io", false)).toBe("n8n");
  });

  test("no partial-label or bare-suffix matches", () => {
    expect(lookupIcon(map, "notn8n.io")).toBe("");
    expect(lookupIcon(map, "io")).toBe("");
    expect(lookupIcon(map, "github.com")).toBe("");
    expect(lookupIcon(map, "")).toBe("");
  });
});

describe("DomainIconStore", () => {
  test("downloads once and serves from memory", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DomainIconStore({ now: time.now });
    expect((await store.get(server.fetch)).size).toBe(9);
    await store.get(server.fetch);
    time.advance(24 * HOUR);
    await store.get(server.fetch);
    expect(server.calls).toHaveLength(1);
  });

  test("concurrent lookups share one download", async () => {
    const server = makeServer();
    const store = new DomainIconStore({});
    await Promise.all([store.get(server.fetch), store.get(server.fetch), store.get(server.fetch)]);
    expect(server.calls).toHaveLength(1);
  });

  test("a refresh sends the ETag and keeps the data on 304", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DomainIconStore({ now: time.now, ttlMs: HOUR });
    const first = await store.get(server.fetch);
    time.advance(2 * HOUR);
    const second = await store.get(server.fetch);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1].headers["If-None-Match"]).toBe('"v1"');
    expect(second).toBe(first);
  });

  test("failures keep the old map, a first-time failure gives null, and both back off", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DomainIconStore({ now: time.now, ttlMs: HOUR });
    await store.get(server.fetch);
    server.fail = 503;
    time.advance(2 * HOUR);
    expect((await store.get(server.fetch)).size).toBe(9);
    const calls = server.calls.length;
    await store.get(server.fetch);
    expect(server.calls).toHaveLength(calls);

    const down = makeServer();
    down.fail = 500;
    const fresh = new DomainIconStore({ now: time.now });
    expect(await fresh.get(down.fetch)).toBeNull();
    expect(await fresh.get(down.fetch)).toBeNull();
    expect(down.calls).toHaveLength(1);
  });

  test("a suspiciously small or empty replacement is rejected", async () => {
    const server = makeServer();
    const time = clock();
    const store = new DomainIconStore({ now: time.now, ttlMs: HOUR });
    await store.get(server.fetch);
    server.etag = '"v2"';
    server.body = software.slice(0, 1);
    time.advance(2 * HOUR);
    expect((await store.get(server.fetch)).size).toBe(9);
  });

  test("the disk cache survives a restart", async () => {
    const dir = tempDir();
    const server = makeServer();
    const time = clock();
    await new DomainIconStore({ cacheDir: dir, now: time.now }).get(server.fetch);
    expect(existsSync(join(dir, "icons.json"))).toBe(true);
    const restarted = new DomainIconStore({ cacheDir: dir, now: time.now });
    expect((await restarted.get(server.fetch)).size).toBe(9);
    expect(server.calls).toHaveLength(1);
  });

  test("a corrupt or unwritable cache does not break lookups", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "icons.json"), "{broken");
    expect((await new DomainIconStore({ cacheDir: dir }).get(makeServer().fetch)).size).toBe(9);
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    expect((await new DomainIconStore({ cacheDir: join(blocker, "sub") }).get(makeServer().fetch)).size).toBe(9);
  });
});

describe("SelfhstFaviconProvider", () => {
  const make = (server = makeServer(), settings = {}) => {
    const provider = new SelfhstFaviconProvider();
    provider.store = new DomainIconStore({});
    provider.configure(settings);
    return { provider, server, context: { fetch: server.fetch, size: 64 } };
  };

  test("returns the WebP icon URL for a known host", async () => {
    const { provider, context } = make();
    expect(await provider.getFavicon("n8n.io", context)).toEqual({ url: `${DEFAULT_ICON_BASE}/n8n.webp` });
    expect(await provider.getFavicon("docs.n8n.io", context)).toEqual({ url: `${DEFAULT_ICON_BASE}/n8n.webp` });
    expect(await provider.getFavicon("www.home-assistant.io", context)).toEqual({ url: `${DEFAULT_ICON_BASE}/home-assistant.webp` });
  });

  test("an unknown host is a null miss with no extra network use", async () => {
    const { provider, context, server } = make();
    expect(await provider.getFavicon("example.com", context)).toBeNull();
    expect(await provider.getFavicon("github.com", context)).toBeNull();
    expect(await provider.getFavicon("", context)).toBeNull();
    expect(server.calls).toHaveLength(1);
  });

  test("it never throws: a dead directory is a miss", async () => {
    const server = makeServer();
    server.fail = 500;
    const { provider, context } = make(server);
    expect(await provider.getFavicon("n8n.io", context)).toBeNull();
  });

  test("settings: subdomains, base URL and refresh interval", async () => {
    const { provider, context } = make(makeServer(), { matchSubdomains: "false", iconBaseUrl: "https://icons.example.com/webp/" });
    expect(await provider.getFavicon("docs.n8n.io", context)).toBeNull();
    expect(await provider.getFavicon("n8n.io", context)).toEqual({ url: "https://icons.example.com/webp/n8n.webp" });
    for (const [input, hours] of [[1, 24], [99999, 2160], ["abc", 168], [48, 48]]) {
      provider.configure({ refreshHours: input });
      expect(provider.store.ttlMs).toBe(hours * HOUR);
    }
  });

  test("cleanBaseUrl falls back on junk and strips queries", () => {
    expect(cleanBaseUrl("javascript:alert(1)")).toBe(DEFAULT_ICON_BASE);
    expect(cleanBaseUrl("not a url")).toBe(DEFAULT_ICON_BASE);
    expect(cleanBaseUrl("https://x.test/a/?q=1#h")).toBe("https://x.test/a");
  });
});
