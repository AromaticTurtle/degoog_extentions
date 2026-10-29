// Builds INVENTED ESPN-shaped scoreboards and schedules for the tests: the layout of the real responses (field names, nesting, string
// scores on a scoreboard, object scores on a schedule), with made-up scores, times and venues. No recorded ESPN data is used.

export const T = {
  panthers: { id: "29", displayName: "Carolina Panthers", short: "Panthers", location: "Carolina", name: "Panthers", abbr: "CAR" },
  rams: { id: "14", displayName: "Los Angeles Rams", short: "Rams", location: "Los Angeles", name: "Rams", abbr: "LAR" },
  packers: { id: "9", displayName: "Green Bay Packers", short: "Packers", location: "Green Bay", name: "Packers", abbr: "GB" },
  chiefs: { id: "12", displayName: "Kansas City Chiefs", short: "Chiefs", location: "Kansas City", name: "Chiefs", abbr: "KC" },
  flaPanthers: { id: "26", displayName: "Florida Panthers", short: "Panthers", location: "Florida", name: "Panthers", abbr: "FLA" },
  bruins: { id: "1", displayName: "Boston Bruins", short: "Bruins", location: "Boston", name: "Bruins", abbr: "BOS" },
  lakers: { id: "13", displayName: "Los Angeles Lakers", short: "Lakers", location: "Los Angeles", name: "Lakers", abbr: "LAL" },
  celtics: { id: "2", displayName: "Boston Celtics", short: "Celtics", location: "Boston", name: "Celtics", abbr: "BOS" },
  braves: { id: "15", displayName: "Atlanta Braves", short: "Braves", location: "Atlanta", name: "Braves", abbr: "ATL" },
  yankees: { id: "10", displayName: "New York Yankees", short: "Yankees", location: "New York", name: "Yankees", abbr: "NYY" },
  arsenal: { id: "359", displayName: "Arsenal", short: "Arsenal", location: "Arsenal", name: "Arsenal", abbr: "ARS" },
  manUtd: { id: "360", displayName: "Manchester United", short: "Man Utd", location: "Manchester United", name: "Manchester United", abbr: "MAN" },
  liverpool: { id: "364", displayName: "Liverpool", short: "Liverpool", location: "Liverpool", name: "Liverpool", abbr: "LIV" },
  duke: { id: "150", displayName: "Duke Blue Devils", short: "Duke", location: "Duke", name: "Blue Devils", abbr: "DUKE" },
  tarHeels: { id: "153", displayName: "North Carolina Tar Heels", short: "North Carolina", location: "North Carolina", name: "Tar Heels", abbr: "UNC" },
  pitt: { id: "221", displayName: "Pittsburgh Panthers", short: "Pitt", location: "Pittsburgh", name: "Panthers", abbr: "PITT" },
};

export const LOGO = (abbr) => `https://a.espncdn.com/i/teamlogos/test/500/scoreboard/${String(abbr).toLowerCase()}.png`;

// Statuses, in the layout of competition.status
export const STATUS = {
  pre: (shortDetail = "10/30 - 8:15 PM EDT") => ({ clock: 0, displayClock: "0:00", period: 0, type: { id: "1", name: "STATUS_SCHEDULED", state: "pre", completed: false, description: "Scheduled", detail: "Thu, October 30th at 8:15 PM EDT", shortDetail } }),
  live: ({ period = 1, clock = "10:00", detail, short, name = "STATUS_IN_PROGRESS" } = {}) => ({ clock: 600, displayClock: clock, period, type: { id: "2", name, state: "in", completed: false, description: "In Progress", detail: detail ?? `${clock} - ${period}`, shortDetail: short ?? `${clock} - ${period}` } }),
  halftime: () => ({ clock: 0, displayClock: "0:00", period: 2, type: { id: "23", name: "STATUS_HALFTIME", state: "in", completed: false, description: "Halftime", detail: "Halftime", shortDetail: "Halftime" } }),
  endPeriod: (period = 1) => ({ clock: 0, displayClock: "0:00", period, type: { id: "22", name: "STATUS_END_PERIOD", state: "in", completed: false, description: "End of Period", detail: `End of ${period}st`, shortDetail: `End ${period}st` } }),
  final: (shortDetail = "Final") => ({ clock: 0, displayClock: "0:00", period: 4, type: { id: "3", name: "STATUS_FINAL", state: "post", completed: true, description: "Final", detail: shortDetail, shortDetail } }),
  postponed: () => ({ clock: 0, displayClock: "0:00", period: 0, type: { id: "6", name: "STATUS_POSTPONED", state: "post", completed: false, description: "Postponed", detail: "Postponed", shortDetail: "Postponed" } }),
  canceled: () => ({ clock: 0, displayClock: "0:00", period: 0, type: { id: "5", name: "STATUS_CANCELED", state: "post", completed: false, description: "Canceled", detail: "Canceled", shortDetail: "Canceled" } }),
  delayed: (detail = "Delayed") => ({ clock: 0, displayClock: "0:00", period: 1, type: { id: "7", name: "STATUS_DELAYED", state: "in", completed: false, description: "Delayed", detail, shortDetail: detail } }),
  suspended: () => ({ clock: 0, displayClock: "0:00", period: 5, type: { id: "8", name: "STATUS_SUSPENDED", state: "in", completed: false, description: "Suspended", detail: "Suspended", shortDetail: "Suspended" } }),
};

const teamBlock = (t) => ({ id: t.id, location: t.location, name: t.name, abbreviation: t.abbr, displayName: t.displayName, shortDisplayName: t.short, color: "112233", logo: t.logo ?? LOGO(t.abbr), logoDark: LOGO(`${t.abbr}-dark`) });

// side: { team, score, record, lines: [numbers], winner, leaders: [[category abbr, who, display]], rank }
const scoreboardCompetitor = (side, homeAway, order) => {
  const out = {
    id: side.team.id,
    homeAway,
    order,
    team: teamBlock(side.team),
    score: side.score === undefined ? "0" : String(side.score),
    records: side.record ? [{ name: "overall", type: "total", summary: side.record }, { name: "Home", type: "home", summary: "3-1" }] : [],
  };
  if (side.winner !== undefined) out.winner = side.winner;
  if (side.lines) out.linescores = side.lines.map((value, i) => ({ value, displayValue: String(value), period: i + 1 }));
  if (side.leaders) out.leaders = side.leaders.map(([abbreviation, who, displayValue]) => ({ name: abbreviation, displayName: abbreviation, abbreviation, leaders: [{ displayValue, value: 1, athlete: { displayName: who, shortName: who } }] }));
  if (side.rank) out.curatedRank = { current: side.rank };
  return out;
};

// o: { id, date (ISO), away, home, status, venue: { name, city, state }, tv: [], situation, notes, neutral }
export const scoreboardEvent = (o) => ({
  id: o.id,
  date: o.date,
  name: `${o.away.team.displayName} at ${o.home.team.displayName}`,
  shortName: `${o.away.team.abbr} @ ${o.home.team.abbr}`,
  competitions: [
    {
      id: o.id,
      date: o.date,
      neutralSite: Boolean(o.neutral),
      venue: o.venue ? { fullName: o.venue.name, address: { city: o.venue.city, state: o.venue.state }, indoor: false } : undefined,
      // like the real feed: the home team first
      competitors: [scoreboardCompetitor(o.home, "home", 0), scoreboardCompetitor(o.away, "away", 1)],
      broadcasts: o.tv ? [{ market: "national", names: o.tv }] : [],
      status: o.status,
      ...(o.situation ? { situation: o.situation } : {}),
    },
  ],
  status: o.status,
  ...(o.notes ? { notes: o.notes.map((headline) => ({ type: "event", headline })) } : {}),
});

export const scoreboard = (events, { week } = {}) => ({
  leagues: [{ abbreviation: "TEST", slug: "test", season: { year: 2026 } }],
  season: { type: 2, year: 2026 },
  ...(week ? { week: { number: week } } : {}),
  events,
});

// The same game on a team schedule: scores are objects, the record key is `record`, no line scores
const scheduleCompetitor = (side, homeAway) => ({
  id: side.team.id,
  homeAway,
  winner: side.winner,
  team: { ...teamBlock(side.team), logos: [{ href: LOGO(side.team.abbr) }] },
  ...(side.score === undefined ? {} : { score: { value: Number(side.score), displayValue: String(side.score) } }),
  record: side.record ? [{ type: "total", displayValue: side.record }] : [],
});

export const scheduleEvent = (o) => ({
  id: o.id,
  date: o.date,
  name: `${o.away.team.displayName} at ${o.home.team.displayName}`,
  competitions: [
    {
      id: o.id,
      date: o.date,
      venue: o.venue ? { fullName: o.venue.name, address: { city: o.venue.city, state: o.venue.state } } : undefined,
      competitors: [scheduleCompetitor(o.home, "home"), scheduleCompetitor(o.away, "away")],
      broadcasts: o.tv ? [{ media: { shortName: o.tv[0] } }] : [],
      status: o.status,
    },
  ],
});

export const schedule = (events) => ({ timestamp: "2026-10-28T12:00:00Z", status: "success", season: { year: 2026 }, team: { id: "29" }, events, requestedSeason: { year: 2026 } });

export const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
