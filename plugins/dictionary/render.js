const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON = (path, size = 14) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const PLAY = ICON('<path d="M8 5.5v13l10.5-6.5z"/>', 12);

export const DICTIONARY_API_URL = "https://dictionaryapi.dev/";
export const WIKTIONARY_URL = "https://en.wiktionary.org/";
export const DEFAULT_LICENSE = { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0" };

const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;

export const searchLink = (word) => `search?q=${encodeURIComponent(`define ${word}`)}`;

const ACCENTS = { us: "US", uk: "UK", au: "AU", ca: "CA", ie: "IE", nz: "NZ", za: "ZA" };

// The address a play button uses: our own route (proxy), the dictionary's media address (direct), or none (off).
export const audioSource = (entry, index, { audio = "proxy", apiBase = "/api/plugin/dictionary" } = {}) => {
  const clip = entry.audio[index];
  if (!clip || audio === "off") return "";
  if (audio === "direct") return clip.url;
  return `${apiBase.replace(/\/+$/, "")}/audio?w=${encodeURIComponent(entry.word)}&n=${index}`;
};

const playButtons = (entry, options, limit) => {
  const buttons = [];
  const usedAccents = new Set();
  for (let index = 0; index < entry.audio.length && buttons.length < limit; index += 1) {
    const clip = entry.audio[index];
    const key = clip.accent || `clip${index}`;
    if (usedAccents.has(key)) continue;
    usedAccents.add(key);
    const src = audioSource(entry, index, options);
    if (!src) continue;
    const label = ACCENTS[clip.accent] ?? "";
    const aria = label ? `Play ${label} pronunciation` : "Play pronunciation";
    buttons.push(`<span class="dictionary-audio"><button class="dictionary-play" type="button" data-src="${esc(src)}" aria-label="${esc(aria)}" title="${esc(aria)}">${PLAY}</button>${label ? `<span class="dictionary-accent">${esc(label)}</span>` : ""}</span>`);
  }
  return buttons.join("");
};

const chips = (label, items) =>
  items.length
    ? `<div class="dictionary-chips-block"><div class="dictionary-label">${esc(label)}</div><div class="dictionary-chips">${items.map((item) => `<a class="dictionary-chip" href="${esc(searchLink(item))}">${esc(item)}</a>`).join("")}</div></div>`
    : "";

const sourceLine = (entry, { compact = false } = {}) => {
  const license = entry.license.url ? entry.license : DEFAULT_LICENSE;
  const wiktionary = link(entry.source || WIKTIONARY_URL, "Wiktionary");
  if (compact) return `${wiktionary} · ${link(license.url, license.name || DEFAULT_LICENSE.name)}`;
  return `Source: ${wiktionary} via ${link(DICTIONARY_API_URL, "Free Dictionary API")} (${link(license.url, license.name || DEFAULT_LICENSE.name)})`;
};

const clamp = (value, max) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

// requested: the word that was typed when the entry shown is for its base form ("" otherwise)
export const buildCard = (entry, { layout = "inline", intent = "define", requested = "", maxMeanings = 3, showExamples = true, showSynonyms = true, audio = "proxy", apiBase } = {}) => {
  const options = { audio, apiBase };
  const kicker = `<div class="dictionary-kicker">Dictionary · English</div>`;
  const phonetic = entry.phonetic ? `<span class="dictionary-phonetic">${esc(entry.phonetic)}</span>` : "";

  if (layout === "panel") {
    const lines = entry.meanings
      .slice(0, 2)
      .map((meaning) => `<div class="dictionary-line"><span class="dictionary-pos-tag">${esc(meaning.pos)}</span><span class="dictionary-line-text">${esc(clamp(meaning.defs[0].def, 110))}</span></div>`)
      .join("");
    const note = requested ? `<div class="dictionary-note">Entry for “${esc(entry.word)}”</div>` : "";
    return `<div class="dictionary-card dictionary-card--panel">${kicker}<div class="dictionary-word">${esc(entry.word)}</div><div class="dictionary-pron">${phonetic}${playButtons(entry, options, 1)}</div>${note}<div class="dictionary-lines">${lines}</div><div class="dictionary-footer">${sourceLine(entry, { compact: true })}</div></div>`;
  }

  const note = requested ? `<div class="dictionary-note">Showing the entry for “${esc(entry.word)}” (no entry for “${esc(requested)}”).</div>` : "";
  const meanings = entry.meanings
    .slice(0, Math.max(1, Math.min(6, maxMeanings)))
    .map((meaning) => {
      const defs = meaning.defs
        .slice(0, 3)
        .map((def) => `<li class="dictionary-def"><span class="dictionary-def-text">${esc(def.def)}</span>${showExamples && def.example ? `<span class="dictionary-example">“${esc(def.example)}”</span>` : ""}</li>`)
        .join("");
      return `<div class="dictionary-meaning"><div class="dictionary-pos">${esc(meaning.pos)}</div><ol class="dictionary-defs">${defs}</ol></div>`;
    })
    .join("");
  const wantsSynonyms = showSynonyms || intent === "synonyms" || intent === "antonyms";
  const relations = wantsSynonyms ? (intent === "antonyms" ? chips("Antonyms", entry.antonyms) + chips("Synonyms", entry.synonyms) : chips("Synonyms", entry.synonyms) + chips("Antonyms", entry.antonyms)) : "";
  return `<div class="dictionary-card dictionary-card--inline">${kicker}<div class="dictionary-head"><div class="dictionary-word">${esc(entry.word)}</div><div class="dictionary-pron">${phonetic}${playButtons(entry, options, 3)}</div></div>${note}<div class="dictionary-meanings">${meanings}</div>${relations}<div class="dictionary-footer">${sourceLine(entry)}</div></div>`;
};
