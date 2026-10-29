// The time rule every extension in this repository follows: degoog gives an engine DEGOOG_SLOT_TIMEOUT_MS (default 10 s). No request
// is started after 70 % of it has passed, and a request still running at 95 % is given up (its reply is lost, the next search asks again).

export const slotTimeoutMs = (env = process.env) => {
  const configured = Number.parseInt(env.DEGOOG_SLOT_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : 10_000;
};

export const startWindowMs = (env = process.env) => Math.max(1000, Math.round(slotTimeoutMs(env) * 0.7));
export const answerWindowMs = (env = process.env) => Math.max(1500, Math.round(slotTimeoutMs(env) * 0.95));

// An AbortSignal that fires after `ms`, combined with degoog's own signal when it gives one
export const deadlineSignal = (ms, outer) => {
  const timer = AbortSignal.timeout(Math.max(1, ms));
  if (!outer) return timer;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([timer, outer]) : timer;
};
