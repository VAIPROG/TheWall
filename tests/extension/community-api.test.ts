/**
 * Unit tests for the PURE parts of the Community V3 data layer: the
 * `chatEndpoints` ChatRef resolver and the `chatTitle` summary mapper. These
 * touch no client, DOM, or network — importing api.ts must stay side-effect
 * free in bare Bun.
 *
 * Run: bun tests/extension/community-api.test.ts
 */
import assert from "node:assert";
import { chatEndpoints, chatTitle, type ChatSummary } from "../../src/ui/community/api";

// ── chatEndpoints: clan ──────────────────────────────────────────────────────
{
  const e = chatEndpoints({ kind: "clan", chatId: "abc" });
  assert.strictEqual(e.list, "/chats/abc/messages");
  assert.strictEqual(e.send, "/chats/abc/messages");
  assert.strictEqual(e.read, "/chats/abc/read");
}

// ── chatEndpoints: dm (no read) ──────────────────────────────────────────────
{
  const e = chatEndpoints({ kind: "dm", userRef: "alice" });
  assert.strictEqual(e.list, "/dm/alice");
  assert.strictEqual(e.send, "/dm/alice");
  assert.strictEqual(e.read, undefined);
}

// ── chatEndpoints: modmail (fixed path, no read) ─────────────────────────────
{
  const e = chatEndpoints({ kind: "modmail" });
  assert.strictEqual(e.list, "/chats/global/modmail");
  assert.strictEqual(e.send, "/chats/global/modmail");
  assert.strictEqual(e.read, undefined);
}

// ── URL-encoding of ids/refs ─────────────────────────────────────────────────
{
  const clan = chatEndpoints({ kind: "clan", chatId: "a/b c" });
  assert.strictEqual(clan.list, "/chats/a%2Fb%20c/messages");
  assert.strictEqual(clan.read, "/chats/a%2Fb%20c/read");
  const dm = chatEndpoints({ kind: "dm", userRef: "user name/1" });
  assert.strictEqual(dm.send, "/dm/user%20name%2F1");
}

// ── chatTitle ────────────────────────────────────────────────────────────────
function summary(over: Partial<ChatSummary>): ChatSummary {
  return {
    id: "1",
    type: "clan",
    slowmodeSeconds: 0,
    createdAt: "2026-01-01T00:00:00Z",
    unreadCount: 0,
    ...over,
  };
}

// clan → topic when set, else "Clan chat"
assert.strictEqual(chatTitle(summary({ type: "clan", topic: "General" })), "General");
assert.strictEqual(chatTitle(summary({ type: "clan", topic: "  " })), "Clan chat");
assert.strictEqual(chatTitle(summary({ type: "clan" })), "Clan chat");

// dm → topic when set, else fallback (dmKey is opaque ids, not a name)
assert.strictEqual(chatTitle(summary({ type: "dm", topic: "alice" })), "alice");
assert.strictEqual(chatTitle(summary({ type: "dm", dmKey: "id1:id2" })), "Direct message");

// modmail / global
assert.strictEqual(chatTitle(summary({ type: "modmail" })), "Modmail");
assert.strictEqual(chatTitle(summary({ type: "global" })), "Global");
assert.strictEqual(chatTitle(summary({ type: "global", topic: "Announcements" })), "Announcements");

console.log("community-api: OK");
