import { cleanText, truncate } from "./text.js";

export const ICON_BASE = "https://raw.githubusercontent.com/selfhst/icons/main/png";

const MIN_ROW_LENGTH = 19;

const norm = (value) =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

export const normalize = norm;

const toUrl = (value) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes(".")) return "";
    return url.toString();
  } catch {
    return "";
  }
};

const lookup = (list, index) => {
  const n = Number.parseInt(String(index ?? ""), 10);
  return Number.isInteger(n) && n >= 0 && typeof list[n] === "string" ? list[n] : "";
};

const nonNegativeInt = (value) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const names = (ids, byId) =>
  (Array.isArray(ids) ? ids : []).map((id) => byId.get(id)).filter((name) => typeof name === "string" && name);

const idMap = (entries) =>
  new Map(
    (Array.isArray(entries) ? entries : [])
      .filter((entry) => Array.isArray(entry) && typeof entry[1] === "string")
      .map((entry) => [entry[0], cleanText(entry[1])]),
  );

const iconName = (row) => {
  if (row[9] !== "Icons") return "";
  const name = String(row[10] || row[2] || "");
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : "";
};

export const decodeApps = ({ software, tags, alternatives, licenses, languages }) => {
  const tagNames = idMap(tags);
  const alternativeNames = idMap(alternatives);
  const licenseList = Array.isArray(licenses) ? licenses : [];
  const languageList = Array.isArray(languages) ? languages : [];
  const seen = new Set();
  const apps = [];

  for (const row of Array.isArray(software) ? software : []) {
    if (!Array.isArray(row) || row.length < MIN_ROW_LENGTH) continue;
    const name = cleanText(row[1]);
    const id = String(row[0]);
    if (!name || seen.has(id)) continue;
    seen.add(id);

    const license = lookup(licenseList, row[7]);
    const platform = String(row[6] ?? "");
    const app = {
      id,
      name,
      slug: String(row[2] ?? ""),
      website: toUrl(row[3]),
      repo: toUrl(row[4]),
      description: cleanText(row[5]),
      platform,
      license,
      language: lookup(languageList, row[8]),
      closed: platform === "Closed" || license === "Proprietary",
      icon: iconName(row),
      stars: nonNegativeInt(row[13]),
      forks: nonNegativeInt(row[14]),
      updated: /^\d{4}-\d{2}-\d{2}$/.test(String(row[15])) && row[15] > "1990-01-01" ? row[15] : "",
      activity: ["G", "Y", "R"].includes(row[16]) ? row[16] : "",
      tags: names(row[17], tagNames),
      alternatives: names(row[18], alternativeNames),
    };
    if (!app.website && !app.repo) continue;
    app.search = {
      name: norm(name),
      slug: norm(app.slug),
      tags: app.tags.map(norm),
      alternatives: app.alternatives.map(norm),
      description: norm(app.description),
      links: norm(`${app.website} ${app.repo}`),
    };
    apps.push(app);
  }
  return apps;
};

export const starsLabel = (stars) => {
  if (!stars) return "";
  if (stars < 1000) return String(stars);
  if (stars < 100_000) return `${(stars / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(stars / 1000)}k`;
};

export const buildSnippet = (app) => {
  const meta = [
    app.language,
    app.license,
    app.stars ? `★ ${starsLabel(app.stars)}` : "",
    app.closed ? "closed source" : "",
    app.updated ? `updated ${app.updated}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const extras = [];
  if (app.tags.length) extras.push(`Tags: ${app.tags.slice(0, 4).join(", ")}`);
  if (app.alternatives.length) extras.push(`Alternative to ${app.alternatives.slice(0, 4).join(", ")}`);
  const head = truncate(app.description, 160);
  return [head, meta].filter(Boolean).join(" — ") + (extras.length ? ` · ${extras.join(" · ")}` : "");
};

export const toResult = (app, source) => {
  const result = {
    title: app.name,
    url: app.website || app.repo,
    snippet: buildSnippet(app),
    source,
  };
  if (app.icon) result.thumbnail = `${ICON_BASE}/${app.icon}.png`;
  return result;
};
