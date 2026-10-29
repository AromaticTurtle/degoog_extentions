import { SETTINGS_SCHEMA } from "./settings.js";
import { LEAGUES, leagueByKey } from "./leagues.js";
import { parseQuery } from "./match.js";
import { resolveTeams } from "./teams.js";
import { DEFAULT_BASE, baseFrom, parseSchedule, parseScoreboard, scheduleUrl, scoreboardUrl } from "./espn.js";
import { bestGame, boardTtl, involves, orderBoard, pickScheduled, rankTeams, surrounding } from "./rank.js";
import { espnDate, serverZone, validZone, whenToDate } from "./time.js";
import { buildGameCard, buildLeagueCard, searchHref } from "./render.js";
import { Budget, usageFile } from "./budget.js";
import { Upstream } from "./upstream.js";

// The inline layout puts the detailed card in the main column, above the results; the panel layout puts the compact card
// in the side column. The position follows the setting (no slotPositions are declared, so degoog uses `position`).
export const INLINE_POSITION = "above-results";
export const PANEL_POSITION = "knowledge-panel";
export const USER_AGENT = "degoog-sports/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";
export const SCHEDULE_TTL_MS = 60 * 60_000;
export const PAST_BOARD_TTL_MS = 6 * 60 * 60_000;
export const DEFAULT_DAILY_LIMIT = 3000;
export const DEFAULT_REFRESH_SECONDS = 30;
const FALLBACK_TEMPLATE = '<div class="command-result sports-result">{{content}}</div>';
const EMPTY = { title: "", html: "" };
const TIMED_OUT = Symbol("timed out");
const MAX_RANK_LEAGUES = 4;
const MAX_RANK_SCHEDULES = 3;

const truthy = (value, fallback) => (value === undefined || value === "" ? fallback : value === true || value === "true");

export const layoutFrom = (value) => (String(value ?? "").trim().toLowerCase() === "panel" ? "panel" : "inline");
export const refreshFrom = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_REFRESH_SECONDS;
  return Math.max(15, Math.min(300, parsed));
};
export const leaguesFrom = (value) => {
  const wanted = String(value ?? "").toLowerCase().split(/[\s,;]+/).filter(Boolean);
  const all = LEAGUES.map((league) => league.key);
  if (!wanted.length || wanted.includes("all")) return all;
  const known = all.filter((key) => wanted.includes(key));
  return known.length ? known : all;
};
const limitOf = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const slotTimeoutMs = () => {
  const configured = Number.parseInt(process.env.DEGOOG_SLOT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
};

// Used only when degoog does not hand the slot its own cache (for example in tests).
const localCache = (ttlMs, now) => {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async set(key, value, ttl = ttlMs) {
      store.set(key, { value, expiresAt: now() + ttl });
    },
  };
};

export class SportsSlot {
  isClientExposed = false;
  id = "sports";
  name = "Sports";
  description = "Live scores for 'panthers score', 'did the lakers win', 'arsenal match', 'nfl scores': one game card, or a league scoreboard, from ESPN's public scoreboard (no key).";
  position = INLINE_POSITION;
  settingsSchema = SETTINGS_SCHEMA;

  layout = "inline";
  enabledLeagues = LEAGUES.map((league) => league.key);
  zone = serverZone();
  autoRefresh = true;
  refreshSeconds = DEFAULT_REFRESH_SECONDS;
  debugMatching = false;
  template = FALLBACK_TEMPLATE;
  base = baseFrom(process.env.DEGOOG_SPORTS_API_BASE || DEFAULT_BASE);
  _signProxy = null;

  now = Date.now;
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  spacingMs = undefined;
  // degoog gives a slot 10 s (DEGOOG_SLOT_TIMEOUT_MS). No request is started after 70 % of it, and a lookup still running at
  // 95 % is given up on for this search (its reply is still cached when it arrives).
  startWindowMs = Math.max(1000, Math.round(slotTimeoutMs() * 0.7));
  answerWindowMs = Math.max(500, Math.round(slotTimeoutMs() * 0.95));

  _local = {};
  _inflight = new Map();

  constructor() {
    this.budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => this.now() });
    this.upstream = new Upstream({ host: this, label: "ESPN", spacingMs: 400, budgetOf: () => this.budget, rateDefaultMs: 2 * 60_000, rateMaxMs: 15 * 60_000, rejectedMessage: "ESPN refused the request" });
  }

  init(context) {
    if (context?.template) this.template = context.template;
    if (typeof context?.signProxyUrl === "function") this._signProxy = context.signProxyUrl;
  }

  configure(settings = {}) {
    this.layout = layoutFrom(settings.layout);
    this.position = this.layout === "panel" ? PANEL_POSITION : INLINE_POSITION;
    this.enabledLeagues = leaguesFrom(settings.leagues);
    this.zone = validZone(settings.timezone) || serverZone();
    this.autoRefresh = truthy(settings.autoRefresh, true);
    this.refreshSeconds = refreshFrom(settings.refreshSeconds);
    this.debugMatching = truthy(settings.debugMatching, false);
    this.budget.cap = limitOf(settings.dailyRequestLimit, DEFAULT_DAILY_LIMIT);
  }

  headers() {
    return { "User-Agent": USER_AGENT, Accept: "application/json" };
  }

  enabled(leagueKey) {
    return this.enabledLeagues.includes(leagueKey);
  }

  _cache(context, name, ttlMs) {
    if (typeof context?.useCache === "function") return context.useCache(`ext:sports:${name}`, ttlMs);
    this._local[name] ??= localCache(ttlMs, this.now);
    return this._local[name];
  }

  async _once(name, key, work) {
    const id = `${name}:${key}`;
    if (!this._inflight.has(id)) {
      this._inflight.set(id, work().finally(() => this._inflight.delete(id)));
    }
    return this._inflight.get(id);
  }

  // The parsed query, limited to the enabled leagues. { parsed, reason }
  inspect(query) {
    const result = parseQuery(query);
    const parsed = result.parsed;
    if (!parsed) return result;
    if (parsed.kind === "league") {
      const keys = parsed.leagueKeys.filter((key) => this.enabled(key));
      return keys.length ? { parsed: { ...parsed, leagueKeys: keys }, reason: result.reason } : { parsed: null, reason: `league ${parsed.leagueKeys.join("/")} is switched off in the settings` };
    }
    const filter = (side) => ({ ...side, candidates: side.candidates.filter((candidate) => this.enabled(candidate.team.league)) });
    if (parsed.kind === "vs") {
      const a = filter(parsed.a);
      const b = filter(parsed.b);
      return a.candidates.length && b.candidates.length ? { parsed: { ...parsed, a, b }, reason: result.reason } : { parsed: null, reason: "the leagues of these teams are switched off in the settings" };
    }
    const team = filter(parsed.team);
    return team.candidates.length ? { parsed: { ...parsed, team }, reason: result.reason } : { parsed: null, reason: "the leagues of this team are switched off in the settings" };
  }

  trigger(query) {
    try {
      const result = this.inspect(query);
      if (!result.parsed && this.debugMatching && /\b(?:scores?|games?|match|vs|versus|win|won|result|results)\b/i.test(String(query ?? ""))) {
        console.info(`[sports] "${String(query).replace(/\s+/g, " ").trim().slice(0, 100)}" not a sports question: ${result.reason}`);
      }
      return Boolean(result.parsed);
    } catch {
      return false;
    }
  }

  // A scoreboard for one league and day. -> { games, week, source } | { games: null, why }
  async board(league, dates, context, deadline) {
    try {
      const key = `${league.key}:${dates || "today"}`;
      const cache = this._cache(context, "board", 5 * 60_000);
      const hit = await cache.get(key);
      if (hit?.games) return { games: hit.games, week: hit.week ?? 0, source: "cache" };
      return await this._once("board", key, async () => {
        const result = await this.upstream.request(scoreboardUrl(this.base, league, { dates }), { context, deadline, maxChars: 3_000_000, headers: this.headers() });
        if (!result.ok) return { games: null, why: result.reason };
        const parsed = parseScoreboard(result.text, league);
        if (!parsed) {
          this.upstream.pause(60_000, "ESPN sent an unreadable reply");
          return { games: null, why: "unreadable" };
        }
        const allDone = parsed.games.length > 0 && parsed.games.every((game) => game.state === "post");
        const ttl = dates && allDone ? PAST_BOARD_TTL_MS : boardTtl(parsed.games, this.now());
        await cache.set(key, { games: parsed.games, week: parsed.week }, ttl);
        return { games: parsed.games, week: parsed.week, source: "request" };
      });
    } catch {
      return { games: null, why: "error" };
    }
  }

  async schedule(league, teamId, context, deadline) {
    try {
      const key = `${league.key}:${teamId}`;
      const cache = this._cache(context, "schedule", SCHEDULE_TTL_MS);
      const hit = await cache.get(key);
      if (hit?.games) return { games: hit.games, source: "cache" };
      return await this._once("schedule", key, async () => {
        const url = scheduleUrl(this.base, league, teamId);
        const result = await this.upstream.request(url, { context, deadline, maxChars: 2_000_000, headers: this.headers() });
        if (!result.ok) return { games: null, why: result.reason };
        const parsed = parseSchedule(result.text, league);
        if (!parsed) {
          this.upstream.pause(60_000, "ESPN sent an unreadable reply");
          return { games: null, why: "unreadable" };
        }
        await cache.set(key, { games: parsed.games }, SCHEDULE_TTL_MS);
        return { games: parsed.games, source: "request" };
      });
    } catch {
      return { games: null, why: "error" };
    }
  }

  _logo(context) {
    const proxy = context?.signProxyUrl ?? this._signProxy;
    if (typeof proxy !== "function") return null;
    return (url) => {
      try {
        const signed = proxy(url);
        return typeof signed === "string" ? signed : "";
      } catch {
        return "";
      }
    };
  }

  _ctx(context, opts) {
    return {
      layout: this.layout,
      zone: this.zone,
      now: this.now(),
      logo: this._logo(context),
      refresh: this.autoRefresh && opts.query ? { query: opts.query, seconds: this.refreshSeconds } : null,
    };
  }

  _chipQuery(team, league) {
    const ambiguous = resolveTeams(team.displayName).candidates.length > 1;
    return ambiguous ? `${team.displayName} ${league.words[0]} score` : `${team.displayName} score`;
  }

  _chips(ranked, chosen) {
    const chips = [];
    let colleges = 0;
    for (const candidate of ranked) {
      if (candidate.team === chosen.team) continue;
      // a pro team's nickname is shared by many schools: one school is enough
      if (chosen.league.kind === "pro" && candidate.league.kind === "college" && (colleges += 1) > 1) continue;
      if (chips.some((chip) => chip.label.startsWith(`${candidate.team.displayName} `))) continue;
      chips.push({ label: `${candidate.team.displayName} · ${candidate.league.name}`, href: searchHref(this._chipQuery(candidate.team, candidate.league)) });
      if (chips.length >= 3) break;
    }
    return chips;
  }

  async computeLeague(parsed, context, deadline, steps, opts) {
    const keys = parsed.leagueKeys.map(leagueByKey).filter(Boolean).sort((a, b) => a.priority - b.priority);
    const dates = whenToDate(parsed.when, this.now());
    for (const league of keys.slice(0, 3)) {
      const board = await this.board(league, dates, context, deadline);
      steps.push(`${league.name} scoreboard${dates ? ` ${dates}` : ""}: ${board.games ? `${board.games.length} games (${board.source})` : `unavailable (${board.why})`}`);
      if (!board.games?.length) continue;
      const dateLabel = parsed.when === "yesterday" ? "Yesterday" : parsed.when === "tomorrow" ? "Tomorrow" : "";
      const html = buildLeagueCard({ league, games: orderBoard(board.games), week: board.week }, { ...this._ctx(context, opts), dateLabel });
      return { html, steps, why: "" };
    }
    return { html: "", steps, why: "no games on the scoreboard" };
  }

  // Facts for ranking same-named teams: Map("league:id" -> { game, score })
  async rankFacts(candidates, context, deadline, steps) {
    const now = this.now();
    const facts = new Map();
    const leagues = [];
    for (const candidate of candidates) if (!leagues.includes(candidate.league)) leagues.push(candidate.league);
    const boards = await Promise.all(leagues.slice(0, MAX_RANK_LEAGUES).map((league) => this.board(league, "", context, deadline)));
    boards.forEach((board, i) => {
      steps.push(`ranking: ${leagues[i].name} scoreboard ${board.games ? `${board.games.length} games (${board.source})` : `unavailable (${board.why})`}`);
      if (!board.games) return;
      for (const candidate of candidates) {
        if (candidate.team.league !== leagues[i].key) continue;
        const best = bestGame(board.games, candidate.team.id, now, this.zone);
        if (best) facts.set(`${candidate.team.league}:${candidate.team.id}`, best);
      }
    });
    if (![...facts.values()].some((fact) => fact.score > 0)) {
      const ordered = candidates.slice().sort((a, b) => a.league.priority - b.league.priority).slice(0, MAX_RANK_SCHEDULES);
      const schedules = await Promise.all(ordered.map((candidate) => this.schedule(candidate.league, candidate.team.id, context, deadline)));
      schedules.forEach((schedule, i) => {
        const candidate = ordered[i];
        steps.push(`ranking: ${candidate.team.displayName} (${candidate.league.name}) schedule ${schedule.games ? `${schedule.games.length} games (${schedule.source})` : `unavailable (${schedule.why})`}`);
        if (!schedule.games) return;
        const best = bestGame(schedule.games, candidate.team.id, now, this.zone);
        if (best) facts.set(`${candidate.team.league}:${candidate.team.id}`, best);
      });
    }
    return facts;
  }

  // Game between two teams: today's boards first, then a team schedule. -> { team, league, game, candidates } | null
  async findVersus(parsed, context, deadline, steps) {
    const pairs = [];
    for (const a of parsed.a.candidates) {
      for (const b of parsed.b.candidates) if (a.team.league === b.team.league && a.team.id !== b.team.id) pairs.push({ a, b, league: a.league });
    }
    const anyPro = pairs.some((pair) => pair.league.kind === "pro");
    const usable = pairs.filter((pair) => !anyPro || pair.league.kind === "pro").sort((x, y) => x.league.priority - y.league.priority).slice(0, 3);
    steps.push(`pairs in the same league: ${usable.map((pair) => `${pair.a.team.displayName} / ${pair.b.team.displayName} (${pair.league.name})`).join("; ") || "none"}`);
    const now = this.now();
    for (const pair of usable) {
      const board = await this.board(pair.league, "", context, deadline);
      const game = board.games?.find((g) => involves(g, pair.a.team.id) && involves(g, pair.b.team.id));
      if (game) return { team: pair.a.team, league: pair.league, game, candidates: [] };
    }
    for (const pair of usable.slice(0, 2)) {
      const schedule = await this.schedule(pair.league, pair.a.team.id, context, deadline);
      const games = schedule.games?.filter((g) => involves(g, pair.b.team.id)) ?? [];
      const game = pickScheduled(games, "", now, this.zone);
      if (game) return { team: pair.a.team, league: pair.league, game, candidates: [] };
    }
    return null;
  }

  async computeTeam(parsed, context, deadline, steps, opts) {
    const now = this.now();
    const candidates = parsed.kind === "vs" ? parsed.a.candidates : parsed.team.candidates;
    let versus = null;
    if (parsed.kind === "vs") {
      versus = await this.findVersus(parsed, context, deadline, steps);
      steps.push(versus ? `game between the two teams: ${versus.game.id} (${versus.game.state})` : "no game between the two teams found: showing the first team's game");
    }
    const anyPro = candidates.some((candidate) => candidate.league.kind === "pro");
    const listed = candidates.slice(0, 8).map((candidate) => `${candidate.team.displayName} (${candidate.league.name}, ${candidate.kind})`).join("; ");
    steps.push(`candidates: ${listed}${candidates.length > 8 ? `; and ${candidates.length - 8} more` : ""}`);

    let chosen;
    let ranked = [];
    if (versus) {
      chosen = { team: versus.team, league: versus.league, game: versus.game };
      ranked = [];
    } else if (candidates.length === 1) {
      chosen = candidates[0];
      ranked = candidates;
    } else {
      const pool = anyPro ? candidates.filter((candidate) => candidate.league.kind === "pro") : candidates;
      const facts = await this.rankFacts(pool, context, deadline, steps);
      ranked = rankTeams(candidates, facts);
      for (const candidate of ranked.slice(0, 6)) steps.push(`  rank: ${candidate.team.displayName} (${candidate.league.name}) tier ${candidate.tier} score ${candidate.score}`);
      chosen = ranked[0];
    }
    const { team, league } = chosen;

    // The game itself
    let want = parsed.next ? "next" : parsed.when || (/win|who won|result/.test(parsed.rule ?? "") ? "past" : "");
    if (want === "today") want = "";
    let game = versus?.game ?? null;
    let scheduleGames = null;
    const scheduleP = this.schedule(league, team.id, context, deadline);
    if (!game && want !== "next") {
      const dates = parsed.when === "yesterday" || parsed.when === "tomorrow" ? whenToDate(parsed.when, now) : "";
      const board = await this.board(league, dates, context, deadline);
      steps.push(`${league.name} scoreboard${dates ? ` ${dates}` : ""}: ${board.games ? `${board.games.length} games (${board.source})` : `unavailable (${board.why})`}`);
      const best = board.games ? bestGame(board.games, team.id, now, this.zone) : null;
      if (best && !(want === "past" && best.game.state === "pre")) game = best.game;
    }
    const schedule = await scheduleP;
    steps.push(`${team.displayName} schedule: ${schedule.games ? `${schedule.games.length} games (${schedule.source})` : `unavailable (${schedule.why})`}`);
    scheduleGames = schedule.games;
    if (!game && scheduleGames) {
      const mine = scheduleGames.filter((g) => involves(g, team.id));
      game = pickScheduled(mine, want, now, this.zone);
      // a finished game found on the schedule: the dated scoreboard has the line score and the top performers
      if (game && game.state === "post") {
        const date = espnDate(game.ts);
        const board = await this.board(league, date, context, deadline);
        const rich = board.games?.find((g) => g.id === game.id);
        steps.push(`dated scoreboard ${date}: ${rich ? "found the game" : board.games ? "game not on it" : `unavailable (${board.why})`}`);
        if (rich) game = rich;
      }
    }
    if (!game) return { html: "", steps, why: want === "next" ? "no upcoming game found" : "no game found" };
    steps.push(`game ${game.id}: ${game.phase}${game.label ? ` (${game.label})` : ""}, ${game.teams.map((t) => `${t.short} ${t.score}`).join(" - ")}, from ${game.source}`);

    const around = scheduleGames ? surrounding(scheduleGames.filter((g) => involves(g, team.id)), game, now) : { next: null, last: null };
    let chips = this._chips(ranked, chosen);
    if (versus === null && parsed.kind === "vs") {
      const b = parsed.b.candidates[0];
      if (b) chips = [{ label: `${b.team.displayName} · ${b.league.name}`, href: searchHref(this._chipQuery(b.team, b.league)) }, ...chips].slice(0, 3);
    }
    const html = buildGameCard({ game, league, focusId: team.id, chips, next: around.next, last: around.last }, this._ctx(context, opts));
    return { html, steps, why: "", shown: { team, league, game } };
  }

  async compute(parsed, context, deadline, opts) {
    const steps = [];
    if (parsed.kind === "league") return this.computeLeague(parsed, context, deadline, steps, opts);
    return this.computeTeam(parsed, context, deadline, steps, opts);
  }

  async build(query, context, opts = {}) {
    const { parsed } = this.inspect(query);
    if (!parsed) return "";
    const answerBy = this.now() + this.answerWindowMs;
    const deadline = this.now() + this.startWindowMs;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, answerBy - this.now()));
    });
    const outcome = await Promise.race([this.compute(parsed, context, deadline, opts), timeout]);
    clearTimeout(timer);
    const shortQuery = String(query).replace(/\s+/g, " ").trim().slice(0, 100);
    if (outcome === TIMED_OUT) {
      if (this.debugMatching) console.info(`[sports] "${shortQuery}" -> too slow for the slot; the replies are cached when they arrive`);
      return "";
    }
    if (this.debugMatching) {
      console.info([`[sports] "${shortQuery}" -> rule: ${parsed.rule}, layout=${this.layout}, zone=${this.zone}`, ...outcome.steps.map((step) => `  ${step}`), `  verdict: ${outcome.html ? "card shown" : `no card (${outcome.why})`}`].join("\n"));
    }
    return outcome.html;
  }

  async execute(query, context) {
    try {
      const html = await this.build(query, context, { query: String(query ?? "").trim() });
      if (!html) return EMPTY;
      return { title: "", html: this.template.replace(/\{\{content\}\}/g, () => html) };
    } catch {
      return EMPTY;
    }
  }
}

export const slot = new SportsSlot();

// "!score panthers" renders the same card. Named exports, no default export: degoog's command loader would prefer a default
// export over a named `command` (see the reddit-lens plugin). The card is not refreshed on the page (there is no query to repeat).
export const command = {
  isClientExposed: false,
  name: "Sports scores",
  description: "!score panthers, !score nfl: the live score card for a team or a league.",
  trigger: "score",
  aliases: ["scores", "sports"],
  settingsSchema: [],

  configure() {},

  async execute(args, context) {
    const words = (Array.isArray(args) ? args.join(" ") : String(args ?? "")).trim();
    const hint = '<div class="command-result sports-result"><div class="sports-card sports-card--hint" data-live="false"><div class="sports-kicker">Sports</div><div class="sports-hint">Try <code>!score panthers</code> or <code>!score nfl</code></div></div></div>';
    if (!words) return { title: "Sports", html: hint };
    const html = (await slot.build(`${words} score`, context)) || (await slot.build(`${words} scores`, context));
    if (!html) return { title: "Sports", html: hint };
    return { title: "", html: slot.template.replace(/\{\{content\}\}/g, () => html) };
  },
};
