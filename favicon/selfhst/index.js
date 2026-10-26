import { join } from "node:path";
import { DEFAULT_DATA_URL, DomainIconStore, lookupIcon } from "./directory.js";

export const DEFAULT_ICON_BASE = "https://cdn.jsdelivr.net/gh/selfhst/icons@main/webp";

const HOUR_MS = 3_600_000;

export const SETTINGS_SCHEMA = [
  {
    key: "iconBaseUrl",
    label: "Icon base URL",
    type: "url",
    default: DEFAULT_ICON_BASE,
    placeholder: DEFAULT_ICON_BASE,
    description:
      "Where the WebP icons are served from. The default is jsDelivr, which selfh.st recommends. A self-hosted mirror must be reachable on a public address, because degoog refuses private addresses for icon URLs.",
  },
  {
    key: "matchSubdomains",
    label: "Also match subdomains",
    type: "toggle",
    default: "true",
    description: "Give docs.n8n.io the same icon as n8n.io.",
  },
  {
    key: "refreshHours",
    label: "Refresh the app list every (hours)",
    type: "number",
    default: "168",
    placeholder: "168",
    description:
      "24 to 2160. The app directory (about 350 KB) is downloaded once and kept on disk. Refreshes ask only whether it changed.",
  },
];

const cacheDir =
  process.env.DEGOOG_SELFHST_FAVICON_CACHE_DIR || join(process.env.DEGOOG_DATA_DIR || "data", "selfhst-icons");

const sharedStore = new DomainIconStore({
  cacheDir,
  url: process.env.DEGOOG_SELFHST_FAVICON_DATA_URL || DEFAULT_DATA_URL,
});

export const cleanBaseUrl = (value) => {
  try {
    const url = new URL(String(value ?? "").trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_ICON_BASE;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_ICON_BASE;
  }
};

const clampHours = (value) => {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.min(2160, Math.max(24, n)) : 168;
};

export default class SelfhstFaviconProvider {
  name = "selfh.st icons";
  description = "Icons for self-hosted apps from selfh.st/icons. Hosts it does not know are passed to the next provider.";
  settingsSchema = SETTINGS_SCHEMA;

  store = sharedStore;
  iconBaseUrl = DEFAULT_ICON_BASE;
  matchSubdomains = true;

  configure(settings) {
    this.iconBaseUrl = cleanBaseUrl(settings.iconBaseUrl || DEFAULT_ICON_BASE);
    this.matchSubdomains = settings.matchSubdomains !== false && settings.matchSubdomains !== "false";
    this.store.ttlMs = clampHours(settings.refreshHours) * HOUR_MS;
  }

  async getFavicon(host, context) {
    try {
      const map = await this.store.get(context?.fetch ?? fetch);
      if (!map) return null;
      const icon = lookupIcon(map, host, this.matchSubdomains);
      return icon ? { url: `${this.iconBaseUrl}/${encodeURIComponent(icon)}.webp` } : null;
    } catch {
      return null;
    }
  }
}
