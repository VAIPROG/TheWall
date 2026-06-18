/**
 * Tests for the shared helpers — error-message extraction and the list
 * status-line builder that the tab views render.
 *
 * Run: bun tests/extension/helpers.test.ts
 */
import assert from "node:assert";
import { errMsg, noteBox } from "../../src/helpers";

// --- 1. errMsg pulls a readable string from anything thrown ---
{
  assert.strictEqual(errMsg(new Error("boom")), "boom", "Error → .message");
  assert.strictEqual(errMsg({ message: "from object" }), "from object", "object with message");
  assert.strictEqual(errMsg("plain string"), "plain string", "string passthrough");
  assert.strictEqual(errMsg(42), "42", "number → stringified");
  assert.strictEqual(errMsg(null), "error", "null → fallback");
  assert.strictEqual(errMsg(undefined), "error", "undefined → fallback");

  // A TypeError subclass still resolves via the Error branch.
  assert.strictEqual(errMsg(new TypeError("bad type")), "bad type", "Error subclass");
}
console.log("helpers.test.ts: errMsg OK");

// --- 2. noteBox renders a padded status line, default tone is muted ---
{
  const sub = noteBox("loading");
  assert.ok(sub.includes("loading"), "contains the message");
  assert.ok(sub.includes("color:var(--sub)"), "default tone uses --sub");
  assert.ok(sub.includes("padding:6px"), "padded");

  const err = noteBox("nope", "err");
  assert.ok(err.includes("#b33"), "err tone is red");
}
console.log("helpers.test.ts: noteBox tones OK");

// --- 3. noteBox escapes its message (no HTML injection) ---
{
  const html = noteBox("<b>x</b> & 'q'");
  assert.ok(!html.includes("<b>x</b>"), "raw markup must not pass through");
  assert.ok(html.includes("&lt;b&gt;"), "angle brackets escaped");
  assert.ok(html.includes("&amp;"), "ampersand escaped");
}
console.log("helpers.test.ts: noteBox escaping OK");

console.log("helpers.test.ts: all assertions passed");
