import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const usageFile = (dataDir) => join(dataDir, "rawg", "usage.json");

const monthOf = (timestamp) => new Date(timestamp).toISOString().slice(0, 7);

// Counts RAWG requests per calendar month (UTC) and keeps the count on disk, so a restart does not reset it.
export class Budget {
  constructor({ file = "", cap = 15_000, now = Date.now } = {}) {
    this.file = file;
    this.cap = cap;
    this.now = now;
    this.month = monthOf(now());
    this.used = 0;
    this.loaded = false;
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.month === this.month && Number.isInteger(saved.used) && saved.used >= 0) this.used = saved.used;
    } catch {
      /* no saved count */
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const folder = dirname(this.file);
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ month: this.month, used: this.used }));
      renameSync(temporary, this.file);
    } catch {
      this.file = "";
    }
  }

  _rollMonth() {
    const month = monthOf(this.now());
    if (month === this.month) return;
    this.month = month;
    this.used = 0;
    this.loaded = true;
    this._save();
  }

  get exhausted() {
    this._load();
    this._rollMonth();
    return this.cap > 0 && this.used >= this.cap;
  }

  // Reserves one request. False means the limit is reached and the request must not be made.
  spend() {
    if (this.exhausted) return false;
    this.used += 1;
    this._save();
    return true;
  }
}
