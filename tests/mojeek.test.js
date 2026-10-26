import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSolutionBody, readChallenge, solveChallenge } from "../engines/mojeek/altcha.js";
import { hasNextPage, pageKind, parseResults } from "../engines/mojeek/parse.js";
import { buildHeaders, buildSearchUrl, sinceParam } from "../engines/mojeek/request.js";
import { Session, SessionError, readCookie } from "../engines/mojeek/session.js";
import { Limiter } from "../engines/mojeek/limiter.js";
import MojeekEngine from "../engines/mojeek/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const html = await read("./fixtures/mojeek-search.html").text();
const challengeText = await read("./fixtures/mojeek-challenge.json").text();
const realChallenge = JSON.parse(challengeText);
const CAPTCHA_HTML = "<html><head><title>Captcha</title></head><body>JavaScript is required to complete this challenge.</body></html>";
const COOKIE = "chllg=abc123";
const DAY = 86_400_000;

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "mojeek-test-"));
  tempDirs.push(dir);
  return dir;
};
afterAll(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const breach = (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status });

const makeServer = () => {
  const server = {
    calls: [],
    cookie: COOKIE,
    html,
    challengeStatus: 200,
    challengeBody: challengeText,
    verifyStatus: 200,
    sendCookie: true,
    searchStatus: 200,
    verified: [],
  };
  server.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    server.calls.push({ path: parsed.pathname, url, init });
    if (parsed.pathname === "/captcha/challenge") return new Response(server.challengeBody, { status: server.challengeStatus });
    if (parsed.pathname === "/captcha/verify") {
      const encoded = /\r\n\r\n([A-Za-z0-9+/=]+)\r\n--/.exec(init.body ?? "")?.[1];
      if (encoded) server.verified.push(JSON.parse(Buffer.from(encoded, "base64").toString()));
      if (server.verifyStatus !== 200) return new Response("no", { status: server.verifyStatus });
      const headers = new Headers();
      if (server.sendCookie) headers.append("set-cookie", `${server.cookie}; expires=Thu, 26-Nov-2026 01:22:42 GMT; Max-Age=2629746; path=/`);
      return new Response('{"ok":true,"verified":true}', { status: 200, headers });
    }
    if (parsed.pathname === "/search") {
      if (server.searchStatus !== 200) return new Response("busy", { status: server.searchStatus });
      return (init.headers?.Cookie ?? "") === server.cookie ? new Response(server.html) : new Response(CAPTCHA_HTML);
    }
    return new Response("not found", { status: 404 });
  };
  return server;
};

const clock = (start = 1_000_000_000) => {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => (state.t += ms) };
};

const stubSolve = () => ({ counter: 299, derivedKey: "ab" });

describe("the Altcha solver, against a real Mojeek challenge", () => {
  test("solves the captured challenge to the same answer found when it was captured", () => {
    const challenge = readChallenge(realChallenge);
    expect(challenge).not.toBeNull();
    const solution = solveChallenge(challenge);
    expect(solution.counter).toBe(299);
    expect(solution.derivedKey.startsWith(realChallenge.parameters.keyPrefix)).toBe(true);
    expect(solution.derivedKey).toHaveLength(64);
  });

  test("it gives up when the budget or the counter limit runs out", () => {
    const challenge = readChallenge(realChallenge);
    expect(solveChallenge(challenge, { maxCounter: 5 })).toBeNull();
    let t = 0;
    expect(solveChallenge(challenge, { budgetMs: 100, now: () => (t += 1000) })).toBeNull();
  });

  test("challenges with unexpected or expensive settings are refused", () => {
    const tweak = (change) => readChallenge({ parameters: { ...realChallenge.parameters, ...change } });
    expect(tweak({})).not.toBeNull();
    expect(tweak({ algorithm: "SCRYPT" })).toBeNull();
    expect(tweak({ cost: 10_000_000 })).toBeNull();
    expect(tweak({ cost: 0 })).toBeNull();
    expect(tweak({ nonce: "zz" })).toBeNull();
    expect(tweak({ keyPrefix: "" })).toBeNull();
    expect(tweak({ keyLength: 4 })).toBeNull();
    expect(readChallenge(null)).toBeNull();
    expect(readChallenge({})).toBeNull();
  });

  test("the solution body carries the challenge and the answer", () => {
    const body = buildSolutionBody(realChallenge, { counter: 299, derivedKey: "ab" }, "XYZ", 150);
    expect(body).toStartWith("--XYZ\r\nContent-Disposition: form-data; name=\"altcha\"\r\n\r\n");
    expect(body).toEndWith("\r\n--XYZ--\r\n");
    const decoded = JSON.parse(Buffer.from(/\r\n\r\n(.+)\r\n--XYZ--/.exec(body)[1], "base64").toString());
    expect(decoded.challenge).toEqual(realChallenge);
    expect(decoded.solution).toEqual({ counter: 299, derivedKey: "ab", time: 150 });
  });
});

describe("parsing Mojeek's real results page", () => {
  test("recognises the page kinds", () => {
    expect(pageKind(html)).toBe("results");
    expect(pageKind(CAPTCHA_HTML)).toBe("captcha");
    expect(pageKind("<p>No pages found matching: zzz</p>")).toBe("empty");
    expect(pageKind("<html>something else</html>")).toBe("unknown");
    expect(pageKind(null)).toBe("unknown");
  });

  test("reads every result, including the clustered one", () => {
    const results = parseResults(html, "Mojeek");
    expect(results.map((r) => r.url)).toEqual([
      "https://en.wikipedia.org/wiki/Linear_B",
      "https://en.wiktionary.org/wiki/Linear_B",
      "https://www.britannica.com/topic/Linear-B",
      "https://www.lafigurineplastique.com/boutique/1-72/linear-b/072-linear-b-roman-market-set-1.html",
    ]);
    expect(results[0].title).toBe("Linear B - Wikipedia");
    expect(results[0].source).toBe("Mojeek");
  });

  test("snippets have their markup removed and entities decoded once", () => {
    const [first, second] = parseResults(html, "Mojeek");
    expect(first.snippet).toStartWith("The oldest Linear B tablets are probably those");
    expect(first.snippet).not.toContain("<");
    expect(second.snippet).toContain("&oldid=88218807");
    expect(second.snippet).not.toContain("&amp;");
    expect(second.snippet).not.toContain("&quot;");
  });

  test("duplicates, bad links and missing lists are handled", () => {
    const item = (url) => `<li class="r1"><a href="${url}" class="ob"></a><h2><a class="title" href="${url}">T</a></h2><p class="s">S</p></li>`;
    const page = `<ul class="results-standard">${item("https://a.test/")}${item("https://a.test/")}${item("javascript:alert(1)")}</ul>`;
    expect(parseResults(page, "Mojeek").map((r) => r.url)).toEqual(["https://a.test/"]);
    expect(parseResults("<html></html>", "Mojeek")).toBeNull();
  });

  test("detects whether there is a next page", () => {
    expect(hasNextPage(html)).toBe(true);
    expect(hasNextPage(html.replace(/<li><a[^>]*>Next<\/a><\/li>/, "<li>Next</li>"))).toBe(false);
  });
});

describe("request building", () => {
  test("search URL, paging and time window", () => {
    expect(buildSearchUrl("linear b", 1, {})).toBe("https://www.mojeek.com/search?q=linear+b&safe=0");
    const later = new URL(buildSearchUrl("x", 3, { safeSearch: true, since: "20261001" }));
    expect(later.searchParams.get("s")).toBe("21");
    expect(later.searchParams.get("safe")).toBe("1");
    expect(later.searchParams.get("since")).toBe("20261001");
    expect(new URL(buildSearchUrl("x", 2, {})).searchParams.get("s")).toBe("11");
    expect(new URL(buildSearchUrl("x".repeat(2000), 1, {})).searchParams.get("q")).toHaveLength(500);
  });

  test("sinceParam", () => {
    const now = Date.UTC(2026, 9, 25);
    expect(sinceParam("week", {}, now)).toBe("20261018");
    expect(sinceParam("any", {}, now)).toBe("");
    expect(sinceParam("custom", { dateFrom: "2026-01-02" }, now)).toBe("20260102");
    expect(sinceParam("custom", {}, now)).toBe("");
  });

  test("an honest user agent, and the cookie only when there is one", () => {
    expect(buildHeaders(COOKIE)["User-Agent"]).toStartWith("degoog-mojeek-engine/");
    expect(buildHeaders(COOKIE).Cookie).toBe(COOKIE);
    expect(buildHeaders("").Cookie).toBeUndefined();
  });
});

describe("readCookie", () => {
  test("finds chllg among several Set-Cookie headers and reads Max-Age", () => {
    const headers = new Headers();
    headers.append("set-cookie", "other=1; path=/");
    headers.append("set-cookie", "chllg=tok123; Max-Age=3600; path=/");
    expect(readCookie({ headers })).toEqual({ value: "tok123", lifetimeMs: 3_600_000 });
    expect(readCookie({ headers: new Headers() })).toBeNull();
    expect(readCookie({ headers: new Headers({ "set-cookie": "chllg=solo" }) })).toMatchObject({ value: "solo" });
  });
});

describe("Session", () => {
  const make = (server = makeServer(), options = {}) => {
    const time = clock();
    const session = new Session({ base: "https://mojeek.test", now: time.now, ...options });
    return { session, server, time };
  };

  test("runs the handshake once with the real solver and keeps the cookie", async () => {
    const { session, server } = make();
    expect(await session.ensure(server.fetch)).toBe(COOKIE);
    expect(server.calls.map((c) => c.path)).toEqual(["/captcha/challenge", "/captcha/verify"]);
    expect(server.verified[0].solution.counter).toBe(299);
    expect(server.verified[0].solution.derivedKey.startsWith(realChallenge.parameters.keyPrefix)).toBe(true);
    expect(await session.ensure(server.fetch)).toBe(COOKIE);
    expect(server.calls).toHaveLength(2);
  });

  test("concurrent callers share one handshake", async () => {
    const { session, server } = make(makeServer(), { solve: stubSolve });
    await Promise.all([session.ensure(server.fetch), session.ensure(server.fetch), session.ensure(server.fetch)]);
    expect(server.calls).toHaveLength(2);
  });

  test("the cookie is renewed before its month is up", async () => {
    const { session, server, time } = make(makeServer(), { solve: stubSolve });
    await session.ensure(server.fetch);
    time.advance(27 * DAY);
    await session.ensure(server.fetch);
    expect(server.calls).toHaveLength(2);
    time.advance(3 * DAY);
    await session.ensure(server.fetch);
    expect(server.calls).toHaveLength(4);
  });

  test("the session survives a restart, privately", async () => {
    const file = join(tempDir(), "mojeek", "session.json");
    const server = makeServer();
    const time = clock();
    await new Session({ base: "https://mojeek.test", cacheFile: file, now: time.now, solve: stubSolve }).ensure(server.fetch);
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new Session({ base: "https://mojeek.test", cacheFile: file, now: time.now, solve: stubSolve });
    expect(await restarted.ensure(server.fetch)).toBe(COOKIE);
    expect(server.calls).toHaveLength(2);
  });

  test("a corrupt or tampered session file is ignored", async () => {
    const dir = tempDir();
    const file = join(dir, "session.json");
    for (const content of ["{broken", JSON.stringify({ cookie: "bad value; evil=1", expiresAt: Date.now() + DAY * 5 })]) {
      writeFileSync(file, content);
      const server = makeServer();
      const session = new Session({ base: "https://mojeek.test", cacheFile: file, solve: stubSolve });
      expect(session.valid).toBe(false);
      expect(await session.ensure(server.fetch)).toBe(COOKIE);
      expect(server.calls).toHaveLength(2);
    }
    expect(readFileSync(file, "utf8")).toContain("abc123");
  });

  test("a second handshake straight after the first is refused instead of looping", async () => {
    const { session, server, time } = make(makeServer(), { solve: stubSolve });
    await session.ensure(server.fetch);
    session.invalidate();
    await expect(session.ensure(server.fetch)).rejects.toMatchObject({ name: "SessionError", status: "captcha" });
    expect(server.calls).toHaveLength(2);
    time.advance(11 * 60_000);
    expect(await session.ensure(server.fetch)).toBe(COOKIE);
    expect(server.calls).toHaveLength(4);
  });

  test("every way the handshake can fail is an error with a clear message", async () => {
    const attempt = async (change, solve = stubSolve) => {
      const server = makeServer();
      Object.assign(server, change);
      const session = new Session({ base: "https://mojeek.test", solve });
      return session.ensure(server.fetch).then(
        () => null,
        (error) => error,
      );
    };
    expect((await attempt({ challengeStatus: 500 })).message).toContain("could not be fetched");
    expect((await attempt({ challengeBody: "<html>" })).message).toContain("expected format");
    expect((await attempt({ challengeBody: JSON.stringify({ parameters: { ...realChallenge.parameters, cost: 99_999_999 } }) })).message).toContain("does not accept");
    expect((await attempt({}, () => null)).message).toContain("could not be solved");
    expect((await attempt({ verifyStatus: 403 })).message).toContain("did not accept");
    const noCookie = await attempt({ sendCookie: false });
    expect(noCookie.message).toContain("Set-Cookie");
    expect(noCookie).toBeInstanceOf(SessionError);
  });
});

describe("MojeekEngine", () => {
  const make = (server = makeServer(), settings = {}) => {
    const time = clock();
    const engine = new MojeekEngine();
    engine.base = "https://mojeek.test";
    engine.limiter = new Limiter({ minIntervalMs: 0 });
    engine.session = new Session({ base: "https://mojeek.test", now: time.now, solve: stubSolve });
    engine.configure(settings);
    const context = {
      fetch: server.fetch,
      engineError: (status, message) => breach(status, message),
      sentinel: (res, name) => {
        if (!res.ok) throw breach(res.status === 429 ? "rate_limited" : "blocked", `${name} ${res.status}`);
      },
    };
    return { engine, server, context, time };
  };
  const searches = (server) => server.calls.filter((c) => c.path === "/search");

  test("the first search does the handshake, later ones reuse the cookie", async () => {
    const { engine, server, context } = make();
    const results = await engine.executeSearch("linear b", 1, "any", context);
    expect(results).toHaveLength(4);
    expect(server.calls.map((c) => c.path)).toEqual(["/captcha/challenge", "/captcha/verify", "/search"]);
    await engine.executeSearch("something else", 1, "any", context);
    expect(server.calls).toHaveLength(4);
    expect(searches(server)[0].init.headers["User-Agent"]).toStartWith("degoog-mojeek-engine/");
  });

  test("paging, safe search and the time filter reach the URL; page 11 makes no request", async () => {
    const { engine, server, context } = make(makeServer(), { safeSearch: "on" });
    await engine.executeSearch("x", 2, "week", context);
    const url = new URL(searches(server)[0].url);
    expect(url.searchParams.get("s")).toBe("11");
    expect(url.searchParams.get("safe")).toBe("1");
    expect(url.searchParams.get("since")).toMatch(/^\d{8}$/);
    const before = server.calls.length;
    expect(await engine.executeSearch("x", 11, "any", context)).toEqual([]);
    expect(server.calls).toHaveLength(before);
  });

  test("when Mojeek stops accepting the cookie, the engine passes the bot check again", async () => {
    const { engine, server, context, time } = make();
    await engine.executeSearch("one", 1, "any", context);
    time.advance(15 * 60_000);
    server.cookie = "chllg=renewed456";
    expect(await engine.executeSearch("two", 1, "any", context)).toHaveLength(4);
    expect(server.calls.map((c) => c.path).slice(3)).toEqual(["/search", "/captcha/challenge", "/captcha/verify", "/search"]);
  });

  test("if the bot check keeps coming back, the engine stops trying for ten minutes", async () => {
    const { engine, server, context, time } = make();
    await engine.executeSearch("one", 1, "any", context);
    time.advance(15 * 60_000);
    server.html = CAPTCHA_HTML;
    server.cookie = "chllg=never-accepted";
    server.sendCookie = true;
    await expect(engine.executeSearch("two", 1, "any", context)).rejects.toMatchObject({ status: "captcha" });
    const calls = server.calls.length;
    await expect(engine.executeSearch("three", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
    expect(server.calls).toHaveLength(calls);
  });

  test("a page with no results is an empty list, not an error", async () => {
    const { engine, server, context } = make();
    server.html = "<html><body>No pages found matching: zzz</body></html>";
    expect(await engine.executeSearch("zzz", 1, "any", context)).toEqual([]);
  });

  test("an unrecognised page is a parse error", async () => {
    const { engine, server, context } = make();
    server.html = "<html><body>maintenance</body></html>";
    await expect(engine.executeSearch("x", 1, "any", context)).rejects.toMatchObject({ status: "parse_error" });
  });

  test("a rate limit or block pauses the engine", async () => {
    const { engine, server, context } = make();
    await engine.executeSearch("one", 1, "any", context);
    server.searchStatus = 429;
    await expect(engine.executeSearch("two", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
    const calls = server.calls.length;
    await expect(engine.executeSearch("three", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
    expect(server.calls).toHaveLength(calls);
  });

  test("a failed handshake becomes an engine error and pauses the engine", async () => {
    const { engine, server, context } = make();
    server.challengeStatus = 500;
    await expect(engine.executeSearch("one", 1, "any", context)).rejects.toMatchObject({ status: "interstitial" });
    const calls = server.calls.length;
    await expect(engine.executeSearch("two", 1, "any", context)).rejects.toMatchObject({ status: "rate_limited" });
    expect(server.calls).toHaveLength(calls);
  });

  test("an empty query makes no request, and safe search can be configured", async () => {
    const { engine, server, context } = make();
    expect(await engine.executeSearch("  ", 1, "any", context)).toEqual([]);
    expect(server.calls).toHaveLength(0);
    engine.configure({ safeSearch: "on" });
    expect(engine.safeSearch).toBe(true);
    engine.configure({});
    expect(engine.safeSearch).toBe(false);
  });
});
