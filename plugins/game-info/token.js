import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_TOKEN_URL, buildTokenRequest, retryAfterMs } from "./request.js";

export const tokenFile = (dataDir) => process.env.DEGOOG_IGDB_TOKEN_FILE || join(dataDir, "igdb", "token.json");

// A saved token that expires sooner than this is replaced.
export const REFRESH_MARGIN_MS = 24 * 60 * 60_000;

// kind: "rejected" (Twitch answered 400/401/403), "rate" (429) or "failed" (anything else).
// The message holds no address, id or secret.
export class TokenError extends Error {
  constructor(kind, retryAfter = 0) {
    super(`The Twitch token request failed (${kind})`);
    this.kind = kind;
    this.retryAfterMs = retryAfter;
  }
}

// Keeps the Twitch app access token in memory and on disk (never the client secret).
export class TokenStore {
  constructor({ file = "", now = Date.now, fetch: doFetch = null } = {}) {
    this.file = file;
    this.now = now;
    this.fetch = doFetch;
    this.state = null;
    this.loaded = false;
    this._pending = null;
    this._pendingId = "";
  }

  _load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (typeof saved.clientId === "string" && typeof saved.token === "string" && saved.token && Number.isFinite(saved.expiresAt)) {
        this.state = { clientId: saved.clientId, token: saved.token, expiresAt: saved.expiresAt };
      }
    } catch {
      /* no saved token */
    }
  }

  _save() {
    if (!this.file) return;
    try {
      const folder = dirname(this.file);
      if (!existsSync(folder)) mkdirSync(folder, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
    } catch {
      this.file = "";
    }
  }

  _usable(clientId) {
    return Boolean(this.state) && this.state.clientId === clientId && this.state.expiresAt - this.now() > REFRESH_MARGIN_MS;
  }

  // Forget the token. When a token is given, only if it is still the current one,
  // so a late 401 does not throw away a token another caller just fetched.
  invalidate(token) {
    this._load();
    if (token !== undefined && this.state?.token !== token) return;
    this.state = null;
    if (!this.file) return;
    try {
      unlinkSync(this.file);
    } catch {
      /* nothing saved */
    }
  }

  // Resolves to a token, or throws a TokenError. Concurrent callers share one token request.
  async get({ clientId, clientSecret, url = DEFAULT_TOKEN_URL, fetch: doFetch } = {}) {
    this._load();
    if (this._usable(clientId)) return this.state.token;
    if (this.state && this.state.clientId !== clientId) this.state = null;
    if (!this._pending || this._pendingId !== clientId) {
      const pending = this._refresh({ clientId, clientSecret, url, doFetch: doFetch ?? this.fetch ?? globalThis.fetch }).finally(() => {
        if (this._pending === pending) this._pending = null;
      });
      this._pending = pending;
      this._pendingId = clientId;
    }
    return this._pending;
  }

  async _refresh({ clientId, clientSecret, url, doFetch }) {
    const request = buildTokenRequest(clientId, clientSecret, url);
    let response;
    try {
      response = await doFetch(request.url, request.init);
    } catch {
      throw new TokenError("failed");
    }
    if (response.status === 429) throw new TokenError("rate", retryAfterMs(response.headers?.get?.("retry-after")));
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new TokenError("rejected");
    if (!response.ok) throw new TokenError("failed");
    let data;
    try {
      data = await response.json();
    } catch {
      throw new TokenError("failed");
    }
    const token = typeof data?.access_token === "string" ? data.access_token.trim() : "";
    const seconds = Number(data?.expires_in);
    if (!token || !Number.isFinite(seconds) || seconds <= 0) throw new TokenError("failed");
    this.state = { clientId, token, expiresAt: this.now() + seconds * 1000 };
    this._save();
    return token;
  }
}
