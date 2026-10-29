import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Request budgets over fixed windows (a minute, an hour, a UTC day, a UTC month). Counts live in memory; with a file they also
// survive a restart. Nothing secret is stored: only window keys and counts.
//
//   const budget = new Budget({ file, windows: [{ name: "hour", unit: "hour", limit: 200 }, { name: "month", unit: "month", limit: 20000 }] });
//   budget.spend(only?)                             true and counts one request, or false when a window is used up
//   budget.waitMs(only?)                               milliseconds until the first used-up window rolls over (0 when none is)
//   budget.sync("month", { remaining, resetAt })    align a window with what the provider reports

const UNIT_MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

const pad = (n) => String(n).padStart(2, "0");

export const windowKey = (unit, time) => {
  const date = new Date(time);
  if (unit === "month") return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
  if (unit === "day") return date.toISOString().slice(0, 10);
  return String(Math.floor(time / UNIT_MS[unit]));
};

export const windowEnd = (unit, time) => {
  if (unit === "month") {
    const date = new Date(time);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return (Math.floor(time / UNIT_MS[unit]) + 1) * UNIT_MS[unit];
};

export const dataFile = (name, envName) => process.env[envName] || join(process.env.DEGOOG_DATA_DIR || "data", name, "usage.json");

export class Budget {
  constructor({ file = "", windows = [], now = Date.now } = {}) {
    this.file = file;
    this.windows = windows;
    this.now = now;
    this.counts = {};
    this.loaded = false;
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved && typeof saved === "object") {
        for (const [name, entry] of Object.entries(saved)) {
          if (entry && typeof entry.key === "string" && Number.isInteger(entry.used) && entry.used >= 0) this.counts[name] = { key: entry.key, used: entry.used };
        }
      }
    } catch {
      /* no saved counts */
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const folder = dirname(this.file);
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.counts));
      renameSync(temporary, this.file);
    } catch {
      this.file = "";
    }
  }

  // the current count of a window, rolled over when its period has changed
  _entry(window) {
    this._load();
    const key = windowKey(window.unit, this.now());
    const entry = this.counts[window.name];
    if (!entry || entry.key !== key) this.counts[window.name] = { key, used: 0 };
    return this.counts[window.name];
  }

  // the windows that count: the ones with a limit, and (when `only` names some) only those
  _active(only) {
    return this.windows.filter((window) => window.limit > 0 && (!only || only.includes(window.name)));
  }

  used(name) {
    const window = this.windows.find((candidate) => candidate.name === name);
    return window ? this._entry(window).used : 0;
  }

  // how long until the first used-up window rolls over; 0 when every window has room
  waitMs(only) {
    let wait = 0;
    for (const window of this._active(only)) {
      if (this._entry(window).used >= window.limit) wait = Math.max(wait, windowEnd(window.unit, this.now()) - this.now());
    }
    return wait;
  }

  get exhausted() {
    return this.waitMs() > 0;
  }

  // Reserves one request. False means a window is used up and nothing was counted.
  spend(only) {
    if (this.waitMs(only) > 0) return false;
    for (const window of this._active(only)) this._entry(window).used += 1;
    this._save();
    return true;
  }

  // The provider said how many requests are left in a window: believe it when it is stricter than the local count.
  sync(name, { remaining }) {
    const window = this.windows.find((candidate) => candidate.name === name);
    const left = Number(remaining);
    if (!window || !(window.limit > 0) || !Number.isFinite(left) || left < 0) return;
    const entry = this._entry(window);
    const reported = Math.max(0, window.limit - Math.trunc(left));
    if (reported > entry.used) {
      entry.used = reported;
      this._save();
    }
  }

  // The provider reported how many requests it has counted in this window (limit and remaining): never count less than it does
  syncUsed(name, used) {
    const window = this.windows.find((candidate) => candidate.name === name);
    const count = Number(used);
    if (!window || !(window.limit > 0) || !Number.isFinite(count) || count < 0) return;
    const entry = this._entry(window);
    if (Math.trunc(count) > entry.used) {
      entry.used = Math.trunc(count);
      this._save();
    }
  }

  // Marks a window as used up for the rest of its period (the provider refused with "limit reached")
  exhaust(name) {
    const window = this.windows.find((candidate) => candidate.name === name);
    if (!window || !(window.limit > 0)) return;
    this._entry(window).used = window.limit;
    this._save();
  }

  setLimit(name, limit) {
    const window = this.windows.find((candidate) => candidate.name === name);
    if (window) window.limit = limit;
  }
}
