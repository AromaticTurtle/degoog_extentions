import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const cacheFile = (dataDir) => process.env.DEGOOG_STOCKS_CACHE_FILE || join(dataDir, "stocks", "cache.json");

const MAX_ENTRIES = 3000;

// A tiny key -> value store with expiry that survives restarts (data/stocks/cache.json, written atomically). It holds what must not
// be asked of Finnhub twice: "this symbol does not exist" (24 h), "company name -> symbol" (30 days) and "candles are not on this
// plan" (a day). An empty `file` keeps everything in memory only (tests).
export class Store {
  constructor({ file = "", now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.map = new Map(); // key -> { value, expiresAt }
    this.loaded = false;
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      for (const [key, entry] of Object.entries(saved?.entries ?? {})) {
        if (entry && typeof entry === "object" && Number.isFinite(entry.expiresAt) && entry.expiresAt > this.now()) this.map.set(key, { value: entry.value, expiresAt: entry.expiresAt });
      }
    } catch {
      /* nothing saved, or unreadable: start empty */
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const folder = dirname(this.file);
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ entries: Object.fromEntries(this.map) }));
      renameSync(temporary, this.file);
    } catch {
      this.file = "";
    }
  }

  // The stored value, or undefined when missing or expired
  get(key) {
    this._load();
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  set(key, value, ttlMs) {
    this._load();
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.map.size > MAX_ENTRIES) {
      const now = this.now();
      for (const [k, entry] of this.map) if (entry.expiresAt <= now) this.map.delete(k);
      while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
    }
    this._save();
  }
}
