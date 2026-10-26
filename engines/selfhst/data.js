import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeApps } from "./parse.js";

export const DEFAULT_DATA_BASE = "https://raw.githubusercontent.com/selfhst/cdn/main/directory";
export const FILES = ["software", "tags", "alternatives", "licenses", "languages"];

const HOUR_MS = 3_600_000;
const DEFAULT_BACKOFF_MS = 15 * 60_000;
const SHRINK_LIMIT = 0.5;
const USER_AGENT = "degoog-selfhst-engine/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";

export class DataError extends Error {
  constructor(message, status = "network") {
    super(message);
    this.name = "DataError";
    this.status = status;
  }
}

const checkList = (name, value) => {
  if (!Array.isArray(value)) throw new DataError(`selfh.st ${name}.json was not a list`, "parse_error");
  return value;
};

export class DirectoryStore {
  constructor({ cacheDir = "", baseUrl = DEFAULT_DATA_BASE, ttlMs = 24 * HOUR_MS, backoffMs = DEFAULT_BACKOFF_MS, now = Date.now } = {}) {
    this.cacheDir = cacheDir;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.ttlMs = ttlMs;
    this.backoffMs = backoffMs;
    this.now = now;
    this.state = null;
    this.loadedFromDisk = false;
    this.retryAt = 0;
    this.inflight = null;
  }

  _readDisk() {
    if (!this.cacheDir) return null;
    try {
      const meta = JSON.parse(readFileSync(join(this.cacheDir, "meta.json"), "utf8"));
      const raw = {};
      for (const name of FILES) raw[name] = checkList(name, JSON.parse(readFileSync(join(this.cacheDir, `${name}.json`), "utf8")));
      const apps = decodeApps(raw);
      if (apps.length === 0 || !Number.isFinite(meta.fetchedAt)) return null;
      return { raw, apps, meta: { fetchedAt: meta.fetchedAt, etags: meta.etags ?? {} } };
    } catch {
      return null;
    }
  }

  _writeDisk(state) {
    if (!this.cacheDir) return;
    try {
      if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
      const write = (name, value) => {
        const path = join(this.cacheDir, name);
        writeFileSync(`${path}.tmp`, JSON.stringify(value));
        renameSync(`${path}.tmp`, path);
      };
      for (const name of FILES) write(`${name}.json`, state.raw[name]);
      write("meta.json", state.meta);
    } catch {
      this.cacheDir = "";
    }
  }

  async get(doFetch) {
    if (!this.state && !this.loadedFromDisk) {
      this.loadedFromDisk = true;
      this.state = this._readDisk();
    }
    const now = this.now();
    if (this.state && now - this.state.meta.fetchedAt < this.ttlMs) return this.state.apps;
    if (now < this.retryAt) {
      if (this.state) return this.state.apps;
      throw new DataError(`selfh.st directory unavailable, trying again in ${Math.ceil((this.retryAt - now) / 60_000)} min`);
    }
    if (!this.inflight) {
      this.inflight = this._refresh(doFetch).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  async _refresh(doFetch) {
    const previous = this.state;
    try {
      const raw = {};
      const etags = {};
      let changed = !previous;
      for (const name of FILES) {
        const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
        const known = previous?.meta.etags?.[name];
        if (known && previous.raw[name]) headers["If-None-Match"] = known;
        const response = await doFetch(`${this.baseUrl}/${name}.json`, { headers });
        if (response.status === 304 && previous?.raw[name]) {
          raw[name] = previous.raw[name];
          etags[name] = known;
          continue;
        }
        if (!response.ok) {
          throw new DataError(`selfh.st ${name}.json answered HTTP ${response.status}`, response.status === 429 ? "rate_limited" : "network");
        }
        let parsed;
        try {
          parsed = JSON.parse(await response.text());
        } catch {
          throw new DataError(`selfh.st ${name}.json was not JSON`, "parse_error");
        }
        raw[name] = checkList(name, parsed);
        etags[name] = response.headers?.get?.("etag") ?? "";
        changed = true;
      }
      if (previous && raw.software.length < previous.raw.software.length * SHRINK_LIMIT) {
        throw new DataError("selfh.st directory shrank suspiciously, keeping the previous copy", "parse_error");
      }
      const apps = changed ? decodeApps(raw) : previous.apps;
      if (apps.length === 0) throw new DataError("selfh.st directory had no usable apps", "parse_error");
      this.state = { raw, apps, meta: { fetchedAt: this.now(), etags } };
      this.retryAt = 0;
      this._writeDisk(this.state);
      return apps;
    } catch (error) {
      this.retryAt = this.now() + this.backoffMs;
      if (previous) return previous.apps;
      if (error?.name === "SentinelBreach" || error instanceof DataError) throw error;
      throw new DataError(`selfh.st directory could not be downloaded: ${error?.message ?? error}`);
    }
  }
}
