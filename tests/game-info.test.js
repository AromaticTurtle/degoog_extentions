// Tests for the game-info slot plugin (IGDB + ProtonDB + Steam link).
//
// NOTE: tests/fixtures/igdb-games.json and igdb-time-to-beat.json are HAND-WRITTEN to IGDB's documented layout.
// They are NOT real recordings. steam-storesearch.json is shaped after a real Steam store search reply and then
// trimmed and extended by hand, and protondb-summary.json is a real ProtonDB reply. To record real IGDB fixtures run
// IGDB_CLIENT_ID=... IGDB_CLIENT_SECRET=... bun ./tests/record-igdb-fixtures.js "skyrim" in your own terminal.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_API_BASE,
  DEFAULT_TOKEN_URL,
  buildIgdbHeaders,
  buildSearchQuery,
  buildTimeToBeatQuery,
  buildTokenRequest,
  coverUrl,
  igdbGamePage,
  igdbUrl,
  isAppId,
  pluginHeaders,
  protonDbPage,
  protonSummaryUrl,
  retryAfterMs,
  sanitizeTerm,
  steamSearchUrl,
  steamStorePage,
} from "../plugins/game-info/request.js";
import { TokenError, TokenStore, tokenFile } from "../plugins/game-info/token.js";
import {
  ACCEPTED_GAME_TYPES,
  BARS,
  SUBTITLE_EXACT,
  cacheKey,
  evaluate,
  extractTerm,
  formatExplanation,
  hasGameWord,
  isAcceptedType,
  isConfidentMatch,
  judge,
  looksLikeATitleSearch,
  normalizeTitle,
  pickGame,
  popularity,
  scoreGame,
  specificity,
  stripDecorations,
  subtitles,
  titleSimilarity,
} from "../plugins/game-info/match.js";
import { SETTINGS_SCHEMA } from "../plugins/game-info/settings.js";
import { compactGame, compactProton, compactTimeToBeat, isoDate, steamAppIdOf } from "../plugins/game-info/shape.js";
import { buildPanel, esc, formatDate, safeUrl, summarize, timeToBeatText } from "../plugins/game-info/render.js";
import { BOARD_GAMES_LOOKUP, GameInfoSlot, boardWaitFromSetting, slot as defaultSlot } from "../plugins/game-info/index.js";

const read = (path) => Bun.file(new URL(path, import.meta.url));
const gamesFixture = await read("./fixtures/igdb-games.json").json();
const ttbFixture = await read("./fixtures/igdb-time-to-beat.json").json();
const protonFixture = await read("./fixtures/protondb-summary.json").json();
const steamFixture = await read("./fixtures/steam-storesearch.json").json();
const compactFixture = gamesFixture.map(compactGame);
const [SKYRIM, SPECIAL, VR] = compactFixture;

const ID = "test-client-id-8841";
const SECRET = "test-client-secret-7f3a9c";
const folders = [];
afterEach(() => {
  while (folders.length) rmSync(folders.pop(), { recursive: true, force: true });
});
const tempFolder = () => {
  const folder = mkdtempSync(join(tmpdir(), "game-info-"));
  folders.push(folder);
  return folder;
};

const withEnv = async (vars, work) => {
  const previous = {};
  for (const [name, value] of Object.entries(vars)) {
    previous[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
};

const capture = async (work) => {
  const lines = [];
  const originals = {};
  for (const method of ["log", "warn", "error", "info", "debug"]) {
    originals[method] = console[method];
    console[method] = (...args) => lines.push(args.join(" "));
  }
  try {
    await work();
  } finally {
    Object.assign(console, originals);
  }
  return lines;
};

const kindOf = (url) => {
  const u = new URL(url);
  if (u.hostname === "token.test") return "token";
  if (u.hostname === "proton.test") return "proton";
  if (u.hostname === "steam.test") return "steam";
  return u.pathname.endsWith("/game_time_to_beats") ? "ttb" : "search";
};
const kinds = (context) => context.calls.map((call) => kindOf(call.url));
const count = (context, kind) => kinds(context).filter((entry) => entry === kind).length;

// A fake degoog context. `respond(kind, request)` may return a Response to override the default one.
const makeContext = ({ search = gamesFixture, ttb = ttbFixture, steam = steamFixture, valid = () => true, respond } = {}) => {
  const calls = [];
  let issued = 0;
  return {
    calls,
    signProxyUrl: (url) => `/proxy?u=${encodeURIComponent(url)}`,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      const kind = kindOf(url);
      const override = respond?.(kind, { url: String(url), init });
      if (override) return override;
      if (kind === "token") {
        issued += 1;
        return Response.json({ access_token: `tok-${issued}`, expires_in: 5_184_000, token_type: "bearer" });
      }
      if (kind === "search" || kind === "ttb") {
        const token = String(init.headers?.Authorization ?? "").replace(/^Bearer /, "");
        if (!valid(token)) return new Response("Authorization Failure", { status: 401 });
        return Response.json(kind === "search" ? search : ttb);
      }
      if (kind === "proton") return Response.json(protonFixture);
      return Response.json(steam);
    },
  };
};

const make = (settings = { clientId: ID, clientSecret: SECRET }) => {
  const slot = new GameInfoSlot();
  slot.apiBase = "https://igdb.test/v4";
  slot.tokenUrl = "https://token.test/oauth2/token";
  slot.protonBase = "https://proton.test";
  slot.steamBase = "https://steam.test";
  slot.spacingMs = 0;
  slot.tokens = new TokenStore({ file: "", now: () => slot.now() });
  slot.configure(settings);
  return slot;
};

const EMPTY = { title: "", html: "" };

describe("request building", () => {
  test("search query is sanitised and uses the current field names", () => {
    const query = buildSearchQuery('say "hi"; fields x\\ \n');
    expect(query.startsWith('search "say hi fields x"; fields name,slug,summary,')).toBe(true);
    expect(query.endsWith("where version_parent = null; limit 8;")).toBe(true);
    expect(query.split('"')).toHaveLength(3);
    expect(query).not.toContain("\\");
    expect(query).not.toContain("\n");
    for (const field of ["game_type.type", "external_games.external_game_source.name", "websites.type.type", "age_ratings.organization.name", "age_ratings.rating_category.rating", "total_rating_count", "cover.image_id"]) {
      expect(query).toContain(field);
    }
    expect(query).not.toMatch(/[,\s](category|status)[,;.\s]/);
    expect(buildSearchQuery("a".repeat(500))).toContain(`"${"a".repeat(100)}"`);
    expect(sanitizeTerm("  Hades\u0000\u001f II  ")).toBe("Hades II");
    expect(sanitizeTerm(null)).toBe("");
  });

  test("time to beat query only ever holds a number", () => {
    expect(buildTimeToBeatQuery(472)).toBe("fields game_id,hastily,normally,completely,count; where game_id = 472;");
    expect(buildTimeToBeatQuery("1; drop")).toBe("fields game_id,hastily,normally,completely,count; where game_id = 0;");
  });

  test("the token request carries the credentials in the form body, never in the url", () => {
    const request = buildTokenRequest(ID, SECRET, "https://id.twitch.tv/oauth2/token");
    expect(request.url).toBe("https://id.twitch.tv/oauth2/token");
    expect(new URL(request.url).search).toBe("");
    expect(request.url).not.toContain(SECRET);
    expect(request.url).not.toContain(ID);
    expect(request.init.method).toBe("POST");
    expect(request.init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(request.init.body);
    expect(form.get("client_id")).toBe(ID);
    expect(form.get("client_secret")).toBe(SECRET);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(JSON.stringify(request.init.headers)).not.toContain(SECRET);
    expect(buildTokenRequest(ID, SECRET).url).toBe(DEFAULT_TOKEN_URL);
  });

  test("igdb requests carry the client id and a bearer token in headers, a plain text body, and no secret", () => {
    const headers = buildIgdbHeaders(ID, "tok-1");
    expect(headers["Client-ID"]).toBe(ID);
    expect(headers.Authorization).toBe("Bearer tok-1");
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("text/plain");
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    expect(igdbUrl("https://api.test/v4/", "games")).toBe("https://api.test/v4/games");
    expect(igdbUrl("", "game_time_to_beats")).toBe(`${DEFAULT_API_BASE}/game_time_to_beats`);
  });

  test("cover images are portrait t_cover_big_2x urls from validated ids only", () => {
    expect(coverUrl("co1abc_-9")).toBe("https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co1abc_-9.jpg");
    for (const bad of ["../x", "a b", 'a"b', "", null, undefined, 5, "a/b"]) expect(coverUrl(bad)).toBe("");
  });

  test("steam, protondb and igdb links are built from validated ids and slugs", () => {
    expect(steamStorePage("489830")).toBe("https://store.steampowered.com/app/489830/");
    expect(steamStorePage(489830)).toBe("https://store.steampowered.com/app/489830/");
    for (const bad of ["", "12a", "../1", "1/2", "javascript:1", null, undefined, "12345678901"]) {
      expect(steamStorePage(bad)).toBe("");
      expect(protonDbPage(bad)).toBe("");
      expect(protonSummaryUrl("https://p.test", bad)).toBe("");
    }
    expect(isAppId("72850")).toBe(true);
    expect(protonDbPage("489830")).toBe("https://www.protondb.com/app/489830");
    expect(protonSummaryUrl("https://p.test/", "489830")).toBe("https://p.test/api/v1/reports/summaries/489830.json");
    expect(igdbGamePage("the-elder-scrolls-v-skyrim")).toBe("https://www.igdb.com/games/the-elder-scrolls-v-skyrim");
    for (const bad of ["Has Caps", "a/b", "a?b", "", null, "x\"y"]) expect(igdbGamePage(bad)).toBe("");
    const steam = new URL(steamSearchUrl("https://s.test/", 'Skyrim "SE"; x'));
    expect(steam.origin + steam.pathname).toBe("https://s.test/api/storesearch/");
    expect(steam.searchParams.get("term")).toBe("Skyrim SE x");
    expect(steam.searchParams.get("cc")).toBe("us");
    expect(steam.searchParams.get("l")).toBe("en");
  });

  test("protondb and steam requests send an honest user agent, retry-after is bounded", () => {
    expect(pluginHeaders()["User-Agent"]).toBe("degoog-game-info/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)");
    expect(retryAfterMs("30")).toBe(30_000);
    expect(retryAfterMs("999999")).toBe(3_600_000);
    expect(retryAfterMs(undefined)).toBe(600_000);
    expect(retryAfterMs("-5")).toBe(600_000);
  });
});

describe("token store", () => {
  const tokenResponse = (token, seconds = 5_184_000) => Response.json({ access_token: token, expires_in: seconds, token_type: "bearer" });
  const credentials = (doFetch, overrides = {}) => ({ clientId: ID, clientSecret: SECRET, url: "https://token.test/oauth2/token", fetch: doFetch, ...overrides });

  test("the default token file lives under the data dir and can be overridden by the environment", async () => {
    await withEnv({ DEGOOG_IGDB_TOKEN_FILE: undefined }, () => expect(tokenFile("data")).toBe(join("data", "igdb", "token.json")));
    await withEnv({ DEGOOG_IGDB_TOKEN_FILE: "/tmp/elsewhere.json" }, () => expect(tokenFile("data")).toBe("/tmp/elsewhere.json"));
  });

  test("a token is saved with mode 0600, atomically, without the secret", async () => {
    const file = join(tempFolder(), "igdb", "token.json");
    let now = 1_700_000_000_000;
    const store = new TokenStore({ file, now: () => now });
    const requests = [];
    const token = await store.get(credentials(async (url, init) => (requests.push({ url, init }), tokenResponse("tok-abc"))));
    expect(token).toBe("tok-abc");
    expect(requests).toHaveLength(1);
    const text = readFileSync(file, "utf8");
    expect(JSON.parse(text)).toEqual({ clientId: ID, token: "tok-abc", expiresAt: now + 5_184_000_000 });
    expect(text).not.toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  test("a saved token is reused by a new instance without any request", async () => {
    const file = join(tempFolder(), "token.json");
    const first = new TokenStore({ file });
    await first.get(credentials(async () => tokenResponse("tok-abc")));
    const second = new TokenStore({ file });
    const token = await second.get(credentials(async () => {
      throw new Error("must not be called");
    }));
    expect(token).toBe("tok-abc");
  });

  test("a token for another client id is discarded", async () => {
    const file = join(tempFolder(), "token.json");
    await new TokenStore({ file }).get(credentials(async () => tokenResponse("tok-old")));
    let calls = 0;
    const token = await new TokenStore({ file }).get(credentials(async () => (calls++, tokenResponse("tok-new")), { clientId: "other-id" }));
    expect(token).toBe("tok-new");
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8")).clientId).toBe("other-id");
  });

  test("a token that expires within 24 hours is replaced", async () => {
    let now = 1_000_000_000;
    const store = new TokenStore({ now: () => now });
    let n = 0;
    const doFetch = async () => tokenResponse(`tok-${++n}`, 30 * 3600);
    expect(await store.get(credentials(doFetch))).toBe("tok-1");
    now += 5 * 3600_000;
    expect(await store.get(credentials(doFetch))).toBe("tok-1");
    now += 2 * 3600_000;
    expect(await store.get(credentials(doFetch))).toBe("tok-2");
  });

  test("concurrent callers share one token request", async () => {
    const store = new TokenStore();
    let calls = 0;
    const doFetch = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tokenResponse("tok-shared");
    };
    const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => store.get(credentials(doFetch))));
    expect(tokens).toEqual(Array(5).fill("tok-shared"));
    expect(calls).toBe(1);
  });

  test("invalidate forgets the token and removes the file, but only the token it was told about", async () => {
    const file = join(tempFolder(), "token.json");
    const store = new TokenStore({ file });
    let n = 0;
    const doFetch = async () => tokenResponse(`tok-${++n}`);
    await store.get(credentials(doFetch));
    store.invalidate("not-the-current-token");
    expect(existsSync(file)).toBe(true);
    expect(await store.get(credentials(doFetch))).toBe("tok-1");
    store.invalidate("tok-1");
    expect(existsSync(file)).toBe(false);
    expect(await store.get(credentials(doFetch))).toBe("tok-2");
  });

  test("failures are classified and never carry the secret", async () => {
    const attempt = async (doFetch) => {
      try {
        await new TokenStore().get(credentials(doFetch));
      } catch (error) {
        return error;
      }
      return null;
    };
    for (const status of [400, 401, 403]) {
      const error = await attempt(async () => new Response("no", { status }));
      expect(error).toBeInstanceOf(TokenError);
      expect(error.kind).toBe("rejected");
    }
    const rate = await attempt(async () => new Response("slow", { status: 429, headers: { "retry-after": "45" } }));
    expect([rate.kind, rate.retryAfterMs]).toEqual(["rate", 45_000]);
    expect((await attempt(async () => new Response("oops", { status: 500 }))).kind).toBe("failed");
    const network = await attempt(async () => {
      throw new Error(`boom ${SECRET}`);
    });
    expect(network.kind).toBe("failed");
    expect(network.message).not.toContain(SECRET);
    expect((await attempt(async () => new Response("not json"))).kind).toBe("failed");
    expect((await attempt(async () => Response.json({ access_token: "x" }))).kind).toBe("failed");
    expect((await attempt(async () => Response.json({ expires_in: 100 }))).kind).toBe("failed");
  });
});

describe("query gating", () => {
  test("short title-like queries pass, questions and addresses do not", () => {
    for (const query of ["skyrim", "Hades", "elden ring walkthrough", "the legend of zelda breath of the wild"]) {
      expect(looksLikeATitleSearch(query)).toBe(true);
    }
    for (const query of ["", "a", "how to beat malenia", "what is a roguelike", "https://store.steampowered.com", "example.com", "2 + 2", "x ".repeat(40), "one two three four five six seven eight nine", "weather"]) {
      expect(looksLikeATitleSearch(query)).toBe(false);
    }
  });

  test("only trailing game words are removed from the title", () => {
    expect(extractTerm("skyrim game")).toBe("skyrim");
    expect(extractTerm("elden ring ps5 review")).toBe("elden ring");
    expect(extractTerm("Dark Souls III system requirements")).toBe("Dark Souls III");
    expect(extractTerm("game dev tycoon")).toBe("game dev tycoon");
    expect(extractTerm("hades")).toBe("hades");
  });

  test("game words are recognised", () => {
    expect(hasGameWord("elden ring walkthrough")).toBe(true);
    expect(hasGameWord("steam deck games")).toBe(true);
    expect(hasGameWord("skyrim")).toBe(false);
  });

  test("the cache key ignores case, accents, punctuation and a leading 'the'", () => {
    expect(cacheKey("The Witcher 3: Wild Hunt")).toBe(cacheKey("witcher 3 wild hunt"));
    expect(cacheKey("Pokémon")).toBe(cacheKey("pokemon"));
    expect(normalizeTitle("DOOM (2016)")).toBe("doom");
  });
});

describe("title matching", () => {
  const rated = (id, name, totalRatingCount, gameType = "Main Game") => ({ id, name, totalRatingCount, gameType });

  test("similarity", () => {
    expect(titleSimilarity("elden ring", "Elden Ring")).toBe(1);
    expect(titleSimilarity("doom", "DOOM (2016)")).toBe(1);
    expect(titleSimilarity("elden ring", "Elden Ring: Shadow of the Erdtree")).toBe(0.9);
    expect(titleSimilarity("zelda breath of the wild", "The Legend of Zelda: Breath of the Wild")).toBe(0.8);
    expect(titleSimilarity("cats", "Dogs")).toBe(0);
    expect(titleSimilarity("hades 2", "Hades")).toBe(0.5);
    expect(titleSimilarity("final fantasy vii", "Final Fantasy")).toBe(0.5);
    expect(titleSimilarity("hades game", "Hades")).toBe(0.9);
  });

  test("a one word query may match a subtitle", () => {
    expect(SUBTITLE_EXACT).toBe(0.88);
    expect(subtitles("The Elder Scrolls V: Skyrim")).toEqual(["skyrim"]);
    expect(subtitles("Skyrim - Special Edition")).toEqual(["special edition"]);
    expect(subtitles("A: B - C")).toEqual(["b", "c"]);
    expect(subtitles("Hades")).toEqual([]);
    expect(titleSimilarity("skyrim", "The Elder Scrolls V: Skyrim")).toBe(SUBTITLE_EXACT);
    // an edition mark is cut off, so the Special Edition fits too (pickGame still prefers the base game for "skyrim")
    expect(titleSimilarity("skyrim", "The Elder Scrolls V: Skyrim Special Edition")).toBe(SUBTITLE_EXACT);
    expect(titleSimilarity("skyrim special edition", "The Elder Scrolls V: Skyrim Special Edition")).toBe(SUBTITLE_EXACT);
    expect(titleSimilarity("skyrim", "The Elder Scrolls V: Skyrim VR")).toBeLessThan(0.5);
  });

  test("confidence needs popularity, an unknown fan game does not qualify", () => {
    // "elden ring" is a medium-specificity query: an exact title needs few ratings (BARS.exact.medium = 3)
    expect(isConfidentMatch("elden ring", rated(1, "Elden Ring", 3), false)).toBe(true);
    expect(isConfidentMatch("elden ring", rated(1, "Elden Ring", 2), false)).toBe(false);
    expect(isConfidentMatch("elden ring", rated(1, "Elden Ring", 1), true)).toBe(true);
    expect(isConfidentMatch("elden ring", rated(1, "Elden Ring: Nightreign", 30), false)).toBe(true);
    expect(isConfidentMatch("elden ring", rated(1, "Elden Ring: Nightreign", 29), false)).toBe(false);
    expect(isConfidentMatch("skyrim", rated(1, "The Elder Scrolls V: Skyrim", 150), false)).toBe(true);
    expect(isConfidentMatch("skyrim", rated(1, "The Elder Scrolls V: Skyrim", 149), false)).toBe(false);
    expect(isConfidentMatch("skyrim", rated(1, "The Elder Scrolls V: Skyrim", 20), true)).toBe(true);
    expect(isConfidentMatch("skyrim", rated(1, "The Elder Scrolls V: Skyrim", 19), true)).toBe(false);
    expect(isConfidentMatch("skyrim", null, true)).toBe(false);
  });

  test("popularity is the total rating count, else players plus critics", () => {
    expect(popularity({ totalRatingCount: 40, userCount: 1, criticCount: 1 })).toBe(40);
    expect(popularity({ totalRatingCount: 0, userCount: 10, criticCount: 5 })).toBe(15);
    expect(popularity({})).toBe(0);
    expect(popularity(null)).toBe(0);
  });

  test("skyrim finds the base game, not the special edition, the VR port, the DLC or the mod", () => {
    expect(pickGame("skyrim", compactFixture, false).id).toBe(472);
    // The mod ("Skyrim: Total Overhaul") would otherwise win with a closer title.
    expect(titleSimilarity("skyrim", "Skyrim: Total Overhaul")).toBe(0.9);
    expect(pickGame("skyrim", [compactFixture[4]], false)).toBeNull();
  });

  test("a specific query finds the matching edition", () => {
    expect(pickGame("skyrim special edition", compactFixture, false).id).toBe(19560);
    expect(pickGame("skyrim vr", compactFixture, false).id).toBe(28420);
    expect(pickGame("the elder scrolls v skyrim", compactFixture, false).id).toBe(472);
  });

  test("only game types that are the game itself are accepted, a missing type is fine", () => {
    for (const type of ACCEPTED_GAME_TYPES) expect(isAcceptedType(type)).toBe(true);
    for (const type of ["Main Game", "REMASTER", "Expanded Game", "Port", "Standalone Expansion", "Remake", "", undefined, null]) {
      expect(isAcceptedType(type)).toBe(true);
    }
    for (const type of ["DLC", "Expansion", "Bundle", "Mod", "Episode", "Season", "Fork", "Pack", "Update"]) expect(isAcceptedType(type)).toBe(false);
    const dlc = rated(5, "Skyrim: Dawnguard", 900, "DLC");
    expect(pickGame("skyrim", [dlc], false)).toBeNull();
    expect(pickGame("skyrim", [{ ...dlc, gameType: "" }], false).id).toBe(5);
    expect(pickGame("skyrim", [{ ...dlc, gameType: undefined }], false).id).toBe(5);
    expect(pickGame("skyrim", [rated(472, "The Elder Scrolls V: Skyrim", 900, "Main Game"), dlc], false).id).toBe(472);
  });

  test("a shared subtitle such as 'origins' is ambiguous unless the query names a game", () => {
    const origins = [rated(1, "Assassin's Creed: Origins", 1500), rated(2, "Dragon Age: Origins", 900)];
    expect(pickGame("origins", origins, false)).toBeNull();
    expect(pickGame("origins", origins, true).id).toBe(1);
    expect(pickGame("assassin's creed origins", origins, false)?.id).toBe(1);
    // Two entries of the same series are not ambiguous.
    const skyrim = [rated(1, "The Elder Scrolls V: Skyrim", 2000), rated(2, "The Elder Scrolls V: Skyrim - Special Edition", 800)];
    expect(pickGame("skyrim", skyrim, false).id).toBe(1);
    // A lesser known game with the subtitle does not meet the popularity bar on its own.
    expect(pickGame("origins", [rated(1, "Assassin's Creed: Origins", 100)], false)).toBeNull();
  });

  test("hades 2 does not show Hades, and a trailing numeral names another game", () => {
    const hades = [rated(1, "Hades", 5000)];
    expect(pickGame("hades 2", hades, false)).toBeNull();
    expect(pickGame("hades ii", hades, false)).toBeNull();
    expect(pickGame("hades 2", [...hades, rated(2, "Hades 2", 800)], false).id).toBe(2);
    expect(pickGame("hades", [...hades, rated(2, "Hades 2", 800)], false).id).toBe(1);
  });

  test("picks the closest title, then the most rated", () => {
    const twins = [rated(1, "Hades", 100), rated(2, "Hades", 9000)];
    expect(pickGame("hades", twins, false).id).toBe(2);
    expect(pickGame("zzz", compactFixture, false)).toBeNull();
    expect(pickGame("elden ring", [], false)).toBeNull();
    expect(pickGame("elden ring", null, false)).toBeNull();
    expect(pickGame("elden ring", [null, {}, { id: 1 }], false)).toBeNull();
  });

  test("a generic one-word query does not trigger on a loosely similar game", () => {
    expect(pickGame("ring", [rated(1, "Elden Ring", 3000), rated(2, "Boxing Ring Simulator", 400)], false)).toBeNull();
  });
});

describe("shaping IGDB data", () => {
  test("a game keeps only the fields the panel uses", () => {
    expect(SKYRIM).toMatchObject({
      id: 472,
      slug: "the-elder-scrolls-v-skyrim",
      name: "The Elder Scrolls V: Skyrim",
      released: "2011-11-11",
      gameType: "Main Game",
      image: "cotestskyrim1",
      genres: ["Role-playing (RPG)", "Adventure"],
      platforms: ["PC", "PS3", "X360"],
      developers: ["Bethesda Game Studios"],
      publishers: ["Bethesda Softworks"],
      criticScore: 89,
      criticCount: 31,
      userScore: 87,
      userCount: 2210,
      totalRatingCount: 2241,
      modes: ["Single player"],
      steamAppId: "72850",
      officialSite: "https://elderscrolls.bethesda.net/en/skyrim",
      ageRating: "ESRB M",
    });
    expect(SKYRIM.platformNames).toContain("PC (Microsoft Windows)");
    expect(SKYRIM.summary).toStartWith("Skyrim reimagines");
    expect(SKYRIM).not.toHaveProperty("external_games");
    expect(Object.keys(SKYRIM)).toHaveLength(22);
  });

  test("the steam app id comes from external_games, whatever the case of the source, else from a store link", () => {
    expect(SKYRIM.steamAppId).toBe("72850");
    expect(SPECIAL.steamAppId).toBe("489830");
    expect(VR.steamAppId).toBe("611670");
    expect(compactFixture[4].steamAppId).toBe("");
    expect(steamAppIdOf({ external_games: [{ uid: 72850, external_game_source: { name: "STEAM" } }] })).toBe("72850");
    expect(steamAppIdOf({ external_games: [{ uid: "abc", external_game_source: { name: "Steam" } }] })).toBe("");
    expect(steamAppIdOf({ external_games: [{ uid: "12", external_game_source: { name: "GOG" } }] })).toBe("");
    expect(steamAppIdOf({ external_games: [{ uid: "1; drop", external_game_source: { name: "Steam" } }] })).toBe("");
    expect(
      steamAppIdOf({
        external_games: [{ uid: "12", external_game_source: { name: "GOG" } }],
        websites: [{ url: "http://store.steampowered.com/app/55/Some_Game" }],
      }),
    ).toBe("55");
    expect(steamAppIdOf({ websites: [{ url: "https://example.com/store.steampowered.com/app/55" }] })).toBe("");
    expect(
      steamAppIdOf({
        external_games: [{ uid: "7", external_game_source: { name: "Steam" } }],
        websites: [{ url: "https://store.steampowered.com/app/9/" }],
      }),
    ).toBe("7");
  });

  test("missing and null fields become empty values, not errors", () => {
    const empty = {
      id: 0,
      slug: "",
      name: "",
      summary: "",
      released: "",
      gameType: "",
      image: "",
      alternatives: [],
      genres: [],
      platforms: [],
      platformNames: [],
      developers: [],
      publishers: [],
      criticScore: 0,
      criticCount: 0,
      userScore: 0,
      userCount: 0,
      totalRatingCount: 0,
      modes: [],
      steamAppId: "",
      officialSite: "",
      ageRating: "",
    };
    expect(compactGame({})).toEqual(empty);
    expect(compactGame(null)).toEqual(empty);
    expect(compactGame(undefined)).toEqual(empty);
    expect(
      compactGame({
        id: null,
        name: null,
        slug: 5,
        first_release_date: "soon",
        game_type: null,
        cover: { image_id: "../x" },
        genres: [null, {}, { name: 7 }],
        platforms: "PC",
        involved_companies: [null, {}, { developer: true }],
        game_modes: null,
        external_games: [null, { uid: null }, {}],
        websites: [{}, null, { url: 5 }],
        age_ratings: [null, {}, { organization: {} }, { rating_category: {} }],
        aggregated_rating: null,
        rating: "high",
        total_rating_count: NaN,
      }),
    ).toEqual(empty);
  });

  test("game type, platforms, genres and companies follow the documented layout", () => {
    expect(compactGame({ game_type: { id: 1, type: "DLC" } }).gameType).toBe("DLC");
    expect(compactGame({ game_type: 5 }).gameType).toBe("");
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Platform ${i}`, abbreviation: i === 0 ? "P0" : "" }));
    const game = compactGame({ platforms: many, genres: many, game_modes: many, involved_companies: Array.from({ length: 9 }, (_, i) => ({ developer: true, publisher: true, company: { name: `Co ${i}` } })) });
    expect(game.platforms).toHaveLength(8);
    expect(game.platforms[0]).toBe("P0");
    expect(game.platforms[1]).toBe("Platform 1");
    expect(game.platformNames).toHaveLength(12);
    expect(game.genres).toHaveLength(6);
    expect(game.modes).toHaveLength(6);
    expect(game.developers).toHaveLength(4);
    expect(game.publishers).toHaveLength(4);
  });

  test("release dates are UTC calendar dates from unix seconds", () => {
    expect(isoDate(1320969600)).toBe("2011-11-11");
    expect(isoDate(1320969600 + 86_399)).toBe("2011-11-11");
    for (const bad of [0, -5, null, undefined, "x", NaN, 1e18]) expect(isoDate(bad)).toBe("");
  });

  test("age rating prefers ESRB, then PEGI, and tolerates odd data", () => {
    const rating = (organization, value) => ({ organization: { name: organization }, rating_category: { rating: value } });
    expect(compactGame({ age_ratings: [rating("PEGI", "18"), rating("ESRB", "M")] }).ageRating).toBe("ESRB M");
    expect(compactGame({ age_ratings: [rating("PEGI", "18"), rating("USK", "16")] }).ageRating).toBe("PEGI 18");
    expect(compactGame({ age_ratings: [rating("USK", "16")] }).ageRating).toBe("");
    expect(compactGame({ age_ratings: [rating("ESRB", "")] }).ageRating).toBe("");
    expect(compactGame({ age_ratings: [{ organization: { name: "ESRB" } }] }).ageRating).toBe("");
  });

  test("the official site is only taken from an official website entry with an http(s) url", () => {
    const site = (type, url) => compactGame({ websites: [{ type: { type }, url }] }).officialSite;
    expect(site("Official", "https://example.com/")).toBe("https://example.com/");
    expect(site("official", "http://example.com/")).toBe("http://example.com/");
    expect(site("Official", "javascript:alert(1)")).toBe("");
    expect(site("Twitter", "https://twitter.com/x")).toBe("");
  });

  test("time to beat is whole hours converted from seconds", () => {
    expect(compactTimeToBeat(ttbFixture[0])).toEqual({ hastily: 28, normally: 56, completely: 120 });
    expect(compactTimeToBeat(ttbFixture)).toEqual({ hastily: 28, normally: 56, completely: 120 });
    expect(compactTimeToBeat({ hastily: 5400, normally: 1700 })).toEqual({ hastily: 2, normally: 0, completely: 0 });
    for (const bad of [null, undefined, {}, [], { hastily: "x", normally: -50 }]) {
      expect(compactTimeToBeat(bad)).toEqual({ hastily: 0, normally: 0, completely: 0 });
    }
  });

  test("protondb summary keeps valid tiers only", () => {
    expect(compactProton(protonFixture)).toEqual({ tier: "gold", bestTier: "platinum", trendingTier: "platinum", total: 1003, confidence: "strong" });
    expect(compactProton({ tier: "borked", bestReportedTier: "nonsense", total: "many" })).toEqual({ tier: "borked", bestTier: "", trendingTier: "", total: 0, confidence: "" });
    for (const bad of [null, undefined, {}, { tier: "diamond" }, { tier: "<b>" }, "gold", []]) expect(compactProton(bad)).toBeNull();
  });
});

describe("rendering", () => {
  const signProxy = (url) => `/proxy?u=${encodeURIComponent(url)}`;
  const ttb = { hastily: 28, normally: 56, completely: 120 };
  const proton = compactProton(protonFixture);
  const full = () => buildPanel({ game: SKYRIM, ttb, proton, signProxy, locale: "en-US" });

  test("shows the labelled badges, the facts, the links and a signed portrait cover", () => {
    const html = full();
    expect(html).toContain("Critics · IGDB");
    expect(html).toContain("Players · IGDB");
    expect(html).toContain("31 reviews");
    expect(html).toContain("2,210 ratings");
    expect(html).toContain("game-info-score--good");
    expect(html).toContain("ESRB M");
    expect(html).toContain("Video game · 2011");
    expect(html).toContain("Nov 11, 2011");
    expect(html).toContain("about 28 h main story · 56 h with extras · 120 h completionist");
    expect(html).toContain("Bethesda Game Studios");
    expect(html).toContain("Bethesda Softworks");
    expect(html).toContain("Single player");
    expect(html).toContain('<span class="game-info-chip">PC</span>');
    expect(html).toContain(`/proxy?u=${encodeURIComponent("https://images.igdb.com/igdb/image/upload/t_cover_big_2x/cotestskyrim1.jpg")}`);
    expect(html).toContain('href="https://www.igdb.com/games/the-elder-scrolls-v-skyrim"');
    expect(html).toContain('href="https://store.steampowered.com/app/72850/"');
    expect(html).toContain(">Steam page<");
    expect(html).toContain('href="https://elderscrolls.bethesda.net/en/skyrim"');
    expect(html).toContain(">Official site<");
    expect(html).toContain(">IGDB page<");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  test("shows the ProtonDB badge as a labelled link, and credits it", () => {
    const html = full();
    expect(html).toContain("ProtonDB</small>");
    expect(html).toContain("Gold");
    expect(html).toContain("1,003 reports");
    expect(html).toContain("game-info-proton--gold");
    expect(html).toContain('href="https://www.protondb.com/app/72850"');
    expect(html).toContain('title="Proton compatibility on Linux, from ProtonDB user reports"');
    expect(html).toContain('Data from <a href="https://www.igdb.com" target="_blank" rel="noopener">IGDB</a>, <a href="https://www.protondb.com" target="_blank" rel="noopener">ProtonDB</a>');
  });

  test("every tier gets its own colour class", () => {
    for (const tier of ["platinum", "gold", "silver", "bronze", "borked", "pending"]) {
      expect(buildPanel({ game: SKYRIM, proton: { ...proton, tier } })).toContain(`game-info-proton--${tier}`);
    }
  });

  test("without ProtonDB data there is no badge and no ProtonDB credit, but IGDB is always credited", () => {
    for (const html of [buildPanel({ game: SKYRIM, ttb, signProxy }), buildPanel({ game: SKYRIM, proton: null }), buildPanel({ game: SKYRIM, proton: { ...proton, tier: "diamond" } })]) {
      expect(html).not.toContain("ProtonDB");
      expect(html).not.toContain("protondb.com");
      expect(html).toContain('Data from <a href="https://www.igdb.com" target="_blank" rel="noopener">IGDB</a>');
      expect(html).toContain("Steam page");
    }
  });

  test("the Steam link only comes from a digit app id, never from API text", () => {
    const without = buildPanel({ game: { ...SKYRIM, steamAppId: "" }, proton });
    expect(without).not.toContain("Steam page");
    expect(without).not.toContain("store.steampowered.com");
    expect(without).not.toContain("ProtonDB");
    for (const bad of ["abc", '1"><script>', "12/../x", "https://store.steampowered.com/app/5/", "javascript:1"]) {
      const html = buildPanel({ game: { ...SKYRIM, steamAppId: bad }, proton });
      expect(html).not.toContain("Steam page");
      expect(html).not.toContain("protondb.com/app");
    }
    // A Steam address in the official site field is just an official site link.
    const site = buildPanel({ game: { ...SKYRIM, steamAppId: "", officialSite: "https://store.steampowered.com/app/9999" } });
    expect(site).not.toContain("Steam page");
    expect(site).toContain(">Official site<");
    expect(buildPanel({ game: { ...SKYRIM, steamAppId: 489830 } })).toContain('href="https://store.steampowered.com/app/489830/"');
  });

  test("showDescription controls the summary, and it is cut cleanly", () => {
    const on = buildPanel({ game: SKYRIM });
    expect(on).toContain("Skyrim reimagines and revolutionizes");
    expect(on).toContain('<p class="game-info-desc">');
    const off = buildPanel({ game: SKYRIM, showDescription: false });
    expect(off).not.toContain("Skyrim reimagines");
    expect(off).not.toContain("game-info-desc");
    expect(on).not.toContain("hundreds of quests");
  });

  test("score colours follow the bands", () => {
    const band = (criticScore) => buildPanel({ game: { ...SKYRIM, criticScore, userScore: 0 } });
    expect(band(75)).toContain("game-info-score--good");
    expect(band(74)).toContain("game-info-score--mixed");
    expect(band(50)).toContain("game-info-score--mixed");
    expect(band(49)).toContain("game-info-score--bad");
    const none = buildPanel({ game: { ...SKYRIM, criticScore: 0, userScore: 0, ageRating: "" } });
    expect(none).not.toContain("game-info-scores");
    expect(buildPanel({ game: { ...SKYRIM, criticCount: 0, userCount: 0 } })).not.toContain("reviews");
    expect(buildPanel({ game: { ...SKYRIM, criticCount: 1, userCount: 1 } })).toContain("1 review<");
  });

  test("works with minimal data and always credits IGDB", () => {
    const html = buildPanel({ game: compactGame({ id: 1, slug: "x", name: "X" }) });
    expect(html).toContain("<h3");
    expect(html).toContain("Data from");
    expect(html).toContain('href="https://www.igdb.com"');
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("game-info-cover");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("null");
    expect(buildPanel({ game: compactGame({}) })).toContain("Data from");
    // No signing function: the cover is left out rather than linking the image host directly.
    expect(buildPanel({ game: SKYRIM })).not.toContain("<img");
  });

  test("escapes every text field and drops unsafe links", () => {
    const evil = {
      ...SKYRIM,
      id: 1,
      slug: 'x"><img src=x onerror=alert(1)>',
      name: '<script>alert("n")</script>',
      summary: "<b>bold</b> & <i>x</i>",
      released: "2011-11-11",
      image: 'x" onerror="alert(1)',
      genres: ["<b>g</b>"],
      platforms: ['"><svg onload=alert(1)>'],
      developers: ["<u>dev</u>"],
      publishers: ["<u>pub</u>"],
      modes: ["<s>mode</s>"],
      ageRating: "<i>M</i>",
      officialSite: "javascript:alert(1)",
      steamAppId: "72850",
    };
    const html = buildPanel({ game: evil, ttb, proton, signProxy });
    for (const forbidden of ["<script", "<b>", "<i>", "<u>", "<s>", "<svg", "<img src=x", "onerror=alert", "javascript:", 'onerror="alert']) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;");
    expect(html).not.toContain("igdb.com/games/x");
    const hostileUrl = buildPanel({ game: { ...SKYRIM, officialSite: 'https://evil.test/?q="><script>alert(1)</script>' } });
    expect(hostileUrl).not.toContain("<script");
    const nonHttp = buildPanel({ game: { ...SKYRIM, officialSite: "ftp://example.com/x" } });
    expect(nonHttp).not.toContain("ftp://");
  });

  test("helpers", () => {
    expect(esc('<a href="x">\'&')).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(esc(null)).toBe("");
    expect(esc(5)).toBe("");
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "//x.com", "x", "", null, undefined]) expect(safeUrl(bad)).toBe("");
    expect(formatDate("2011-11-11", "en-US")).toBe("Nov 11, 2011");
    expect(formatDate("2011-11-11")).toBe("Nov 11, 2011");
    for (const bad of ["", "2011", "x", null, undefined, "2011-13-45x"]) expect(formatDate(bad)).toBe("");
    expect(timeToBeatText({ hastily: 0, normally: 56, completely: 0 })).toBe("about 56 h with extras");
    expect(timeToBeatText({ hastily: 10, normally: 0, completely: 99 })).toBe("about 10 h main story · 99 h completionist");
    expect(timeToBeatText({ hastily: 0, normally: 0, completely: 0 })).toBe("");
    expect(timeToBeatText(null)).toBe("");
  });

  test("summaries cut at a sentence after 40 %, else at a word with an ellipsis", () => {
    expect(summarize("  Short   text\n here. ", 300)).toBe("Short text here.");
    expect(summarize(null)).toBe("");
    const exact = "x".repeat(300);
    expect(summarize(exact, 300)).toBe(exact);
    const sentence = `${"A".repeat(150)}. ${"B".repeat(300)}`;
    expect(summarize(sentence, 300)).toBe(`${"A".repeat(150)}.`);
    const early = `${"A".repeat(50)}. ${"word ".repeat(100)}`;
    const cutAtWord = summarize(early, 300);
    expect(cutAtWord.endsWith("…")).toBe(true);
    expect(cutAtWord.length).toBeLessThanOrEqual(301);
    expect(early.replace(/\s+/g, " ").startsWith(cutAtWord.slice(0, -1))).toBe(true);
    expect(cutAtWord).not.toContain("wor…");
    expect(summarize("x".repeat(400), 300)).toBe(`${"x".repeat(300)}…`);
    const bang = `${"A".repeat(200)}! ${"B".repeat(200)}`;
    expect(summarize(bang, 300)).toBe(`${"A".repeat(200)}!`);
    const question = `${"A".repeat(130)}? ${"B".repeat(200)}`;
    expect(summarize(question, 300)).toBe(`${"A".repeat(130)}?`);
  });
});

describe("the slot", () => {
  test("is a valid knowledge panel slot", () => {
    expect(defaultSlot.position).toBe("knowledge-panel");
    expect(defaultSlot.slotPositions).toEqual(["knowledge-panel", "above-sidebar", "below-sidebar", "above-results"]);
    expect(typeof defaultSlot.trigger).toBe("function");
    expect(typeof defaultSlot.execute).toBe("function");
    expect(defaultSlot.isClientExposed).toBe(false);
    expect(defaultSlot.id).toBe("game-info");
  });

  test("credentials are optional in the schema so the environment fallback works, and the secret is a secret", () => {
    const schema = defaultSlot.settingsSchema;
    const field = (key) => schema.find((entry) => entry.key === key);
    expect(field("clientId").type).toBe("text");
    expect(field("clientSecret").type).toBe("password");
    expect(field("clientSecret").secret).toBe(true);
    expect(schema.some((entry) => entry.required)).toBe(false);
    for (const key of ["requireGameWord", "showProtonDb", "steamFallback", "showDescription"]) expect(field(key).type).toBe("toggle");
    expect(field("requireGameWord").default).toBe("false");
    for (const key of ["showProtonDb", "steamFallback", "showDescription"]) expect(field(key).default).toBe("true");
    expect(field("clientId").description).toContain("dev.twitch.tv/console");
  });

  test("the plugin folder is self-contained", () => {
    const folder = new URL("../plugins/game-info/", import.meta.url);
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".js"))) {
      expect(readFileSync(new URL(name, folder), "utf8")).not.toMatch(/from\s+["']\.\.\//);
    }
    expect(readFileSync(new URL("template.html", folder), "utf8").trim()).toBe('<div class="command-result game-info-result">{{content}}</div>');
  });

  test("without credentials nothing triggers and nothing is requested", async () => {
    await withEnv({ IGDB_CLIENT_ID: undefined, IGDB_CLIENT_SECRET: undefined }, async () => {
      for (const settings of [{}, { clientId: ID }, { clientSecret: SECRET }]) {
        const slot = make(settings);
        const context = makeContext();
        expect(slot.trigger("skyrim")).toBe(false);
        expect(await slot.execute("skyrim", context)).toEqual(EMPTY);
        expect(context.calls).toHaveLength(0);
      }
    });
  });

  test("environment credentials are used per field when the setting is empty, and the setting wins", async () => {
    await withEnv({ IGDB_CLIENT_ID: "env-id", IGDB_CLIENT_SECRET: "env-secret" }, async () => {
      const fromEnv = make({});
      expect([fromEnv.clientId, fromEnv.clientSecret]).toEqual(["env-id", "env-secret"]);
      expect(fromEnv.trigger("skyrim")).toBe(true);
      const mixed = make({ clientId: "ui-id", clientSecret: "  " });
      expect([mixed.clientId, mixed.clientSecret]).toEqual(["ui-id", "env-secret"]);
      const ui = make({ clientId: "ui-id", clientSecret: "ui-secret" });
      expect([ui.clientId, ui.clientSecret]).toEqual(["ui-id", "ui-secret"]);
      const context = makeContext();
      await ui.execute("skyrim", context);
      expect(new URLSearchParams(context.calls[0].init.body).get("client_id")).toBe("ui-id");
    });
  });

  test("toggle settings accept strings and booleans", () => {
    const slot = make({ clientId: ID, clientSecret: SECRET, requireGameWord: true, showProtonDb: "false", steamFallback: false, showDescription: "true" });
    expect([slot.requireGameWord, slot.showProtonDb, slot.steamFallback, slot.showDescription]).toEqual([true, false, false, true]);
    const defaults = make({ clientId: ID, clientSecret: SECRET });
    expect([defaults.requireGameWord, defaults.showProtonDb, defaults.steamFallback, defaults.showDescription]).toEqual([false, true, true, true]);
  });

  test("the first query costs a token, a search, a time to beat and a ProtonDB request, and renders the panel", async () => {
    const slot = make();
    slot.init({ template: '<div class="x">{{content}}</div>' });
    const context = makeContext();
    const out = await slot.execute("skyrim", context);
    expect(kinds(context)).toEqual(["token", "search", "ttb", "proton"]);
    expect(out.title).toBe("The Elder Scrolls V: Skyrim");
    expect(out.html).toStartWith('<div class="x"><div class="game-info-card">');
    for (const part of ["Critics · IGDB", "Players · IGDB", "ProtonDB", "https://store.steampowered.com/app/72850/", "about 28 h main story", "Data from"]) {
      expect(out.html).toContain(part);
    }
    const [token, search, ttb, proton] = context.calls;
    expect(token.url).toBe("https://token.test/oauth2/token");
    expect(new URLSearchParams(token.init.body).get("client_secret")).toBe(SECRET);
    expect(search.url).toBe("https://igdb.test/v4/games");
    expect(search.init.method).toBe("POST");
    expect(search.init.headers["Client-ID"]).toBe(ID);
    expect(search.init.headers.Authorization).toBe("Bearer tok-1");
    expect(search.init.body).toStartWith('search "skyrim"; fields ');
    expect(ttb.url).toBe("https://igdb.test/v4/game_time_to_beats");
    expect(ttb.init.body).toContain("where game_id = 472;");
    expect(proton.url).toBe("https://proton.test/api/v1/reports/summaries/72850.json");
    expect(proton.init.headers["User-Agent"]).toContain("degoog-game-info/1.0");
    expect(count(context, "steam")).toBe(0);
  });

  test("the same game is then served from cache with no requests", async () => {
    const slot = make();
    const context = makeContext();
    const first = await slot.execute("skyrim", context);
    context.calls.length = 0;
    const again = await slot.execute("The  Skyrim game", context);
    expect(again.title).toBe("The Elder Scrolls V: Skyrim");
    expect(again.html).toBe(first.html);
    expect(context.calls).toHaveLength(0);
  });

  test("another game reuses the token and the single token request", async () => {
    const slot = make();
    const context = makeContext();
    await slot.execute("skyrim", context);
    context.calls.length = 0;
    const out = await slot.execute("skyrim special edition", context);
    expect(out.title).toBe("The Elder Scrolls V: Skyrim Special Edition");
    expect(kinds(context)).toEqual(["search", "ttb", "proton"]);
    expect(context.calls[2].url).toContain("/489830.json");
    expect(out.html).toContain("https://store.steampowered.com/app/489830/");
  });

  test("a query with no match costs one search, and is remembered", async () => {
    const slot = make();
    const context = makeContext({ search: [] });
    expect(await slot.execute("zzz nothing", context)).toEqual(EMPTY);
    expect(kinds(context)).toEqual(["token", "search"]);
    await slot.execute("zzz nothing", context);
    expect(context.calls).toHaveLength(2);
  });

  test("a loose match is rejected without time to beat or ProtonDB requests", async () => {
    const slot = make();
    const context = makeContext();
    expect((await slot.execute("ring", context)).html).toBe("");
    expect(kinds(context)).toEqual(["token", "search"]);
  });

  test("queries that are not game titles cause no requests at all", async () => {
    const slot = make();
    const context = makeContext();
    for (const query of ["weather", "how to beat skyrim", "what is a roguelike", "example.com", "x"]) {
      expect(slot.trigger(query)).toBe(false);
      expect(await slot.execute(query, context)).toEqual(EMPTY);
    }
    expect(context.calls).toHaveLength(0);
  });

  test("requireGameWord blocks plain queries and allows game ones", async () => {
    const slot = make({ clientId: ID, clientSecret: SECRET, requireGameWord: "true" });
    expect(slot.trigger("skyrim")).toBe(false);
    expect(slot.trigger("skyrim game")).toBe(true);
    const context = makeContext();
    expect(await slot.execute("skyrim", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
  });

  test("showProtonDb off makes no ProtonDB request and shows no badge, credit or ProtonDB text", async () => {
    const slot = make({ clientId: ID, clientSecret: SECRET, showProtonDb: "false" });
    const context = makeContext();
    const out = await slot.execute("skyrim", context);
    expect(kinds(context)).toEqual(["token", "search", "ttb"]);
    expect(out.html).not.toContain("ProtonDB");
    expect(out.html).toContain("Steam page");
  });

  test("showDescription off hides the summary", async () => {
    const slot = make({ clientId: ID, clientSecret: SECRET, showDescription: "false" });
    const out = await slot.execute("skyrim", makeContext());
    expect(out.html).not.toContain("Skyrim reimagines");
    expect(out.html).toContain("The Elder Scrolls V: Skyrim");
  });

  test("a ProtonDB failure still renders, and pauses only ProtonDB", async () => {
    const slot = make();
    const context = makeContext({ respond: (kind) => (kind === "proton" ? new Response("oops", { status: 503 }) : undefined) });
    const warnings = await capture(async () => {
      const out = await slot.execute("skyrim", context);
      expect(out.html).toContain("The Elder Scrolls V: Skyrim");
      expect(out.html).not.toContain("ProtonDB");
    });
    expect(warnings).toHaveLength(1);
    expect(slot.isPaused("protondb")).toBe(true);
    expect(slot.paused).toBe(false);
    expect(slot.trigger("skyrim")).toBe(true);
    context.calls.length = 0;
    const next = await slot.execute("skyrim special edition", context);
    expect(next.html).toContain("Special Edition");
    expect(kinds(context)).toEqual(["search", "ttb"]);
  });

  test("ProtonDB 404 means no reports, is cached as none, and does not pause anything", async () => {
    const slot = make();
    const context = makeContext({ respond: (kind) => (kind === "proton" ? new Response("nope", { status: 404 }) : undefined) });
    const out = await slot.execute("skyrim", context);
    expect(out.html).not.toContain("ProtonDB");
    expect(slot.isPaused("protondb")).toBe(false);
    context.calls.length = 0;
    await slot.execute("skyrim", context);
    expect(context.calls).toHaveLength(0);
  });

  test("ProtonDB 429 and 403 pause ProtonDB only", async () => {
    for (const status of [429, 403]) {
      const slot = make();
      const context = makeContext({ respond: (kind) => (kind === "proton" ? new Response("slow", { status, headers: { "retry-after": "30" } }) : undefined) });
      await capture(() => slot.execute("skyrim", context));
      expect(slot.isPaused("protondb")).toBe(true);
      expect(slot.isPaused("igdb")).toBe(false);
      expect(slot.isPaused("steam")).toBe(false);
    }
  });

  test("a failed time to beat request still renders the panel and pauses IGDB briefly", async () => {
    const slot = make();
    const context = makeContext({ respond: (kind) => (kind === "ttb" ? new Response("oops", { status: 500 }) : undefined) });
    let out;
    await capture(async () => {
      out = await slot.execute("skyrim", context);
    });
    expect(out.html).toContain("The Elder Scrolls V: Skyrim");
    expect(out.html).not.toContain("Time to beat");
    expect(slot.paused).toBe(true);
    expect(slot._pausedUntil.igdb - slot.now()).toBeLessThanOrEqual(60_000);
  });

  test("IGDB 429 pauses IGDB only, for the retry-after time", async () => {
    const slot = make();
    let now = 1_000_000;
    slot.now = () => now;
    const context = makeContext({ respond: (kind) => (kind === "search" ? new Response("slow", { status: 429, headers: { "retry-after": "30" } }) : undefined) });
    await capture(async () => expect(await slot.execute("skyrim", context)).toEqual(EMPTY));
    expect(kinds(context)).toEqual(["token", "search"]);
    expect(slot.paused).toBe(true);
    expect(slot.isPaused("protondb")).toBe(false);
    expect(slot.isPaused("steam")).toBe(false);
    expect(slot.trigger("hades")).toBe(false);
    context.calls.length = 0;
    expect(await slot.execute("hades", context)).toEqual(EMPTY);
    expect(context.calls).toHaveLength(0);
    now += 29_000;
    expect(slot.paused).toBe(true);
    now += 2_000;
    expect(slot.paused).toBe(false);
    expect(slot.trigger("hades")).toBe(true);
  });

  test("a 429 without retry-after pauses for ten minutes, and never longer than an hour", async () => {
    const slot = make();
    const context = makeContext({ respond: (kind) => (kind === "search" ? new Response("slow", { status: 429 }) : undefined) });
    await capture(() => slot.execute("skyrim", context));
    expect(slot._pausedUntil.igdb - slot.now()).toBeGreaterThan(9 * 60_000);
    expect(slot._pausedUntil.igdb - slot.now()).toBeLessThanOrEqual(10 * 60_000);
    const long = make();
    const longContext = makeContext({ respond: (kind) => (kind === "search" ? new Response("slow", { status: 429, headers: { "retry-after": "999999" } }) : undefined) });
    await capture(() => long.execute("skyrim", longContext));
    expect(long._pausedUntil.igdb - long.now()).toBeLessThanOrEqual(3_600_000);
  });

  test("an expired token (401) is replaced once and that request is retried", async () => {
    const slot = make();
    const context = makeContext({ valid: (token) => token === "tok-2" });
    const warnings = await capture(async () => {
      const out = await slot.execute("skyrim", context);
      expect(out.title).toBe("The Elder Scrolls V: Skyrim");
    });
    expect(warnings).toHaveLength(0);
    expect(kinds(context)).toEqual(["token", "search", "token", "search", "ttb", "proton"]);
    expect(context.calls[1].init.headers.Authorization).toBe("Bearer tok-1");
    expect(context.calls[3].init.headers.Authorization).toBe("Bearer tok-2");
    expect(context.calls[4].init.headers.Authorization).toBe("Bearer tok-2");
    expect(slot.paused).toBe(false);
  });

  test("a second 401 pauses IGDB for 30 minutes with one short warning", async () => {
    const slot = make();
    const context = makeContext({ valid: () => false });
    const lines = await capture(async () => expect(await slot.execute("skyrim", context)).toEqual(EMPTY));
    expect(kinds(context)).toEqual(["token", "search", "token", "search"]);
    expect(slot.paused).toBe(true);
    expect(slot._pausedUntil.igdb - slot.now()).toBeGreaterThan(29 * 60_000);
    expect(lines).toHaveLength(1);
    for (const secretish of [SECRET, ID, "tok-1", "tok-2", "http", "igdb.test", "token.test"]) expect(lines[0]).not.toContain(secretish);
    expect(slot.trigger("skyrim")).toBe(false);
  });

  test("a token endpoint that rejects the credentials pauses IGDB for 30 minutes with one warning", async () => {
    for (const status of [400, 401, 403]) {
      const slot = make();
      const context = makeContext({ respond: (kind) => (kind === "token" ? new Response(`bad ${SECRET}`, { status }) : undefined) });
      const lines = await capture(async () => expect(await slot.execute("skyrim", context)).toEqual(EMPTY));
      expect(kinds(context)).toEqual(["token"]);
      expect(slot._pausedUntil.igdb - slot.now()).toBeGreaterThan(29 * 60_000);
      expect(lines).toHaveLength(1);
      expect(lines.join("")).not.toContain(SECRET);
      expect(lines[0]).not.toContain("http");
      expect(slot.trigger("skyrim")).toBe(false);
    }
  });

  test("the Twitch token service being down pauses IGDB for a minute", async () => {
    const slot = make();
    const context = makeContext({ respond: (kind) => (kind === "token" ? new Response("oops", { status: 502 }) : undefined) });
    await capture(() => slot.execute("skyrim", context));
    expect(slot._pausedUntil.igdb - slot.now()).toBeLessThanOrEqual(60_000);
    expect(slot.paused).toBe(true);
  });

  test("the token is kept on disk and reused by a new slot without a token request", async () => {
    const file = join(tempFolder(), "igdb", "token.json");
    const first = make();
    first.tokens = new TokenStore({ file, now: () => first.now() });
    await first.execute("skyrim", makeContext());
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("tok-1");
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    const second = make();
    second.tokens = new TokenStore({ file, now: () => second.now() });
    const context = makeContext();
    await second.execute("skyrim special edition", context);
    expect(kinds(context)).toEqual(["search", "ttb", "proton"]);
    expect(context.calls[0].init.headers.Authorization).toBe("Bearer tok-1");
  });

  test("a network failure or server error pauses briefly, never throws and never logs the secret", async () => {
    const slot = make();
    const context = {
      ...makeContext(),
      fetch: async (url) => {
        throw new Error(`boom ${url} ${SECRET}`);
      },
    };
    const lines = await capture(async () => expect(await slot.execute("skyrim", context)).toEqual(EMPTY));
    expect(slot.paused).toBe(true);
    expect(lines.join("")).not.toContain(SECRET);
    expect(lines.join("")).not.toContain("http");

    const serverError = make();
    const failing = makeContext({ respond: (kind) => (kind === "search" ? new Response("oops", { status: 502 }) : undefined) });
    await capture(async () => expect(await serverError.execute("skyrim", failing)).toEqual(EMPTY));
    expect(serverError.paused).toBe(true);
    expect(serverError._pausedUntil.igdb - serverError.now()).toBeLessThanOrEqual(60_000);

    const forbidden = make();
    const denied = makeContext({ respond: (kind) => (kind === "search" ? new Response("no", { status: 403 }) : undefined) });
    await capture(async () => expect(await forbidden.execute("skyrim", denied)).toEqual(EMPTY));
    expect(forbidden._pausedUntil.igdb - forbidden.now()).toBeGreaterThan(29 * 60_000);
    expect(kinds(denied)).toEqual(["token", "search"]);
  });

  test("a reply that is not a list is not cached and shows nothing", async () => {
    const slot = make();
    const context = makeContext({ search: { message: "unexpected" } });
    expect(await slot.execute("skyrim", context)).toEqual(EMPTY);
    expect(slot.paused).toBe(false);
    await slot.execute("skyrim", context);
    expect(count(context, "search")).toBe(2);
  });

  test("simultaneous identical searches share their requests", async () => {
    const slot = make();
    const context = makeContext();
    const outs = await Promise.all([slot.execute("skyrim", context), slot.execute("skyrim", context), slot.execute("Skyrim game", context)]);
    expect(outs.every((out) => out.title === "The Elder Scrolls V: Skyrim")).toBe(true);
    expect([count(context, "token"), count(context, "search"), count(context, "ttb"), count(context, "proton")]).toEqual([1, 1, 1, 1]);
  });

  test("IGDB requests keep their distance", async () => {
    const slot = make();
    slot.spacingMs = 300;
    let now = 1_000_000;
    const sleeps = [];
    slot.now = () => now;
    slot.sleep = async (ms) => {
      sleeps.push(ms);
      now += ms;
    };
    await slot.execute("skyrim", makeContext());
    expect(sleeps).toEqual([300]);
    const parallel = make();
    parallel.spacingMs = 300;
    let clock = 5_000_000;
    const waits = [];
    parallel.now = () => clock;
    parallel.sleep = async (ms) => {
      waits.push(ms);
      clock += ms;
    };
    const context = makeContext();
    await Promise.all([parallel.execute("skyrim", context), parallel.execute("skyrim special edition", context)]);
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(waits.every((ms) => ms > 0 && ms <= 300)).toBe(true);
  });

  test("uses degoog's cache with the documented namespaces and lifetimes", async () => {
    const slot = make();
    const stores = {};
    const lifetimes = {};
    const base = makeContext();
    const context = {
      ...base,
      useCache: (name, ttl) => {
        stores[name] ??= new Map();
        lifetimes[name] = ttl;
        return {
          get: async (key) => stores[name].get(key) ?? null,
          set: async (key, value) => void stores[name].set(key, value),
        };
      },
    };
    await slot.execute("skyrim", context);
    expect(Object.keys(stores).sort()).toEqual(["ext:game-info:proton", "ext:game-info:search", "ext:game-info:ttb"]);
    expect(lifetimes).toEqual({
      "ext:game-info:search": 24 * 3_600_000,
      "ext:game-info:ttb": 7 * 24 * 3_600_000,
      "ext:game-info:proton": 24 * 3_600_000,
    });
    expect(base.calls).toHaveLength(4);
    await slot.execute("skyrim", context);
    expect(base.calls).toHaveLength(4);
  });
});

describe("the Steam fallback", () => {
  const SE_NAME = "The Elder Scrolls V: Skyrim Special Edition";
  const noSteamGame = (overrides = {}) => [
    {
      id: 7001,
      slug: "the-elder-scrolls-v-skyrim-special-edition",
      name: SE_NAME,
      first_release_date: 1477612800,
      game_type: { type: "Remaster" },
      platforms: [{ name: "PC (Microsoft Windows)", abbreviation: "PC" }, { name: "PlayStation 4", abbreviation: "PS4" }],
      total_rating_count: 400,
      rating: 80,
      rating_count: 400,
      ...overrides,
    },
  ];
  const run = async (search, settings = { clientId: ID, clientSecret: SECRET }, steam = steamFixture) => {
    const slot = make(settings);
    const context = makeContext({ search, steam });
    const out = await slot.execute("skyrim special edition", context);
    return { slot, context, out };
  };

  test("an exact name match supplies the Steam page and ProtonDB looks it up", async () => {
    const { context, out } = await run(noSteamGame());
    expect(count(context, "steam")).toBe(1);
    expect(new URL(context.calls.find((call) => kindOf(call.url) === "steam").url).searchParams.get("term")).toBe(SE_NAME);
    expect(context.calls.find((call) => kindOf(call.url) === "proton").url).toContain("/489830.json");
    expect(out.html).toContain("https://store.steampowered.com/app/489830/");
    expect(out.html).toContain("ProtonDB");
  });

  test("only an exact name counts, and only for an app", async () => {
    const near = { items: [{ type: "app", name: `${SE_NAME} - Soundtrack`, id: 5 }, { type: "dlc", name: SE_NAME, id: 6 }, { type: "app", name: "Skyrim", id: 7 }] };
    const { context, out } = await run(noSteamGame(), undefined, near);
    expect(count(context, "steam")).toBe(1);
    expect(count(context, "proton")).toBe(0);
    expect(out.html).not.toContain("Steam page");
    expect(out.html).not.toContain("store.steampowered.com");
    expect(out.title).toBe(SE_NAME);
  });

  test("names are compared ignoring case, accents and punctuation but not words", async () => {
    const lax = { items: [{ type: "app", name: "the elder scrolls v: skyrim  SPECIAL edition!", id: 321 }] };
    const { out } = await run(noSteamGame(), undefined, lax);
    expect(out.html).toContain("https://store.steampowered.com/app/321/");
  });

  test("an id that is not a number is never used", async () => {
    const hostile = { items: [{ type: "app", name: SE_NAME, id: "1/../x" }] };
    const { out } = await run(noSteamGame(), undefined, hostile);
    expect(out.html).not.toContain("Steam page");
  });

  test("no request when IGDB already has a Steam page", async () => {
    const { context } = await run(gamesFixture);
    expect(count(context, "steam")).toBe(0);
  });

  test("no request for games that are not on PC", async () => {
    const consoleOnly = noSteamGame({ platforms: [{ name: "PlayStation 4", abbreviation: "PS4" }, { name: "Nintendo Switch" }] });
    const { context, out } = await run(consoleOnly);
    expect(count(context, "steam")).toBe(0);
    expect(out.html).not.toContain("Steam page");
    for (const name of ["Linux", "Mac", "PC (Microsoft Windows)", "Windows"]) {
      const { context: other } = await run(noSteamGame({ platforms: [{ name }] }));
      expect(count(other, "steam")).toBe(1);
    }
  });

  test("the setting turns it off", async () => {
    const { context, out } = await run(noSteamGame(), { clientId: ID, clientSecret: SECRET, steamFallback: "false" });
    expect(count(context, "steam")).toBe(0);
    expect(count(context, "proton")).toBe(0);
    expect(out.html).not.toContain("Steam page");
  });

  test("the answer, including none, is cached", async () => {
    const slot = make();
    const context = makeContext({ search: noSteamGame(), steam: { items: [] } });
    await slot.execute("skyrim special edition", context);
    context.calls.length = 0;
    await slot.execute("skyrim special edition", context);
    expect(context.calls).toHaveLength(0);

    const found = make();
    const foundContext = makeContext({ search: noSteamGame() });
    await found.execute("skyrim special edition", foundContext);
    foundContext.calls.length = 0;
    await found.execute("skyrim special edition", foundContext);
    expect(foundContext.calls).toHaveLength(0);
  });

  test("uses its own cache namespace with a one week lifetime", async () => {
    const slot = make();
    const lifetimes = {};
    const base = makeContext({ search: noSteamGame() });
    const context = {
      ...base,
      useCache: (name, ttl) => {
        lifetimes[name] = ttl;
        const store = (lifetimes[`store:${name}`] ??= new Map());
        return { get: async (key) => store.get(key) ?? null, set: async (key, value) => void store.set(key, value) };
      },
    };
    await slot.execute("skyrim special edition", context);
    expect(lifetimes["ext:game-info:steam"]).toBe(7 * 24 * 3_600_000);
  });

  test("a Steam server error pauses Steam only and the panel still renders", async () => {
    const slot = make();
    const context = makeContext({ search: noSteamGame(), respond: (kind) => (kind === "steam" ? new Response("oops", { status: 500 }) : undefined) });
    let out;
    await capture(async () => {
      out = await slot.execute("skyrim special edition", context);
    });
    expect(out.html).toContain(SE_NAME);
    expect(slot.isPaused("steam")).toBe(true);
    expect(slot.paused).toBe(false);
    expect(slot.isPaused("protondb")).toBe(false);
    expect(out.html).not.toContain("Steam page");
  });
});

describe("secrets", () => {
  test("no credential or token reaches a log line, the html or a request address", async () => {
    const scenarios = [
      makeContext(),
      makeContext({ valid: (token) => token === "tok-2" }),
      makeContext({ valid: () => false }),
      makeContext({ respond: (kind) => (kind === "token" ? new Response(`bad ${SECRET} ${ID}`, { status: 401 }) : undefined) }),
      makeContext({ respond: (kind) => (kind === "proton" ? new Response("x", { status: 500 }) : undefined) }),
      { ...makeContext(), fetch: async (url) => { throw new Error(`down ${url} ${SECRET} ${ID} tok-1`); } },
    ];
    const everything = [];
    for (const context of scenarios) {
      const slot = make();
      const lines = await capture(async () => {
        const out = await slot.execute("skyrim", context);
        everything.push(out.html);
      });
      everything.push(...lines);
      for (const call of context.calls ?? []) {
        everything.push(call.url);
        // The bearer token is meant to be in the Authorization header, nowhere else.
        if (kindOf(call.url) !== "token") {
          everything.push(String(call.init.body ?? ""));
          for (const [name, value] of Object.entries(call.init.headers ?? {})) if (name !== "Authorization") everything.push(String(value));
        }
      }
    }
    const text = everything.join("\n");
    for (const secret of [SECRET, "tok-1", "tok-2"]) expect(text).not.toContain(secret);
    // The client id is sent as a header on IGDB calls, but is never in a url, log line or the page.
    for (const context of scenarios) for (const call of context.calls ?? []) expect(call.url).not.toContain(ID);
  });

  test("the secret only ever appears in the body of the token request", async () => {
    const slot = make();
    const context = makeContext();
    await slot.execute("skyrim", context);
    for (const call of context.calls) {
      const carriesSecret = JSON.stringify(call.init).includes(SECRET);
      expect(carriesSecret).toBe(kindOf(call.url) === "token");
    }
  });
});

// --- Decision quality: regression tests (invented titles) ---

// An IGDB-shaped compact game for an invented title.
const igdbGame = (id, name, ratings, extra = {}) => compactGame({ id, name, total_rating_count: ratings, game_type: { type: "Main Game" }, ...extra });

describe("specificity bands and edition marks", () => {
  test("one short word is low, one long word or two words medium, three words or 14+ characters high", () => {
    expect(specificity("skyrim")).toBe("low");
    expect(specificity("hades")).toBe("low");
    expect(specificity("root")).toBe("low");
    expect(specificity("wingspan")).toBe("medium");
    expect(specificity("elden ring")).toBe("medium");
    expect(specificity("the witness")).toBe("medium");
    expect(specificity("red dead redemption")).toBe("high");
    expect(specificity("Elden Ring (Deluxe Edition)")).toBe("medium");
    expect(specificity("")).toBe("low");
  });

  test("edition marks and parentheticals are ignored on both sides", () => {
    expect(stripDecorations("Elden Ring (Deluxe Edition)")).toBe("Elden Ring");
    expect(stripDecorations("Skyrim: Special Edition")).toBe("Skyrim");
    expect(stripDecorations("Mass Effect Legendary Edition")).toBe("Mass Effect");
    expect(stripDecorations("Doom Remastered")).toBe("Doom");
    expect(stripDecorations("Resident Evil 4 (2023)")).toBe("Resident Evil 4");
    expect(stripDecorations("Final Fantasy VII Remake")).toBe("Final Fantasy VII Remake");
    expect(titleSimilarity("elden ring", "Elden Ring (Deluxe Edition)")).toBe(1);
    expect(titleSimilarity("elden ring deluxe edition", "Elden Ring")).toBe(1);
    expect(titleSimilarity("hollow knight game of the year edition", "Hollow Knight")).toBe(1);
  });

  test("the numeral rule is not affected: 'hades 2' is not 'Hades'", () => {
    expect(titleSimilarity("hades 2", "Hades")).toBeLessThan(0.9);
    expect(titleSimilarity("hades ii", "Hades (Deluxe Edition)")).toBeLessThan(0.9);
    expect(pickGame("hades 2", [igdbGame(1, "Hades", 5000)], false)).toBeNull();
  });

  test("specificity lowers the ratings needed for an exact title", () => {
    expect(BARS.exact.high).toBeLessThan(BARS.exact.medium);
    expect(BARS.exact.medium).toBeLessThan(BARS.exact.low);
    for (const band of ["low", "medium", "high"]) {
      expect(judge({ sim: 1, pop: BARS.exact[band], intent: false, band }).accepted).toBe(true);
      expect(judge({ sim: 1, pop: BARS.exact[band] - 1, intent: false, band }).accepted).toBe(false);
    }
    expect(judge({ sim: 1, pop: 2, intent: false, band: "low" }).rule).toBe("needs pop>=20, has 2");
  });

  test("the first result that matches closely needs half the ratings, a non-matching one never passes", () => {
    expect(judge({ sim: 1, pop: 10, intent: false, band: "low", rank: 0 }).accepted).toBe(true);
    expect(judge({ sim: 1, pop: 10, intent: false, band: "low", rank: 1 }).accepted).toBe(false);
    expect(judge({ sim: 1, pop: 9, intent: false, band: "low", rank: 0 }).accepted).toBe(false);
    expect(judge({ sim: 0.5, pop: 99999, intent: false, band: "high", rank: 0 }).accepted).toBe(false);
    expect(judge({ sim: 0.85, pop: 99999, intent: false, band: "high", rank: 0 }).accepted).toBe(false);
  });
});

describe("popularity signals and alternative names", () => {
  test("the strongest rating count wins and a missing or null count never zeroes the others", () => {
    expect(popularity({ totalRatingCount: 0, userCount: 0, criticCount: 40 })).toBe(40);
    expect(popularity({ totalRatingCount: null, userCount: undefined, criticCount: "x" })).toBe(0);
    expect(popularity({ totalRatingCount: 12, userCount: 30, criticCount: 5 })).toBe(35);
    expect(popularity({ totalRatingCount: 500, userCount: 1, criticCount: 1 })).toBe(500);
    expect(popularity({ userCount: 7 })).toBe(7);
  });

  test("a game known only by a few counts of one kind still passes", () => {
    const onlyCritics = igdbGame(9, "Wide Tundra Chronicle", 0, { aggregated_rating_count: 12 });
    expect(pickGame("wide tundra chronicle", [onlyCritics], false)?.id).toBe(9);
  });

  test("alternative names are compared, but a short generic query trusts them less", () => {
    const aliased = igdbGame(10, "Lantern Keepers of the Deep", 400, { alternative_names: [{ name: "Delve" }, { name: "深海守护者" }] });
    expect(aliased.alternatives).toEqual(["Delve", "深海守护者"]);
    expect(scoreGame("delve", aliased).sim).toBeLessThanOrEqual(0.85); // low specificity cap
    expect(pickGame("delve", [aliased], false)).toBeNull();
    const longAlias = igdbGame(11, "Something Unrelated", 400, { alternative_names: [{ name: "Sunken Lantern Archive" }] });
    expect(pickGame("sunken lantern archive", [longAlias], false)?.id).toBe(11);
    // a name in another script is never compared (it would lose its letters when normalised)
    const foreign = igdbGame(12, "Totally Different Game", 4000, { alternative_names: [{ name: "Skyrim 上古卷轴" }] });
    expect(scoreGame("skyrim", foreign).sim).toBeLessThan(0.5);
  });

  test("the query may not simply add words to an alternative name ('skyrim vr' is not 'Skyrim')", () => {
    const base = igdbGame(1, "The Elder Scrolls V: Skyrim", 2000, { alternative_names: [{ name: "Skyrim" }] });
    const vr = igdbGame(2, "The Elder Scrolls V: Skyrim VR", 300, { alternative_names: [{ name: "Skyrim VR" }] });
    expect(pickGame("skyrim vr", [base, vr], false)?.id).toBe(2);
    expect(pickGame("skyrim", [base, vr], false)?.id).toBe(1);
  });
});

describe("exact titles with several entries (a game that is also a board game)", () => {
  const wingspan = [
    igdbGame(1, "Wingspan", 60, { total_rating_count: 60 }),
    igdbGame(2, "Wingspan: European Expansion", 8, { game_type: { type: "Standalone Expansion" } }),
    igdbGame(3, "Wingspan: Oceania Expansion", 4, { game_type: { type: "Expansion" } }),
    igdbGame(4, "Wingspan Fan Remix", 1, { game_type: { type: "Mod" } }),
  ];

  test("an exact title of a modest game shows without a keyword", () => {
    expect(pickGame("wingspan", wingspan, false)?.id).toBe(1);
    expect(pickGame("wingspan", wingspan, true)?.id).toBe(1);
  });

  test("a different, less specific copy does not win, and expansions and mods stay out", () => {
    expect(pickGame("wingspan", wingspan.slice(1), false)).toBeNull();
    expect(pickGame("wingspan european expansion", wingspan, false)?.id).toBe(2);
  });

  test("the same name with a digital edition mark still matches the base title", () => {
    const digital = [igdbGame(5, "Wingspan (Digital Edition)", 80)];
    expect(pickGame("wingspan", digital, false)?.id).toBe(5);
  });

  test("generic one-word titles stay quiet unless the game is well known", () => {
    for (const word of ["Root", "Risk", "Carl", "Hades"]) {
      expect(pickGame(word.toLowerCase(), [igdbGame(1, word, 6)], false)).toBeNull();
    }
    expect(pickGame("hades", [igdbGame(1, "Hades", 4000)], false)?.id).toBe(1);
  });

  test("'weather' is not a game search", () => {
    expect(looksLikeATitleSearch("weather")).toBe(false);
  });
});

describe("explaining decisions (debugMatching)", () => {
  test("formatExplanation lists candidates with signals, verdicts and the outcome", () => {
    const text = formatExplanation("skyrim", "skyrim", false, evaluate("skyrim", compactFixture, false, { explain: true }));
    const lines = text.split("\n");
    expect(lines[0]).toBe('[game-info] "skyrim" term="skyrim" intent=false specificity=low source=igdb');
    expect(lines[1]).toMatch(/^ {2}#1 "The Elder Scrolls V: Skyrim" sim=0\.88 signals\[.*total=\d+.*\] pop=\d+ -> accepted by subtitle, low specificity/);
    expect(text).toContain('rejected: game type "DLC" is not a game of its own');
    expect(lines.at(-1)).toMatch(/^ {2}=> panel: "The Elder Scrolls V: Skyrim" \(/);
    expect(lines.filter((line) => line.startsWith("  #")).length).toBeLessThanOrEqual(6);
  });

  test("a rejection says what is missing", () => {
    const text = formatExplanation("hades", "hades", false, evaluate("hades", [igdbGame(1, "Hades", 2)], false, { explain: true }));
    expect(text).toContain("rejected: needs pop>=10 (first result), has 2");
    expect(text.split("\n").at(-1)).toMatch(/^ {2}=> no panel/);
    expect(formatExplanation("x", "x", false, evaluate("x", [], false, { explain: true }))).toContain("(no candidates)");
  });

  test("hostile names stay on one line each", () => {
    const many = Array.from({ length: 9 }, (_, i) => igdbGame(i + 1, `Name ${i}\n[injected] ${"x".repeat(300)}`, 3));
    const lines = formatExplanation("name", "name", false, evaluate("name", many, false, { explain: true })).split("\n");
    expect(lines.filter((line) => line.startsWith("  #"))).toHaveLength(6);
    expect(lines.every((line) => !line.startsWith("[injected]"))).toBe(true);
  });

  test("the slot logs the block only when debugMatching is on, and never the credentials", async () => {
    const off = make({ clientId: ID, clientSecret: SECRET });
    expect(await capture(() => off.execute("skyrim", makeContext()))).toEqual([]);
    const on = make({ clientId: ID, clientSecret: SECRET, debugMatching: "true" });
    const lines = await capture(() => on.execute("skyrim", makeContext()));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith('[game-info] "skyrim" term="skyrim"');
    expect(lines[0]).toContain("=> panel:");
    for (const secret of [ID, SECRET, "tok-1", "http"]) expect(lines[0]).not.toContain(secret);
  });

  test("a title-like query the gating rejects gets one line naming the rule, only in debug mode", async () => {
    const strict = make({ clientId: ID, clientSecret: SECRET, debugMatching: true, requireGameWord: true });
    const lines = await capture(async () => {
      expect(strict.trigger("skyrim")).toBe(false);
      expect(strict.trigger("how to bake bread")).toBe(false);
    });
    expect(lines).toEqual(['[game-info] "skyrim" skipped: requireGameWord is on and the query has no game word']);
    const quiet = make({ clientId: ID, clientSecret: SECRET, requireGameWord: true });
    expect(await capture(async () => expect(quiet.trigger("skyrim")).toBe(false))).toEqual([]);
  });

  test("the setting is advanced, off by default and never required", () => {
    const field = SETTINGS_SCHEMA.find((entry) => entry.key === "debugMatching");
    expect(field).toMatchObject({ type: "toggle", default: "false", advanced: true });
    expect(field.required).toBeUndefined();
  });
});

// --- Board game or video game? The board game panel is preferred when both match ---

describe("preferring the board game panel", () => {
  // A fake board-games lookup. `answer` is a function (or a value) for what lookupTitle returns.
  const fakeBoard = (answer) => {
    const calls = [];
    const lookup = async (request) => {
      calls.push(request);
      return typeof answer === "function" ? answer(request) : answer;
    };
    return { calls, lookup };
  };
  const withBoard = (settings, board) => {
    const slot = make({ clientId: ID, clientSecret: SECRET, ...settings });
    slot.boardLookup = () => board?.lookup;
    return slot;
  };
  const MATCH = { status: "match", name: "Skyrim: The Board Game", id: "900123" };
  const searches = (context) => kinds(context).filter((kind) => kind === "search").length;

  test("the symbol is the documented one and the default lookup reads the global", async () => {
    expect(BOARD_GAMES_LOOKUP).toBe(Symbol.for("degoog-extentions.board-games.lookup"));
    const slot = make();
    expect(slot.boardLookup()).toBeUndefined();
    const lookup = async () => ({ status: "none" });
    globalThis[BOARD_GAMES_LOOKUP] = lookup;
    try {
      expect(slot.boardLookup()).toBe(lookup);
    } finally {
      delete globalThis[BOARD_GAMES_LOOKUP];
    }
  });

  test("a matching board game hides the video game panel, before any follow-up request", async () => {
    const board = fakeBoard(MATCH);
    const slot = withBoard({}, board);
    const context = makeContext();
    expect(await slot.execute("skyrim", context)).toEqual(EMPTY);
    expect(board.calls).toHaveLength(1);
    expect(board.calls[0].term).toBe("skyrim");
    expect(board.calls[0].context).toBe(context);
    expect(board.calls[0].deadlineMs).toBeGreaterThan(0);
    expect(board.calls[0].deadlineMs).toBeLessThanOrEqual(5000);
    expect(kinds(context)).toEqual(["token", "search"]); // no time to beat, Steam or ProtonDB request for a hidden panel
  });

  test("none, unknown, anything odd, a throw, or no board-games plugin: the video game shows", async () => {
    for (const answer of [{ status: "none" }, { status: "unknown" }, undefined, null, "match", 5, { status: "other" }, {}]) {
      const slot = withBoard({}, fakeBoard(answer));
      expect((await slot.execute("skyrim", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
    }
    const throwing = withBoard({}, fakeBoard(() => { throw new Error("boom"); }));
    expect((await throwing.execute("skyrim", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
    expect((await withBoard({}, null).execute("skyrim", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
    const notAFunction = make({ clientId: ID, clientSecret: SECRET });
    notAFunction.boardLookup = () => "nope";
    expect((await notAFunction.execute("skyrim", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
  });

  test("a lookup that never answers cannot hold the panel past the wait budget", async () => {
    const slot = withBoard({}, fakeBoard(() => new Promise(() => {})));
    slot.startWindowMs = 500;
    const started = Date.now();
    const out = await slot.execute("skyrim", makeContext());
    expect(out.title).toBe("The Elder Scrolls V: Skyrim");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("the wait is the setting (5 s by default), capped by the time left of 70 % of the slot timeout, and skipped when almost nothing is left", async () => {
    const board = fakeBoard({ status: "none" });
    const roomy = withBoard({}, board);
    roomy.startWindowMs = 7000;
    await roomy.execute("skyrim", makeContext());
    expect(board.calls[0].deadlineMs).toBeLessThanOrEqual(5000);
    expect(board.calls[0].deadlineMs).toBeGreaterThan(4500);

    const tight = fakeBoard({ status: "none" });
    const small = withBoard({}, tight);
    small.startWindowMs = 1000;
    await small.execute("skyrim", makeContext());
    expect(tight.calls[0].deadlineMs).toBeLessThanOrEqual(1000);

    // the time already used counts: a slow IGDB search leaves less
    const used = fakeBoard({ status: "none" });
    const slowSearch = withBoard({}, used);
    slowSearch.startWindowMs = 1200;
    const context = makeContext();
    const realFetch = context.fetch;
    context.fetch = async (url, init) => {
      if (kindOf(url) === "search") await new Promise((resolve) => setTimeout(resolve, 150));
      return realFetch(url, init);
    };
    await slowSearch.execute("skyrim", context);
    expect(used.calls[0].deadlineMs).toBeLessThanOrEqual(1050);

    // nothing left: the lookup is not even asked, and the video game shows
    const none = fakeBoard(MATCH);
    const spent = withBoard({}, none);
    spent.startWindowMs = 100;
    expect((await spent.execute("skyrim", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
    expect(none.calls).toHaveLength(0);
  });

  test("a clock that already ran out never waits longer than the slot allows", async () => {
    const board = fakeBoard(MATCH);
    const slot = withBoard({}, board);
    let ticks = 0;
    slot.now = () => 1_000_000 + (ticks += 4000); // every reading is 4 s later than the previous one
    const out = await slot.execute("skyrim", makeContext());
    expect(board.calls).toHaveLength(0);
    expect(out.title).toBe("The Elder Scrolls V: Skyrim");
  });

  test("with preferBoardGames off the lookup is never called", async () => {
    for (const value of ["false", false]) {
      const board = fakeBoard(MATCH);
      const slot = withBoard({ preferBoardGames: value }, board);
      expect((await slot.execute("skyrim", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
      expect(board.calls).toHaveLength(0);
    }
    const on = fakeBoard(MATCH);
    expect(await withBoard({ preferBoardGames: "true" }, on).execute("skyrim", makeContext())).toEqual(EMPTY);
    expect(on.calls).toHaveLength(1);
    expect(make().preferBoardGames).toBe(true);
    const field = SETTINGS_SCHEMA.find((entry) => entry.key === "preferBoardGames");
    expect(field).toMatchObject({ type: "toggle", default: "true" });
    expect(field.required).toBeUndefined();
    expect(field.description).toContain("show the board game panel and hide this one");
  });

  test("a video-game-specific word skips the check entirely and keeps the video game", async () => {
    for (const query of ["skyrim ps5", "skyrim walkthrough", "skyrim video game", "skyrim steam", "skyrim pc", "skyrim dlc", "skyrim mods", "skyrim remastered", "skyrim xbox series x", "skyrim nintendo switch", "skyrim gameplay", "skyrim speedrun"]) {
      const board = fakeBoard(MATCH);
      const slot = withBoard({}, board);
      const out = await slot.execute(query, makeContext());
      expect(out.title).toBe("The Elder Scrolls V: Skyrim");
      expect(board.calls).toHaveLength(0);
    }
  });

  test("a board game word keeps this panel from showing at all (and asks nothing)", async () => {
    for (const query of ["skyrim board game", "skyrim boardgame", "skyrim tabletop", "skyrim rules", "skyrim rulebook", "skyrim bgg", "skyrim card game", "skyrim expansion", "skyrim how to play", "skyrim worker placement"]) {
      const board = fakeBoard(MATCH);
      const slot = withBoard({}, board);
      const context = makeContext();
      expect(slot.trigger(query)).toBe(false);
      expect(await slot.execute(query, context)).toEqual(EMPTY);
      expect(context.calls).toHaveLength(0);
      expect(board.calls).toHaveLength(0);
    }
    // unless a word that can only mean a video game is there too
    const board = fakeBoard({ status: "none" });
    const slot = withBoard({}, board);
    expect(slot.trigger("skyrim board game ps5")).toBe(true);
    expect((await slot.execute("skyrim board game ps5", makeContext())).title).toBe("The Elder Scrolls V: Skyrim");
    expect(board.calls).toHaveLength(0);
  });

  test("the ambiguous words ('game', 'guide', 'review', 'wiki', 'trailer', 'co-op') ask the board game first", async () => {
    for (const query of ["skyrim game", "skyrim games", "skyrim guide", "skyrim review", "skyrim wiki", "skyrim trailer", "skyrim co-op", "skyrim multiplayer", "skyrim release date"]) {
      const board = fakeBoard(MATCH);
      const slot = withBoard({}, board);
      expect(slot.trigger(query)).toBe(true);
      expect(await slot.execute(query, makeContext())).toEqual(EMPTY);
      expect(board.calls).toHaveLength(1);
      expect(board.calls[0].term).toBe("skyrim"); // the trailing word is not part of the title
    }
  });

  test("a title that is only a video game is unaffected: the board game lookup says none or unknown", async () => {
    for (const title of [{ query: "skyrim", expected: "The Elder Scrolls V: Skyrim" }]) {
      const slot = withBoard({}, fakeBoard({ status: "none" }));
      expect((await slot.execute(title.query, makeContext())).title).toBe(title.expected);
    }
    expect(withBoard({}, fakeBoard({ status: "none" })).trigger("elden ring")).toBe(true);
  });

  test("no board game question for a game that is not a confident pick, and none when the plugin would not trigger", async () => {
    const board = fakeBoard(MATCH);
    const slot = withBoard({}, board);
    expect(await slot.execute("zzz nothing", makeContext({ search: [] }))).toEqual(EMPTY);
    expect(await withBoard({ clientId: "", clientSecret: "" }, board).execute("skyrim", makeContext())).toEqual(EMPTY);
    expect(board.calls).toHaveLength(0);
  });

  test("a hidden panel is not cached as 'no game': the IGDB search stays cached, the board decision is asked again", async () => {
    const board = fakeBoard(MATCH);
    const slot = withBoard({}, board);
    const context = makeContext();
    await slot.execute("skyrim", context);
    await slot.execute("skyrim", context);
    expect(searches(context)).toBe(1);
    expect(board.calls).toHaveLength(2);
    // when the board game plugin later answers "none", the video game shows without another IGDB search
    board.lookup = async () => ({ status: "none" });
    slot.boardLookup = () => board.lookup;
    expect((await slot.execute("skyrim", context)).title).toBe("The Elder Scrolls V: Skyrim");
    expect(searches(context)).toBe(1);
  });

  test("debugMatching logs one line saying which board game won, or why the video game stayed, and no secrets", async () => {
    const loud = withBoard({ debugMatching: "true" }, fakeBoard(MATCH));
    const lines = await capture(() => loud.execute("skyrim", makeContext()));
    expect(lines.filter((line) => line.includes("hidden, a board game matches"))).toEqual(['[game-info] "skyrim" hidden, a board game matches: "Skyrim: The Board Game" (id 900123)']);
    const stayed = withBoard({ debugMatching: "true" }, fakeBoard({ status: "unknown" }));
    const other = await capture(() => stayed.execute("skyrim", makeContext()));
    expect(other.some((line) => line === '[game-info] "skyrim" shown, board game lookup: unknown')).toBe(true);
    const absent = withBoard({ debugMatching: "true" }, null);
    expect((await capture(() => absent.execute("skyrim", makeContext()))).some((line) => line.includes("board game lookup"))).toBe(false);
    for (const line of [...lines, ...other]) {
      for (const secret of [ID, SECRET, "tok-1", "http"]) expect(line).not.toContain(secret);
    }
    // quiet by default
    const quiet = withBoard({}, fakeBoard(MATCH));
    expect(await capture(() => quiet.execute("skyrim", makeContext()))).toEqual([]);
  });

  test("hostile names from the other plugin are cleaned before they reach the log", async () => {
    const hostile = withBoard({ debugMatching: "true" }, fakeBoard({ status: "match", name: `Bad\n[injected] ${"x".repeat(300)}`, id: "9<script>\n1" }));
    const lines = await capture(() => hostile.execute("skyrim", makeContext()));
    const line = lines.find((entry) => entry.includes("hidden"));
    expect(line.includes("\n")).toBe(false);
    expect(line).not.toContain("<script>");
    expect(line.length).toBeLessThan(250);
  });
});

describe("how long to wait for the board game answer (boardGameWaitSeconds)", () => {
  const waitFor = async (settings, startWindowMs = 8000) => {
    const calls = [];
    const slot = make({ clientId: ID, clientSecret: SECRET, ...settings });
    slot.startWindowMs = startWindowMs;
    slot.boardLookup = () => async (request) => {
      calls.push(request.deadlineMs);
      return { status: "none" };
    };
    await slot.execute("skyrim", makeContext());
    return calls[0];
  };

  test("the setting is an advanced number, 5 seconds by default, shown only while the preference is on", () => {
    const field = SETTINGS_SCHEMA.find((entry) => entry.key === "boardGameWaitSeconds");
    expect(field).toMatchObject({ type: "number", default: "5", advanced: true, visibleWhen: { key: "preferBoardGames", equals: "true" } });
    expect(field.required).toBeUndefined();
    expect(make().boardWaitMs).toBe(5000);
  });

  test("seconds are converted and clamped to 1..8, anything unreadable is the default", () => {
    expect(boardWaitFromSetting("4")).toBe(4000);
    expect(boardWaitFromSetting("5")).toBe(5000);
    expect(boardWaitFromSetting(6)).toBe(6000);
    expect(boardWaitFromSetting("2.5")).toBe(2500);
    expect(boardWaitFromSetting("0")).toBe(1000);
    expect(boardWaitFromSetting("-3")).toBe(1000);
    expect(boardWaitFromSetting("0.2")).toBe(1000);
    expect(boardWaitFromSetting("8")).toBe(8000);
    expect(boardWaitFromSetting("30")).toBe(8000);
    for (const bad of ["", "soon", undefined, null, NaN, Infinity, {}]) expect(boardWaitFromSetting(bad)).toBe(5000);
  });

  test("the configured wait reaches the lookup, still capped by what is left of the slot budget", async () => {
    expect(await waitFor({ boardGameWaitSeconds: "6" })).toBeLessThanOrEqual(6000);
    expect(await waitFor({ boardGameWaitSeconds: "6" })).toBeGreaterThan(5500);
    expect(await waitFor({ boardGameWaitSeconds: "1" })).toBeLessThanOrEqual(1000);
    expect(await waitFor({ boardGameWaitSeconds: "99" })).toBeLessThanOrEqual(8000);
    expect(await waitFor({ boardGameWaitSeconds: "6" }, 3000)).toBeLessThanOrEqual(3000); // 70 % of the slot time is the limit
    expect(await waitFor({})).toBeLessThanOrEqual(5000);
  });
});
