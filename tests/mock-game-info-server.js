// Local stand-in for all four upstreams of the game-info plugin (Twitch token, IGDB, ProtonDB, Steam store),
// used only for integration checks. Give the same base URL to every override:
//   DEGOOG_IGDB_API_BASE=http://host:4468/v4  DEGOOG_IGDB_TOKEN_URL=http://host:4468/oauth2/token
//   DEGOOG_PROTONDB_BASE=http://host:4468     DEGOOG_STEAM_BASE=http://host:4468
// Credentials: client id "test-id", client secret "test-secret", access token "test-token".
// A search containing "quota" answers 429, "zzz" finds nothing. ProtonDB app 999 answers 404.
// Invented titles that are ALSO board games in the board-games mock, so both plugins can match the same query. A search for
// one of these terms lists the video game first:
//   starfall    video 2021, board 2019    (the board game is older)
//   moonharvest video 2016, board 2023    (the video game is older)
//   tiebreak    video 2020, board 2020    (a tie)
//   driftwood   video year unknown, board 2018
// GET /__stats reports how many requests each upstream served.
// Usage: bun tests/mock-game-info-server.js [port]
const port = Number(process.argv[2] || 4468);
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).json();
const games = await read("igdb-games.json");
const timeToBeat = await read("igdb-time-to-beat.json");
const proton = await read("protondb-summary.json");
const steam = await read("steam-storesearch.json");
const stats = { token: 0, search: 0, ttb: 0, proton: 0, steam: 0 };
const sharedTitle = (id, name, year) => ({
  id,
  slug: `${name.toLowerCase()}-video-game`,
  name,
  summary: "An invented video game with the same title as an invented board game. This text is made up for tests.",
  ...(year ? { first_release_date: Date.UTC(year, 5, 1) / 1000 } : {}),
  game_type: { id: 0, type: "Main Game" },
  genres: [{ name: "Strategy" }],
  platforms: [{ name: "Nintendo Switch", abbreviation: "Switch" }],
  aggregated_rating: 71,
  aggregated_rating_count: 4,
  rating: 68,
  rating_count: 120,
  total_rating: 69,
  total_rating_count: 124,
});
const shared = {
  starfall: sharedTitle(990001, "Starfall", 2021),
  moonharvest: sharedTitle(990002, "Moonharvest", 2016),
  tiebreak: sharedTitle(990003, "Tiebreak", 2020),
  driftwood: sharedTitle(990004, "Driftwood", 0),
};

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__stats") return Response.json(stats);
    // Only the method and path are logged: never a body, header or query string.
    console.log(`MOCK ${request.method} ${url.pathname}`);

    if (url.pathname === "/oauth2/token" && request.method === "POST") {
      stats.token += 1;
      const form = new URLSearchParams(await request.text());
      const valid =
        form.get("client_id") === "test-id" && form.get("client_secret") === "test-secret" && form.get("grant_type") === "client_credentials";
      if (!valid || url.search) return Response.json({ status: 400, message: "invalid client" }, { status: 400 });
      return Response.json({ access_token: "test-token", expires_in: 5184000, token_type: "bearer" });
    }

    if (url.pathname.startsWith("/v4/")) {
      const authorised = request.headers.get("client-id") === "test-id" && request.headers.get("authorization") === "Bearer test-token";
      if (!authorised) return Response.json({ message: "Authorization Failure" }, { status: 401 });
      const body = await request.text();
      if (url.pathname === "/v4/games") {
        stats.search += 1;
        if (body.includes("quota")) return new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
        if (body.includes("zzz")) return Response.json([]);
        const term = /search "([^"]*)"/i.exec(body)?.[1]?.trim().toLowerCase() ?? "";
        if (Object.hasOwn(shared, term)) return Response.json([shared[term], ...games]);
        return Response.json(games);
      }
      if (url.pathname === "/v4/game_time_to_beats") {
        stats.ttb += 1;
        return Response.json(timeToBeat);
      }
    }

    const summary = /^\/api\/v1\/reports\/summaries\/(\d+)\.json$/.exec(url.pathname);
    if (summary) {
      stats.proton += 1;
      return summary[1] === "999" ? new Response("not found", { status: 404 }) : Response.json(proton);
    }

    if (url.pathname === "/api/storesearch/") {
      stats.steam += 1;
      return Response.json(steam);
    }

    return new Response("not found", { status: 404 });
  },
});
console.log(`mock game-info upstreams listening on ${port}`);
