import { cleanText, isHttpUrl, truncate } from "./text.js";

// Openverse results come from many sources (Flickr, Wikimedia Commons, museums...), so image and page addresses are not tied to one
// host: any http(s) address is kept as it is. extraHosts is unused here; it exists so the three engines share one signature.

const LICENSE_NAMES = {
  by: "CC BY",
  "by-sa": "CC BY-SA",
  "by-nd": "CC BY-ND",
  "by-nc": "CC BY-NC",
  "by-nc-sa": "CC BY-NC-SA",
  "by-nc-nd": "CC BY-NC-ND",
  cc0: "CC0",
  pdm: "Public Domain Mark",
  sampling: "Sampling",
  "sampling+": "Sampling+",
  "nc-sampling+": "NC-Sampling+",
};

// "by-sa" + "4.0" -> "CC BY-SA 4.0"; "cc0" + "1.0" -> "CC0 1.0"; "" when the licence is not a plain code
export const licenseLabel = (license, version) => {
  const code = String(license ?? "").trim().toLowerCase();
  if (!/^[a-z0-9+-]{1,16}$/.test(code)) return "";
  const name = LICENSE_NAMES[code] ?? `CC ${code.toUpperCase()}`;
  const number = typeof version === "string" && /^\d{1,2}(\.\d{1,2})?$/.test(version.trim()) ? ` ${version.trim()}` : "";
  return `${name}${number}`;
};

const httpUrl = (value) => (isHttpUrl(value) ? value.trim() : "");

const dimension = (value) => (Number.isInteger(value) && value > 0 && value < 100_000 ? value : 0);

// "Flickr" from a source or provider code or name ("flickr", "wikimedia", "met", "nasa")
export const sourceLabel = (item) => {
  const raw = cleanText(item?.source) || cleanText(item?.provider);
  if (!raw) return "";
  const names = { flickr: "Flickr", wikimedia: "Wikimedia Commons", stocksnap: "StockSnap", met: "The Met", nypl: "NYPL", rawpixel: "rawpixel", smithsonian: "Smithsonian", europeana: "Europeana" };
  return names[raw.toLowerCase()] ?? raw;
};

// Items flagged as mature or sensitive are dropped even when the request said mature=false (belt and braces)
const isMature = (item) => item?.mature === true || (Array.isArray(item?.unstable__sensitivity) && item.unstable__sensitivity.length > 0);

// The licence and the creator are part of every result: Creative Commons licences require attribution, and the result links to the
// source page (foreign_landing_url), where the work is credited in full.
export const parseImages = (data, source) => {
  if (!data || !Array.isArray(data.results)) return null;
  const seen = new Set();
  const out = [];
  for (const item of data.results) {
    if (isMature(item)) continue;
    const url = httpUrl(item?.foreign_landing_url);
    const imageUrl = httpUrl(item?.url);
    const thumbnail = httpUrl(item?.thumbnail) || imageUrl;
    if (!url || !thumbnail || !imageUrl || seen.has(url)) continue;
    seen.add(url);

    const creator = cleanText(item.creator);
    const license = licenseLabel(item.license, item.license_version);
    const origin = sourceLabel(item);
    const tags = Array.isArray(item.tags) ? item.tags.map((tag) => cleanText(tag?.name)).filter(Boolean).slice(0, 4).join(", ") : "";
    const name = cleanText(item.title) || tags || "Openverse image";
    const credit = [license || "Openly licensed", creator || "creator unknown", origin].filter(Boolean).join(" · ");
    const width = dimension(item.width);
    const height = dimension(item.height);
    const snippet = width && height ? `${credit} · ${width}×${height}` : credit;

    // degoog's image preview shows the title, the host of the result address (the source page) and the engine name, but not the
    // snippet, so the licence and the creator that Creative Commons licences require are part of the title too.
    const title = `${truncate(name, 110)} — ${[license || "Openly licensed", creator].filter(Boolean).join(" · ")}`;

    out.push({ title, url, snippet, source, thumbnail, imageUrl });
  }
  return out;
};

export const totalOf = (data) => {
  const total = Number(data?.result_count);
  return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : undefined;
};
