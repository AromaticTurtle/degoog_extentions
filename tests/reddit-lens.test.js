// Tests for the Reddit lens plugin (interceptor, notice slot and !reddit command).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULT_OPTIONS, MAX_QUERY_CHARS, MAX_TRIGGER_WORDS, POSITIONS, commandQuery, optionsFrom, parseWords, rewriteQuery } from "../plugins/reddit-lens/rewrite.js";
import { SETTINGS_SCHEMA } from "../plugins/reddit-lens/settings.js";
import * as lens from "../plugins/reddit-lens/index.js";

const q = (query, options) => rewriteQuery(query, options).query;
const changed = (query, options) => rewriteQuery(query, options).changed;

afterEach(() => lens.interceptor.configure({}));

describe("rewriting the query", () => {
  // input -> expected query ("=" means unchanged)
  const TABLE = [
    // the cases of the brief
    ["best homelab os reddit", "best homelab os site:reddit.com"],
    ["reddit best homelab os", "best homelab os site:reddit.com"],
    ["!reddit best homelab os", "best homelab os site:reddit.com"],
    ["!rl best homelab os", "best homelab os site:reddit.com"],
    ["r/homelab best os", "best os site:reddit.com/r/homelab"],
    ["what is reddit", "="],
    ["reddit", "="],
    // case, spacing, punctuation
    ["Best OS REDDIT", "Best OS site:reddit.com"],
    ["  best   os   reddit  ", "best os site:reddit.com"],
    ["REDDIT best os", "best os site:reddit.com"],
    ["!REDDIT best os", "best os site:reddit.com"],
    ["!Rl best os", "best os site:reddit.com"],
    ["best os /r/homelab", "best os site:reddit.com/r/homelab"],
    ["best os r/homelab", "best os site:reddit.com/r/homelab"],
    ["best os r/HomeLab", "best os site:reddit.com/r/HomeLab"],
    ["r/homelab/ best os", "best os site:reddit.com/r/homelab"],
    ["best os r/homelab reddit", "best os site:reddit.com/r/homelab"],
    ["reddit r/homelab nas", "nas site:reddit.com/r/homelab"],
    ["!reddit r/homelab nas", "nas site:reddit.com/r/homelab"],
    ["best os for a small home server reddit", "best os for a small home server site:reddit.com"],
    ["reddit best os reddit", "best os site:reddit.com"],
    // never
    ["reddit reddit", "="],
    ["the reddit", "="],
    ["!reddit", "="],
    ["!rl", "="],
    ["r/homelab", "="],
    ["reddit r/homelab", "="],
    ["my reddit account", "="],
    ["is reddit down", "="],
    ["reddit's api pricing", "="],
    ["redditor best os", "="],
    ["best os subreddit", "="],
    ["best os reddit.com", "="],
    ["https://www.reddit.com/r/homelab", "="],
    ["www.reddit.com best os", "="],
    ["reddit.com", "="],
    ['"best os reddit"', "="],
    ['"best os" "reddit"', "="],
    ["'best os reddit'", "="],
    ["best os site:reddit.com reddit", "="],
    ["best os reddit site:example.com", "="],
    ["best os reddit -site:example.com", "="],
    ["reddit inurl:homelab best os", "="],
    ["site:reddit.com best os", "="],
    ["who owns reddit", "="],
    ["how do I use reddit", "="],
    ["what's reddit", "="],
    ["why is reddit down", "="],
    ["", "="],
    ["   ", "="],
    ["a", "="],
  ];
  test.each(TABLE)("%p", (input, expected) => {
    expect(q(input)).toBe(expected === "=" ? input : expected);
    expect(changed(input)).toBe(expected !== "=");
  });

  test("longer questions with a trailing word still get the lens, a leading word always does", () => {
    expect(q("how to set up a tiny home server with proxmox reddit")).toBe("how to set up a tiny home server with proxmox site:reddit.com");
    expect(q("reddit how do I use proxmox")).toBe("how do I use proxmox site:reddit.com");
    expect(q("reddit what is proxmox")).toBe("what is proxmox site:reddit.com");
    expect(q("how do I use reddit", { skipQuestions: false })).toBe("how do I use site:reddit.com");
    expect(q("what is reddit", { skipQuestions: false })).toBe("what is reddit"); // only stop words are left either way
  });

  test("the position setting", () => {
    expect(q("best os reddit", { position: "first" })).toBe("best os reddit");
    expect(q("reddit best os", { position: "first" })).toBe("best os site:reddit.com");
    expect(q("reddit best os", { position: "last" })).toBe("reddit best os");
    expect(q("best os reddit", { position: "last" })).toBe("best os site:reddit.com");
    expect(q("reddit best os", { position: "either" })).toBe("best os site:reddit.com");
  });

  test("trigger words from the settings", () => {
    expect(q("best os subreddit", { triggerWords: ["reddit", "subreddit"] })).toBe("best os site:reddit.com");
    expect(q("best os reddit", { triggerWords: ["subreddit"] })).toBe("best os reddit");
  });

  test("the bang and the subreddit form can be turned off", () => {
    expect(q("!reddit best os", { enableBang: false })).toBe("!reddit best os");
    expect(q("r/homelab best os", { alsoTrigger: false })).toBe("r/homelab best os");
    expect(q("best os reddit", { alsoTrigger: false })).toBe("best os site:reddit.com");
    expect(q("best os r/homelab reddit", { alsoTrigger: false })).toBe("best os r/homelab site:reddit.com");
    expect(q("!reddit r/homelab nas", { alsoTrigger: false })).toBe("r/homelab nas site:reddit.com");
  });

  test("the result describes how it was triggered", () => {
    expect(rewriteQuery("best os reddit")).toEqual({ query: "best os site:reddit.com", changed: true, via: "word", subreddit: "" });
    expect(rewriteQuery("!rl best os")).toMatchObject({ via: "bang" });
    expect(rewriteQuery("r/homelab best os")).toEqual({ query: "best os site:reddit.com/r/homelab", changed: true, via: "subreddit", subreddit: "homelab" });
    expect(rewriteQuery("hello")).toEqual({ query: "hello", changed: false, via: "", subreddit: "" });
  });

  test("an unchanged query is returned exactly as it came, spacing included", () => {
    for (const input of ["  plain   query  ", "my reddit account", "site:reddit.com best"]) expect(rewriteQuery(input).query).toBe(input);
  });

  test("odd input never throws", () => {
    for (const input of [undefined, null, 5, {}, [], "x".repeat(10_000), "reddit " + "x ".repeat(500), "\u0000reddit", "reddit\nbest\tos", "reddit ".repeat(50)]) {
      const result = rewriteQuery(input);
      expect(typeof result.query).toBe("string");
      expect(typeof result.changed).toBe("boolean");
    }
    expect(rewriteQuery("reddit " + "x".repeat(MAX_QUERY_CHARS)).changed).toBe(false);
    expect(q("reddit best\nos\tnow")).toBe("best os now site:reddit.com");
  });

  test("the lens adds exactly one filter and never doubles it", () => {
    const once = q("best os reddit");
    expect(q(once)).toBe(once);
    expect(once.match(/site:/g)).toHaveLength(1);
  });

  test("a subreddit needs a plausible name", () => {
    for (const bad of ["r/a best os", "r/ best os", "r/has-dash best os", "best os r/" + "x".repeat(40)]) expect(changed(bad)).toBe(false);
  });
});

describe("options", () => {
  test("words: letters and digits, lowercase, at most five, the default when empty", () => {
    expect(parseWords("Reddit, SubReddit ; r3ddit")).toEqual(["reddit", "subreddit", "r3ddit"]);
    expect(parseWords("")).toEqual(["reddit"]);
    expect(parseWords(undefined)).toEqual(["reddit"]);
    expect(parseWords("!!! ,, x")).toEqual(["reddit"]);
    expect(parseWords("site:reddit, a b-c")).toEqual(["reddit"]);
    expect(parseWords("w1 w2 w3 w4 w5 w6 w7")).toHaveLength(MAX_TRIGGER_WORDS);
    expect(parseWords("reddit reddit REDDIT")).toEqual(["reddit"]);
  });

  test("settings as strings or booleans, defaults, junk", () => {
    expect(optionsFrom({})).toEqual({ ...DEFAULT_OPTIONS });
    expect(optionsFrom(undefined)).toEqual({ ...DEFAULT_OPTIONS });
    const off = optionsFrom({ enableBang: "false", alsoTrigger: false, skipQuestions: "false", showNotice: "false", position: "last", triggerWords: "reddit, subreddit" });
    expect(off).toEqual({ triggerWords: ["reddit", "subreddit"], position: "last", enableBang: false, alsoTrigger: false, skipQuestions: false, showNotice: false });
    expect(optionsFrom({ position: "middle" }).position).toBe("either");
    expect(optionsFrom({ enableBang: "banana" }).enableBang).toBe(false);
    expect(optionsFrom({ enableBang: "" }).enableBang).toBe(true);
    expect(POSITIONS).toEqual(["first", "last", "either"]);
  });

  test("the schema: every key has a label and a description, nothing is required, defaults match", () => {
    expect(SETTINGS_SCHEMA.map((field) => field.key)).toEqual(["triggerWords", "position", "enableBang", "alsoTrigger", "skipQuestions", "showNotice"]);
    for (const field of SETTINGS_SCHEMA) {
      expect(field.label).toBeTruthy();
      expect(field.description).toBeTruthy();
      expect(field.required).toBeUndefined();
      expect(field.fieldset).toBeTruthy();
    }
    const field = (key) => SETTINGS_SCHEMA.find((entry) => entry.key === key);
    expect(field("triggerWords")).toMatchObject({ type: "text", default: "reddit" });
    expect(field("position")).toMatchObject({ type: "select", default: "either", options: ["either", "first", "last"] });
    expect(field("position").optionLabels).toHaveLength(3);
    expect(field("enableBang")).toMatchObject({ type: "toggle", default: "true" });
    expect(field("alsoTrigger")).toMatchObject({ type: "toggle", default: "true" });
    expect(field("alsoTrigger").label).toBe("Append site:reddit.com when the query names a subreddit like r/homelab");
    expect(optionsFrom(Object.fromEntries(SETTINGS_SCHEMA.map((entry) => [entry.key, entry.default])))).toEqual({ ...DEFAULT_OPTIONS });
  });
});

describe("the interceptor", () => {
  test("it answers {query} like degoog expects, with the rewritten text", async () => {
    expect(await lens.interceptor.intercept("best homelab os reddit")).toEqual({ query: "best homelab os site:reddit.com" });
    expect(await lens.interceptor.intercept("reddit best homelab os", { lang: "en" })).toEqual({ query: "best homelab os site:reddit.com" });
    expect(await lens.interceptor.intercept("!reddit best homelab os")).toEqual({ query: "best homelab os site:reddit.com" });
    expect(await lens.interceptor.intercept("!rl best homelab os")).toEqual({ query: "best homelab os site:reddit.com" });
    expect(await lens.interceptor.intercept("r/homelab best os")).toEqual({ query: "best os site:reddit.com/r/homelab" });
    for (const same of ["what is reddit", "reddit", "plain words", "best os site:reddit.com"]) expect(await lens.interceptor.intercept(same)).toEqual({ query: same });
    expect(Object.keys(await lens.interceptor.intercept("best os reddit"))).toEqual(["query"]); // no overrides: the tab and the language stay
  });

  test("configure applies the settings, including strings from the settings page", async () => {
    lens.interceptor.configure({ position: "first", enableBang: "false", triggerWords: "reddit, subreddit" });
    expect(await lens.interceptor.intercept("best os reddit")).toEqual({ query: "best os reddit" });
    expect(await lens.interceptor.intercept("subreddit best os")).toEqual({ query: "best os site:reddit.com" });
    expect(await lens.interceptor.intercept("!reddit best os")).toEqual({ query: "!reddit best os" });
    lens.interceptor.configure({});
    expect(await lens.interceptor.intercept("best os reddit")).toEqual({ query: "best os site:reddit.com" });
  });

  test("it never throws and never returns a non-string query", async () => {
    for (const input of [undefined, null, 5, {}, "x".repeat(5000)]) {
      const result = await lens.interceptor.intercept(input);
      expect(Object.keys(result)).toEqual(["query"]);
    }
  });

  test("it makes no request: there is no fetch in the interceptor at all", async () => {
    const calls = [];
    await lens.interceptor.intercept("best os reddit", { fetch: (...args) => calls.push(args) });
    expect(calls).toHaveLength(0);
    expect(readFileSync(new URL("../plugins/reddit-lens/index.js", import.meta.url), "utf8")).not.toMatch(/\bfetch\s*\(/);
  });
});

describe("the notice slot", () => {
  const TEMPLATE = '<div class="n">Showing <strong>{{rewritten}}</strong></div>';

  test("it shows only for a rewritten query, with the rewritten text escaped", async () => {
    lens.slot.init({ template: TEMPLATE });
    expect(lens.slot.trigger("best os reddit")).toBe(true);
    expect(lens.slot.trigger("reddit")).toBe(false);
    expect(lens.slot.trigger("plain query")).toBe(false);
    expect(lens.slot.trigger("what is reddit")).toBe(false);
    const out = await lens.slot.execute("best homelab os reddit");
    expect(out.html).toBe('<div class="n">Showing <strong>best homelab os site:reddit.com</strong></div>');
    const hostile = await lens.slot.execute('<img src=x onerror=alert(1)> "q" reddit');
    expect(hostile.html).not.toContain("<img");
    expect(hostile.html).toContain("&lt;img");
    expect((await lens.slot.execute("plain query")).html).toBe("");
  });

  test("showNotice off, a different position and no template", async () => {
    lens.slot.init({ template: TEMPLATE });
    lens.interceptor.configure({ showNotice: "false" });
    expect(lens.slot.trigger("best os reddit")).toBe(false);
    lens.interceptor.configure({});
    lens.slot.init({});
    expect((await lens.slot.execute("best os reddit")).html).toBe("");
    lens.slot.init({ template: TEMPLATE });
    expect(lens.slot.position).toBe("at-a-glance");
  });

  test("the packaged template has the placeholder and nothing that needs a script", () => {
    const html = readFileSync(new URL("../plugins/reddit-lens/template.html", import.meta.url), "utf8");
    expect(html).toContain("{{rewritten}}");
    expect(html).not.toContain("<script");
  });
});

describe("the !reddit command", () => {
  test("it jumps to an ordinary search for the rewritten query", async () => {
    const out = await lens.command.execute("best homelab os");
    expect(out.html).toContain('href="search?q=best%20homelab%20os%20site%3Areddit.com"');
    expect(out.html).toContain('u.searchParams.set("q","best homelab os site:reddit.com")');
    expect(out.html).toContain("location.replace");
    expect(out.searchType).toBe("web");
    const sub = await lens.command.execute("r/homelab nas");
    expect(sub.html).toContain('"nas site:reddit.com/r/homelab"');
  });

  test("the rewritten query already has site:, so the interceptor leaves it alone after the jump", async () => {
    const out = await lens.command.execute("best homelab os");
    const target = /set\("q","([^"]*)"\)/.exec(out.html)[1];
    expect(await lens.interceptor.intercept(target)).toEqual({ query: target });
  });

  test("what the user typed cannot break out of the page or the script", async () => {
    const out = await lens.command.execute('x"</script><img src=x onerror=alert(1)>\u2028 & more');
    expect(out.html.match(/<script>/g)).toHaveLength(1);
    expect(out.html.match(/<\/script>/g)).toHaveLength(1);
    const script = /<script>([\s\S]*)<\/script>/.exec(out.html)[1];
    expect(script).not.toContain("</");
    expect(script).not.toContain("<img");
    expect(out.html.replace(/<script>[\s\S]*<\/script>/, "")).not.toContain("<img");
    expect(out.html).not.toContain("\u2028");
    expect(() => new Function(script)).not.toThrow();
  });

  test("no query, too long a query, a query with site: already, the bang turned off", async () => {
    expect((await lens.command.execute("")).html).toContain("Type what to look for");
    expect((await lens.command.execute(undefined)).html).toContain("Type what to look for");
    expect((await lens.command.execute("x ".repeat(400))).html).toContain("Type what to look for");
    expect((await lens.command.execute("best os site:example.com")).html).toContain('"best os site:example.com"');
    lens.interceptor.configure({ enableBang: "false" });
    expect((await lens.command.execute("best os")).html).toContain("turned off");
    expect((await lens.command.execute("best os")).html).not.toContain("<script");
  });

  test("the pure helper", () => {
    expect(commandQuery("best homelab os")).toBe("best homelab os site:reddit.com");
    expect(commandQuery("  best   os ")).toBe("best os site:reddit.com");
    expect(commandQuery("nas r/homelab")).toBe("nas site:reddit.com/r/homelab");
    expect(commandQuery("r/homelab")).toBe("r/homelab site:reddit.com");
    expect(commandQuery("")).toBe("");
    expect(commandQuery("x", { alsoTrigger: false })).toBe("x site:reddit.com");
  });
});

describe("the module matches degoog's loaders", () => {
  // the checks degoog's registries make (read from degoog's source), applied to this module
  const isInterceptor = (v) => typeof v === "object" && v !== null && typeof v.name === "string" && typeof v.intercept === "function";
  const isSlotPlugin = (v) => typeof v === "object" && v !== null && typeof v.name === "string" && ["knowledge-panel", "at-a-glance", "above-sidebar", "below-sidebar", "above-results"].includes(v.position) && typeof v.trigger === "function" && typeof v.execute === "function";
  const isBangCommand = (v) => typeof v === "object" && v !== null && typeof v.name === "string" && typeof v.trigger === "string" && typeof v.execute === "function";
  const isPluginManifest = (v) => typeof v === "object" && v !== null && typeof v.id === "string" && v.id.length > 0 && typeof v.name === "string";

  test("named exports for the manifest, the interceptor, the slot and the command", () => {
    expect(isPluginManifest(lens.plugin)).toBe(true);
    expect(lens.plugin.id).toBe("reddit-lens");
    expect(isInterceptor(lens.interceptor)).toBe(true);
    expect(isSlotPlugin(lens.slot)).toBe(true);
    expect(isBangCommand(lens.command)).toBe(true);
    expect(lens.command.trigger).toBe("reddit");
    expect(lens.command.aliases).toEqual(["rl"]);
  });

  test("there is no default export: degoog's command loader would take it instead of the named command", () => {
    expect(lens.default).toBeUndefined();
    expect(Object.keys(lens).sort()).toEqual(["command", "interceptor", "plugin", "slot"]);
  });

  test("the settings live on the interceptor, which degoog configures when it loads", () => {
    expect(lens.interceptor.settingsSchema).toBe(SETTINGS_SCHEMA);
    expect(lens.interceptor.settingsSchema.length).toBeGreaterThan(0);
    expect(typeof lens.interceptor.configure).toBe("function");
    expect(lens.slot.settingsSchema).toBeUndefined(); // otherwise degoog would list every setting twice
    expect(lens.plugin.settingsSchema).toBeUndefined();
  });

  test("the plugin folder is self-contained: no import leaves it", () => {
    const folder = new URL("../plugins/reddit-lens/", import.meta.url);
    for (const file of readdirSync(folder).filter((name) => name.endsWith(".js"))) {
      const source = readFileSync(new URL(file, folder), "utf8");
      for (const match of source.matchAll(/from\s+"([^"]+)"/g)) expect(match[1].startsWith("./")).toBe(true);
    }
    for (const file of ["index.js", "rewrite.js", "settings.js", "template.html", "style.css", "author.json", "README.md"]) {
      expect(() => readFileSync(new URL(file, folder), "utf8")).not.toThrow();
    }
  });
});
