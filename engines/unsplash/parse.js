import { cleanText, isHttpUrl, truncate } from "./text.js";

const secureUnsplashUrl = (value) => {
  if (!isHttpUrl(value)) return "";
  try {
    const url = new URL(value.trim());
    if (url.hostname !== "unsplash.com" && !url.hostname.endsWith(".unsplash.com")) return "";
    url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
};

const MAX_PROFILE_PATH = 80;

export const profileLabel = (user) => {
  let path = "";
  const link = secureUnsplashUrl(user?.links?.html);
  if (link) {
    path = new URL(link).pathname.replace(/\/+$/, "");
  } else if (typeof user?.username === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(user.username)) {
    path = `/@${user.username}`;
  }
  return path.length > 1 && path.length <= MAX_PROFILE_PATH ? `unsplash.com${path}` : "";
};

export const parsePhotos = (data, source) => {
  if (!data || !Array.isArray(data.results)) return null;
  const seen = new Set();
  const out = [];
  for (const photo of data.results) {
    const url = secureUnsplashUrl(photo?.links?.html);
    const thumbnail = secureUnsplashUrl(photo?.urls?.small) || secureUnsplashUrl(photo?.urls?.thumb);
    const imageUrl =
      secureUnsplashUrl(photo?.urls?.regular) || secureUnsplashUrl(photo?.urls?.full) || thumbnail;
    if (!url || !thumbnail || !imageUrl || seen.has(url)) continue;
    seen.add(url);

    const description = cleanText(photo.description);
    const photographer = cleanText(photo.user?.name);
    const profile = profileLabel(photo.user);
    const title =
      cleanText(photo.alt_description) || description || (photographer ? `Photo by ${photographer}` : "Unsplash photo");
    const credit = photographer
      ? `Photo by ${photographer}${profile ? ` (${profile})` : ""} on Unsplash`
      : "Photo on Unsplash";
    const snippet = description && description !== title ? `${credit} — ${truncate(description, 200)}` : credit;

    out.push({ title: truncate(title, 160), url, snippet, source, thumbnail, imageUrl });
  }
  return out;
};
