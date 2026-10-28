import { SETTINGS_SCHEMA } from "./settings.js";
import { DEFAULT_OPTIONS, commandQuery, optionsFrom, rewriteQuery } from "./rewrite.js";

// Reddit lens: a query that clearly wants Reddit gets "site:reddit.com" added, so the user's ordinary web engines return Reddit
// pages with their own titles, snippets and dates. Nothing is fetched from Reddit by this plugin.
//
// The interceptor, the notice and the !reddit command share these options (one module), set from the plugin's settings.
let options = { ...DEFAULT_OPTIONS };

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// A string for inside a <script>: JSON that cannot close the tag or start a comment.
const jsString = (value) => JSON.stringify(String(value ?? "")).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

// One settings entry for the interceptor and the notice (degoog's "Reddit lens" plugin).
export const plugin = {
  id: "reddit-lens",
  name: "Reddit lens",
  description: "Rewrites queries like 'best homelab os reddit' to 'best homelab os site:reddit.com' so your web engines return Reddit pages.",
};

export const interceptor = {
  isClientExposed: false,
  name: "Reddit lens",
  description: plugin.description,
  settingsSchema: SETTINGS_SCHEMA,

  configure(settings) {
    options = optionsFrom(settings);
  },

  async intercept(query) {
    try {
      return { query: rewriteQuery(query, options).query };
    } catch {
      return { query };
    }
  },
};

let template = "";

export const slot = {
  isClientExposed: false,
  name: "Reddit lens",
  description: "Says when a query was rewritten to search Reddit pages.",
  position: "at-a-glance",

  init(context) {
    template = context?.template ?? "";
  },

  trigger(query) {
    return options.showNotice && rewriteQuery(query, options).changed;
  },

  async execute(query) {
    const result = rewriteQuery(query, options);
    if (!result.changed || !template) return { html: "" };
    return { html: template.replace(/\{\{rewritten\}\}/g, () => esc(result.query)) };
  },
};

// The web page sends "!bang" queries to degoog's command handler, never to interceptors, so this is what answers !reddit and
// !rl there: it jumps to an ordinary search for the rewritten query (which the lens then leaves alone, it has site: in it).
export const command = {
  isClientExposed: false,
  name: "Reddit lens",
  description: "!reddit best homelab os: search the web engines for Reddit pages (site:reddit.com).",
  trigger: "reddit",
  aliases: ["rl"],
  settingsSchema: [],

  configure() {},

  async execute(args) {
    if (!options.enableBang) return { title: "Reddit lens", html: '<div class="reddit-lens-redirect">The !reddit bang is turned off in the Reddit lens settings.</div>' };
    const query = commandQuery(args, options);
    if (!query) return { title: "Reddit lens", html: '<div class="reddit-lens-redirect">Type what to look for: <code>!reddit best homelab os</code></div>' };
    const link = `search?q=${encodeURIComponent(query)}`;
    return {
      title: "Reddit lens",
      searchType: "web",
      html: `<div class="reddit-lens-redirect">Searching the web for Reddit pages: <a href="${esc(link)}">${esc(query)}</a></div><script>(function(){var u=new URL("search",location.href);u.searchParams.set("q",${jsString(query)});location.replace(u.toString());})();</script>`,
    };
  },
};

// No default export on purpose: degoog's command loader prefers a module's default export over a named `command`.
