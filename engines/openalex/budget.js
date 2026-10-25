import { retryAfterMs } from "./limiter.js";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

export const pauseFromHeaders = (status, headers) => {
  const remaining = headers?.get?.("x-ratelimit-remaining");
  const exhausted = remaining !== null && remaining !== undefined && remaining !== "" && Number(remaining) <= 0;
  if (exhausted) {
    const reset = Number.parseInt(String(headers.get("x-ratelimit-reset") ?? ""), 10);
    return Number.isFinite(reset) && reset > 0 ? Math.min(SIX_HOURS_MS, reset * 1000) : 60 * 60 * 1000;
  }
  if (status === 429 || status === 503) return retryAfterMs(headers?.get?.("retry-after"), 10_000, 300_000);
  return 0;
};
