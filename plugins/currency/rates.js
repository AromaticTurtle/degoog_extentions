import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Budget, ratesFile, usageFile } from "./budget.js";
import { Upstream } from "./upstream.js";

export const DEFAULT_ER_BASE = "https://open.er-api.com";
export const RATES_TTL_MS = 6 * 60 * 60_000;
export const STALE_MAX_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_DAILY_LIMIT = 24;
const ER_RATE_PAUSE_MS = 20 * 60_000; // open.er-api.com blocks a client that gets a 429 for 20 minutes
const ER_RATE_MAX_MS = 60 * 60_000;

// open.er-api.com answers { result: "success", time_last_update_unix, time_next_update_unix, base_code, rates: { EUR: 0.9, ... } }
export const parseFiat = (text) => {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (!json || json.result !== "success" || !json.rates || typeof json.rates !== "object") return null;
  const rates = {};
  for (const [code, value] of Object.entries(json.rates)) {
    if (/^[A-Z]{3}$/.test(code) && typeof value === "number" && Number.isFinite(value) && value > 0) rates[code] = value;
  }
  if (!rates.USD) rates.USD = 1;
  if (Object.keys(rates).length < 10) return null;
  const seconds = (value) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) * 1000 : 0);
  return { rates, updated: seconds(json.time_last_update_unix), next: seconds(json.time_next_update_unix) };
};

const valid = (data) => Boolean(data && typeof data === "object" && data.rates && typeof data.rates === "object" && Number.isFinite(data.fetchedAt) && data.rates.USD === 1);

// All fiat rates come from ONE request (the USD base); every cross rate is computed locally. The rates are kept in memory,
// in degoog's cache and in data/currency/rates.json, so a restart does not fetch again. A refresh happens only when the data
// is older than 6 hours AND the provider's next update time has passed; on a failure data up to 7 days old is still used.
export class FiatRates {
  constructor(host) {
    this.host = host;
    this.base = process.env.DEGOOG_CURRENCY_ER_BASE || DEFAULT_ER_BASE;
    this.file = ratesFile(process.env.DEGOOG_DATA_DIR || "data");
    this.budget = new Budget({ file: usageFile(process.env.DEGOOG_DATA_DIR || "data"), cap: DEFAULT_DAILY_LIMIT, now: () => host.now() });
    this.upstream = new Upstream({
      host,
      label: "the exchange rate service",
      spacingMs: 1000,
      budgetOf: () => this.budget,
      rateDefaultMs: ER_RATE_PAUSE_MS,
      rateMaxMs: ER_RATE_MAX_MS,
      rejectedMessage: "the exchange rate service refused the request",
    });
    this.memory = null;
    this.diskRead = false;
  }

  _readDisk() {
    if (this.diskRead) return;
    this.diskRead = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (valid(saved) && !this.memory) this.memory = saved;
    } catch {
      /* no saved rates */
    }
  }

  _writeDisk(data) {
    if (!this.file) return;
    try {
      const folder = dirname(this.file);
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(data));
      renameSync(temporary, this.file);
    } catch {
      this.file = "";
    }
  }

  _fresh(data) {
    const now = this.host.now();
    const age = now - data.fetchedAt;
    if (age >= STALE_MAX_MS) return false;
    return age < RATES_TTL_MS || (data.next > 0 && now < data.next);
  }

  // -> { rates, updated, next, fetchedAt, stale } or null when there are no usable rates at all
  async get({ context, deadline }) {
    const cache = this.host._cache(context, "fiat", RATES_TTL_MS);
    this._readDisk();
    let last = this.memory;
    if (!last) {
      const cached = await cache.get("usd");
      if (valid(cached)) last = cached;
    }
    if (last && this._fresh(last)) {
      this.memory = last;
      return { ...last, stale: false };
    }
    const fetched = await this.host._once("fiat", "usd", async () => {
      const result = await this.upstream.request(`${this.base}/v6/latest/USD`, { context, deadline, maxChars: 200_000, headers: this.host.headers() });
      if (!result.ok) return null;
      const parsed = parseFiat(result.text);
      if (!parsed) {
        this.upstream.pause(60_000, "the exchange rate service sent an unreadable reply");
        return null;
      }
      const data = { ...parsed, fetchedAt: this.host.now() };
      this.memory = data;
      await cache.set("usd", data, RATES_TTL_MS);
      this._writeDisk(data);
      return data;
    });
    if (fetched) return { ...fetched, stale: false };
    const fallback = this.memory ?? last;
    if (fallback && this.host.now() - fallback.fetchedAt < STALE_MAX_MS) return { ...fallback, stale: true };
    return null;
  }
}
