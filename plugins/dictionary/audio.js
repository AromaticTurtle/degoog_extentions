import { AUDIO_HOSTS, safeUrl } from "./shape.js";

// A tiny audio proxy for the pronunciation buttons. The browser asks this server for ?w=<word>&n=<clip>; the address of the clip
// is never taken from the request: it is looked up in what the dictionary replies said (see remember()), so this is not an open
// proxy. Only https hosts from AUDIO_HOSTS, only audio content types, at most MAX_BYTES, and a small in-memory cache.

export const MAX_BYTES = 2 * 1024 * 1024;
const MAX_WORDS_KNOWN = 300;
const MAX_CLIPS = 24;
const FETCH_TIMEOUT_MS = 8000;
const PAUSE_MS = 60_000;
const MIN_SPACING_MS = 500;
const WORD = /^[a-z][a-z'’ -]{0,39}$/;

// For integration tests only: fetch the dictionary's media files from another address (the path stays the same).
const mediaTarget = (source) => {
  const base = process.env.DEGOOG_DICTIONARY_MEDIA_BASE;
  if (!base) return source;
  try {
    const url = new URL(source);
    return `${base.replace(/\/+$/, "")}${url.pathname}`;
  } catch {
    return source;
  }
};

const plain = (status, text = "") => new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

const isAudioType = (type) => /^(audio\/|application\/ogg)/i.test(String(type ?? ""));

const readLimited = async (response, limit) => {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length > limit ? null : buffer;
  }
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export class AudioProxy {
  constructor(host) {
    this.host = host;
    this.words = new Map(); // word -> [clip urls]
    this.clips = new Map(); // url -> { type, bytes }
    this.pausedUntil = 0;
    this.lastAt = 0;
  }

  // Called with every entry that is rendered, so its clips can be served afterwards.
  remember(entry) {
    const urls = entry.audio.map((clip) => safeUrl(clip.url, AUDIO_HOSTS)).filter(Boolean);
    if (!urls.length) return;
    this.words.delete(entry.word.toLowerCase());
    this.words.set(entry.word.toLowerCase(), urls);
    while (this.words.size > MAX_WORDS_KNOWN) this.words.delete(this.words.keys().next().value);
  }

  clipUrl(word, index) {
    if (!WORD.test(word) || !Number.isInteger(index) || index < 0 || index > 5) return "";
    return this.words.get(word)?.[index] ?? "";
  }

  async serve(request) {
    let url;
    try {
      url = new URL(request.url, "http://localhost");
    } catch {
      return plain(400, "bad request");
    }
    const word = String(url.searchParams.get("w") ?? "").toLowerCase();
    const index = Number.parseInt(String(url.searchParams.get("n") ?? "0"), 10);
    const source = this.clipUrl(word, index);
    if (!source) return plain(404, "not found");
    const cached = this.clips.get(source);
    if (cached) return this._respond(cached);
    if (this.host.now() < this.pausedUntil) return plain(503, "unavailable");
    const wait = this.lastAt + MIN_SPACING_MS - this.host.now();
    if (wait > 0) await this.host.sleep(wait);
    this.lastAt = this.host.now();
    try {
      const doFetch = this.host.fetchImpl ?? fetch;
      const response = await doFetch(mediaTarget(source), { headers: { "User-Agent": this.host.userAgent, Accept: "audio/*" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const finalHost = response.url && !process.env.DEGOOG_DICTIONARY_MEDIA_BASE ? safeUrl(response.url, AUDIO_HOSTS) : source;
      if (!finalHost) return plain(502, "unexpected redirect");
      if (response.status === 429 || response.status >= 500) {
        this.pausedUntil = this.host.now() + PAUSE_MS;
        return plain(503, "unavailable");
      }
      if (response.status !== 200) return plain(404, "not found");
      const type = response.headers.get("content-type") ?? "";
      if (!isAudioType(type)) return plain(502, "not audio");
      const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(length) && length > MAX_BYTES) return plain(502, "too large");
      const bytes = await readLimited(response, MAX_BYTES);
      if (!bytes || !bytes.length) return plain(502, "too large");
      const clip = { type: type.split(";")[0].trim().toLowerCase(), bytes };
      this.clips.set(source, clip);
      while (this.clips.size > MAX_CLIPS) this.clips.delete(this.clips.keys().next().value);
      return this._respond(clip);
    } catch {
      this.pausedUntil = this.host.now() + PAUSE_MS;
      return plain(502, "unavailable");
    }
  }

  _respond(clip) {
    return new Response(clip.bytes, {
      status: 200,
      headers: {
        "content-type": clip.type,
        "content-length": String(clip.bytes.length),
        "cache-control": "public, max-age=604800, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
