/**
 * Tests for the Profile pure helpers — social-link URL normalisation /
 * validation, icon guessing, and the pinned-template caption.
 *
 * Run: bun tests/extension/profile-model.test.ts
 */
import assert from "node:assert";
import {
  guessIcon,
  normaliseUrl,
  isUrlValid,
  pinCaption,
} from "../../src/ui/profile-model";

// --- normaliseUrl: scheme handling ---
{
  assert.strictEqual(normaliseUrl(""), "");
  assert.strictEqual(normaliseUrl("   "), "");
  assert.strictEqual(normaliseUrl("https://x.com/vai"), "https://x.com/vai", "keeps scheme");
  assert.strictEqual(normaliseUrl("mailto:a@b.c"), "mailto:a@b.c", "keeps mailto");
  assert.strictEqual(normaliseUrl("x.com/vai"), "https://x.com/vai", "adds https");
  assert.strictEqual(normaliseUrl("user@example.com"), "mailto:user@example.com", "bare address → mailto");
  // An address with a path is treated as a host, not an email.
  assert.strictEqual(normaliseUrl("t.me/@some/path"), "https://t.me/@some/path");
  assert.strictEqual(normaliseUrl("  github.com/vai  "), "https://github.com/vai", "trims");
}

// --- isUrlValid ---
{
  assert.strictEqual(isUrlValid(""), false);
  assert.strictEqual(isUrlValid("x.com"), true);
  assert.strictEqual(isUrlValid("https://x.com"), true);
  assert.strictEqual(isUrlValid("user@example.com"), true, "mailto counts");
  assert.strictEqual(isUrlValid("ht tp://nope"), false, "spaces break URL parse");
}

// --- guessIcon: a couple of representative hosts + fallback ---
{
  assert.strictEqual(guessIcon("https://x.com/vai"), "🐦");
  assert.strictEqual(guessIcon("https://github.com/vai"), "🐙");
  assert.strictEqual(guessIcon("https://discord.gg/abc"), "💬");
  assert.strictEqual(guessIcon("https://t.me/vai"), "✈️");
  assert.strictEqual(guessIcon("mailto:a@b.c"), "✉️");
  assert.strictEqual(guessIcon("https://example.com"), "🔗", "fallback");
}

// --- pinCaption: 12-char cap, empty-safe ---
{
  assert.strictEqual(pinCaption(undefined), "");
  assert.strictEqual(pinCaption("short"), "short");
  assert.strictEqual(pinCaption("a-very-long-template-name"), "a-very-long-");
}

console.log("profile-model: all assertions passed");
