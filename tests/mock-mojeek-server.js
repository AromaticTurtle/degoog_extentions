// Local stand-in for mojeek.com, used only for integration checks.
// It verifies the Altcha solution for real, hands out a chllg cookie, and serves the results page only with that cookie.
// Usage: bun tests/mock-mojeek-server.js [port]
import { pbkdf2Sync } from "node:crypto";

const port = Number(process.argv[2] || 4466);
const read = (name) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const challengeText = await read("mojeek-challenge.json").text();
const challenge = JSON.parse(challengeText);
const results = await read("mojeek-search.html").text();
const TOKEN = "mocktoken123";

const solved = (payload) => {
  const p = payload.challenge.parameters;
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(payload.solution.counter);
  const key = pbkdf2Sync(Buffer.concat([Buffer.from(p.nonce, "hex"), counter]), Buffer.from(p.salt, "hex"), p.cost, p.keyLength, "sha256").toString("hex");
  return key === payload.solution.derivedKey && key.startsWith(p.keyPrefix);
};

Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    const cookie = request.headers.get("cookie") ?? "";
    console.log(`MOCK ${request.method} ${url.pathname}${url.search} cookie=${cookie ? "yes" : "none"} ua=${(request.headers.get("user-agent") ?? "").split(" ")[0]}`);
    if (url.pathname === "/captcha/challenge") return new Response(challengeText, { headers: { "content-type": "application/json" } });
    if (url.pathname === "/captcha/verify") {
      const text = await request.text();
      const encoded = /\r\n\r\n([A-Za-z0-9+/=]+)\r\n--/.exec(text)?.[1];
      let ok = false;
      try {
        ok = solved(JSON.parse(Buffer.from(encoded, "base64").toString()));
      } catch {
        ok = false;
      }
      if (!ok) return new Response('{"ok":false}', { status: 403 });
      return new Response('{"ok":true,"verified":true}', {
        headers: { "set-cookie": `chllg=${TOKEN}; expires=Thu, 26-Nov-2026 01:22:42 GMT; Max-Age=2629746; path=/` },
      });
    }
    if (url.pathname === "/search") {
      if (!cookie.includes(`chllg=${TOKEN}`)) return new Response("<html><head><title>Captcha</title></head><body>JavaScript is required</body></html>");
      if ((url.searchParams.get("q") ?? "").includes("nothing")) return new Response("<html><body>No pages found matching: nothing</body></html>");
      return new Response(results);
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(`mock mojeek listening on ${port}`);
