// The "use my location" flow, server side: what the card route accepts, how a label is made, nothing that does I/O. Pure.
//
// GET <api>/card?lat=35.23&lon=-80.84[&label=Charlotte]   coordinates from the browser's geolocation (rounded to 2 decimals here too)
// GET <api>/card?q=Charlotte%2C%20NC                      a typed place, resolved by the geocoder with the usual disambiguation
// Anything else is refused. The route only ever calls the three Open-Meteo services with fixed parameters; it is not a proxy.

export const MAX_QUERY_CHARS = 80;
export const MAX_LABEL_CHARS = 60;

export const roundCoord = (value) => Math.round(Number(value) * 100) / 100;

// Digits, one optional minus sign, one optional dot: no exponent, no hex, no "NaN".
const NUMBER = /^-?\d{1,3}(?:\.\d{1,12})?$/;

const coordinate = (raw, limit) => {
  const text = String(raw ?? "").trim();
  if (!NUMBER.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= limit ? roundCoord(value) : null;
};

export const cleanLabel = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LABEL_CHARS);

// "America/New_York" -> "New York"; zones with no city ("UTC", "Etc/GMT+5") -> ""
export const labelFromTimezone = (timezone) => {
  const zone = String(timezone ?? "");
  if (!zone.includes("/") || /^Etc\//i.test(zone)) return "";
  return cleanLabel(zone.split("/").pop().replace(/_/g, " "));
};

// params: URLSearchParams -> { kind: "coords", lat, lon, label } | { kind: "query", q } | { error }
export const parseCardRequest = (params) => {
  const has = (name) => params.has(name);
  if (has("lat") || has("lon")) {
    const lat = coordinate(params.get("lat"), 90);
    const lon = coordinate(params.get("lon"), 180);
    if (lat === null || lon === null) return { error: "bad coordinates" };
    return { kind: "coords", lat, lon, label: cleanLabel(params.get("label")) };
  }
  if (has("q")) {
    const q = String(params.get("q") ?? "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!q) return { error: "empty place" };
    if (q.length > MAX_QUERY_CHARS) return { error: "place too long" };
    if (/[a-z]+:\/\/|[<>@{}\\]/i.test(q)) return { error: "not a place name" };
    return { kind: "query", q };
  }
  return { error: "lat and lon, or q, is required" };
};

// The route address the script calls: only a root-relative path under /api/plugin/ is accepted from degoog's init context.
export const safeApiBase = (value, fallback = "/api/plugin/weather") => (typeof value === "string" && /^\/api\/plugin\/[A-Za-z0-9._-]+$/.test(value) ? value : fallback);
