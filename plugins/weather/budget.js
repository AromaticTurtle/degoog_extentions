import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const usageFile = (dataDir) => process.env.DEGOOG_WEATHER_USAGE_FILE || join(dataDir, "weather", "usage.json");

const DAY_MS = 86_400_000;
const dayOf = (timestamp) => new Date(timestamp).toISOString().slice(0, 10);

// Counts the requests to a service per UTC day and keeps the count on disk, so a restart does not reset it.
export class Budget {
  constructor({ file = "", cap = 5000, now = Date.now } = {}) {
    this.file = file;
    this.cap = cap;
    this.now = now;
    this.day = dayOf(now());
    this.used = 0;
    this.loaded = false;
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.day === this.day && Number.isInteger(saved.used) && saved.used >= 0) this.used = saved.used;
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
      writeFileSync(temporary, JSON.stringify({ day: this.day, used: this.used }));
      renameSync(temporary, this.file);
    } catch {
      this.file = "";
    }
  }

  _rollDay() {
    const day = dayOf(this.now());
    if (day === this.day) return;
    this.day = day;
    this.used = 0;
    this.loaded = true;
    this._save();
  }

  get exhausted() {
    this._load();
    this._rollDay();
    return this.cap > 0 && this.used >= this.cap;
  }

  // Milliseconds until the next UTC midnight, when the count starts again.
  get msUntilReset() {
    const now = this.now();
    return DAY_MS - (now % DAY_MS);
  }

  // Reserves one request. False means the limit is reached and the request must not be made.
  spend() {
    if (this.exhausted) return false;
    this.used += 1;
    this._save();
    return true;
  }
}
