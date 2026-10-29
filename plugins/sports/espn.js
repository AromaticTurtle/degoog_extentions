// ESPN's public site API: request addresses and defensive parsers. ESPN's JSON is unofficial and undocumented, so every field is
// optional here and anything unexpected is dropped rather than shown. Nothing in this file does I/O.
//
// Both the scoreboard and the team schedule describe a game as an "event" with one "competition". They differ in details:
// scoreboard scores are strings, schedule scores are { value, displayValue } objects; scoreboards carry linescores, leaders and
// situations, schedules do not. parseEvent() reads either and returns the same game model:
//
//   { id, league, ts, state: "pre"|"in"|"post", phase, label, note, teams: [away, home], venue, tv: [], situation, leaders: [], source }
//   team: { id, name, short, abbr, logo, score ("" when none), record, rank, winner, lines: [] }
//   phase: scheduled | live | halftime | break | final | postponed | canceled | delayed | suspended | forfeit

export const DEFAULT_BASE = "https://site.api.espn.com/apis/site/v2/sports";

export const baseFrom = (value) => {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_BASE;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return DEFAULT_BASE;
  }
};

export const scoreboardUrl = (base, league, { dates = "" } = {}) => {
  const params = new URLSearchParams(league.board ?? {});
  if (/^\d{8}$/.test(dates)) params.set("dates", dates);
  const query = params.toString();
  return `${baseFrom(base)}/${league.path}/scoreboard${query ? `?${query}` : ""}`;
};

export const scheduleUrl = (base, league, teamId) => (/^\d{1,9}$/.test(String(teamId)) ? `${baseFrom(base)}/${league.path}/teams/${teamId}/schedule` : "");

const text = (value, max = 120) => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
};

const wholeNumber = (value) => {
  const raw = value && typeof value === "object" ? (value.displayValue ?? value.value) : value;
  if (raw === "" || raw === null || raw === undefined) return "";
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 && number < 10_000 ? String(Math.trunc(number)) : "";
};

// ESPN logos live on espncdn.com; anything else is not used (the plugin shows an abbreviation badge instead).
export const safeLogo = (value) => {
  try {
    const url = new URL(String(value ?? ""));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !(host === "espncdn.com" || host.endsWith(".espncdn.com"))) return "";
    return url.href;
  } catch {
    return "";
  }
};

export const ordinal = (n) => {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

const PHASES = [
  [/POSTPONED/, "postponed"],
  [/CANCEL/, "canceled"],
  [/SUSPEND|ABANDON/, "suspended"],
  [/FORFEIT/, "forfeit"],
  [/DELAY/, "delayed"],
  [/HALFTIME|HALF_TIME/, "halftime"],
  [/END_PERIOD|END_OF|END_QUARTER|END_INNING|BREAK|INTERMISSION/, "break"],
];

const STATES = new Set(["pre", "in", "post"]);

const baseballLabel = (detail, period) => {
  const match = /^(top|bot|bottom|mid|middle|end)\s+(?:of\s+(?:the\s+)?)?(\d{1,2})(?:st|nd|rd|th)?/i.exec(detail);
  if (match) {
    const half = { top: "Top", bot: "Bottom", bottom: "Bottom", mid: "Middle", middle: "Middle", end: "End" }[match[1].toLowerCase()];
    return `${half} ${ordinal(Number(match[2]))}`;
  }
  return period > 0 ? `${ordinal(period)} inning` : "";
};

// The words for a game in progress, by sport: "Q3 · 4:12", "P1 · 12:02", "Top 6th", "2nd Half 67'", "Halftime"
export const liveLabel = (league, phase, status) => {
  const period = Number.parseInt(status?.period, 10) || 0;
  const clock = text(status?.displayClock, 12);
  const detail = text(status?.type?.shortDetail || status?.type?.detail, 40);
  if (phase === "halftime") return "Halftime";
  if (phase === "delayed") return detail && !/^\d/.test(detail) ? detail : "Delayed";
  const withClock = (name) => (clock && clock !== "0:00" && clock !== "0.0" ? `${name} · ${clock}` : name);
  const regulation = league?.periods ?? 4;
  switch (league?.sport) {
    case "football":
    case "basketball": {
      if (phase === "break" && period > 0) {
        const name = regulation === 2 ? (period === 1 ? "End of 1st half" : period === 2 ? "End of 2nd half" : "End of OT") : period <= regulation ? `End of Q${period}` : "End of OT";
        return name;
      }
      if (period <= 0) return detail;
      if (regulation === 2) return period === 1 ? withClock("1st half") : period === 2 ? withClock("2nd half") : withClock(period === 3 ? "OT" : `${period - 2}OT`);
      if (period <= regulation) return withClock(`Q${period}`);
      const over = period - regulation;
      return withClock(over === 1 ? "OT" : `${over}OT`);
    }
    case "hockey": {
      if (/SHOOTOUT/i.test(text(status?.type?.name, 40))) return "Shootout";
      if (phase === "break" && period > 0) return period <= regulation ? `End of P${period}` : "End of OT";
      if (period <= 0) return detail;
      if (period <= regulation) return withClock(`P${period}`);
      const over = period - regulation;
      return withClock(over === 1 ? "OT" : `${over}OT`);
    }
    case "baseball":
      return baseballLabel(detail, period) || detail;
    case "soccer": {
      const half = period === 1 ? "1st Half" : period === 2 ? "2nd Half" : period === 3 || period === 4 ? "Extra time" : period >= 5 ? "Penalties" : "";
      if (!half) return detail;
      return clock ? `${half} ${clock}` : half;
    }
    default:
      return detail;
  }
};

export const finalLabel = (status) => {
  const detail = text(status?.type?.shortDetail || status?.type?.detail, 30);
  if (/^f(?:inal)?(?:\s*\/|\s|$)/i.test(detail)) return detail.replace(/^f(?!inal)/i, "Final").replace(/^final\s*$/i, "Final");
  if (/^(ft|full[\s-]?time)$/i.test(detail)) return "Final";
  if (/^aet$/i.test(detail)) return "Final/AET";
  if (/^ft[-\s]?pens?$/i.test(detail)) return "Final/Pens";
  return "Final";
};

const parseStatus = (status, league) => {
  const type = status?.type ?? {};
  const name = text(type.name, 50).toUpperCase();
  let state = text(type.state, 8).toLowerCase();
  if (!STATES.has(state)) state = type.completed === true ? "post" : name.includes("FINAL") || name.includes("FULL_TIME") ? "post" : name.includes("SCHEDULED") ? "pre" : name.includes("PROGRESS") || /HALF|PERIOD|QUARTER|INNING/.test(name) ? "in" : "pre";
  let phase = state === "in" ? "live" : state === "post" ? "final" : "scheduled";
  for (const [pattern, value] of PHASES) {
    if (pattern.test(name)) {
      phase = value;
      break;
    }
  }
  // a break or halftime flag on a game that is not in progress is ignored
  if ((phase === "halftime" || phase === "break") && state !== "in") phase = state === "post" ? "final" : "scheduled";
  let label = "";
  if (phase === "live" || phase === "halftime" || phase === "break" || phase === "delayed") label = liveLabel(league, phase, status);
  else if (phase === "final") label = finalLabel(status);
  else if (phase === "postponed") label = "Postponed";
  else if (phase === "canceled") label = "Canceled";
  else if (phase === "suspended") label = "Suspended";
  else if (phase === "forfeit") label = "Forfeit";
  return { state, phase, label };
};

const recordOf = (competitor) => {
  const list = Array.isArray(competitor?.records) ? competitor.records : Array.isArray(competitor?.record) ? competitor.record : [];
  const total = list.find((entry) => entry && (entry.type === "total" || /overall/i.test(String(entry.name ?? ""))));
  const entry = total ?? list.find((candidate) => text(candidate?.summary ?? candidate?.displayValue));
  return text(entry?.summary ?? entry?.displayValue, 20);
};

const rankOf = (competitor) => {
  const n = Number(competitor?.curatedRank?.current);
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : 0;
};

const leadersOf = (competitor) => {
  const categories = Array.isArray(competitor?.leaders) ? competitor.leaders : [];
  for (const category of categories) {
    const entry = Array.isArray(category?.leaders) ? category.leaders[0] : null;
    const who = text(entry?.athlete?.shortName || entry?.athlete?.displayName, 40);
    const value = text(entry?.displayValue, 60);
    if (!who || !value) continue;
    const unit = text(category.abbreviation, 8);
    return `${who} ${value}${unit && /^[\d.,-]+$/.test(value) ? ` ${unit}` : ""}`;
  }
  return "";
};

const teamOf = (competitor) => {
  const team = competitor?.team;
  const id = text(team?.id ?? competitor?.id, 12);
  const name = text(team?.displayName ?? team?.name, 60);
  if (!id || !name) return null;
  const lines = Array.isArray(competitor.linescores) ? competitor.linescores.map((line) => wholeNumber(line?.displayValue ?? line?.value) || (line && (line.displayValue === "-" || line.displayValue === "X") ? text(line.displayValue, 2) : "")).slice(0, 20) : [];
  return {
    id,
    name,
    short: text(team.shortDisplayName || team.name, 30) || name,
    abbr: text(team.abbreviation, 6),
    logo: safeLogo(team.logo ?? team.logos?.[0]?.href),
    score: wholeNumber(competitor.score),
    record: recordOf(competitor),
    rank: rankOf(competitor),
    winner: competitor.winner === true,
    lines,
    leader: leadersOf(competitor),
    homeAway: competitor.homeAway === "away" || competitor.homeAway === "home" ? competitor.homeAway : "",
    order: Number.isFinite(Number(competitor.order)) ? Number(competitor.order) : 9,
  };
};

const venueOf = (competition) => {
  const venue = competition?.venue;
  if (!venue) return null;
  const name = text(venue.fullName, 80);
  const address = venue.address ?? {};
  const place = [text(address.city, 40), text(address.state, 20) || (text(address.country, 30) !== "USA" ? text(address.country, 30) : "")].filter(Boolean).join(", ");
  return name || place ? { name, place } : null;
};

const broadcastsOf = (competition) => {
  const names = [];
  for (const entry of Array.isArray(competition?.broadcasts) ? competition.broadcasts : []) {
    const list = Array.isArray(entry?.names) ? entry.names : [entry?.media?.shortName];
    for (const name of list) {
      const clean = text(name, 20);
      if (clean && !names.includes(clean)) names.push(clean);
    }
  }
  return names.slice(0, 3);
};

const situationOf = (league, competition) => {
  const s = competition?.situation;
  if (!s || typeof s !== "object") return "";
  const parts = [];
  if (league?.sport === "football") {
    const down = text(s.shortDownDistanceText || s.downDistanceText, 50);
    if (down) parts.push(down);
  } else if (league?.sport === "baseball") {
    const balls = Number(s.balls);
    const strikes = Number(s.strikes);
    const outs = Number(s.outs);
    if (Number.isInteger(balls) && Number.isInteger(strikes) && balls >= 0 && strikes >= 0) parts.push(`${balls}-${strikes} count`);
    if (Number.isInteger(outs) && outs >= 0 && outs <= 3) parts.push(`${outs} ${outs === 1 ? "out" : "outs"}`);
    const bases = [s.onFirst && "1st", s.onSecond && "2nd", s.onThird && "3rd"].filter(Boolean);
    if (bases.length) parts.push(`runners on ${bases.join(", ")}`);
  }
  if (!parts.length) {
    const last = text(s.lastPlay?.text, 110);
    if (last) parts.push(`Last play: ${last}`);
  }
  return parts.join(" · ");
};

export const parseEvent = (event, league, source = "scoreboard") => {
  try {
    const competition = Array.isArray(event?.competitions) ? event.competitions[0] : null;
    if (!competition) return null;
    const competitors = (Array.isArray(competition.competitors) ? competition.competitors : []).map(teamOf).filter(Boolean);
    if (competitors.length !== 2) return null;
    const rank = (team) => (team.homeAway === "away" ? 0 : team.homeAway === "home" ? 1 : 2);
    const teams = competitors.slice().sort((a, b) => rank(a) - rank(b) || b.order - a.order);
    const id = text(event.id ?? competition.id, 20);
    const ts = Date.parse(text(event.date ?? competition.date, 40));
    if (!id || !Number.isFinite(ts)) return null;
    const { state, phase, label } = parseStatus(competition.status ?? event.status, league);
    if (state === "post" && phase !== "canceled" && !teams.some((team) => team.winner)) {
      const [a, b] = teams;
      if (a.score !== "" && b.score !== "" && Number(a.score) !== Number(b.score)) (Number(a.score) > Number(b.score) ? a : b).winner = true;
    }
    if (state !== "post") for (const team of teams) team.winner = false;
    const noteList = Array.isArray(event.notes) ? event.notes : Array.isArray(competition.notes) ? competition.notes : [];
    const showScores = state !== "pre" && phase !== "postponed" && phase !== "canceled";
    if (!showScores) for (const team of teams) team.score = "";
    const hasPlayerLeaders = teams.some((team) => team.leader);
    return {
      id,
      league: league.key,
      ts,
      state,
      phase,
      label,
      note: text(noteList[0]?.headline, 70),
      teams,
      venue: venueOf(competition),
      tv: broadcastsOf(competition),
      situation: phase === "live" || phase === "delayed" ? situationOf(league, competition) : "",
      leaders: state === "pre" || !hasPlayerLeaders ? [] : teams.filter((team) => team.leader).map((team) => ({ abbr: team.abbr || team.short, text: team.leader })).slice(0, 2),
      neutral: competition.neutralSite === true,
      source,
    };
  } catch {
    return null;
  }
};

const parseJson = (raw) => {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
};

// -> { games, week } or null when the reply is not a scoreboard. An empty board (off-season) is { games: [] }.
export const parseScoreboard = (raw, league) => {
  const data = parseJson(raw);
  if (!data || !Array.isArray(data.events)) return null;
  const games = data.events.map((event) => parseEvent(event, league, "scoreboard")).filter(Boolean);
  const week = Number(data.week?.number);
  return { games, week: Number.isInteger(week) && week > 0 && week < 60 ? week : 0 };
};

// -> { games } or null
export const parseSchedule = (raw, league) => {
  const data = parseJson(raw);
  if (!data || !Array.isArray(data.events)) return null;
  return { games: data.events.map((event) => parseEvent(event, league, "schedule")).filter(Boolean) };
};
