import { cleanText, isHttpUrl, truncate } from "./text.js";

// Image and page addresses must be on pixabay.com (upgraded to https). extraHosts exists for tests against a local mock only
// (DEGOOG_PIXABAY_EXTRA_HOSTS); those addresses are kept exactly as they are.
const securePixabayUrl = (value, extraHosts = []) => {
  if (!isHttpUrl(value)) return "";
  try {
    const url = new URL(value.trim());
    if (url.hostname === "pixabay.com" || url.hostname.endsWith(".pixabay.com")) {
      url.protocol = "https:";
      return url.toString();
    }
    return extraHosts.includes(url.hostname) ? url.toString() : "";
  } catch {
    return "";
  }
};

const TYPE_LABEL = { photo: "Photo", illustration: "Illustration", vector: "Vector graphic" };

// pixabay.com/users/Josch13-48777 (the profile address the API documents), or "" when the pieces are not safe to use
export const profileLabel = (hit) => {
  const user = hit?.user;
  const id = hit?.user_id;
  if (typeof user !== "string" || !/^[A-Za-z0-9_.-]{1,60}$/.test(user)) return "";
  if (!Number.isInteger(id) || id <= 0) return "";
  return `pixabay.com/users/${user}-${id}`;
};

const dimension = (value) => (Number.isInteger(value) && value > 0 && value < 100_000 ? value : 0);

// Only fields every API key gets are read: pageURL, previewURL, webformatURL, largeImageURL, tags, type, user, user_id and the sizes.
// fullHDURL, imageURL and vectorURL (full API access only) are never used.
export const parseHits = (data, source, extraHosts = []) => {
  if (!data || !Array.isArray(data.hits)) return null;
  const seen = new Set();
  const out = [];
  for (const hit of data.hits) {
    const url = securePixabayUrl(hit?.pageURL, extraHosts);
    const thumbnail = securePixabayUrl(hit?.webformatURL, extraHosts) || securePixabayUrl(hit?.previewURL, extraHosts);
    const imageUrl = securePixabayUrl(hit?.largeImageURL, extraHosts) || securePixabayUrl(hit?.webformatURL, extraHosts) || thumbnail;
    if (!url || !thumbnail || !imageUrl || seen.has(url)) continue;
    seen.add(url);

    const tags = cleanText(hit.tags);
    const kind = TYPE_LABEL[hit.type] ?? "Image";
    const contributor = cleanText(hit.user);
    const profile = profileLabel(hit);
    // degoog's image preview shows the title, the host of the result address and the engine name, but not the snippet, so the credit
    // Pixabay asks for ("by [contributor] via Pixabay") is part of the title too.
    const label = contributor ? `by ${contributor} via Pixabay` : "via Pixabay";
    const title = tags ? `${truncate(tags.charAt(0).toUpperCase() + tags.slice(1), 110)} — ${label}` : `${kind} ${label}`;
    const credit = contributor ? `${kind} by ${contributor}${profile ? ` (${profile})` : ""} via Pixabay` : `${kind} via Pixabay`;
    const width = dimension(hit.imageWidth);
    const height = dimension(hit.imageHeight);
    const snippet = width && height ? `${credit} · ${width}×${height}` : credit;

    out.push({ title, url, snippet, source, thumbnail, imageUrl });
  }
  return out;
};

export const totalOf = (data) => {
  const total = Number(data?.totalHits ?? data?.total);
  return Number.isFinite(total) && total >= 0 ? Math.trunc(total) : undefined;
};
