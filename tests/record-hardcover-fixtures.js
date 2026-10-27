// Saves one real Hardcover search as a test fixture. Exactly one request.
// Run it in your own terminal so the token never leaves your machine:
//   HARDCOVER_API_TOKEN=your-token bun ./tests/record-hardcover-fixtures.js "dune"
// The token is read from the environment and sent only in a header. The file is refused if its content contains the token.
// Note: the reply is real Hardcover catalog data and user-uploaded image URLs. Keep the recorded file for local testing;
// do not commit it or publish it, and run `git status` before committing.
// The token needs only the read:catalog permission.
import { writeFileSync } from "node:fs";
import { DEFAULT_API_URL, buildHeaders, buildRequestBody, normalizeToken } from "../plugins/books/request.js";
import { parseSearchReply } from "../plugins/books/shape.js";

const token = normalizeToken(process.env.HARDCOVER_API_TOKEN);
const term = process.argv[2] || "dune";
if (!token) {
  console.error("Set HARDCOVER_API_TOKEN in the environment first.");
  process.exit(1);
}

const response = await fetch(DEFAULT_API_URL, { method: "POST", headers: buildHeaders(token), body: buildRequestBody(term) });
if (!response.ok) throw new Error(`Hardcover answered HTTP ${response.status}`);
const reply = await response.json();
if (Array.isArray(reply?.errors) && reply.errors.length) throw new Error("Hardcover answered with a GraphQL error");

// Only the data is kept, not headers or extensions.
const text = `${JSON.stringify({ data: reply.data }, null, 2)}\n`;
if (text.includes(token)) throw new Error("Refusing to save the fixture: it contains the token");
const parsed = parseSearchReply(text);
writeFileSync(new URL("./fixtures/hardcover-search.json", import.meta.url), text);
console.log(`saved hardcover-search.json (${parsed.books?.length ?? 0} books). It is real data: keep it local, do not commit it.`);
console.log("Some tests expect the hand-written Orchard Cycle data and will point out where real replies differ.");
