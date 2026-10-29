import { dayDiff } from "./time.js";

// Which game to show, and which team when a nickname belongs to several. Pure functions over the parsed game model.

const DAY_MS = 86_400_000;
export const NEAR_MS = 7 * DAY_MS;

export const isLive = (game) => game.state === "in" && game.phase !== "suspended";

// How interesting a game is for a team right now. Higher is better; 0 means nothing near.
//   live 1000 > today 800 > within +-7 days (600 down to 400, closer first)
export const gameScore = (game, now, zone) => {
  if (!game) return 0;
  if (isLive(game)) return 1000;
  if (game.phase === "postponed" || game.phase === "canceled") return 0;
  if (dayDiff(game.ts, now, zone) === 0) return 800;
  const gap = Math.abs(game.ts - now);
  if (gap > NEAR_MS) return 0;
  return 600 - Math.round((gap / NEAR_MS) * 200);
};

export const involves = (game, teamId) => game.teams.some((team) => team.id === String(teamId));

// The best game of a list for a team: live, then today's, then the nearest. { game, score }
export const bestGame = (games, teamId, now, zone) => {
  let best = null;
  for (const game of games) {
    if (!involves(game, teamId)) continue;
    const score = gameScore(game, now, zone);
    if (!best || score > best.score || (score === best.score && Math.abs(game.ts - now) < Math.abs(best.game.ts - now))) best = { game, score };
  }
  return best;
};

// candidates: [{ team, league }] (league = the row of leagues.js); facts: Map("league:id" -> { game, score } | null)
// Pro leagues come before college ones unless every candidate is a college team, then by game state, then by league priority.
// -> the candidates, best first, each with { score }
export const rankTeams = (candidates, facts) => {
  const anyPro = candidates.some((candidate) => candidate.league.kind === "pro");
  return candidates
    .map((candidate) => {
      const fact = facts.get(`${candidate.team.league}:${candidate.team.id}`);
      const tier = anyPro && candidate.league.kind === "college" ? 1 : 0;
      return { ...candidate, tier, score: fact?.score ?? 0, game: fact?.game ?? null };
    })
    .sort((a, b) => a.tier - b.tier || b.score - a.score || a.league.priority - b.league.priority);
};

// From a team's schedule: the game to show for a query.
//   want: "" (nearest), "next" (the next game), "past" (the latest finished game), "yesterday", "tomorrow", "today"
export const pickScheduled = (games, want, now, zone) => {
  const sorted = games.filter((game) => game.phase !== "canceled").slice().sort((a, b) => a.ts - b.ts);
  if (!sorted.length) return null;
  const live = sorted.find(isLive);
  if (live && want !== "next" && want !== "yesterday" && want !== "tomorrow") return live;
  const onDay = (offset) => sorted.find((game) => dayDiff(game.ts, now, zone) === offset);
  if (want === "yesterday") return onDay(-1) ?? null;
  if (want === "tomorrow") return onDay(1) ?? null;
  const upcoming = sorted.filter((game) => game.state === "pre" && game.ts >= now - 3 * 3_600_000);
  const finished = sorted.filter((game) => game.state === "post").reverse();
  if (want === "next") return upcoming[0] ?? null;
  if (want === "past") {
    const played = onDay(0);
    return (played && played.state !== "pre" ? played : null) ?? finished[0] ?? upcoming[0] ?? null;
  }
  const today = onDay(0);
  if (today) return today;
  const next = upcoming[0];
  const last = finished[0];
  if (next && last) return Math.abs(next.ts - now) < Math.abs(now - last.ts) ? next : last;
  return next ?? last ?? null;
};

// "Next" and "Last" lines for the team: { next, last } games on the schedule other than the shown game
export const surrounding = (games, shown, now) => {
  const others = games.filter((game) => game.id !== shown?.id && game.phase !== "canceled").sort((a, b) => a.ts - b.ts);
  const next = others.find((game) => game.state === "pre" && game.ts > Math.max(now, shown?.ts ?? 0)) ?? null;
  const last = others.filter((game) => game.state === "post" && game.ts < (shown?.state === "pre" ? Number.POSITIVE_INFINITY : (shown?.ts ?? now))).pop() ?? null;
  return { next, last };
};

// League scoreboard order: games in progress first, then upcoming, then finished; by start time inside each group
export const orderBoard = (games) => {
  const group = (game) => (isLive(game) ? 0 : game.state === "pre" ? 1 : 2);
  return games.slice().sort((a, b) => group(a) - group(b) || a.ts - b.ts);
};

// Board cache lifetime: short while anything is live, a minute when a game is about to start, otherwise a few minutes
export const boardTtl = (games, now) => {
  if (games.some(isLive)) return 20_000;
  if (games.some((game) => game.state === "pre" && game.ts - now < 30 * 60_000 && game.ts - now > -3_600_000)) return 60_000;
  return 5 * 60_000;
};
