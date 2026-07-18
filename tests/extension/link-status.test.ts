/**
 * Tests for the linked-accounts mapper — the /v2/me/links body is FLAT
 * snake_case (backend/src/routes/v2/links.rs LinkStatus); the old nested
 * `{ telegram: { username } }` assumption rendered every provider as
 * "not linked". These lock the real wire shape + the Discord via-site
 * semantics (DELETE only clears the OAuth flag).
 *
 * Run: bun tests/extension/link-status.test.ts
 */
import assert from "node:assert";
import { mapLinkStatus } from "../../src/backend/link-status";

// --- 1. real backend shape: both providers linked ---
{
  const m = mapLinkStatus({
    discord_id: "123456789",
    discord_username: "Vai",
    discord_linked_via_oauth: true,
    telegram_user_id: "42",
    telegram_username: "vai_tg",
    telegram_photo_url: "https://t.me/i/userpic/x.jpg",
    email: null,
    email_request_status: null,
  });
  assert.strictEqual(m.telegram.linked, true, "telegram linked");
  assert.strictEqual(m.telegram.detail, "@vai_tg", "telegram handle @-formatted");
  assert.strictEqual(m.telegram.photoUrl, "https://t.me/i/userpic/x.jpg", "photo kept");
  assert.strictEqual(m.telegram.canUnlink, true, "telegram unlinkable");
  assert.strictEqual(m.discord.linked, true, "discord linked");
  assert.strictEqual(m.discord.detail, "Vai", "discord username shown as-is");
  assert.strictEqual(m.discord.canUnlink, true, "oauth discord unlinkable");
  assert.strictEqual(m.discord.note, undefined, "no via-site note when oauth");
}
console.log("link-status.test.ts: linked shape OK");

// --- 2. nothing linked → both rows unlinked, no details ---
{
  const m = mapLinkStatus({
    discord_id: null,
    discord_username: null,
    discord_linked_via_oauth: false,
    telegram_user_id: null,
    telegram_username: null,
    telegram_photo_url: null,
  });
  assert.strictEqual(m.telegram.linked, false);
  assert.strictEqual(m.telegram.detail, "");
  assert.strictEqual(m.telegram.canUnlink, false);
  assert.strictEqual(m.discord.linked, false);
  assert.strictEqual(m.discord.canUnlink, false);
}
console.log("link-status.test.ts: unlinked shape OK");

// --- 3. Discord linked via SITE (no OAuth): linked but not unlinkable ---
// unlink_discord only clears discord_linked_via_oauth — a site-sourced
// identity survives the DELETE, so the UI must offer Connect, not Unlink.
{
  const m = mapLinkStatus({
    discord_id: "999",
    discord_username: "SiteGuy",
    discord_linked_via_oauth: false,
  });
  assert.strictEqual(m.discord.linked, true, "site identity still counts as linked");
  assert.strictEqual(m.discord.canUnlink, false, "DELETE would be a no-op");
  assert.strictEqual(m.discord.note, "via site", "flagged as site-sourced");
}
console.log("link-status.test.ts: discord via-site semantics OK");

// --- 4. Telegram with an id but no username → numeric fallback detail ---
{
  const m = mapLinkStatus({ telegram_user_id: "777" });
  assert.strictEqual(m.telegram.linked, true);
  assert.strictEqual(m.telegram.detail, "id 777");
}
console.log("link-status.test.ts: telegram id fallback OK");

// --- 5. defensive: legacy nested shape still maps to linked ---
{
  const m = mapLinkStatus({
    telegram: { username: "nested_tg" },
    discord: { username: "nested_dc" },
  });
  assert.strictEqual(m.telegram.linked, true, "nested telegram tolerated");
  assert.strictEqual(m.telegram.detail, "@nested_tg");
  assert.strictEqual(m.discord.linked, true, "nested discord tolerated");
  assert.strictEqual(m.discord.detail, "nested_dc");
}
console.log("link-status.test.ts: nested legacy shape OK");

// --- 6. garbage in → safe unlinked rows out (never throws) ---
{
  for (const junk of [null, undefined, 42, "x", [], { telegram_username: 5 }]) {
    const m = mapLinkStatus(junk);
    assert.strictEqual(m.telegram.linked, false, `junk ${String(junk)} → unlinked tg`);
    assert.strictEqual(m.discord.linked, false, `junk ${String(junk)} → unlinked dc`);
  }
  // Whitespace-only strings don't count as identities.
  const m = mapLinkStatus({ telegram_username: "   ", discord_id: " " });
  assert.strictEqual(m.telegram.linked, false, "blank username ignored");
  assert.strictEqual(m.discord.linked, false, "blank id ignored");
}
console.log("link-status.test.ts: garbage tolerance OK");

console.log("link-status.test.ts: all assertions passed");
