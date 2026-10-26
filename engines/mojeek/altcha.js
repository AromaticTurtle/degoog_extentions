import { pbkdf2Sync } from "node:crypto";

export const MAX_COUNTER = 20_000;
export const SOLVE_BUDGET_MS = 8_000;
const MAX_COST = 200_000;
const MAX_KEY_LENGTH = 64;

const HEX = /^[0-9a-f]+$/i;
const hex = (value) => (typeof value === "string" && value.length % 2 === 0 && HEX.test(value) ? Buffer.from(value, "hex") : null);

const ALGORITHMS = { "PBKDF2/SHA-256": "sha256", "PBKDF2/SHA-384": "sha384", "PBKDF2/SHA-512": "sha512" };

export const readChallenge = (data) => {
  const parameters = data?.parameters;
  if (!parameters || typeof parameters !== "object") return null;
  const digest = ALGORITHMS[parameters.algorithm];
  const nonce = hex(parameters.nonce);
  const salt = hex(parameters.salt);
  const prefix = hex(parameters.keyPrefix);
  const { cost, keyLength } = parameters;
  if (!digest || !nonce || !salt || !prefix || prefix.length === 0) return null;
  if (!Number.isInteger(cost) || cost < 1 || cost > MAX_COST) return null;
  if (!Number.isInteger(keyLength) || keyLength < prefix.length || keyLength > MAX_KEY_LENGTH) return null;
  return { digest, nonce, salt, prefix, cost, keyLength };
};

export const solveChallenge = (challenge, { maxCounter = MAX_COUNTER, budgetMs = SOLVE_BUDGET_MS, now = Date.now } = {}) => {
  const deadline = now() + budgetMs;
  for (let counter = 0; counter < maxCounter; counter++) {
    if (counter % 16 === 0 && now() > deadline) return null;
    const counterBytes = Buffer.alloc(4);
    counterBytes.writeUInt32BE(counter);
    const secret = Buffer.concat([challenge.nonce, counterBytes]);
    const key = pbkdf2Sync(secret, challenge.salt, challenge.cost, challenge.keyLength, challenge.digest);
    if (key.subarray(0, challenge.prefix.length).equals(challenge.prefix)) {
      return { counter, derivedKey: key.toString("hex") };
    }
  }
  return null;
};

export const buildSolutionBody = (rawChallenge, solution, boundary, timeMs = 150) => {
  const payload = Buffer.from(
    JSON.stringify({ challenge: rawChallenge, solution: { counter: solution.counter, derivedKey: solution.derivedKey, time: timeMs } }),
  ).toString("base64");
  return `--${boundary}\r\nContent-Disposition: form-data; name="altcha"\r\n\r\n${payload}\r\n--${boundary}--\r\n`;
};
