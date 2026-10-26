import { join } from "node:path";
import { SETTINGS_SCHEMA } from "./settings.js";
import { DEFAULT_DATA_BASE, DirectoryStore } from "./data.js";
import { toResult } from "./parse.js";
import { searchApps } from "./search.js";
import { clampInt } from "./text.js";

export const type = "apps";

const HOUR_MS = 3_600_000;

const cacheDir =
  process.env.DEGOOG_SELFHST_CACHE_DIR || join(process.env.DEGOOG_DATA_DIR || "data", "selfhst");

const sharedStore = new DirectoryStore({
  cacheDir,
  baseUrl: process.env.DEGOOG_SELFHST_DATA_BASE || DEFAULT_DATA_BASE,
});

const truthy = (value) => value === true || value === "true";

export default class SelfhstEngine {
  isClientExposed = false;
  name = "selfh.st";
  bangShortcut = "selfhst";
  settingsSchema = SETTINGS_SCHEMA;

  store = sharedStore;
  perPage = 20;
  activeOnly = false;
  openSourceOnly = false;

  configure(settings) {
    this.store.ttlMs = clampInt(settings.refreshHours, 6, 720, 24) * HOUR_MS;
    this.perPage = clampInt(settings.perPage, 5, 50, 20);
    this.activeOnly = truthy(settings.activeOnly);
    this.openSourceOnly = truthy(settings.openSourceOnly);
  }

  _error(context, status, message) {
    return context?.engineError
      ? context.engineError(status, message, { engine: this.name })
      : new Error(message);
  }

  async executeSearch(query, page = 1, _timeFilter, context) {
    const text = String(query ?? "").trim();
    if (!text) return [];

    let apps;
    try {
      apps = await this.store.get(context?.fetch ?? fetch);
    } catch (error) {
      if (error?.name === "SentinelBreach") throw error;
      throw this._error(context, error?.status ?? "network", error?.message ?? "selfh.st directory unavailable");
    }

    const matches = searchApps(apps, text, { activeOnly: this.activeOnly, openSourceOnly: this.openSourceOnly });
    const start = (Math.max(1, page || 1) - 1) * this.perPage;
    return matches.slice(start, start + this.perPage).map((app) => toResult(app, this.name));
  }
}
