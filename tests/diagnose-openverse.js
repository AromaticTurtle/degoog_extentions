// Explains what the Openverse engine does for one query, against the REAL Openverse API. No key needed:
//   bun ./tests/diagnose-openverse.js "forest lake"
// Optional registered credentials (higher limits), read from the environment only:
//   set -x OPENVERSE_CLIENT_ID your-id; read -sx OPENVERSE_CLIENT_SECRET; bun ./tests/diagnose-openverse.js; set -e OPENVERSE_CLIENT_SECRET OPENVERSE_CLIENT_ID
// At most 3 requests in total (the token request, when credentials are set, counts as one) and ONE search page: anonymous use is
// limited to a few requests an hour, so please do not run this in a loop. The usage file is not touched. Secrets and tokens are never
// printed. For every reply it prints the status, the rate-limit headers (numbers), the top-level keys, which fields the results carry
// and the hosts of the image and thumbnail addresses.
import OpenverseEngine from "../engines/openverse/index.js";

const query = process.argv.slice(2).join(" ").trim() || "forest lake";
const clientId = (process.env.OPENVERSE_CLIENT_ID ?? "").trim();
const clientSecret = (process.env.OPENVERSE_CLIENT_SECRET ?? "").trim();
const secrets = [clientSecret].filter(Boolean);

const MAX_REQUESTS = 3;
const engine = new OpenverseEngine();
engine.budget.file = "";
engine.limiter.minIntervalMs = 1000;
engine.limiter.maxWaitMs = 5000;
engine.configure({ clientId, clientSecret, pageSize: "20", debugMatching: "true" });
console.log(engine.tokens.enabled ? "Credentials found in the environment: the engine asks for an access token first." : "No credentials: searching anonymously (limits are low).");

const scrub = (text) => {
  let out = String(text ?? "");
  for (const secret of secrets) out = out.split(secret).join("***");
  return out.replace(/(client_secret=|access_token=|Bearer\s+)[^&\s"']*/gi, "$1***");
};

const seen = [];
let count = 0;
const context = {
  fetch: async (url, init) => {
    if (++count > MAX_REQUESTS) throw new Error("diagnose request cap reached");
    const u = new URL(url);
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    } catch (error) {
      seen.push(`${init?.method ?? "GET"} ${u.host}${u.pathname} -> failed (${error?.name ?? "error"})`);
      throw new Error("network");
    }
    const text = await response.clone().text().catch(() => "");
    let shape = "(not JSON)";
    try {
      const json = JSON.parse(text);
      if (Array.isArray(json?.results)) {
        const fields = new Set(json.results.flatMap((item) => Object.keys(item)));
        const hostOf = (value) => {
          try {
            return new URL(value).host;
          } catch {
            return "";
          }
        };
        const thumbHosts = new Set(json.results.map((item) => hostOf(item.thumbnail)).filter(Boolean));
        const imageHosts = new Set(json.results.map((item) => hostOf(item.url)).filter(Boolean));
        const licenses = new Set(json.results.map((item) => item.license).filter(Boolean));
        const withMature = json.results.filter((item) => item.mature === true).length;
        shape = `keys: ${Object.keys(json).join(",")} | result_count ${json.result_count}, page_count ${json.page_count}, ${json.results.length} results (${withMature} flagged mature) | result fields: ${[...fields].join(",")} | licenses: ${[...licenses].join(",")} | thumbnail hosts: ${[...thumbHosts].join(",")} | image hosts (${imageHosts.size}): ${[...imageHosts].slice(0, 6).join(",")}`;
      } else {
        const keys = Object.keys(json ?? {});
        shape = `keys: ${keys.join(",")}${keys.includes("access_token") ? "" : ` | body: ${scrub(text).slice(0, 160)}`}`;
      }
    } catch {
      shape = `(not JSON) ${scrub(text).slice(0, 120)}`;
    }
    const limits = ["x-ratelimit-limit-anon_burst", "x-ratelimit-available-anon_burst", "x-ratelimit-limit-anon_sustained", "x-ratelimit-available-anon_sustained", "x-ratelimit-limit-oauth2_client_credentials_burst", "x-ratelimit-available-oauth2_client_credentials_burst", "x-ratelimit-limit-oauth2_client_credentials_sustained", "x-ratelimit-available-oauth2_client_credentials_sustained", "retry-after"]
      .map((name) => [name, response.headers.get(name)])
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name}: ${value}`);
    const others = [...response.headers.keys()].filter((name) => /ratelimit|throttl|retry/i.test(name) && !limits.some((line) => line.startsWith(`${name}:`)));
    seen.push(`${init?.method ?? "GET"} ${u.host}${u.pathname} -> ${response.status}, ${text.length} bytes | ${limits.join(", ") || "no known rate-limit headers"}${others.length ? ` | other rate-limit headers: ${others.join(",")}` : ""} | ${shape}`);
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
let outcome;
const started = performance.now();
try {
  try {
    const results = await engine.executeSearch(query, 1, "any", context);
    outcome = `page 1: ${results.length} results; first has fields ${Object.keys(results[0] ?? {}).join(",") || "(none)"}; snippet shape: ${(results[0]?.snippet ?? "").replace(/[^ ·()@/.:×0-9]/g, "x").slice(0, 60)}`;
  } catch (error) {
    outcome = `page 1: error: ${scrub(error?.message)}`;
  }
} finally {
  Object.assign(console, originals);
}
const elapsed = Math.round(performance.now() - started);
console.log([...lines.map(scrub), "", ...seen.map((line) => `  request: ${scrub(line)}`), "", outcome, `(${count} upstream request${count === 1 ? "" : "s"}, ${elapsed} ms)`].join("\n"));
