// Normalises the Free Dictionary API reply into a small, safe structure. Never throws; every string is capped and cleaned.
//
// The API answers an array of entries: { word, phonetic, phonetics: [{ text, audio, sourceUrl, license }],
// meanings: [{ partOfSpeech, definitions: [{ definition, example?, synonyms[], antonyms[] }], synonyms[], antonyms[] }],
// license: { name, url }, sourceUrls: [] }. An unknown word answers 404 { title: "No Definitions Found" }.

export const AUDIO_HOSTS = ["api.dictionaryapi.dev", "upload.wikimedia.org"];
const MAX_POS = 8;
const MAX_DEFS = 5;
const MAX_WORDS_LIST = 12;

const text = (value, max) =>
  (typeof value === "string" || typeof value === "number" ? String(value) : "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const list = (value) => (Array.isArray(value) ? value : []);

// A link we are willing to put in a page: https, and a host from the allowed list (or a subdomain of one).
export const safeUrl = (value, hosts) => {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const host = url.hostname.toLowerCase();
    return hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? url.toString() : "";
  } catch {
    return "";
  }
};

export const SOURCE_HOSTS = ["wiktionary.org"];
export const LICENSE_HOSTS = ["creativecommons.org"];

// "https://api.dictionaryapi.dev/media/pronunciations/en/word-us.mp3" -> "us"; anything else -> ""
export const accentOf = (url) => {
  const match = /[-_](us|uk|au|ca|gb|ie|nz|za)\.(?:mp3|ogg|wav)(?:$|\?)/i.exec(String(url));
  if (!match) return "";
  const accent = match[1].toLowerCase();
  return accent === "gb" ? "uk" : accent;
};

const isAudioUrl = (url) => /\.(?:mp3|ogg|wav|oga)(?:$|\?)/i.test(url);

const words = (values) => {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const word = text(value, 40).toLowerCase();
    if (!/^[a-z][a-z'’ -]*$/.test(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= MAX_WORDS_LIST) break;
  }
  return out;
};

// -> { word, phonetic, audio: [{ url, accent }], meanings: [{ pos, defs: [{ def, example }] }], synonyms[], antonyms[],
//      license: { name, url }, source } or null when there is nothing to show
export const compactEntries = (json) => {
  const entries = list(json).filter((entry) => entry && typeof entry === "object");
  if (!entries.length) return null;
  const word = text(entries[0].word, 60);
  if (!word) return null;

  let phonetic = "";
  const audio = [];
  const seenAudio = new Set();
  const byPos = new Map();
  const synonyms = [];
  const antonyms = [];
  let license = { name: "", url: "" };
  let source = "";

  for (const entry of entries.slice(0, 6)) {
    if (!phonetic) phonetic = text(entry.phonetic, 60);
    for (const item of list(entry.phonetics).slice(0, 12)) {
      if (!item || typeof item !== "object") continue;
      if (!phonetic) phonetic = text(item.text, 60);
      const url = safeUrl(item.audio, AUDIO_HOSTS);
      if (url && isAudioUrl(url) && !seenAudio.has(url)) {
        seenAudio.add(url);
        audio.push({ url, accent: accentOf(url), text: text(item.text, 60) });
        if (!phonetic) phonetic = text(item.text, 60);
      }
    }
    for (const meaning of list(entry.meanings).slice(0, 12)) {
      if (!meaning || typeof meaning !== "object") continue;
      const pos = text(meaning.partOfSpeech, 30).toLowerCase() || "other";
      if (!byPos.has(pos) && byPos.size >= MAX_POS) continue;
      const bucket = byPos.get(pos) ?? [];
      for (const definition of list(meaning.definitions).slice(0, 12)) {
        if (!definition || typeof definition !== "object") continue;
        const def = text(definition.definition, 400);
        if (!def) continue;
        if (bucket.length < MAX_DEFS) bucket.push({ def, example: text(definition.example, 300) });
        synonyms.push(...list(definition.synonyms));
        antonyms.push(...list(definition.antonyms));
      }
      synonyms.push(...list(meaning.synonyms));
      antonyms.push(...list(meaning.antonyms));
      if (bucket.length) byPos.set(pos, bucket);
    }
    if (!license.url && entry.license && typeof entry.license === "object") {
      const url = safeUrl(entry.license.url, LICENSE_HOSTS);
      if (url) license = { name: text(entry.license.name, 40), url };
    }
    if (!source) {
      for (const candidate of list(entry.sourceUrls)) {
        const url = safeUrl(candidate, SOURCE_HOSTS);
        if (url) {
          source = url;
          break;
        }
      }
    }
  }
  if (!byPos.size) return null;
  return {
    word,
    phonetic,
    audio: audio.slice(0, 4),
    meanings: [...byPos.entries()].map(([pos, defs]) => ({ pos, defs })),
    synonyms: words(synonyms).filter((w) => w !== word.toLowerCase()),
    antonyms: words(antonyms).filter((w) => w !== word.toLowerCase()),
    license,
    source,
  };
};
