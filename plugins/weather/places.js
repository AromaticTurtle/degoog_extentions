// Place text -> a geocoding request and a choice among its results. Pure.
//
// The geocoding API only searches by place name ("paris"), not "paris texas", so the query's place text is split into a name and
// a region hint ("texas", "tx", "france", "fr"), the name is searched, and the hint picks among the results. Without a hint the
// most populated place wins.

const US_STATES = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware", fl: "florida", ga: "georgia",
  hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts",
  mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico",
  ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina",
  sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia", wi: "wisconsin", wy: "wyoming",
  dc: "district of columbia",
};

const CA_PROVINCES = {
  ab: "alberta", bc: "british columbia", mb: "manitoba", nb: "new brunswick", nl: "newfoundland and labrador", ns: "nova scotia", nt: "northwest territories",
  nu: "nunavut", on: "ontario", pe: "prince edward island", qc: "quebec", sk: "saskatchewan", yt: "yukon",
};

// Region names that are not abbreviated (Australia, the UK)
const OTHER_REGIONS = ["new south wales", "victoria", "queensland", "tasmania", "western australia", "south australia", "northern territory", "england", "scotland", "wales", "northern ireland"];

// Country names (and common short forms) -> ISO 3166 alpha-2 code
const COUNTRIES = {
  "united states": "US", usa: "US", america: "US", "united kingdom": "GB", uk: "GB", england: "GB", scotland: "GB", wales: "GB", "great britain": "GB", canada: "CA", mexico: "MX",
  france: "FR", germany: "DE", italy: "IT", spain: "ES", portugal: "PT", netherlands: "NL", holland: "NL", belgium: "BE", switzerland: "CH", austria: "AT", sweden: "SE",
  norway: "NO", denmark: "DK", finland: "FI", iceland: "IS", ireland: "IE", poland: "PL", czechia: "CZ", "czech republic": "CZ", hungary: "HU", greece: "GR", turkey: "TR",
  russia: "RU", ukraine: "UA", romania: "RO", bulgaria: "BG", croatia: "HR", serbia: "RS", israel: "IL", egypt: "EG", morocco: "MA", "south africa": "ZA", nigeria: "NG",
  kenya: "KE", ethiopia: "ET", china: "CN", japan: "JP", "south korea": "KR", korea: "KR", india: "IN", pakistan: "PK", bangladesh: "BD", thailand: "TH", vietnam: "VN",
  indonesia: "ID", malaysia: "MY", singapore: "SG", philippines: "PH", australia: "AU", "new zealand": "NZ", brazil: "BR", argentina: "AR", chile: "CL", colombia: "CO",
  peru: "PE", venezuela: "VE", cuba: "CU", "saudi arabia": "SA", "united arab emirates": "AE", uae: "AE", iran: "IR", iraq: "IQ",
};

const REGION_NAMES = new Set([...Object.values(US_STATES), ...Object.values(CA_PROVINCES), ...OTHER_REGIONS]);
const REGION_ABBR = new Map([...Object.entries(US_STATES), ...Object.entries(CA_PROVINCES)]);

export const norm = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// A hint's kind: "region" (a state, province or country in the tables), "soft" (any other two letters: maybe a country code) or ""
const hintKind = (hint) => {
  const h = norm(hint);
  if (!h) return "";
  if (REGION_NAMES.has(h) || REGION_ABBR.has(h) || h in COUNTRIES) return "region";
  if (/^[a-z]{2}$/.test(h)) return "soft";
  return "";
};

// "paris texas" -> { name: "paris", hint: "texas", kind: "region" }; "charlotte, nc"; "london" -> { name: "london", hint: "" }
export const splitPlace = (text) => {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  const comma = clean.lastIndexOf(",");
  if (comma > 0) {
    const name = clean.slice(0, comma).trim();
    const hint = clean.slice(comma + 1).trim();
    const kind = hintKind(hint) || (hint ? "soft" : "");
    if (name && hint) return { name, hint, kind };
    if (name) return { name, hint: "", kind: "" };
  }
  const whole = norm(clean);
  if (REGION_NAMES.has(whole) || whole in COUNTRIES) return { name: clean, hint: "", kind: "" };
  const words = clean.split(" ");
  for (const take of [2, 1]) {
    if (words.length <= take) continue;
    const hint = words.slice(-take).join(" ");
    const kind = hintKind(hint);
    if (kind) return { name: words.slice(0, -take).join(" "), hint, kind };
  }
  return { name: clean, hint: "", kind: "" };
};

const matchesHint = (result, hint) => {
  const h = norm(hint);
  const region = US_STATES[h] ?? CA_PROVINCES[h] ?? h;
  const country = COUNTRIES[h] ?? (h.length === 2 ? h.toUpperCase() : "");
  if (norm(result.admin1) === region || norm(result.admin1) === h) return true;
  if (norm(result.country) === h) return true;
  if (country && String(result.countryCode ?? "").toUpperCase() === country) return true;
  if (norm(result.admin2) === h) return true;
  return false;
};

// Results of the geocoding request for `split` -> { place, candidates: [{ result, verdict }], reason }
export const pickPlace = (results, split) => {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return { place: null, candidates: [], reason: "the geocoder found nothing" };
  const wanted = norm(split.name);
  const exact = list.filter((r) => norm(r.name) === wanted);
  let pool = exact.length ? exact : list;
  let reason = exact.length ? "exact name matches" : "no exact name match, using the geocoder's closest";
  if (split.hint) {
    const matches = pool.filter((r) => matchesHint(r, split.hint));
    if (matches.length) {
      pool = matches;
      reason += `, filtered by "${split.hint}"`;
    } else if (split.kind === "region") {
      return { place: null, candidates: list.slice(0, 6).map((result) => ({ result, verdict: "no match for the region hint" })), reason: `no result matches "${split.hint}"` };
    } else {
      reason += `, "${split.hint}" matched nothing (ignored)`;
    }
  }
  const rank = (r) => [String(r.feature ?? "").startsWith("PPL") ? 1 : 0, Number(r.population) || 0];
  const sorted = [...pool].sort((a, b) => {
    const [pa, na] = rank(a);
    const [pb, nb] = rank(b);
    return pb - pa || nb - na;
  });
  const place = sorted[0];
  const candidates = list.slice(0, 6).map((result) => ({ result, verdict: result === place ? "chosen" : pool.includes(result) ? "candidate" : "filtered out" }));
  return { place, candidates, reason: `${reason}, most populated` };
};

export const placeLabel = (place) => {
  const parts = [place.name, place.admin1, place.country].filter((p, i, all) => p && all.indexOf(p) === i);
  return parts.join(", ");
};
