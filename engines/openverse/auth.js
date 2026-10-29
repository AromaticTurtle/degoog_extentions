import { tokenBody, tokenHeaders, tokenUrl } from "./request.js";

const SAFETY_MS = 60_000; // use a token only until a minute before it expires
const RETRY_AFTER_FAILURE_MS = 10 * 60_000; // after a failed token request, stay anonymous for this long
const MIN_LIFETIME_MS = 2 * 60_000;
const MAX_LIFETIME_MS = 24 * 3_600_000;
const MAX_BODY_CHARS = 20_000;

// The OAuth2 client-credentials token of an Openverse application, fetched once and reused until shortly before it expires.
// Any failure means "anonymous" (no token) for ten minutes; the engine never stops searching because of it. The secret and the token
// are held in memory only, sent only in the token request and the Authorization header, and never put in a message.
export class TokenSource {
  constructor({ base, now = Date.now } = {}) {
    this.base = base;
    this.now = now;
    this.clientId = "";
    this.clientSecret = "";
    this.token = "";
    this.expiresAt = 0;
    this.failedUntil = 0;
    this.pending = null;
    this.lastProblem = "";
  }

  configure(clientId, clientSecret) {
    const id = String(clientId ?? "").trim();
    const secret = String(clientSecret ?? "").trim();
    if (id !== this.clientId || secret !== this.clientSecret) {
      this.clientId = id;
      this.clientSecret = secret;
      this.invalidate();
      this.failedUntil = 0;
    }
  }

  get enabled() {
    return Boolean(this.clientId && this.clientSecret);
  }

  invalidate() {
    this.token = "";
    this.expiresAt = 0;
  }

  // The token to use now, or "" for an anonymous request
  async get(doFetch, { signal } = {}) {
    if (!this.enabled) return "";
    const now = this.now();
    if (this.token && now < this.expiresAt - SAFETY_MS) return this.token;
    if (now < this.failedUntil) return "";
    if (!this.pending) {
      this.pending = this._fetch(doFetch, signal).finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  async _fetch(doFetch, signal) {
    const fail = (note) => {
      this.lastProblem = note;
      this.failedUntil = this.now() + RETRY_AFTER_FAILURE_MS;
      this.invalidate();
      return "";
    };
    let response;
    try {
      response = await doFetch(tokenUrl(this.base), { method: "POST", headers: tokenHeaders(), body: tokenBody(this.clientId, this.clientSecret), signal });
    } catch {
      return fail("the token request could not be made");
    }
    if (!response.ok) return fail(`the token request was refused (HTTP ${response.status})`);
    let data;
    try {
      data = JSON.parse((await response.text()).slice(0, MAX_BODY_CHARS));
    } catch {
      return fail("the token reply was not JSON");
    }
    const token = typeof data?.access_token === "string" ? data.access_token.trim() : "";
    if (!/^[A-Za-z0-9._~+/=-]{8,4000}$/.test(token)) return fail("the token reply had no usable access token");
    const seconds = Number(data.expires_in);
    const lifetime = Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_LIFETIME_MS, Math.max(MIN_LIFETIME_MS, seconds * 1000)) : 3_600_000;
    this.token = token;
    this.expiresAt = this.now() + lifetime;
    this.lastProblem = "";
    return token;
  }
}
