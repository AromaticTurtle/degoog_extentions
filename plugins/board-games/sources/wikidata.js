import { Upstream } from "../upstream.js";
import { USER_AGENT, isId, sanitizeTerm } from "../request.js";
import { titleSimilarity } from "../match.js";

export const DEFAULT_WIKIDATA_API = "https://www.wikidata.org/w/api.php";
// Wikidata property "BoardGameGeek ID" (checked against Wikidata itself).
export const BGG_ID_PROPERTY = "P2339";
export const MIN_LABEL_SIMILARITY = 0.9;
const SEARCH_LIMIT = 5;
const MAX_CHARS = 300_000;

const trimBase = (base) => String(base || DEFAULT_WIKIDATA_API).replace(/\/+$/, "");

// Search syntax characters in the term would change what Wikidata searches for.
const searchText = (term) => sanitizeTerm(term).replace(/[:"\\~*?!()[\]{}<>|&^+=-]/g, " ").replace(/\s+/g, " ").trim();

export const wikidataSearchUrl = (term, base = DEFAULT_WIKIDATA_API) =>
  `${trimBase(base)}?${new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: `haswbstatement:${BGG_ID_PROPERTY} ${searchText(term)}`,
    srlimit: String(SEARCH_LIMIT),
    format: "json",
  })}`;

export const wikidataEntitiesUrl = (qids, base = DEFAULT_WIKIDATA_API) =>
  `${trimBase(base)}?${new URLSearchParams({
    action: "wbgetentities",
    ids: qids.join("|"),
    props: "labels|claims",
    languages: "en",
    format: "json",
  })}`;

const isQid = (value) => typeof value === "string" && /^Q\d{1,12}$/.test(value);

const parse = (text) => {
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !data.error ? data : null;
  } catch {
    return null;
  }
};

export const parseSearchQids = (text) => {
  const data = parse(text);
  const hits = data?.query?.search;
  if (!Array.isArray(hits)) return null;
  return hits.map((hit) => hit?.title).filter(isQid).slice(0, SEARCH_LIMIT);
};

// -> [{ qid, label, bggId }] for the entities that have an English label and a BoardGameGeek id.
export const parseEntities = (text, qids) => {
  const data = parse(text);
  const entities = data?.entities;
  if (!entities || typeof entities !== "object") return null;
  const out = [];
  for (const qid of qids) {
    const entity = entities[qid];
    const label = typeof entity?.labels?.en?.value === "string" ? entity.labels.en.value.trim().slice(0, 200) : "";
    const claims = Array.isArray(entity?.claims?.[BGG_ID_PROPERTY]) ? entity.claims[BGG_ID_PROPERTY] : [];
    const bggId = claims.map((claim) => claim?.mainsnak?.datavalue?.value).find((value) => typeof value === "string" && isId(value));
    if (label && bggId) out.push({ qid, label, bggId });
  }
  return out;
};

// Wikidata (CC0, no key) only turns a game's name into its BoardGameGeek id.
export class Wikidata {
  constructor({ host, budgetOf = null }) {
    this.base = process.env.DEGOOG_WIKIDATA_API || DEFAULT_WIKIDATA_API;
    this.upstream = new Upstream({ host, label: "Wikidata", budgetOf, blockMessage: "Wikidata refused the request" });
  }

  get headers() {
    return { Accept: "application/json", "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT };
  }

  // Resolves to { ok: true, candidates } (closest title first, similarity of at least 0.9; may be empty)
  // or { ok: false, reason }.
  async resolve({ term, context, deadline }) {
    const options = { context, deadline, maxChars: MAX_CHARS, headers: this.headers };
    const found = await this.upstream.request(wikidataSearchUrl(term, this.base), options);
    if (!found.ok) return { ok: false, reason: found.reason };
    const qids = parseSearchQids(found.text);
    if (!qids) return { ok: false, reason: "invalid" };
    if (!qids.length) return { ok: true, candidates: [] };
    const fetched = await this.upstream.request(wikidataEntitiesUrl(qids, this.base), options);
    if (!fetched.ok) return { ok: false, reason: fetched.reason };
    const entities = parseEntities(fetched.text, qids);
    if (!entities) return { ok: false, reason: "invalid" };
    const candidates = entities
      .map((entity, index) => ({ ...entity, index, sim: titleSimilarity(term, entity.label) }))
      .filter((entity) => entity.sim >= MIN_LABEL_SIMILARITY)
      .sort((a, b) => b.sim - a.sim || a.index - b.index);
    return { ok: true, candidates };
  }
}
