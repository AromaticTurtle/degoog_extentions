import { normalize } from "./parse.js";

const STOP_WORDS = new Set([
  "self", "hosted", "selfhosted", "selfhost", "open", "source", "opensource", "software", "app", "apps",
  "application", "applications", "free", "the", "a", "an", "for", "to", "of", "in", "and", "with", "best",
  "tool", "tools", "like", "alternative", "alternatives", "replacement", "replace", "instead",
]);

const ALTERNATIVE_PATTERNS = [
  /\balternatives?\s+(?:to|for)\s+(.+)$/,
  /^(.+?)\s+alternatives?\b/,
  /\b(?:replacements?\s+for|replace|instead\s+of|apps?\s+like|like)\s+(.+)$/,
];

const tokenize = (text) =>
  normalize(text)
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);

const significant = (tokens) => {
  const kept = tokens.filter((token) => !STOP_WORDS.has(token));
  return kept.length > 0 ? kept : tokens;
};

const popularity = (app) => Math.log10(app.stars + 1) * 3 + (app.activity === "G" ? 3 : app.activity === "R" ? -3 : 0);

const hasWord = (text, token) => new RegExp(`(?:^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(text);

const scoreToken = (app, token) => {
  const { name, slug, tags, alternatives, description, links } = app.search;
  let best = 0;
  if (name === token) best = Math.max(best, 100);
  else if (name.startsWith(token)) best = Math.max(best, 60);
  else if (hasWord(name, token)) best = Math.max(best, 45);
  else if (name.includes(token)) best = Math.max(best, 30);
  if (slug.includes(token)) best = Math.max(best, 20);
  if (tags.some((tag) => tag === token || hasWord(tag, token))) best = Math.max(best, 25);
  else if (tags.some((tag) => tag.includes(token))) best = Math.max(best, 12);
  if (alternatives.some((alt) => alt === token || hasWord(alt, token))) best = Math.max(best, 20);
  if (hasWord(description, token)) best = Math.max(best, 8);
  else if (description.includes(token)) best = Math.max(best, 4);
  if (links.includes(token)) best = Math.max(best, 3);
  return best;
};

export const alternativeTarget = (query) => {
  const text = normalize(query).trim();
  for (const pattern of ALTERNATIVE_PATTERNS) {
    const match = pattern.exec(text);
    const target = match?.[1]?.replace(/\b(?:alternatives?|self[\s-]?hosted)\b/g, "").replace(/\s+/g, " ").trim();
    if (target && target.length >= 2) return target;
  }
  return "";
};

const matchesAlternative = (app, target) =>
  app.search.alternatives.some((alt) => alt === target || (target.length >= 3 && (alt.includes(target) || (alt.length >= 3 && target.includes(alt)))));

const keep = (app, options) =>
  !(options.activeOnly && app.activity === "R") && !(options.openSourceOnly && app.closed);

export const searchApps = (apps, query, options = {}) => {
  const candidates = apps.filter((app) => keep(app, options));
  const target = alternativeTarget(query);

  if (target) {
    const matched = candidates.filter((app) => matchesAlternative(app, target));
    if (matched.length > 0) {
      return matched
        .map((app) => ({ app, score: popularity(app) }))
        .sort((a, b) => b.score - a.score || b.app.stars - a.app.stars || a.app.name.localeCompare(b.app.name))
        .map((entry) => entry.app);
    }
  }

  const tokens = significant(tokenize(target || query));
  if (tokens.length === 0) return [];
  const whole = normalize(target || query).trim();

  const scored = [];
  for (const app of candidates) {
    let total = 0;
    let complete = true;
    for (const token of tokens) {
      const score = scoreToken(app, token);
      if (score === 0) {
        complete = false;
        break;
      }
      total += score;
    }
    if (!complete) continue;
    if (app.search.name === whole) total += 50;
    scored.push({ app, score: total + popularity(app) });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.app.stars - a.app.stars || a.app.name.localeCompare(b.app.name))
    .map((entry) => entry.app);
};
