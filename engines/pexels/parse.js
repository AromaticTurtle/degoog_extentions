import { cleanText, isHttpUrl, truncate } from "./text.js";

// Photo, image and profile addresses must be on pexels.com (upgraded to https). extraHosts exists for tests against a local mock only
// (DEGOOG_PEXELS_EXTRA_HOSTS); those addresses are kept exactly as they are.
const securePexelsUrl = (value, extraHosts = []) => {
  if (!isHttpUrl(value)) return "";
  try {
    const url = new URL(value.trim());
    if (url.hostname === "pexels.com" || url.hostname.endsWith(".pexels.com")) {
      url.protocol = "https:";
      return url.toString();
    }
    return extraHosts.includes(url.hostname) ? url.toString() : "";
  } catch {
    return "";
  }
};

const MAX_PROFILE_PATH = 80;

// pexels.com/@daria from the photographer's profile address, or ""
export const profileLabel = (photo, extraHosts = []) => {
  const link = securePexelsUrl(photo?.photographer_url, extraHosts);
  if (!link) return "";
  const path = new URL(link).pathname.replace(/\/+$/, "");
  return /^\/@[A-Za-z0-9_.-]{1,60}$/.test(path) && path.length <= MAX_PROFILE_PATH ? `pexels.com${path}` : "";
};

const dimension = (value) => (Number.isInteger(value) && value > 0 && value < 100_000 ? value : 0);

// options.fullSize: which src size is the full-size image: large (940 px), large2x (1880 px) or original
export const parsePhotos = (data, source, { fullSize = "large2x", extraHosts = [] } = {}) => {
  if (!data || !Array.isArray(data.photos)) return null;
  const seen = new Set();
  const out = [];
  for (const photo of data.photos) {
    const src = photo?.src ?? {};
    const url = securePexelsUrl(photo?.url, extraHosts);
    const pick = (name) => securePexelsUrl(src[name], extraHosts);
    const thumbnail = pick("medium") || pick("large") || pick("small") || pick("tiny") || pick("large2x") || pick("original");
    const imageUrl = pick(fullSize) || pick("large2x") || pick("large") || pick("original") || thumbnail;
    if (!url || !thumbnail || !imageUrl || seen.has(url)) continue;
    seen.add(url);

    const photographer = cleanText(photo.photographer);
    const profile = profileLabel(photo, extraHosts);
    const alt = cleanText(photo.alt);
    // degoog's image preview shows the title, the host of the result address and the engine name, but not the snippet, so the credit
    // Pexels asks for ("Photo by John Doe on Pexels") is part of the title too.
    const label = photographer ? `Photo by ${photographer} on Pexels` : "Photo on Pexels";
    const title = alt ? `${truncate(alt, 110)} — ${label}` : label;
    // Pexels asks for the photographer's name with a link to the photo page ("Photo by John Doe on Pexels"); the result links to
    // the photo page, and the profile address is shown beside the name.
    const credit = photographer ? `Photo by ${photographer}${profile ? ` (${profile})` : ""} on Pexels` : "Photo on Pexels";
    const width = dimension(photo.width);
    const height = dimension(photo.height);
    const snippet = width && height ? `${credit} · ${width}×${height}` : credit;

    out.push({ title, url, snippet, source, thumbnail, imageUrl });
  }
  return out;
};

export const totalOf = (data) => {
  const total = Number(data?.total_results);
  return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : undefined;
};
