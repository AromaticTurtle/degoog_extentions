import { attrOf, childrenOf, decodeHtmlEntities, firstChild, parseXml, scanXml } from "./xml.js";
import { imageUrl, isId } from "./request.js";
import { isAcceptedType } from "./match.js";

const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const number = (value) => {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const integer = (value) => Math.max(0, Math.trunc(number(value)));
const round = (value, places) => Math.round(number(value) * 10 ** places) / 10 ** places;
const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const strings = (value, limit, max = 80) => list(value).map((entry) => text(entry, max)).filter(Boolean).slice(0, limit);

export const SEARCH_MAX_CHARS = 1_500_000;
export const SEARCH_MAX_ITEMS = 4000;
export const THING_MAX_CHARS = 2_000_000;
const DESCRIPTION_SOURCE_LIMIT = 6000;
const DESCRIPTION_LIMIT = 2000;
const SUBTYPE_RANK = "boardgame";

export const SOURCE_API = "bgg-api";
export const SOURCE_RECOMMEND_GAMES = "recommend-games";
export const SOURCE_INTERNAL = "bgg-internal";

// Every source produces exactly this object, so the panel does not care where a game came from.
// Missing data is 0, "" or [].
export const blankGame = (source, fields = {}) => ({
  id: "",
  source,
  name: "",
  alternates: [],
  year: 0,
  image: "",
  description: "",
  minPlayers: 0,
  maxPlayers: 0,
  bestPlayers: "",
  recommendedPlayers: "",
  minPlayTime: 0,
  maxPlayTime: 0,
  minAge: 0,
  rating: 0,
  ratingCount: 0,
  rank: 0,
  weight: 0,
  designers: [],
  publishers: [],
  categories: [],
  mechanics: [],
  expansionCount: 0,
  ...fields,
});

// BGG descriptions are HTML (inside XML text for the API, plain HTML for the website's JSON): entities, line breaks and tags.
export const cleanDescription = (raw) => {
  let value = typeof raw === "string" ? raw.slice(0, DESCRIPTION_SOURCE_LIMIT) : "";
  value = value.replace(/<\s*br\s*\/?>/gi, " ").replace(/<\/\s*(?:p|div|li)\s*>/gi, " ");
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  value = decodeHtmlEntities(value).replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return value.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT);
};

// Consecutive numbers become ranges: [1,2,3,5] -> "1–3, 5". "4+" entries stay as they are.
export const formatPlayerList = (entries) => {
  const whole = [];
  const open = [];
  for (const entry of entries) {
    const match = /^(\d{1,3})(\+?)$/.exec(String(entry).trim());
    if (!match) continue;
    (match[2] ? open : whole).push(Number(match[1]));
  }
  const sorted = [...new Set(whole)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j += 1;
    parts.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  for (const n of [...new Set(open)].sort((a, b) => a - b)) parts.push(`${n}+`);
  return parts.join(", ");
};

// 3,3 -> "3", 3,4 -> "3–4", anything else -> "".
export const rangeText = (min, max) => {
  const low = integer(min);
  const high = integer(max);
  if (low > 0 && high >= low) return low === high ? String(low) : `${low}–${high}`;
  return low > 0 ? String(low) : high > 0 ? String(high) : "";
};

// ---- Source 1: the BGG XML API -------------------------------------------------------------

const isAcceptedSearchType = (type) => !type || type.toLowerCase() === "boardgame";

// Reads a search reply in one pass without building a tree: the list can hold thousands of items,
// and only the ids, names and years are kept. valid is false when the reply is not an <items> document.
export const scanSearch = (xml, { maxItems = SEARCH_MAX_ITEMS, maxChars = SEARCH_MAX_CHARS } = {}) => {
  const items = [];
  let current = null;
  let valid = false;
  const status = scanXml(
    xml,
    {
      open(tag, attrs) {
        if (tag === "items") valid = true;
        else if (tag === "item") {
          current = isId(attrs.id) && isAcceptedSearchType(attrs.type ?? "") ? { id: String(attrs.id), name: "", alternates: [], year: 0 } : null;
        } else if (current && tag === "name") {
          const name = text(attrs.value, 200);
          if (!name) return true;
          if (attrs.type === "alternate") {
            if (current.alternates.length < 12) current.alternates.push(name);
          } else if (!current.name) current.name = name;
          else if (current.alternates.length < 12) current.alternates.push(name);
        } else if (current && tag === "yearpublished") current.year = integer(attrs.value);
        return true;
      },
      close(tag) {
        if (tag === "item" && current) {
          if (!current.name && current.alternates.length) current.name = current.alternates.shift();
          if (current.name) items.push(current);
          current = null;
          if (items.length >= maxItems) return false;
        }
        return true;
      },
    },
    { maxChars },
  );
  return { items: status === "bad" ? [] : items, valid: valid && status !== "bad" };
};

const valueOf = (node, tag) => attrOf(firstChild(node, tag), "value");

const linkValues = (node, type, limit) =>
  childrenOf(node, "link")
    .filter((link) => attrOf(link, "type") === type)
    .map((link) => text(attrOf(link, "value"), 80))
    .filter(Boolean)
    .slice(0, limit);

// "Best with 3–4 players" -> "3–4"
const summaryPlayers = (value) => {
  const raw = text(value, 80);
  const match = /\bwith\s+(.+?)\s+players?\b/i.exec(raw) ?? /\bwith\s+(.+)$/i.exec(raw);
  return (match ? match[1] : "").replace(/[^\d,–\-+\s]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
};

// Without BGG's own summary: best = the player counts with the most Best votes,
// recommended = the counts where Best plus Recommended votes outweigh Not Recommended.
const derivePlayers = (poll) => {
  const rows = childrenOf(poll, "results").map((results) => {
    const votes = { best: 0, recommended: 0, not: 0 };
    for (const result of childrenOf(results, "result")) {
      const value = attrOf(result, "value").toLowerCase();
      const n = integer(attrOf(result, "numvotes"));
      if (value === "best") votes.best = n;
      else if (value === "recommended") votes.recommended = n;
      else if (value === "not recommended") votes.not = n;
    }
    return { players: text(attrOf(results, "numplayers"), 8), ...votes };
  });
  const most = Math.max(0, ...rows.map((row) => row.best));
  return {
    best: most > 0 ? formatPlayerList(rows.filter((row) => row.best === most).map((row) => row.players)) : "",
    recommended: formatPlayerList(rows.filter((row) => row.best + row.recommended > row.not).map((row) => row.players)),
  };
};

const playersOf = (node) => {
  const polls = childrenOf(node, "poll").filter((poll) => attrOf(poll, "name") === "suggested_numplayers");
  const summaries = childrenOf(node, "poll-summary").filter((summary) => attrOf(summary, "name") === "suggested_numplayers");
  let best = "";
  let recommended = "";
  for (const result of summaries.flatMap((summary) => childrenOf(summary, "result"))) {
    const name = attrOf(result, "name").toLowerCase();
    if (name === "bestwith") best = summaryPlayers(attrOf(result, "value"));
    else if (/^recomm+endedwith$/.test(name)) recommended = summaryPlayers(attrOf(result, "value"));
  }
  if ((!best || !recommended) && polls.length) {
    const derived = derivePlayers(polls[0]);
    best ||= derived.best;
    recommended ||= derived.recommended;
  }
  return { best, recommended };
};

// "Not Ranked" (or anything that is not a number) means 0.
const rankNumber = (value) => (/^\d{1,7}$/.test(String(value ?? "")) ? Number(value) : 0);

const rankOf = (ratings) => {
  const ranks = childrenOf(firstChild(ratings, "ranks"), "rank");
  const rank = ranks.find((entry) => attrOf(entry, "name") === SUBTYPE_RANK) ?? null;
  return rankNumber(attrOf(rank, "value"));
};

const emptyNode = { tag: "", attrs: {}, children: [], text: "" };

// One <item> of a thing reply.
export const compactThing = (node) => {
  const item = node ?? emptyNode;
  const names = childrenOf(item, "name");
  const primary = names.find((entry) => attrOf(entry, "type") === "primary") ?? names[0];
  const alternates = names
    .filter((entry) => entry !== primary)
    .map((entry) => text(attrOf(entry, "value"), 200))
    .filter(Boolean)
    .slice(0, 8);
  const ratings = firstChild(firstChild(item, "statistics"), "ratings");
  const players = playersOf(item);
  const id = attrOf(item, "id");
  return blankGame(SOURCE_API, {
    id: isId(id) ? id : "",
    name: text(attrOf(primary, "value"), 200),
    alternates,
    year: integer(valueOf(item, "yearpublished")),
    image: imageUrl(firstChild(item, "image")?.text ?? "") || imageUrl(firstChild(item, "thumbnail")?.text ?? ""),
    description: cleanDescription(firstChild(item, "description")?.text ?? ""),
    minPlayers: integer(valueOf(item, "minplayers")),
    maxPlayers: integer(valueOf(item, "maxplayers")),
    bestPlayers: players.best,
    recommendedPlayers: players.recommended,
    minPlayTime: integer(valueOf(item, "minplaytime")),
    maxPlayTime: integer(valueOf(item, "maxplaytime")) || integer(valueOf(item, "playingtime")),
    minAge: integer(valueOf(item, "minage")),
    rating: round(valueOf(ratings, "average"), 2),
    ratingCount: integer(valueOf(ratings, "usersrated")),
    rank: rankOf(ratings),
    weight: round(valueOf(ratings, "averageweight"), 2),
    designers: linkValues(item, "boardgamedesigner", 4),
    publishers: linkValues(item, "boardgamepublisher", 3),
    categories: linkValues(item, "boardgamecategory", 6),
    mechanics: linkValues(item, "boardgamemechanic", 6),
    expansionCount: childrenOf(item, "link").filter((link) => attrOf(link, "type") === "boardgameexpansion" && attrOf(link, "inbound") !== "true").length,
  });
};

// A whole thing reply as a list of games, or null when it is not an <items> document.
// Items that are not board games themselves (expansions, accessories...) are left out.
export const parseThings = (xml) => {
  const root = parseXml(xml, { maxChars: THING_MAX_CHARS });
  if (!root || root.tag !== "items") return null;
  return childrenOf(root, "item")
    .filter((node) => isAcceptedType(attrOf(node, "type")))
    .map(compactThing)
    .filter((game) => game.id && game.name);
};

// ---- Source 2: recommend.games -------------------------------------------------------------

export const RECOMMEND_MAX_RESULTS = 30;
export const RECOMMEND_MAX_CHARS = 2_000_000;
const MAX_OBJECT_CHARS = 200_000;

export const isRecommendExpansion = (raw) =>
  list(raw?.category_name).some((category) => typeof category === "string" && /^expansion for base-?game$/i.test(category.trim()));

// The first image is the original, the second a small 200x150 one, which suits a sidebar cover better.
const recommendImage = (value) => {
  const candidates = Array.isArray(value) ? [...value].reverse() : [value];
  for (const candidate of candidates) {
    const url = imageUrl(candidate);
    if (url) return url;
  }
  return "";
};

export const compactRecommendGame = (raw) => {
  const game = object(raw);
  const name = text(game.name);
  const id = String(game.bgg_id ?? "");
  return blankGame(SOURCE_RECOMMEND_GAMES, {
    id: isId(id) ? id : "",
    name,
    alternates: strings(game.alt_name, 60, 200).filter((alternate) => alternate !== name).slice(0, 12),
    year: integer(game.year),
    image: recommendImage(game.image_url),
    description: cleanDescription(game.description),
    minPlayers: integer(game.min_players),
    maxPlayers: integer(game.max_players),
    bestPlayers: rangeText(game.min_players_best, game.max_players_best),
    recommendedPlayers: rangeText(game.min_players_rec, game.max_players_rec),
    minPlayTime: integer(game.min_time),
    maxPlayTime: integer(game.max_time),
    minAge: integer(game.min_age),
    rating: round(game.avg_rating, 2),
    ratingCount: integer(game.num_votes),
    rank: rankNumber(game.bgg_rank),
    weight: round(game.complexity, 2),
    designers: strings(game.designer_name, 4),
    categories: strings(game.category_name, 6),
    mechanics: strings(game.mechanic_name, 6),
  });
};

// The objects of the "results" array, read one by one so a reply with hundreds of fuzzy matches
// (or one cut at the size cap) still yields its first few. Strings and escapes are respected.
const readResultObjects = (body, limit) => {
  const start = /"results"\s*:\s*\[/.exec(body);
  if (!start) return null;
  const out = [];
  let i = start.index + start[0].length;
  while (i < body.length && out.length < limit) {
    while (i < body.length && /[\s,]/.test(body[i])) i += 1;
    if (body[i] !== "{") break;
    let depth = 0;
    let inString = false;
    let j = i;
    for (; j < body.length && j - i < MAX_OBJECT_CHARS; j += 1) {
      const c = body[j];
      if (inString) {
        if (c === "\\") j += 1;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0 || j >= body.length) break;
    try {
      out.push(JSON.parse(body.slice(i, j + 1)));
    } catch {
      /* skip an object that is not valid JSON */
    }
    i = j + 1;
  }
  return out;
};

// A search reply as a list of games (expansions left out, at most RECOMMEND_MAX_RESULTS read),
// or null when it is not a recommend.games list.
export const parseRecommendGames = (body) => {
  if (typeof body !== "string" || !body.trim()) return null;
  let results = null;
  if (body.length <= RECOMMEND_MAX_CHARS) {
    try {
      const data = JSON.parse(body);
      if (Array.isArray(data?.results)) results = data.results.slice(0, RECOMMEND_MAX_RESULTS);
    } catch {
      results = null;
    }
  }
  if (!results) results = readResultObjects(body, RECOMMEND_MAX_RESULTS);
  if (!results) return null;
  return results
    .filter((raw) => raw && typeof raw === "object" && !isRecommendExpansion(raw))
    .map(compactRecommendGame)
    .filter((game) => game.id && game.name);
};

// ---- Source 3: BGG's own JSON API (geekitems + dynamicinfo) --------------------------------

const rangesText = (value) =>
  [...new Set(list(value).map((entry) => rangeText(object(entry).min, object(entry).max)).filter(Boolean))].join(", ");

const geekdoImage = (item) => {
  const images = object(item.images);
  for (const candidate of [images.previewthumb, item.imageurl, item["imageurl@2x"], images.square200, images.original]) {
    const url = imageUrl(candidate);
    if (url) return url;
  }
  return "";
};

// Whether a geekitems reply describes a board game itself (not an expansion or an accessory).
export const isGeekdoBoardGame = (itemData) => {
  const subtype = text(object(itemData?.item).subtype, 40).toLowerCase();
  return !subtype || subtype === "boardgame";
};

export const geekdoId = (itemData) => {
  const id = String(object(itemData?.item).objectid ?? "");
  return isId(id) ? id : "";
};

// geekitems has the description and the facts, dynamicinfo the rank, the ratings and the player polls.
export const compactGeekdo = (itemData, dynamicData) => {
  const item = object(itemData?.item);
  const dynamic = object(dynamicData?.item);
  const stats = object(dynamic.stats);
  const polls = object(dynamic.polls);
  const players = object(polls.userplayers);
  const links = object(item.links);
  const name = text(object(item.primaryname).name) || text(item.name);
  const rankEntry = list(dynamic.rankinfo).find((entry) => object(entry).rankobjecttype === "subtype" && object(entry).browsesubtype === SUBTYPE_RANK);
  const linkNames = (type, limit) => list(links[type]).map((entry) => text(object(entry).name, 80)).filter(Boolean).slice(0, limit);
  return blankGame(SOURCE_INTERNAL, {
    id: geekdoId(itemData),
    name,
    alternates: list(item.alternatenames)
      .map((entry) => text(object(entry).name, 200))
      .filter((alternate) => alternate && alternate !== name)
      .slice(0, 8),
    year: integer(item.yearpublished),
    image: geekdoImage(item),
    description: cleanDescription(item.description || item.short_description),
    minPlayers: integer(item.minplayers),
    maxPlayers: integer(item.maxplayers),
    bestPlayers: rangesText(players.best),
    recommendedPlayers: rangesText(players.recommended),
    minPlayTime: integer(item.minplaytime),
    maxPlayTime: integer(item.maxplaytime),
    minAge: integer(item.minage),
    rating: round(stats.average, 2),
    ratingCount: integer(stats.usersrated),
    rank: rankNumber(object(rankEntry).rank),
    weight: round(stats.avgweight ?? object(polls.boardgameweight).averageweight, 2),
    designers: linkNames("boardgamedesigner", 4),
    publishers: linkNames("boardgamepublisher", 3),
    categories: linkNames("boardgamecategory", 6),
    mechanics: linkNames("boardgamemechanic", 6),
    expansionCount: list(links.boardgameexpansion).length,
  });
};
