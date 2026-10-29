// Explains what the Pexels engine does for one query, against the REAL Pexels API. Needs your free key in the environment:
//   read -sx PEXELS_API_KEY; bun ./tests/diagnose-pexels.js "forest lake"; set -e PEXELS_API_KEY
// At most 2 requests (page 1, then page 2 to check paging). The usage file is not touched. The key is never printed (it travels in
// the Authorization header only). For every reply it prints the status, the rate-limit headers (numbers), the top-level keys, which
// fields the photos carry and the image hosts.
import PexelsEngine from "../engines/pexels/index.js";

const query = process.argv.slice(2).join(" ").trim() || "forest lake";
const key = (process.env.PEXELS_API_KEY ?? "").trim();
if (!key) {
  console.error("PEXELS_API_KEY is not set. Get a free key at https://www.pexels.com/api/ (free account, then 'Your API Key').");
  console.error("In fish:  read -sx PEXELS_API_KEY; bun ./tests/diagnose-pexels.js; set -e PEXELS_API_KEY");
  process.exit(1);
}

const MAX_REQUESTS = 2;
const engine = new PexelsEngine();
engine.budget.file = "";
engine.limiter.minIntervalMs = 1000;
engine.limiter.maxWaitMs = 5000;
engine.configure({ apiKey: key, debugMatching: "true" });

const scrub = (text) => String(text ?? "").split(key).join("***");

const seen = [];
let count = 0;
const context = {
  fetch: async (url, init) => {
    if (++count > MAX_REQUESTS) throw new Error("diagnose request cap reached");
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    } catch (error) {
      seen.push(`GET ${new URL(url).host}${new URL(url).pathname} -> failed (${error?.name ?? "error"})`);
      throw new Error("network");
    }
    const text = await response.clone().text().catch(() => "");
    let shape = "(not JSON)";
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json?.photos)) {
        const fields = new Set(json.photos.flatMap((photo) => Object.keys(photo)));
        const sizes = new Set(json.photos.flatMap((photo) => Object.keys(photo.src ?? {})));
        const hosts = new Set(json.photos.flatMap((photo) => Object.values(photo.src ?? {}).filter((u) => typeof u === "string").map((u) => new URL(u).host)));
        shape = `keys: ${Object.keys(json).join(",")} | total_results ${json.total_results}, ${json.photos.length} photos | photo fields: ${[...fields].join(",")} | src sizes: ${[...sizes].join(",")} | image hosts: ${[...hosts].join(",")}`;
      } else {
        shape = `keys: ${Object.keys(json ?? {}).join(",")} | body: ${scrub(text).slice(0, 120)}`;
      }
    } catch {
      shape = `(not JSON) ${scrub(text).slice(0, 120)}`;
    }
    const limits = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"].map((name) => [name, response.headers.get(name)]).filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${value}`);
    const u = new URL(url);
    seen.push(`GET ${u.host}${u.pathname} (key in the Authorization header, not printed) -> ${response.status}, ${text.length} bytes | ${limits.join(", ") || "no rate-limit headers"} | ${shape}`);
    return response;
  },
  sentinel: (res, name) => {
    if (!res.ok) throw Object.assign(new Error(`${name} answered HTTP ${res.status}`), { name: "SentinelBreach", status: res.status });
  },
  engineError: (status, message) => Object.assign(new Error(message), { name: "SentinelBreach", status }),
};

const lines = [];
const originals = {};
for (const method of ["info", "warn"]) {
  originals[method] = console[method];
  console[method] = (...args) => lines.push(args.join(" "));
}
const outcome = [];
const started = performance.now();
try {
  for (const page of [1, 2]) {
    try {
      const results = await engine.executeSearch(query, page, "any", context);
      outcome.push(`page ${page}: ${results.length} results; first has fields ${Object.keys(results[0] ?? {}).join(",") || "(none)"}; snippet shape: ${(results[0]?.snippet ?? "").replace(/[^ ·()@/.:×0-9]/g, "x").slice(0, 60)}`);
    } catch (error) {
      outcome.push(`page ${page}: error: ${scrub(error?.message)}`);
    }
  }
} finally {
  Object.assign(console, originals);
}
const elapsed = Math.round(performance.now() - started);
console.log([...lines.map(scrub), "", ...seen.map((line) => `  request: ${scrub(line)}`), "", ...outcome, `(${count} upstream request${count === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n"));
