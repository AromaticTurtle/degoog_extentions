// Tests for the dictionary slot plugin: query parsing, entry shaping, cards, lookups, audio route, layout and settings.
//
// NOTE: tests/fixtures/dictionary-*.json are HAND-WRITTEN to the layout of the Free Dictionary API. The words
// ("florbit", "quillfern"), their definitions, examples and phonetics are invented, not real dictionary content.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AudioProxy, MAX_BYTES } from "../plugins/dictionary/audio.js";
import { BARE_STOPLIST, CURRENCY_CODES, DEFER } from "../plugins/dictionary/bare-lists.js";
import { bareWord, lemmaOf, parseQuery } from "../plugins/dictionary/match.js";
import { CalculatorSlot } from "../plugins/calculator/index.js";
import { CurrencySlot } from "../plugins/currency/index.js";
import { FIAT_CODES, WORDLIKE_FIAT } from "../plugins/currency/currencies.js";
import { SportsSlot } from "../plugins/sports/index.js";
import { WELL_KNOWN } from "../plugins/stocks/stoplist.js";
import { StocksSlot } from "../plugins/stocks/index.js";
import { WeatherSlot } from "../plugins/weather/index.js";
import { accentOf, compactEntries, safeUrl } from "../plugins/dictionary/shape.js";
import { audioSource, buildCard } from "../plugins/dictionary/render.js";
import { SETTINGS_SCHEMA } from "../plugins/dictionary/settings.js";
import { DictionarySlot, slot as sharedSlot, ENTRY_TTL_MS, INLINE_POSITION, MISSING_TTL_MS, PANEL_POSITION, USER_AGENT, audioFrom, layoutFrom, maxMeaningsFrom, routes } from "../plugins/dictionary/index.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FLORBIT = fixture("dictionary-florbit.json");
const QUILL = fixture("dictionary-quillfern.json");
const NOT_FOUND = fixture("dictionary-not-found.json");

const json = (text, status = 200, headers = {}) => new Response(text, { status, headers: { "content-type": "application/json", ...headers } });

// A fake dictionary: florbit and quillfern exist, everything else is 404.
const world = (overrides = {}) => {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: String(url), path: u.pathname, headers: init.headers ?? {}, at: Date.now() });
    const word = decodeURIComponent(u.pathname.split("/").pop());
    const custom = overrides[word] ?? overrides["*"];
    if (custom) {
      const response = await custom(word, calls.length);
      if (response) return response;
    }
    if (word === "florbit") return json(FLORBIT);
    if (word === "quillfern") return json(QUILL);
    return json(NOT_FOUND, 404);
  };
  return { fetch, calls };
};

const clock = (start = Date.parse("2026-10-28T12:00:00Z")) => {
  const state = { t: start };
  return { state, now: () => state.t, sleep: async (ms) => { state.t += ms; } };
};

const makeSlot = (settings = {}, { time } = {}) => {
  const slot = new DictionarySlot();
  slot.spacingMs = 0;
  slot.budget.file = "";
  if (time) {
    slot.now = time.now;
    slot.sleep = time.sleep;
  }
  slot.configure(settings);
  return slot;
};

const capture = async (work) => {
  const lines = [];
  const original = { info: console.info, warn: console.warn, log: console.log, error: console.error };
  for (const level of ["info", "warn", "log", "error"]) console[level] = (...args) => lines.push(args.join(" "));
  try {
    await work();
  } finally {
    Object.assign(console, original);
  }
  return lines;
};

const wordOf = (query) => parseQuery(query).parsed?.word ?? null;
const intentOf = (query) => parseQuery(query).parsed?.intent ?? null;

describe("which queries are dictionary questions", () => {
  const positives = [
    ["define serendipity", "serendipity", "define"],
    ["define: serendipity", "serendipity", "define"],
    ["Define Serendipity", "serendipity", "define"],
    ["definition of serendipity", "serendipity", "define"],
    ["definitions of serendipity", "serendipity", "define"],
    ["serendipity definition", "serendipity", "define"],
    ["serendipity meaning", "serendipity", "define"],
    ["meaning of serendipity", "serendipity", "define"],
    ["the meaning of serendipity", "serendipity", "define"],
    ["what does serendipity mean", "serendipity", "define"],
    ["what does serendipity mean?", "serendipity", "define"],
    ["what is the definition of serendipity", "serendipity", "define"],
    ["what's the meaning of serendipity", "serendipity", "define"],
    ["what is the meaning of life", "life", "define"],
    ["meaning of life", "life", "define"],
    ["serendipity synonym", "serendipity", "synonyms"],
    ["serendipity synonyms", "serendipity", "synonyms"],
    ["synonyms for happy", "happy", "synonyms"],
    ["synonym of happy", "happy", "synonyms"],
    ["serendipity antonym", "serendipity", "antonyms"],
    ["antonyms of happy", "happy", "antonyms"],
    ["opposite of happy", "happy", "antonyms"],
    ["serendipity pronunciation", "serendipity", "pronunciation"],
    ["how to pronounce serendipity", "serendipity", "pronunciation"],
    ["how do you pronounce quinoa", "quinoa", "pronunciation"],
    ["pronounce quinoa", "quinoa", "pronunciation"],
    ["define well-known", "well-known", "define"],
    ["define don't", "don't", "define"],
    ["define ice cream", "ice cream", "define"],
    ["define a la carte", "a la carte", "define"],
    ["what does the word love mean", "love", "define"],
    ["define the word love", "love", "define"],
    ["“define serendipity”", "serendipity", "define"],
    ["  define   serendipity  ", "serendipity", "define"],
  ];
  for (const [query, word, intent] of positives) {
    test(`${query} => ${word} (${intent})`, () => {
      expect(wordOf(query)).toBe(word);
      expect(intentOf(query)).toBe(intent);
    });
  }

  const negatives = [
    "", " ", "define", "definition", "meaning", "synonyms", "what is serendipity", "what does mean", "define 5", "define 2+2", "define c++",
    "define the term in c++ programming language", "define one two three four", "serendipity means", "meaning of", "how to pronounce", "the definition", "synonyms for", "what is the meaning",
    "definition of the", "define the", "define a", "https://example.com define", "me@example.com meaning", "weather meaning 10", "x".repeat(200), "define " + "a".repeat(60),
    "legal definition of murder", "meaning of life in the movie", "pronunciation of 12", "dictionary", "define 123abc",
  ];
  for (const query of negatives) test(`not a dictionary question: ${JSON.stringify(query.slice(0, 40))}`, () => expect(wordOf(query), query).toBeNull());

  test("calculator, currency and weather style queries are left alone", () => {
    for (const query of ["2+2", "100 usd to eur", "5 km to miles", "btc", "weather paris", "15% of 80"]) expect(wordOf(query), query).toBeNull();
  });

  test("without the bare-word option a lone word never triggers", () => {
    for (const query of ["serendipity", "happy", "dog", "colloquial"]) expect(wordOf(query), query).toBeNull();
  });

  test("a rejection gives a reason", () => {
    expect(parseQuery("serendipity").reason).toContain("no dictionary word");
    expect(parseQuery("").reason).toBe("empty");
    expect(parseQuery("define the").reason).toContain("stop word");
  });

  test("never throws", () => {
    for (const query of [null, undefined, 5, {}, "\u0000", "define \u0000", "💥 meaning", "define " + "é".repeat(30)]) expect(() => parseQuery(query)).not.toThrow();
  });
});

describe("fallback forms", () => {
  const table = [
    ["stories", "story"], ["cities", "city"], ["boxes", "box"], ["churches", "church"], ["classes", "class"], ["dogs", "dog"], ["tomatoes", "tomato"],
    ["running", "run"], ["stopped", "stop"], ["walked", "walk"], ["walking", "walk"], ["making", "make"], ["liked", "like"], ["tried", "try"], ["played", "play"],
    ["florbits", "florbit"], ["jumping", "jump"], ["falling", "fall"], ["passed", "pass"],
  ];
  for (const [word, lemma] of table) test(`${word} -> ${lemma}`, () => expect(lemmaOf(word)).toBe(lemma));
  test("nothing for words without an inflection or too short", () => {
    for (const word of ["glass", "virus", "this", "go", "red", "bed", "sing", "x", "", "cat", "serendipity", "a-b-c", "123", null]) expect(lemmaOf(word), String(word)).toBeNull();
  });
});

describe("entry shaping", () => {
  const entry = compactEntries(JSON.parse(FLORBIT));
  test("the invented fixture is shaped", () => {
    expect(entry.word).toBe("florbit");
    expect(entry.phonetic).toBe("/ˈflɔːbɪt/");
    expect(entry.audio.map((clip) => clip.accent)).toEqual(["us", "uk", "au"]);
    expect(entry.meanings.map((m) => m.pos)).toEqual(["noun", "verb", "adjective", "adverb"]);
    expect(entry.meanings[0].defs.length).toBe(5);
    expect(entry.meanings[0].defs[0].example).toContain("florbit rang");
    expect(entry.synonyms).toEqual(expect.arrayContaining(["tinkler", "chimelet", "pingle", "tinkle"]));
    expect(entry.antonyms).toEqual(expect.arrayContaining(["silence", "muffle", "real thing"]));
    expect(entry.license).toEqual({ name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0" });
    expect(entry.source).toBe("https://en.wiktionary.org/wiki/florbit");
  });

  test("an entry without audio or source", () => {
    const quill = compactEntries(JSON.parse(QUILL));
    expect(quill.audio).toEqual([]);
    expect(quill.source).toBe("");
    expect(quill.phonetic).toBe("/ˈkwɪlfɜːn/");
  });

  test("nothing usable gives null, and odd shapes never throw", () => {
    for (const bad of [null, undefined, 5, "x", {}, [], [null], [{}], [{ word: "x" }], [{ word: "x", meanings: [] }], [{ word: "x", meanings: [{ definitions: [] }] }], JSON.parse(NOT_FOUND), [{ word: "", meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "d" }] }] }]]) {
      expect(() => compactEntries(bad)).not.toThrow();
      expect(compactEntries(bad)).toBeNull();
    }
    const odd = compactEntries([{ word: "x", phonetics: "nope", meanings: [null, { partOfSpeech: 5, definitions: [null, { definition: { a: 1 } }, { definition: "ok", synonyms: "no", antonyms: [1, null, "fine"] }] }] }]);
    expect(odd.meanings[0].defs).toEqual([{ def: "ok", example: "" }]);
    expect(odd.antonyms).toEqual(["fine"]);
  });

  test("markup in the data is flattened", () => {
    const hostile = compactEntries([{ word: "<b>x</b>", phonetic: "<script>alert(1)</script>/x/", meanings: [{ partOfSpeech: "noun<br>", definitions: [{ definition: "a <img src=x onerror=alert(1)> thing &amp; more", example: "e\u0000x" }] }] }]);
    expect(hostile.word).toBe("x");
    expect(hostile.meanings[0].defs[0].def).toBe("a thing & more");
    expect(JSON.stringify(hostile)).not.toContain("<");
  });

  test("only allowed audio, source and licence links survive", () => {
    const entry2 = compactEntries([
      {
        word: "x",
        phonetics: [
          { audio: "http://api.dictionaryapi.dev/media/a-us.mp3" },
          { audio: "https://evil.example/a-us.mp3" },
          { audio: "https://api.dictionaryapi.dev.evil.example/a-us.mp3" },
          { audio: "https://api.dictionaryapi.dev/media/a.html" },
          { audio: "https://user:pw@api.dictionaryapi.dev/media/a-us.mp3" },
          { audio: "javascript:alert(1)" },
          { audio: "https://upload.wikimedia.org/wikipedia/commons/a/ab/En-us-x.ogg" },
        ],
        meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "d" }] }],
        license: { name: "x", url: "https://evil.example/l" },
        sourceUrls: ["https://evil.example/wiki/x", "javascript:1", "https://en.wiktionary.org/wiki/x"],
      },
    ]);
    expect(entry2.audio.map((clip) => clip.url)).toEqual(["https://upload.wikimedia.org/wikipedia/commons/a/ab/En-us-x.ogg"]);
    expect(entry2.license.url).toBe("");
    expect(entry2.source).toBe("https://en.wiktionary.org/wiki/x");
    expect(safeUrl("https://sub.wiktionary.org/x", ["wiktionary.org"])).toBeTruthy();
    expect(safeUrl("https://notwiktionary.org/x", ["wiktionary.org"])).toBe("");
    expect(accentOf("https://x/word-us.mp3")).toBe("us");
    expect(accentOf("https://x/word-gb.mp3")).toBe("uk");
    expect(accentOf("https://x/word.mp3")).toBe("");
  });

  test("lists are capped", () => {
    const many = { word: "x", meanings: Array.from({ length: 30 }, (_, i) => ({ partOfSpeech: `pos${i}`, definitions: Array.from({ length: 20 }, (_, j) => ({ definition: `d${j}`, synonyms: [`syn${i}x${j}`.replace(/\d/g, "a")] })) })) };
    const out = compactEntries([many]);
    expect(out.meanings.length).toBeLessThanOrEqual(8);
    expect(out.meanings[0].defs.length).toBeLessThanOrEqual(5);
    expect(out.synonyms.length).toBeLessThanOrEqual(12);
  });
});

describe("cards", () => {
  const entry = compactEntries(JSON.parse(FLORBIT));
  const options = { apiBase: "/api/plugin/dictionary" };

  test("inline: word, phonetic, one play button per accent, meanings, chips, source", () => {
    const html = buildCard(entry, { layout: "inline", ...options });
    expect(html).toContain("dictionary-card--inline");
    expect(html).toContain("Dictionary · English");
    expect(html).toContain(">florbit<");
    expect(html).toContain("/ˈflɔːbɪt/");
    expect([...html.matchAll(/class="dictionary-play"/g)]).toHaveLength(3);
    for (const accent of ["US", "UK", "AU"]) expect(html).toContain(`>${accent}<`);
    expect(html).toContain('data-src="/api/plugin/dictionary/audio?w=florbit&amp;n=0"');
    expect(html).toContain(">noun<");
    expect(html).toContain(">verb<");
    expect(html).toContain(">adjective<");
    expect(html).not.toContain(">adverb<");
    expect([...html.matchAll(/class="dictionary-def"/g)].length).toBeLessThanOrEqual(9);
    expect(html).toContain("The florbit rang twice");
    expect(html).toContain('href="search?q=define%20tinkler"');
    expect(html).toContain("Synonyms");
    expect(html).toContain("Antonyms");
    expect(html).toContain("Source: ");
    expect(html).toContain('<a href="https://en.wiktionary.org/wiki/florbit" target="_blank" rel="noopener noreferrer">Wiktionary</a>');
    expect(html).toContain("Free Dictionary API");
    expect(html).toContain('href="https://creativecommons.org/licenses/by-sa/3.0"');
    expect(html).toContain("CC BY-SA 3.0");
    expect(html).not.toContain("<details");
  });

  test("each part of speech shows at most three definitions", () => {
    const html = buildCard(entry, { layout: "inline", ...options });
    const noun = html.split('<div class="dictionary-meaning">')[1];
    expect([...noun.matchAll(/class="dictionary-def"/g)]).toHaveLength(3);
  });

  test("maxMeanings, examples and synonyms follow the settings", () => {
    const one = buildCard(entry, { layout: "inline", maxMeanings: 1, ...options });
    expect(one).toContain(">noun<");
    expect(one).not.toContain(">verb<");
    const six = buildCard(entry, { layout: "inline", maxMeanings: 6, ...options });
    expect(six).toContain(">adverb<");
    const none = buildCard(entry, { layout: "inline", showExamples: false, showSynonyms: false, ...options });
    expect(none).not.toContain("dictionary-example");
    expect(none).not.toContain("dictionary-chip");
    const asked = buildCard(entry, { layout: "inline", showSynonyms: false, intent: "synonyms", ...options });
    expect(asked).toContain("dictionary-chip");
    expect(asked.indexOf("Synonyms")).toBeLessThan(asked.indexOf("Antonyms"));
    const opposite = buildCard(entry, { layout: "inline", showSynonyms: false, intent: "antonyms", ...options });
    expect(opposite.indexOf("Antonyms")).toBeLessThan(opposite.indexOf("Synonyms"));
  });

  test("panel: compact, one play button, two one-line meanings", () => {
    const inline = buildCard(entry, { layout: "inline", ...options });
    const panel = buildCard(entry, { layout: "panel", ...options });
    expect(panel).toContain("dictionary-card--panel");
    expect([...panel.matchAll(/class="dictionary-play"/g)]).toHaveLength(1);
    expect([...panel.matchAll(/class="dictionary-line"/g)]).toHaveLength(2);
    expect(panel).not.toContain("dictionary-chip");
    expect(panel).not.toContain("dictionary-example");
    expect(panel.length).toBeLessThan(inline.length);
    expect(panel).toContain("Wiktionary");
  });

  test("audio modes", () => {
    expect(audioSource(entry, 0, { audio: "proxy", apiBase: "/api/plugin/dictionary/" })).toBe("/api/plugin/dictionary/audio?w=florbit&n=0");
    expect(audioSource(entry, 1, { audio: "direct" })).toBe("https://api.dictionaryapi.dev/media/pronunciations/en/florbit-uk.mp3");
    expect(audioSource(entry, 0, { audio: "off" })).toBe("");
    expect(audioSource(entry, 9, { audio: "proxy" })).toBe("");
    const off = buildCard(entry, { layout: "inline", audio: "off", ...options });
    expect(off).not.toContain("dictionary-play");
    const direct = buildCard(entry, { layout: "inline", audio: "direct", ...options });
    expect(direct).toContain('data-src="https://api.dictionaryapi.dev/media/pronunciations/en/florbit-us.mp3"');
  });

  test("the fallback form is flagged", () => {
    const html = buildCard(entry, { layout: "inline", requested: "florbits", ...options });
    expect(html).toContain("Showing the entry for “florbit” (no entry for “florbits”)");
    expect(buildCard(entry, { layout: "panel", requested: "florbits", ...options })).toContain("Entry for “florbit”");
    expect(buildCard(entry, { layout: "inline", ...options })).not.toContain("Showing the entry");
  });

  test("everything is escaped", () => {
    const hostile = { ...entry, word: 'x"><img src=x onerror=alert(1)>', phonetic: "<b>", synonyms: ["a<b>c"], antonyms: [], meanings: [{ pos: "<i>", defs: [{ def: "<img src=x>", example: '"><script>' }] }], audio: [] };
    const html = buildCard(hostile, { layout: "inline", ...options }) + buildCard(hostile, { layout: "panel", ...options });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
  });
});

describe("lookups", () => {
  const ctx = (w) => ({ fetch: w.fetch });

  test("a word: one request, the documented address, an honest User-Agent", async () => {
    const w = world();
    const slot = makeSlot();
    const result = await slot.execute("define florbit", ctx(w));
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].url).toBe("https://api.dictionaryapi.dev/api/v2/entries/en/florbit");
    expect(w.calls[0].headers["User-Agent"]).toBe(USER_AGENT);
    expect(Object.keys(w.calls[0].headers).sort()).toEqual(["Accept", "User-Agent"]);
    expect(result.title).toBe("");
    expect(result.html.startsWith('<div class="command-result dictionary-result">')).toBe(true);
    expect(result.html).toContain("florbit");
  });

  test("found entries are cached for 7 days", async () => {
    const time = clock();
    const w = world();
    const slot = makeSlot({}, { time });
    await slot.execute("define florbit", ctx(w));
    await slot.execute("florbit meaning", ctx(w));
    await slot.execute("synonyms of florbit", ctx(w));
    expect(w.calls).toHaveLength(1);
    time.state.t += ENTRY_TTL_MS - 1000;
    await slot.execute("define florbit", ctx(w));
    expect(w.calls).toHaveLength(1);
    time.state.t += 2000;
    await slot.execute("define florbit", ctx(w));
    expect(w.calls).toHaveLength(2);
  });

  test("unknown words are cached for 24 hours and give no card", async () => {
    const time = clock();
    const w = world();
    const slot = makeSlot({}, { time });
    expect(await slot.execute("define zzyzx", ctx(w))).toEqual({ title: "", html: "" });
    expect(await slot.execute("define zzyzx", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(1);
    expect(slot.upstream.paused).toBe(false);
    time.state.t += MISSING_TTL_MS + 1000;
    await slot.execute("define zzyzx", ctx(w));
    expect(w.calls).toHaveLength(2);
  });

  test("a plural gets exactly one fallback request and is flagged", async () => {
    const w = world();
    const slot = makeSlot();
    const result = await slot.execute("define florbits", ctx(w));
    expect(w.calls.map((c) => c.path)).toEqual(["/api/v2/entries/en/florbits", "/api/v2/entries/en/florbit"]);
    expect(result.html).toContain("Showing the entry for “florbit” (no entry for “florbits”)");
    await slot.execute("define florbits", ctx(w));
    expect(w.calls).toHaveLength(2);
  });

  test("no fallback when the base form is unknown too, or for phrases", async () => {
    const w = world();
    const slot = makeSlot();
    expect(await slot.execute("define zzyzxs", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(2);
    await slot.execute("define big dogs", ctx(w));
    expect(w.calls).toHaveLength(3);
  });

  test("concurrent identical lookups share one request", async () => {
    const w = world({ florbit: async () => { await new Promise((r) => setTimeout(r, 30)); return null; } });
    const slot = makeSlot();
    await Promise.all([slot.execute("define florbit", ctx(w)), slot.execute("florbit meaning", ctx(w)), slot.execute("define florbit", ctx(w))]);
    expect(w.calls).toHaveLength(1);
  });

  test("requests are at least a second apart", async () => {
    const time = clock();
    const times = [];
    const w = world({ "*": () => { times.push(time.state.t); return null; } });
    const slot = new DictionarySlot();
    slot.budget.file = "";
    slot.now = time.now;
    slot.sleep = time.sleep;
    slot.configure({});
    await slot.execute("define florbit", ctx(w));
    await slot.execute("define quillfern", ctx(w));
    expect(times).toHaveLength(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(1000);
  });

  test("429 pauses for Retry-After with one warning; 5xx for a minute; neither makes a card", async () => {
    const time = clock();
    const w = world({ florbit: () => new Response("", { status: 429, headers: { "retry-after": "120" } }) });
    const slot = makeSlot({}, { time });
    const lines = await capture(async () => {
      expect(await slot.execute("define florbit", ctx(w))).toEqual({ title: "", html: "" });
      expect(await slot.execute("define quillfern", ctx(w))).toEqual({ title: "", html: "" });
    });
    expect(w.calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("paused for 2 min");
    time.state.t += 121_000;
    const ok = world();
    expect((await slot.execute("define quillfern", ctx(ok))).html).toContain("quillfern");

    const boom = world({ "*": () => new Response("", { status: 503 }) });
    const slot2 = makeSlot({}, { time });
    const lines2 = await capture(async () => {
      await slot2.execute("define florbit", ctx(boom));
      await slot2.execute("define quillfern", ctx(boom));
    });
    expect(boom.calls).toHaveLength(1);
    expect(lines2[0]).toContain("paused for 1 min");
    expect(lines2.join("")).not.toContain("http");
  });

  test("the service saying its limit is used up pauses briefly", async () => {
    const w = world({ florbit: () => json(FLORBIT, 200, { "x-ratelimit-remaining": "0" }) });
    const slot = makeSlot();
    let html = "";
    await capture(async () => {
      html = (await slot.execute("define florbit", ctx(w))).html;
    });
    expect(html).toContain("florbit");
    expect(slot.upstream.paused).toBe(true);
  });

  test("unreadable replies and network errors give no card and pause", async () => {
    const slot = makeSlot();
    await capture(async () => {
      expect(await slot.execute("define florbit", ctx(world({ florbit: () => new Response("<html>", { status: 200 }) })))).toEqual({ title: "", html: "" });
    });
    expect(slot.upstream.paused).toBe(true);
    const slot2 = makeSlot();
    const lines = await capture(async () => {
      expect(await slot2.execute("define florbit", { fetch: async () => { throw new Error("boom https://secret.example"); } })).toEqual({ title: "", html: "" });
    });
    expect(lines.join("")).not.toContain("secret");
  });

  test("the daily request limit", async () => {
    const w = world();
    const slot = makeSlot({ dailyRequestLimit: "1" });
    await slot.execute("define florbit", ctx(w));
    await capture(async () => {
      expect(await slot.execute("define quillfern", ctx(w))).toEqual({ title: "", html: "" });
    });
    expect(w.calls).toHaveLength(1);
    expect(slot.budget.used).toBe(1);
  });

  test("a lookup that is too slow for the slot gives up; the reply is cached for the next search", async () => {
    const gate = Promise.withResolvers();
    const w = world({ florbit: async () => { await gate.promise; return null; } });
    const slot = makeSlot();
    slot.answerWindowMs = 100;
    expect(await slot.execute("define florbit", ctx(w))).toEqual({ title: "", html: "" });
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    slot.answerWindowMs = 5000;
    expect((await slot.execute("define florbit", ctx(w))).html).toContain("florbit");
    expect(w.calls).toHaveLength(1);
  });

  test("no request is started after 70 % of the slot time", async () => {
    const w = world();
    const slot = makeSlot();
    slot.startWindowMs = -1;
    expect(await slot.execute("define florbit", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
  });

  test("not a dictionary question: no request, empty result; never throws", async () => {
    const w = world();
    const slot = makeSlot();
    expect(await slot.execute("two words florbit", ctx(w))).toEqual({ title: "", html: "" });
    expect(await slot.execute("florbit", { fetch: w.fetch })).not.toEqual({ title: "", html: "" }); // a bare word is looked up by default
    expect(w.calls).toHaveLength(1);
    await capture(async () => {
      for (const query of [null, undefined, "", "define florbit"]) {
        expect(await slot.execute(query, { fetch: async () => { throw new Error("x"); } })).toBeDefined();
        expect(await slot.execute(query, undefined)).toBeDefined();
      }
    });
  });
});

describe("the audio route", () => {
  const mp3 = (size = 2048, type = "audio/mpeg", extra = {}) => new Response(new Uint8Array(size).fill(7), { status: 200, headers: { "content-type": type, ...extra } });
  const proxyFor = (respond) => {
    const calls = [];
    const host = { now: Date.now, sleep: async () => {}, userAgent: USER_AGENT, fetchImpl: async (url, init) => { calls.push({ url: String(url), headers: init?.headers }); return respond(String(url), calls.length); } };
    const proxy = new AudioProxy(host);
    proxy.remember(compactEntries(JSON.parse(FLORBIT)));
    return { proxy, calls, host };
  };
  const get = (proxy, query) => proxy.serve(new Request(`http://degoog.local/api/plugin/dictionary/audio${query}`));

  test("serves a remembered clip with safe headers, and caches it", async () => {
    const { proxy, calls } = proxyFor(() => mp3());
    const first = await get(proxy, "?w=florbit&n=0");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("audio/mpeg");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("cache-control")).toContain("max-age=604800");
    expect((await first.arrayBuffer()).byteLength).toBe(2048);
    await get(proxy, "?w=florbit&n=0");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.dictionaryapi.dev/media/pronunciations/en/florbit-us.mp3");
    expect(Object.keys(calls[0].headers).sort()).toEqual(["Accept", "User-Agent"]);
    await get(proxy, "?w=florbit&n=1");
    expect(calls[1].url).toContain("florbit-uk.mp3");
  });

  test("it is not an open proxy: only clips from replies it has seen", async () => {
    const { proxy, calls } = proxyFor(() => mp3());
    for (const query of ["", "?w=other&n=0", "?w=florbit&n=7", "?w=florbit&n=-1", "?w=florbit&n=x", "?w=..%2F..%2Fetc&n=0", "?w=florbit&n=0&url=https://evil.example/x.mp3", "?u=https://evil.example/x.mp3"]) {
      const response = await get(proxy, query);
      if (query.includes("url=")) expect(response.status).toBe(200);
      else expect(response.status, query).toBe(404);
    }
    expect(calls.every((c) => c.url.startsWith("https://api.dictionaryapi.dev/"))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("refuses what is not audio, too large, redirected away or failing", async () => {
    expect((await get(proxyFor(() => mp3(10, "text/html")).proxy, "?w=florbit&n=0")).status).toBe(502);
    expect((await get(proxyFor(() => mp3(10, "audio/mpeg", { "content-length": String(MAX_BYTES + 1) })).proxy, "?w=florbit&n=0")).status).toBe(502);
    expect((await get(proxyFor(() => mp3(MAX_BYTES + 10)).proxy, "?w=florbit&n=0")).status).toBe(502);
    expect((await get(proxyFor(() => new Response("", { status: 404 })).proxy, "?w=florbit&n=0")).status).toBe(404);
    const redirected = Object.defineProperty(mp3(), "url", { value: "https://evil.example/x.mp3" });
    expect((await get(proxyFor(() => redirected).proxy, "?w=florbit&n=0")).status).toBe(502);
    const busy = proxyFor(() => new Response("", { status: 503 }));
    expect((await get(busy.proxy, "?w=florbit&n=0")).status).toBe(503);
    expect((await get(busy.proxy, "?w=florbit&n=1")).status).toBe(503);
    expect(busy.calls).toHaveLength(1);
    const broken = proxyFor(() => { throw new Error("boom"); });
    expect((await get(broken.proxy, "?w=florbit&n=0")).status).toBe(502);
  });

  test("the route is exported in the shape degoog expects, and works through the slot", async () => {
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ method: "get", path: "/audio" });
    expect(typeof routes[0].handler).toBe("function");
  });

  test("a rendered card makes its clips available", async () => {
    const slot = makeSlot();
    slot.fetchImpl = async () => mp3();
    await slot.execute("define florbit", { fetch: world().fetch });
    const response = await slot.audioProxy.serve(new Request("http://x/audio?w=florbit&n=2"));
    expect(response.status).toBe(200);
    expect((await slot.audioProxy.serve(new Request("http://x/audio?w=nothing&n=0"))).status).toBe(404);
  });
});

describe("layout and settings", () => {
  test("position follows the layout and the card differs", async () => {
    const inline = makeSlot({ layout: "inline" });
    const panel = makeSlot({ layout: "panel" });
    expect(inline.position).toBe(INLINE_POSITION);
    expect(panel.position).toBe(PANEL_POSITION);
    expect(inline.slotPositions).toBeUndefined();
    const w = world();
    const a = (await inline.execute("define florbit", { fetch: w.fetch })).html;
    const b = (await panel.execute("define florbit", { fetch: w.fetch })).html;
    expect(a).toContain("dictionary-card--inline");
    expect(b).toContain("dictionary-card--panel");
    expect(a.length).toBeGreaterThan(b.length);
  });

  test("clamping and defaults", () => {
    expect(maxMeaningsFrom("0")).toBe(1);
    expect(maxMeaningsFrom("99")).toBe(6);
    expect(maxMeaningsFrom("x")).toBe(3);
    expect(maxMeaningsFrom(undefined)).toBe(3);
    expect(audioFrom("DIRECT")).toBe("direct");
    expect(audioFrom("off")).toBe("off");
    expect(audioFrom("nonsense")).toBe("proxy");
    expect(layoutFrom("panel")).toBe("panel");
    expect(layoutFrom(undefined)).toBe("inline");
    const slot = makeSlot({ dailyRequestLimit: "9" });
    expect(slot.budget.cap).toBe(9);
    slot.configure({ dailyRequestLimit: "x" });
    expect(slot.budget.cap).toBe(500);
    slot.configure({ dailyRequestLimit: "0" });
    expect(slot.budget.cap).toBe(0);
  });

  test("init takes the template and the api base from degoog", () => {
    const slot = new DictionarySlot();
    slot.init({ template: "<p>{{content}}</p>", apiBase: "/api/plugin/dictionary-x" });
    expect(slot.template).toBe("<p>{{content}}</p>");
    expect(slot.apiBase).toBe("/api/plugin/dictionary-x");
    slot.init({ apiBase: "https://evil.example" });
    expect(slot.apiBase).toBe("/api/plugin/dictionary-x");
  });

  test("the schema", () => {
    expect(SETTINGS_SCHEMA.map((f) => f.key)).toEqual(["layout", "maxMeanings", "showExamples", "showSynonyms", "triggerOnBareWord", "audio", "dailyRequestLimit", "debugMatching"]);
    expect(SETTINGS_SCHEMA.find((f) => f.key === "layout")).toMatchObject({ default: "inline", options: ["inline", "panel"] });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "audio")).toMatchObject({ default: "proxy", options: ["proxy", "direct", "off"] });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "dailyRequestLimit")).toMatchObject({ default: "500", advanced: true });
    expect(SETTINGS_SCHEMA.find((f) => f.key === "debugMatching")).toMatchObject({ default: "false", advanced: true });
    expect(SETTINGS_SCHEMA.some((f) => f.required)).toBe(false);
  });
});

describe("debugMatching", () => {
  test("off by default: nothing is logged", async () => {
    const slot = makeSlot();
    const w = world();
    const lines = await capture(async () => {
      slot.trigger("serendipity meaning of");
      await slot.execute("define florbits", { fetch: w.fetch });
    });
    expect(lines).toEqual([]);
  });

  test("on: one block per decision with the steps, and the rule for near misses", async () => {
    const slot = makeSlot({ debugMatching: "true" });
    const w = world();
    const near = await capture(async () => {
      expect(slot.trigger("define the")).toBe(false);
      expect(slot.trigger("hello world")).toBe(false);
    });
    expect(near).toHaveLength(1);
    expect(near[0]).toContain("stop word");
    const lines = await capture(async () => {
      await slot.execute("define florbits", { fetch: w.fetch });
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('word "florbits"');
    expect(lines[0]).toContain("florbits: missing (request)");
    expect(lines[0]).toContain("florbit: found (request) [fallback form]");
    expect(lines[0]).toContain("verdict: card shown");
    expect(lines[0]).not.toContain("http");
  });
});

describe("one menu entry", () => {
  test("the module exports a slot and no bang command (a command would add a second entry to degoog's plugin list)", async () => {
    const mod = await import("../plugins/dictionary/index.js");
    expect(mod.slot).toBe(sharedSlot);
    expect("command" in mod).toBe(false);
    expect("default" in mod).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------
describe("bare words", () => {
  const bare = (query) => parseQuery(query, { bareWord: true });
  const wordsOf = (query) => bare(query).parsed?.word ?? null;

  test("a lone word is defined: lower case or capitalised, with an inner hyphen or apostrophe", () => {
    for (const [query, word] of [["colloquial", "colloquial"], ["Colloquial", "colloquial"], ["ephemeral", "ephemeral"], ["serendipity", "serendipity"], ["well-known", "well-known"], ["don't", "don't"], ["rock'n'roll", "rock'n'roll"], ["colloquialisms", "colloquialisms"], ["colloquial?", "colloquial"], ["  colloquial  ", "colloquial"], ["python", "python"], ["top", "top"], ["cat", "cat"], ["Quillfern", "quillfern"]]) {
      expect(wordsOf(query), query).toBe(word);
      expect(bare(query).parsed.intent).toBe("define");
      expect(bare(query).bare).toBe("lookup");
    }
  });

  test("length: 3 to 30 letters (shorter words only through explicit forms)", () => {
    for (const query of ["a", "ab", "go", "x".repeat(31)]) expect(wordsOf(query), query).toBeNull();
    expect(wordsOf("abc")).toBe("abc");
    expect(wordsOf("a".repeat(30))).toBe("a".repeat(30));
    expect(parseQuery("define go", { bareWord: true }).parsed.word).toBe("go");
    expect(bare("ab").reason).toContain("shorter than 3");
    expect(bare("x".repeat(31)).reason).toContain("longer than 30");
  });

  test("not words: digits, URLs, dots, slashes, @, symbols, several words", () => {
    for (const query of ["12345", "abc123", "x.com", "example.com", "a/b", "me@example.com", "http://x", "c++", "$AAPL", "!weather", "100%", "two words", "colloquial word", "hello_world", "tab\tbed", "-dash", "dash-", "'quote", "e-mail-", "..."]) {
      expect(wordsOf(query), query).toBeNull();
    }
  });

  test("capitals: an all-caps token or a mixed-case name is not a word", () => {
    for (const query of ["AAPL", "NASA", "HTML", "iPhone", "McDonald", "eBay"]) expect(wordsOf(query), query).toBeNull();
    expect(bare("NASA").reason).toContain("all capitals");
    expect(bare("iPhone").reason).toContain("mixed capitals");
  });

  test("popular sites and brands are skipped (stoplist)", () => {
    for (const query of ["google", "youtube", "facebook", "reddit", "amazon", "gmail", "login", "Google", "netflix", "github"]) {
      expect(wordsOf(query), query).toBeNull();
      expect(bare(query).reason).toContain("stoplist");
    }
  });

  test("stop words are skipped", () => {
    for (const query of ["the", "and", "meaning", "definition", "dictionary", "word", "synonyms"]) expect(wordsOf(query), query).toBeNull();
  });

  test("words another core plugin answers are left to it", () => {
    for (const [query, plugin] of [["weather", "weather"], ["forecast", "weather"], ["Weather", "weather"], ["score", "sports"], ["scores", "sports"], ["tau", "calculator"], ["sqrt", "calculator"], ["bitcoin", "currency"], ["btc", "currency"], ["doge", "currency"], ["ethereum", "currency"], ["msft", "stocks"], ["aapl", "stocks"], ["Tsla", "stocks"], ["meta", "stocks"]]) {
      expect(wordsOf(query), query).toBeNull();
      expect(bare(query).reason, query).toContain(plugin);
    }
  });

  test("currency codes are not words", () => {
    for (const query of ["usd", "eur", "gbp", "jpy", "USD", "Eur"]) expect(wordsOf(query), query).toBeNull();
    // codes that are also English words stay definable
    for (const query of ["top", "pen", "cup", "mad", "try", "all", "kid", "cop"]) expect(wordsOf(query), query).toBe(query);
  });

  test("explicit forms win and keep their meaning", () => {
    expect(bare("define score").parsed).toMatchObject({ word: "score", intent: "define" });
    expect(bare("score meaning").parsed).toMatchObject({ word: "score", intent: "define" });
    expect(bare("define weather").parsed.word).toBe("weather");
    expect(bare("synonyms for happy").parsed.intent).toBe("synonyms");
    expect(bare("define score").bare).toBeUndefined();
  });

  test("queries that are neither explicit nor a lone word still give a reason", () => {
    expect(bare("what is serendipity").reason).toContain("bare word skipped: more than one word");
    expect(bare("").reason).toBe("empty");
  });

  test("bareWord() on odd input never throws", () => {
    for (const query of [null, undefined, 5, {}, [], "\u0000", "💥", "é".repeat(40), "a".repeat(5000)]) expect(() => bareWord(query)).not.toThrow();
  });

  describe("the lists stay in step with the plugins that own those words", () => {
    const quiet = (slot) => slot;
    const weather = new WeatherSlot();
    weather.configure({});
    const sports = new SportsSlot();
    sports.configure({});
    const calculator = new CalculatorSlot();
    calculator.configure({});
    const currency = new CurrencySlot();
    currency.configure({});
    const stocks = new StocksSlot();
    stocks.store.file = "";
    stocks.configure({ apiKey: "test-key-0123456789" });
    quiet(weather);

    test("every deferred word is really claimed by that plugin, or is a word it must own", () => {
      for (const word of DEFER.weather) if (["weather", "forecast"].includes(word)) expect(weather.trigger(word), word).toBe(true);
      for (const word of DEFER.currency) if (["bitcoin", "btc", "ethereum", "eth", "ether", "xrp", "doge", "dogecoin", "ltc", "litecoin"].includes(word)) expect(currency.trigger(word), word).toBe(true);
      for (const word of DEFER.stocks) expect(stocks.trigger(word), word).toBe(true);
    });

    test("the stock allowlist (three letters or more) is deferred in full", () => {
      for (const symbol of WELL_KNOWN) {
        if (symbol.length < 3 || symbol.includes(".")) continue;
        expect(DEFER.stocks.has(symbol.toLowerCase()), symbol).toBe(true);
      }
    });

    test("no bare word is claimed by the dictionary and by another plugin at the same time", () => {
      const slot = new DictionarySlot();
      slot.configure({});
      const pool = new Set(["colloquial", "ephemeral", "weather", "forecast", "score", "scores", "pi", "bitcoin", "btc", "eth", "ether", "msft", "aapl", "meta", "usd", "eur", "top", "pen", "serendipity", "euro", "dollar", "pound", "stock", "stocks", "temperature", "calculator", ...DEFER.weather, ...DEFER.sports, ...DEFER.calculator, ...DEFER.currency, ...DEFER.stocks, ...BARE_STOPLIST]);
      for (const word of pool) {
        for (const form of [word, word.toUpperCase(), word[0].toUpperCase() + word.slice(1)]) {
          const takers = [weather, sports, calculator, currency, stocks].filter((other) => other.trigger(form));
          if (slot.trigger(form)) expect(takers.map((t) => t.id), form).toEqual([]);
        }
      }
    });

    test("the currency codes: every code the currency plugin knows is skipped, except the ones that are English words", () => {
      for (const code of FIAT_CODES) expect(CURRENCY_CODES.has(code.toLowerCase()), code).toBe(!WORDLIKE_FIAT.has(code));
      for (const code of CURRENCY_CODES) expect(FIAT_CODES.has(code.toUpperCase()), code).toBe(true);
    });

    test("the stoplist never overlaps the deferral lists and holds only lower-case words", () => {
      for (const word of BARE_STOPLIST) {
        expect(word, word).toBe(word.toLowerCase());
        for (const words of Object.values(DEFER)) expect(words.has(word), word).toBe(false);
      }
      expect(BARE_STOPLIST.size).toBeGreaterThan(30);
      expect(BARE_STOPLIST.size).toBeLessThan(120);
    });
  });
});

describe("bare words: the slot", () => {
  const ctx = (w) => ({ fetch: w.fetch });

  test("on by default: a lone word is looked up and shows the card", async () => {
    const w = world();
    const slot = makeSlot();
    expect(slot.triggerOnBareWord).toBe(true);
    expect(slot.trigger("florbit")).toBe(true);
    const result = await slot.execute("florbit", ctx(w));
    expect(result.html).toContain("dictionary-card");
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].url).toBe("https://api.dictionaryapi.dev/api/v2/entries/en/florbit");
  });

  test("off: only the explicit forms trigger", async () => {
    const w = world();
    const slot = makeSlot({ triggerOnBareWord: "false" });
    expect(slot.triggerOnBareWord).toBe(false);
    expect(slot.trigger("florbit")).toBe(false);
    expect(await slot.execute("florbit", ctx(w))).toEqual({ title: "", html: "" });
    expect(w.calls).toHaveLength(0);
    expect(slot.trigger("define florbit")).toBe(true);
    expect(slot.trigger("florbit meaning")).toBe(true);
  });

  test("non-words never reach the upstream", async () => {
    const w = world();
    const slot = makeSlot();
    for (const query of ["google", "youtube", "12345", "a", "AAPL", "weather", "score", "x.com", "login", "two words", "usd", "msft"]) {
      expect(slot.trigger(query), query).toBe(false);
      expect(await slot.execute(query, ctx(w))).toEqual({ title: "", html: "" });
    }
    expect(w.calls).toHaveLength(0);
  });

  test("an unknown word: one request, then the 24 hour miss cache answers (no more requests)", async () => {
    const w = world();
    const time = clock();
    const slot = makeSlot({}, { time });
    expect((await slot.execute("zzzzzz", ctx(w))).html).toBe("");
    const first = w.calls.length;
    expect(first).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 3; i += 1) expect((await slot.execute("zzzzzz", ctx(w))).html).toBe("");
    expect(w.calls.length).toBe(first);
    time.state.t += 23 * 3_600_000;
    await slot.execute("zzzzzz", ctx(w));
    expect(w.calls.length).toBe(first);
    time.state.t += 2 * 3_600_000;
    await slot.execute("zzzzzz", ctx(w));
    expect(w.calls.length).toBeGreaterThan(first);
  });

  test("the lemma fallback works for a bare plural", async () => {
    const w = world();
    const slot = makeSlot();
    const result = await slot.execute("quillferns", ctx(w));
    expect(result.html).toContain("Showing the entry for");
    expect(result.html).toContain("quillfern");
  });

  test("the daily budget still caps bare lookups", async () => {
    const w = world();
    const slot = makeSlot({ dailyRequestLimit: "1" });
    await capture(async () => {
      await slot.execute("florbit", ctx(w));
      await slot.execute("quillfern", ctx(w));
    });
    expect(w.calls).toHaveLength(1);
  });

  test("debugMatching explains a lookup and a skip, and only for single tokens", async () => {
    const slot = makeSlot({ debugMatching: "true" });
    const lines = await capture(async () => {
      slot.trigger("colloquial");
      slot.trigger("google");
      slot.trigger("AAPL");
      slot.trigger("two words");
    });
    expect(lines.some((line) => line.includes('"colloquial" -> bare word: lookup'))).toBe(true);
    expect(lines.some((line) => line.includes('"google" -> bare word: skipped (a popular site or brand (stoplist))'))).toBe(true);
    expect(lines.some((line) => line.includes('"AAPL" -> bare word: skipped (all capitals'))).toBe(true);
    expect(lines.some((line) => line.includes("two words"))).toBe(false);
    for (const line of lines) expect(line).not.toMatch(/https?:/);
  });

  test("the setting is a toggle on by default", () => {
    const field = SETTINGS_SCHEMA.find((f) => f.key === "triggerOnBareWord");
    expect(field.type).toBe("toggle");
    expect(field.default).toBe("true");
    expect(field.description).toContain("Off:");
  });
});
