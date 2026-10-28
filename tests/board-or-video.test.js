// The board-games and game-info plugins each keep their own copy of the word lists that tell a board game query from a
// video game query. This test runs the same table of queries through both copies and checks that they agree.
import { describe, expect, test } from "bun:test";
import * as board from "../plugins/board-games/match.js";
import * as video from "../plugins/game-info/match.js";

// query, a word that can only mean a video game, a word that can only mean a board game
const TABLE = [
  ["wingspan", false, false],
  ["wingspan game", false, false],
  ["wingspan games", false, false],
  ["wingspan guide", false, false],
  ["wingspan review", false, false],
  ["wingspan reviews", false, false],
  ["wingspan wiki", false, false],
  ["wingspan trailer", false, false],
  ["wingspan release date", false, false],
  ["wingspan requirements", false, false],
  ["wingspan co-op", false, false],
  ["wingspan multiplayer", false, false],
  ["dune novel", false, false],
  ["skyrim", false, false],
  ["elden ring", false, false],
  ["wingspan ps5", true, false],
  ["wingspan ps4", true, false],
  ["wingspan playstation 5", true, false],
  ["wingspan xbox", true, false],
  ["wingspan xbox series x", true, false],
  ["wingspan nintendo switch", true, false],
  ["wingspan switch", true, false],
  ["wingspan pc", true, false],
  ["wingspan steam", true, false],
  ["elden ring steam", true, false],
  ["wingspan video game", true, false],
  ["wingspan video games", true, false],
  ["wingspan gameplay", true, false],
  ["skyrim walkthrough", true, false],
  ["skyrim dlc", true, false],
  ["skyrim speedrun", true, false],
  ["skyrim mods", true, false],
  ["skyrim mod", true, false],
  ["skyrim cheats", true, false],
  ["skyrim patch notes", true, false],
  ["skyrim system requirements", true, false],
  ["skyrim controller", true, false],
  ["skyrim console", true, false],
  ["skyrim fps", true, false],
  ["skyrim remastered", true, false],
  ["final fantasy remake", true, false],
  ["diablo rpg", true, false],
  ["hades roguelike", true, false],
  ["elden ring soulslike", true, false],
  ["wingspan board game", false, true],
  ["wingspan boardgame", false, true],
  ["wingspan board games", false, true],
  ["catan tabletop", false, true],
  ["catan rules", false, true],
  ["catan rulebook", false, true],
  ["catan setup", false, true],
  ["catan bgg", false, true],
  ["catan boardgamegeek", false, true],
  ["root tabletop", false, true],
  ["root meeple", false, true],
  ["catan expansion", false, true],
  ["catan expansions", false, true],
  ["azul solo variant", false, true],
  ["pandemic card game", false, true],
  ["pandemic dice game", false, true],
  ["agricola worker placement", false, true],
  ["dominion deck builder", false, true],
  ["dominion deckbuilder", false, true],
  ["catan how to play", false, true],
  ["catan player count", false, true],
  ["gloomhaven co-op board", false, true],
  ["wingspan board game ps5", true, true],
  ["catan rules steam", true, true],
];

describe("the two plugins classify queries the same way", () => {
  test.each(TABLE)("%s", (query, videoSpecific, boardWord) => {
    expect(video.hasVideoGameWord(query)).toBe(videoSpecific);
    expect(board.hasVideoGameWord(query)).toBe(videoSpecific);
    expect(video.hasBoardGameWord(query)).toBe(boardWord);
    expect(board.hasBoardGameWord(query)).toBe(boardWord);
  });

  test("a board game word keeps the video game panel away, a video game word keeps the board game lookup away", () => {
    for (const [query, videoSpecific, boardWord] of TABLE) {
      expect(video.isBoardGameQuery(query)).toBe(boardWord && !videoSpecific);
      expect(board.isVideoGameQuery(query)).toBe(videoSpecific && !boardWord);
    }
  });

  test("a query with both kinds of word reaches both plugins; one with neither reaches both too", () => {
    expect(video.isBoardGameQuery("wingspan board game ps5")).toBe(false);
    expect(board.isVideoGameQuery("wingspan board game ps5")).toBe(false);
    expect(video.isBoardGameQuery("wingspan")).toBe(false);
    expect(board.isVideoGameQuery("wingspan")).toBe(false);
  });

  test("the words must be whole words, so titles that merely contain them are not touched", () => {
    for (const query of ["pcs", "steamboat", "switchblade", "modest", "remakes of x", "rulesome", "consoles", "controllers", "setups", "grpg", "xboxes", "boardwalk empire", "tabletops"]) {
      expect(video.hasVideoGameWord(query)).toBe(board.hasVideoGameWord(query));
      expect(video.hasBoardGameWord(query)).toBe(board.hasBoardGameWord(query));
    }
    expect(video.hasVideoGameWord("steamboat willie")).toBe(false);
    expect(video.hasVideoGameWord("switchblade")).toBe(false);
    expect(video.hasBoardGameWord("boardwalk empire")).toBe(false);
  });

  test("the title left over after the trailing words are dropped", () => {
    expect(board.extractTerm("wingspan game")).toBe("wingspan");
    expect(board.extractTerm("wingspan board game")).toBe("wingspan");
    expect(board.extractTerm("wingspan games guide")).toBe("wingspan");
    expect(board.extractTerm("catan rules")).toBe("catan");
    expect(board.extractTerm("the game")).toBe("the game");
    expect(board.extractTerm("board game")).toBe("board game");
    expect(board.extractTerm("dice game")).toBe("dice game");
    expect(video.extractTerm("wingspan game")).toBe("wingspan");
    expect(video.extractTerm("skyrim ps5")).toBe("skyrim");
    expect(video.extractTerm("skyrim board game ps5")).toBe("skyrim");
    expect(video.extractTerm("skyrim ps5 board game")).toBe("skyrim");
    expect(video.extractTerm("game dev tycoon")).toBe("game dev tycoon");
  });
});

// ---- When both match: the decision, identical in both plugins ----

describe("decideBothMatch", () => {
  const same = (input) => {
    const a = video.decideBothMatch(input);
    const b = board.decideBothMatch(input);
    expect(b).toBe(a);
    return a;
  };

  // mode, board year, video year, expected panel
  const CASES = [
    // the four examples of the rule
    ["oldest", 2023, 2016, "video"], // Stardew Valley: the video game came first
    ["oldest", 2019, 2020, "board"], // Wingspan
    ["oldest", 2017, 2019, "board"], // Gloomhaven
    ["oldest", 1979, 1992, "board"], // Dune
    // ties and unknown years go to the board game
    ["oldest", 2020, 2020, "board"],
    ["oldest", 0, 2016, "board"],
    ["oldest", 2019, 0, "board"],
    ["oldest", 0, 0, "board"],
    ["oldest", undefined, 2016, "board"],
    ["oldest", 2023, undefined, "board"],
    ["oldest", null, null, "board"],
    ["oldest", -2016, 2019, "board"],
    ["oldest", 2019, -2016, "board"],
    ["oldest", NaN, 2016, "board"],
    ["oldest", 2023, Number.NaN, "board"],
    ["oldest", Infinity, 2016, "board"],
    ["oldest", 2019.5, 2016, "board"],
    ["oldest", 2023, 2016.5, "board"],
    ["oldest", "soon", 2016, "board"],
    ["oldest", 2023, "", "board"],
    ["oldest", {}, 2016, "board"],
    ["oldest", [], 2016, "board"],
    ["oldest", 12345, 2016, "board"], // not a year
    // years as digit strings are read as years
    ["oldest", "2023", "2016", "video"],
    ["oldest", "2019", 2020, "board"],
    ["oldest", 2023, " 2016 ", "video"],
    ["oldest", "2020", "2020", "board"],
    // the other modes ignore years
    ["board-game", 2023, 2016, "board"],
    ["board-game", 0, 0, "board"],
    ["video-game", 2016, 2023, "video"],
    ["video-game", 0, 0, "video"],
    ["both", 2023, 2016, "both"],
    ["both", 0, 0, "both"],
    // an unknown or missing mode is the default
    [undefined, 2023, 2016, "video"],
    [null, 2019, 2020, "board"],
    ["", 2023, 2016, "video"],
    ["nonsense", 2023, 2016, "video"],
    ["OLDEST", 2023, 2016, "video"],
  ];
  test.each(CASES)("mode %p, board %p, video %p -> %p", (mode, boardYear, videoYear, expected) => {
    expect(same({ mode, boardYear, videoYear })).toBe(expected);
  });

  test("missing or odd arguments never throw", () => {
    for (const input of [undefined, null, {}, 5, "x", []]) expect(same(input)).toBe("board");
  });

  test("the two copies agree on every combination of a wide grid", () => {
    const years = [undefined, null, 0, -1, 1, 1979, 1992, 2016, 2019, 2020, 2023, 9999, 10000, "2016", "2023", "", "x", NaN, 2019.5];
    for (const mode of [...video.WHEN_BOTH_MODES, "x", undefined]) {
      for (const boardYear of years) for (const videoYear of years) same({ mode, boardYear, videoYear });
    }
    expect(video.WHEN_BOTH_MODES).toEqual(["oldest", "board-game", "video-game", "both"]);
    expect(board.WHEN_BOTH_MODES).toEqual(video.WHEN_BOTH_MODES);
    expect(board.DEFAULT_WHEN_BOTH).toBe("oldest");
    expect(video.DEFAULT_WHEN_BOTH).toBe("oldest");
    for (const value of [...video.WHEN_BOTH_MODES, "x", undefined, null, 5]) expect(board.normalizeWhenBoth(value)).toBe(video.normalizeWhenBoth(value));
    for (const value of [...years, "0", "00", " 12 ", "20 19"]) expect(board.validYear(value)).toBe(video.validYear(value));
  });
});
