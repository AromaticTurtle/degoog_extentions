// Both plugins together: a title that is a board game AND a video game, in a shared fake world. The two real plugin classes
// are configured, registered through init() (so they find each other through the globalThis contracts, as in degoog) and
// executed one after the other in either order, as degoog does (sequentially, by priority).
//
// Everything here is INVENTED: "Moonharvest", the years, the numbers.
import { afterEach, describe, expect, test } from "bun:test";
import { Budget } from "../plugins/board-games/budget.js";
import { BoardGamesSlot } from "../plugins/board-games/index.js";
import { GameInfoSlot } from "../plugins/game-info/index.js";
import { TokenStore } from "../plugins/game-info/token.js";

afterEach(() => {
  delete globalThis[Symbol.for("degoog-extentions.board-games.lookup")];
  delete globalThis[Symbol.for("degoog-extentions.game-info.lookup")];
});

const unix = (year) => Date.UTC(year, 5, 1) / 1000;
const igdbGame = (name, year) => ({
  id: 990001,
  slug: "moonharvest",
  name,
  summary: "An invented video game. This text is made up for tests.",
  ...(year ? { first_release_date: unix(year) } : {}),
  game_type: { id: 0, type: "Main Game" },
  platforms: [{ name: "Nintendo Switch", abbreviation: "Switch" }],
  total_rating_count: 300,
  rating_count: 290,
  aggregated_rating_count: 10,
  rating: 80,
  aggregated_rating: 82,
});
const rgGame = (name, year) => ({
  bgg_id: 910001,
  name,
  alt_name: [],
  year,
  description: "An invented board game. This text is made up for tests.",
  min_players: 1,
  max_players: 4,
  min_time: 30,
  max_time: 60,
  bgg_rank: 120,
  num_votes: 9000,
  avg_rating: 7.8,
  complexity: 2.1,
  designer_name: ["Invented Designer"],
  category_name: ["Farming"],
  mechanic_name: ["Set Collection"],
  image_url: ["https://cf.geekdo-images.com/original/img/x.jpg", "https://cf.geekdo-images.com/small/img/x.jpg"],
  url: "https://boardgamegeek.com/boardgame/910001",
});

// One world: the board game year (0 = unknown), the video game year (0 = unknown), settings for each plugin, a delay for the
// recommend.games answer, and which plugins are installed.
const resetGlobals = () => {
  delete globalThis[Symbol.for("degoog-extentions.board-games.lookup")];
  delete globalThis[Symbol.for("degoog-extentions.game-info.lookup")];
};

const makeWorld = ({ boardYear = 2023, videoYear = 2016, whenBothMatch, board = true, video = true, rgDelayMs = 0, videoSettings = {}, boardSettings = {}, title = "Moonharvest" } = {}) => {
  resetGlobals(); // a world is the only one that is registered
  const calls = [];
  const fetch = async (url, init = {}) => {
    const host = new URL(url).hostname;
    calls.push(host);
    if (host === "token.test") return Response.json({ access_token: "tok", expires_in: 5_184_000, token_type: "bearer" });
    if (host === "igdb.test") return url.endsWith("/games") ? Response.json([igdbGame(title, videoYear)]) : Response.json([{ hastily: 3600, normally: 7200, completely: 10_800 }]);
    if (host === "rg.test") {
      if (rgDelayMs) await new Promise((resolve) => setTimeout(resolve, rgDelayMs));
      return Response.json({ count: 1, results: [rgGame(title, boardYear)] });
    }
    return new Response("not found", { status: 404 });
  };
  const context = { fetch, signProxyUrl: (u) => u };

  const boardSlot = new BoardGamesSlot();
  boardSlot.spacingMs = 0;
  boardSlot.sources.recommend.base = "https://rg.test";
  for (const source of Object.values(boardSlot.sources)) source.budget = new Budget({ file: "", cap: 0, now: () => boardSlot.now() });
  boardSlot.configure({ enableApi: "false", enableRecommendGames: "true", enableBggInternal: "false", ...boardSettings });

  const videoSlot = new GameInfoSlot();
  videoSlot.apiBase = "https://igdb.test/v4";
  videoSlot.tokenUrl = "https://token.test/oauth2/token";
  videoSlot.spacingMs = 0;
  videoSlot.tokens = new TokenStore({ file: "", now: () => videoSlot.now() });
  videoSlot.configure({ clientId: "id-1234", clientSecret: "secret-1234", ...(whenBothMatch ? { whenBothMatch } : {}), ...videoSettings });

  if (board) boardSlot.init({});
  if (video) videoSlot.init({});
  const plugins = { board: boardSlot, video: videoSlot };
  const installed = { board, video };

  // degoog's loop: slots one after the other, each under its own timeout; a panel with no html is not shown.
  const search = async (query, order) => {
    const panels = {};
    for (const name of order) {
      if (!installed[name]) continue;
      const out = await plugins[name].execute(query, context);
      if (out.html) panels[name] = out.title;
    }
    return panels;
  };
  const count = (host) => calls.filter((entry) => entry === host).length;
  return { search, calls, count, boardSlot, videoSlot };
};

const BOARD_FIRST = ["board", "video"];
const VIDEO_FIRST = ["video", "board"];

describe("whichever came first, with both real plugins, in both orders", () => {
  // board year, video year, mode, expected panels
  const CASES = [
    [2023, 2016, undefined, { video: "Moonharvest" }], // the video game came first (Stardew Valley)
    [2019, 2021, undefined, { board: "Moonharvest" }], // the board game came first (Wingspan)
    [2020, 2020, undefined, { board: "Moonharvest" }], // a tie goes to the board game
    [2023, 0, undefined, { board: "Moonharvest" }], // unknown video year
    [0, 2016, undefined, { board: "Moonharvest" }], // unknown board year
    [0, 0, undefined, { board: "Moonharvest" }],
    [2023, 2016, "oldest", { video: "Moonharvest" }],
    [2023, 2016, "board-game", { board: "Moonharvest" }],
    [2019, 2021, "video-game", { video: "Moonharvest" }],
    [2023, 2016, "both", { board: "Moonharvest", video: "Moonharvest" }],
    [2019, 2021, "both", { board: "Moonharvest", video: "Moonharvest" }],
  ];

  for (const [boardYear, videoYear, mode, expected] of CASES) {
    for (const order of [BOARD_FIRST, VIDEO_FIRST]) {
      test(`board ${boardYear}, video ${videoYear}, mode ${mode ?? "default"}, ${order[0]} runs first`, async () => {
        const world = makeWorld({ boardYear, videoYear, whenBothMatch: mode });
        const first = await world.search("moonharvest", order);
        expect(first).toEqual(expected);
        // the same decision for the same search, and nothing more is asked of the upstreams
        const before = world.calls.length;
        expect(await world.search("moonharvest", order)).toEqual(expected);
        expect(world.calls).toHaveLength(before);
        // one board search and one IGDB search in all, however many questions the plugins asked each other
        expect(world.count("rg.test")).toBe(1);
        expect(world.count("token.test")).toBe(1);
        expect(world.calls.filter((host) => host === "igdb.test").length).toBe(expected.video ? 2 : 1); // search + time to beat only when shown
      });
    }
  }

  test("the order of the plugins never changes what shows", async () => {
    for (const [boardYear, videoYear, mode] of CASES) {
      const a = await makeWorld({ boardYear, videoYear, whenBothMatch: mode }).search("moonharvest", BOARD_FIRST);
      const b = await makeWorld({ boardYear, videoYear, whenBothMatch: mode }).search("moonharvest", VIDEO_FIRST);
      expect(b).toEqual(a);
    }
  });

  test("a title that is only a board game, or only a video game, is unaffected", async () => {
    const onlyBoard = makeWorld({ boardYear: 2023, videoYear: 2016 });
    onlyBoard.videoSlot.configure({ clientId: "", clientSecret: "" }); // no IGDB credentials: no video game can match
    expect(await onlyBoard.search("moonharvest", BOARD_FIRST)).toEqual({ board: "Moonharvest" });
    expect(await onlyBoard.search("moonharvest", VIDEO_FIRST)).toEqual({ board: "Moonharvest" });
    const onlyVideo = makeWorld({ boardSettings: { enableRecommendGames: "false" } }); // no board game source is usable
    expect(await onlyVideo.search("moonharvest", BOARD_FIRST)).toEqual({ video: "Moonharvest" });
    expect(await onlyVideo.search("moonharvest", VIDEO_FIRST)).toEqual({ video: "Moonharvest" });
    expect(onlyVideo.count("rg.test")).toBe(0);
  });

  test("when the other plugin is not installed or is disabled, each shows its own panel", async () => {
    expect(await makeWorld({ board: false }).search("moonharvest", VIDEO_FIRST)).toEqual({ video: "Moonharvest" });
    expect(await makeWorld({ video: false }).search("moonharvest", BOARD_FIRST)).toEqual({ board: "Moonharvest" });
    // installed but switched off: degoog passes disabled to configure() and never calls execute()
    const off = makeWorld({ boardYear: 2023, videoYear: 2016, boardSettings: { disabled: "true" } });
    off.boardSlot.disabled = true;
    expect(await off.search("moonharvest", ["video"])).toEqual({ video: "Moonharvest" });
    const offVideo = makeWorld({ boardYear: 2019, videoYear: 2021, videoSettings: { disabled: "true" } });
    expect(await offVideo.search("moonharvest", ["board"])).toEqual({ board: "Moonharvest" });
  });

  test("explicit words win, and nothing is asked across the plugins", async () => {
    for (const order of [BOARD_FIRST, VIDEO_FIRST]) {
      const ps5 = makeWorld({ boardYear: 2019, videoYear: 2021 });
      expect(await ps5.search("moonharvest ps5", order)).toEqual({ video: "Moonharvest" });
      expect(ps5.count("rg.test")).toBe(0);
      const boardWord = makeWorld({ boardYear: 2023, videoYear: 2016 });
      expect(await boardWord.search("moonharvest board game", order)).toEqual({ board: "Moonharvest" });
      expect(boardWord.calls.filter((host) => host === "igdb.test" || host === "token.test")).toHaveLength(0);
      const rules = makeWorld({ boardYear: 2023, videoYear: 2016 });
      expect(await rules.search("moonharvest rules", order)).toEqual({ board: "Moonharvest" });
    }
  });

  test("an ambiguous word ('game') takes the same decision as the plain title", async () => {
    for (const order of [BOARD_FIRST, VIDEO_FIRST]) {
      expect(await makeWorld({ boardYear: 2023, videoYear: 2016 }).search("moonharvest game", order)).toEqual({ video: "Moonharvest" });
      expect(await makeWorld({ boardYear: 2019, videoYear: 2021 }).search("moonharvest game", order)).toEqual({ board: "Moonharvest" });
    }
  });

  test("neither plugin ever asks the other from inside an answer: no deadlock, even when the answers are slow", async () => {
    const world = makeWorld({ boardYear: 2019, videoYear: 2021, rgDelayMs: 60 });
    const panels = await Promise.race([world.search("moonharvest", VIDEO_FIRST), new Promise((resolve) => setTimeout(() => resolve("deadlock"), 3000))]);
    expect(panels).toEqual({ board: "Moonharvest" });
  });
});

describe("a slow cold search (the board game answer takes longer than game-info waits)", () => {
  test("game-info first: the video game gives way when it is older; the next search is consistent", async () => {
    const world = makeWorld({ boardYear: 2023, videoYear: 2016, rgDelayMs: 600 });
    world.videoSlot.boardWaitMs = 250; // not enough for the board game answer
    const first = await world.search("moonharvest", VIDEO_FIRST);
    // game-info gave up waiting and showed itself; the board game plugin then saw the older video game and stepped back
    expect(first).toEqual({ video: "Moonharvest" });
    expect(await world.search("moonharvest", VIDEO_FIRST)).toEqual({ video: "Moonharvest" });
    expect(world.count("rg.test")).toBe(1);
  });

  test("game-info first, board game older: the video game shows once, then only the board game", async () => {
    const world = makeWorld({ boardYear: 2019, videoYear: 2021, rgDelayMs: 600 });
    world.videoSlot.boardWaitMs = 250;
    const first = await world.search("moonharvest", VIDEO_FIRST);
    // the documented limitation: a very slow cold answer can make both panels show once
    expect(first.video).toBe("Moonharvest");
    const second = await world.search("moonharvest", VIDEO_FIRST);
    expect(second).toEqual({ board: "Moonharvest" });
    expect(world.count("rg.test")).toBe(1);
  });

  test("board games first with a slow answer: it shares the work with the lookup, the decision is the same", async () => {
    const world = makeWorld({ boardYear: 2019, videoYear: 2021, rgDelayMs: 600 });
    expect(await world.search("moonharvest", BOARD_FIRST)).toEqual({ board: "Moonharvest" });
    expect(world.count("rg.test")).toBe(1);
  });

  test("a plugin that gave up in time answers 'unknown', so the other one shows itself", async () => {
    const world = makeWorld({ boardYear: 2019, videoYear: 2021, rgDelayMs: 600 });
    world.boardSlot.answerWindowMs = 30; // the board game panel is too slow for this search
    world.videoSlot.boardWaitMs = 1000;
    const first = await world.search("moonharvest", BOARD_FIRST);
    expect(first).toEqual({ video: "Moonharvest" }); // no board game panel was coming, so the video game was not hidden
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await world.search("moonharvest", BOARD_FIRST)).toEqual({ board: "Moonharvest" });
  });
});
