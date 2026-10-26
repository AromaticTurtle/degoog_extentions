import { attrOf, childrenOf, decodeHtmlEntities, firstChild, parseXml, scanXml } from "./xml.js";
import { imageUrl, isId } from "./request.js";

const text = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");
const number = (value) => {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : 0;
};
const integer = (value) => Math.max(0, Math.trunc(number(value)));
const round = (value, places) => Math.round(number(value) * 10 ** places) / 10 ** places;

export const SEARCH_MAX_CHARS = 1_500_000;
export const SEARCH_MAX_ITEMS = 4000;
export const THING_MAX_CHARS = 2_000_000;
const DESCRIPTION_SOURCE_LIMIT = 6000;
const DESCRIPTION_LIMIT = 2000;
const SUBTYPE_RANK = "boardgame";

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

// BGG descriptions are HTML inside XML text: entities (also doubled up), line breaks and stray tags.
export const cleanDescription = (raw) => {
  let value = typeof raw === "string" ? raw.slice(0, DESCRIPTION_SOURCE_LIMIT) : "";
  value = value.replace(/<\s*br\s*\/?>/gi, " ").replace(/<\/\s*(?:p|div|li)\s*>/gi, " ");
  value = value.replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  value = decodeHtmlEntities(value).replace(/<\/?[a-zA-Z][^>]*>/g, " ");
  return value.replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT);
};

const valueOf = (node, tag) => attrOf(firstChild(node, tag), "value");

const linkValues = (node, type, limit) =>
  childrenOf(node, "link")
    .filter((link) => attrOf(link, "type") === type)
    .map((link) => text(attrOf(link, "value"), 80))
    .filter(Boolean)
    .slice(0, limit);

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
const rankOf = (ratings) => {
  const ranks = childrenOf(firstChild(ratings, "ranks"), "rank");
  const rank = ranks.find((entry) => attrOf(entry, "name") === SUBTYPE_RANK) ?? null;
  const value = attrOf(rank, "value");
  return /^\d{1,7}$/.test(value) ? Number(value) : 0;
};

const emptyNode = { tag: "", attrs: {}, children: [], text: "" };

// One <item> of a thing reply. Keeps only the fields the panel uses, which also keeps the cache small.
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
  return {
    id: isId(id) ? id : "",
    itemType: text(attrOf(item, "type"), 40),
    name: text(attrOf(primary, "value"), 200),
    alternates,
    year: integer(valueOf(item, "yearpublished")),
    image: imageUrl(firstChild(item, "image")?.text ?? ""),
    thumbnail: imageUrl(firstChild(item, "thumbnail")?.text ?? ""),
    description: cleanDescription(firstChild(item, "description")?.text ?? ""),
    minPlayers: integer(valueOf(item, "minplayers")),
    maxPlayers: integer(valueOf(item, "maxplayers")),
    playingTime: integer(valueOf(item, "playingtime")),
    minPlayTime: integer(valueOf(item, "minplaytime")),
    maxPlayTime: integer(valueOf(item, "maxplaytime")),
    minAge: integer(valueOf(item, "minage")),
    bestWith: players.best,
    recommendedWith: players.recommended,
    designers: linkValues(item, "boardgamedesigner", 4),
    publishers: linkValues(item, "boardgamepublisher", 3),
    categories: linkValues(item, "boardgamecategory", 6),
    mechanics: linkValues(item, "boardgamemechanic", 6),
    expansions: childrenOf(item, "link").filter((link) => attrOf(link, "type") === "boardgameexpansion" && attrOf(link, "inbound") !== "true").length,
    rating: round(valueOf(ratings, "average"), 2),
    ratingCount: integer(valueOf(ratings, "usersrated")),
    rank: rankOf(ratings),
    weight: round(valueOf(ratings, "averageweight"), 2),
    weightCount: integer(valueOf(ratings, "numweights")),
  };
};

// A whole thing reply as a list of compact games, or null when it is not an <items> document.
export const parseThings = (xml) => {
  const root = parseXml(xml, { maxChars: THING_MAX_CHARS });
  if (!root || root.tag !== "items") return null;
  return childrenOf(root, "item")
    .map(compactThing)
    .filter((game) => game.id && game.name);
};
