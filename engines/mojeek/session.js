import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildSolutionBody, readChallenge, solveChallenge } from "./altcha.js";
import { DEFAULT_BASE, sessionHeaders } from "./request.js";

const DAY_MS = 86_400_000;
const MAX_LIFETIME_MS = 30 * DAY_MS;
const SAFETY_MARGIN_MS = DAY_MS;
const DEFAULT_HANDSHAKE_GAP_MS = 10 * 60_000;
const COOKIE_NAME = "chllg";
const COOKIE_SPLIT = /,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/;

export class SessionError extends Error {
  constructor(message, status = "interstitial") {
    super(message);
    this.name = "SessionError";
    this.status = status;
  }
}

export const readCookie = (response) => {
  const listed = response.headers?.getSetCookie?.() ?? [];
  const lines = listed.length ? listed : (response.headers?.get?.("set-cookie") ?? "").split(COOKIE_SPLIT);
  for (const line of lines) {
    const match = new RegExp(`^\\s*${COOKIE_NAME}=([^;]+)`).exec(line);
    if (!match) continue;
    const maxAge = Number.parseInt(/max-age=(\d+)/i.exec(line)?.[1] ?? "", 10);
    return { value: match[1], lifetimeMs: Number.isFinite(maxAge) ? maxAge * 1000 : MAX_LIFETIME_MS };
  }
  return null;
};

export class Session {
  constructor({ cacheFile = "", base = DEFAULT_BASE, now = Date.now, handshakeGapMs = DEFAULT_HANDSHAKE_GAP_MS, solve = solveChallenge } = {}) {
    this.cacheFile = cacheFile;
    this.base = base.replace(/\/+$/, "");
    this.now = now;
    this.handshakeGapMs = handshakeGapMs;
    this.solve = solve;
    this.cookie = "";
    this.expiresAt = 0;
    this.loaded = false;
    this.nextHandshakeAt = 0;
    this.pending = null;
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cacheFile) return;
    try {
      const saved = JSON.parse(readFileSync(this.cacheFile, "utf8"));
      if (typeof saved.cookie === "string" && /^[A-Za-z0-9_=.+/-]+$/.test(saved.cookie) && Number.isFinite(saved.expiresAt)) {
        this.cookie = saved.cookie;
        this.expiresAt = saved.expiresAt;
      }
    } catch {
      /* no usable saved session */
    }
  }

  _save() {
    if (!this.cacheFile) return;
    try {
      const folder = dirname(this.cacheFile);
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true });
      const temporary = `${this.cacheFile}.tmp`;
      writeFileSync(temporary, JSON.stringify({ cookie: this.cookie, expiresAt: this.expiresAt }), { mode: 0o600 });
      renameSync(temporary, this.cacheFile);
    } catch {
      this.cacheFile = "";
    }
  }

  get valid() {
    this._load();
    return Boolean(this.cookie) && this.now() < this.expiresAt;
  }

  header() {
    return this.valid ? `${COOKIE_NAME}=${this.cookie}` : "";
  }

  invalidate() {
    this.cookie = "";
    this.expiresAt = 0;
    this._save();
  }

  async ensure(doFetch) {
    if (this.valid) return this.header();
    if (!this.pending) {
      this.pending = this._handshake(doFetch).finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  async _handshake(doFetch) {
    const now = this.now();
    if (now < this.nextHandshakeAt) {
      throw new SessionError(
        `Mojeek's bot check was passed recently and the search was still refused, so it is not retried for ${Math.ceil((this.nextHandshakeAt - now) / 60_000)} min`,
        "captcha",
      );
    }
    this.nextHandshakeAt = now + this.handshakeGapMs;

    const challengeResponse = await doFetch(`${this.base}/captcha/challenge`, { headers: sessionHeaders({ Accept: "application/json" }) });
    if (!challengeResponse.ok) throw new SessionError(`Mojeek's bot check could not be fetched (HTTP ${challengeResponse.status})`);
    let raw;
    try {
      raw = JSON.parse(await challengeResponse.text());
    } catch {
      throw new SessionError("Mojeek's bot check was not in the expected format");
    }
    const challenge = readChallenge(raw);
    if (!challenge) throw new SessionError("Mojeek's bot check uses settings this engine does not accept");

    const started = this.now();
    const solution = this.solve(challenge);
    if (!solution) throw new SessionError("Mojeek's bot check could not be solved in time");

    const boundary = `----degoog${randomUUID().replace(/-/g, "")}`;
    const verify = await doFetch(`${this.base}/captcha/verify`, {
      method: "POST",
      headers: sessionHeaders({ "Content-Type": `multipart/form-data; boundary=${boundary}` }),
      body: buildSolutionBody(raw, solution, boundary, Math.max(100, Math.min(this.now() - started, 5000))),
    });
    if (!verify.ok) throw new SessionError(`Mojeek did not accept the solved bot check (HTTP ${verify.status})`);

    const cookie = readCookie(verify);
    if (!cookie) {
      throw new SessionError("Mojeek accepted the bot check but no cookie came back; this HTTP client may be hiding Set-Cookie headers");
    }
    this.cookie = cookie.value;
    this.expiresAt = this.now() + Math.min(cookie.lifetimeMs, MAX_LIFETIME_MS) - SAFETY_MARGIN_MS;
    this._save();
    return this.header();
  }
}

export const sessionFile = (dataDir) => join(dataDir, "mojeek", "session.json");
