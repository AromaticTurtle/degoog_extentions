import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_DATA_URL = "https://raw.githubusercontent.com/selfhst/cdn/main/directory/software.json";

const HOUR_MS = 3_600_000;
const DEFAULT_BACKOFF_MS = 15 * 60_000;
const SHRINK_LIMIT = 0.5;
const MIN_ROW_LENGTH = 17;
const USER_AGENT = "degoog-selfhst-favicon/1.0 (+https://github.com/AromaticTurtle/degoog_extentions)";

export const normalizeHost = (value) => {
  const host = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes(".")) return "";
  if (/^\d+(\.\d+){3}$/.test(host)) return "";
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return "";
  return host;
};

const flat = (text) => String(text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const iconName = (row) => {
  if (row[9] !== "Icons") return "";
  const name = String(row[10] || row[2] || "");
  return /^[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : "";
};

export const buildDomainMap = (software) => {
  const candidates = new Map();
  (Array.isArray(software) ? software : []).forEach((row, order) => {
    if (!Array.isArray(row) || row.length < MIN_ROW_LENGTH) return;
    const icon = iconName(row);
    const site = String(row[3] ?? "").trim();
    if (!icon || !site) return;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`);
    } catch {
      return;
    }
    if (url.pathname.replace(/\/+$/, "") !== "") return;
    const host = normalizeHost(url.hostname);
    if (!host) return;
    const stars = Number.parseInt(String(row[13] ?? ""), 10);
    const entry = {
      icon,
      nameMatch: flat(row[1]) === flat(host.split(".")[0]),
      stars: Number.isFinite(stars) ? stars : 0,
      order,
    };
    if (!candidates.has(host)) candidates.set(host, []);
    candidates.get(host).push(entry);
  });

  const map = new Map();
  for (const [host, list] of candidates) {
    list.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.stars - a.stars || a.order - b.order);
    map.set(host, list[0].icon);
  }
  return map;
};

export const lookupIcon = (map, host, matchSubdomains = true) => {
  const clean = normalizeHost(host);
  if (!clean) return "";
  const labels = clean.split(".");
  const last = matchSubdomains ? labels.length - 1 : 1;
  for (let start = 0; start < last; start++) {
    const icon = map.get(labels.slice(start).join("."));
    if (icon) return icon;
  }
  return "";
};

export class DomainIconStore {
  constructor({ cacheDir = "", url = DEFAULT_DATA_URL, ttlMs = 168 * HOUR_MS, backoffMs = DEFAULT_BACKOFF_MS, now = Date.now } = {}) {
    this.cacheDir = cacheDir;
    this.url = url;
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
      const saved = JSON.parse(readFileSync(join(this.cacheDir, "icons.json"), "utf8"));
      if (!Array.isArray(saved.entries) || !Number.isFinite(saved.fetchedAt)) return null;
      const map = new Map(saved.entries.filter((pair) => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "string"));
      if (map.size === 0) return null;
      return { map, meta: { fetchedAt: saved.fetchedAt, etag: typeof saved.etag === "string" ? saved.etag : "" } };
    } catch {
      return null;
    }
  }

  _writeDisk(state) {
    if (!this.cacheDir) return;
    try {
      if (!existsSync(this.cacheDir)) mkdirSync(this.cacheDir, { recursive: true });
      const path = join(this.cacheDir, "icons.json");
      writeFileSync(`${path}.tmp`, JSON.stringify({ ...state.meta, entries: [...state.map] }));
      renameSync(`${path}.tmp`, path);
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
    if (this.state && now - this.state.meta.fetchedAt < this.ttlMs) return this.state.map;
    if (now < this.retryAt) return this.state ? this.state.map : null;
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
      const headers = { Accept: "application/json", "User-Agent": USER_AGENT };
      if (previous?.meta.etag) headers["If-None-Match"] = previous.meta.etag;
      const response = await doFetch(this.url, { headers });

      if (response.status === 304 && previous) {
        this.state = { map: previous.map, meta: { ...previous.meta, fetchedAt: this.now() } };
      } else {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const map = buildDomainMap(JSON.parse(await response.text()));
        if (map.size === 0) throw new Error("no usable apps");
        if (previous && map.size < previous.map.size * SHRINK_LIMIT) throw new Error("directory shrank suspiciously");
        this.state = { map, meta: { fetchedAt: this.now(), etag: response.headers?.get?.("etag") ?? "" } };
      }
      this.retryAt = 0;
      this._writeDisk(this.state);
      return this.state.map;
    } catch {
      this.retryAt = this.now() + this.backoffMs;
      return previous ? previous.map : null;
    }
  }
}
