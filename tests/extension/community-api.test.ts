/**
 * Unit tests for the PURE parts of the Community V3 data layer: the
 * `chatEndpoints` ChatRef resolver and the `chatTitle` summary mapper. These
 * touch no client, DOM, or network — importing api.ts must stay side-effect
 * free in bare Bun.
 *
 * Run: bun tests/extension/community-api.test.ts
 */
import assert from "node:assert";
import {
  chatEndpoints,
  chatTitle,
  peerOf,
  chronological,
  type ChatSummary,
  type Message,
} from "../../src/ui/community/api";
import { clanAvatarUrl, clanBannerUrl } from "../../src/ui/community/api";

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

// modmail / global — now localised (t()) with a leading marker glyph, so match
// on the substring rather than the exact string.
assert.ok(chatTitle(summary({ type: "modmail" })).includes("Modmail"));
assert.ok(chatTitle(summary({ type: "global" })).includes("Global"));

// ── chatEndpoints: global (distinct from modmail; list/send take the `global`
// selector, but read is Uuid-only on the backend so it must be undefined —
// markRead uses the concrete chat id resolved from a loaded message) ─────────
{
  const g = chatEndpoints({ kind: "global" });
  assert.strictEqual(g.list, "/chats/global/messages");
  assert.strictEqual(g.send, "/chats/global/messages");
  assert.strictEqual(g.read, undefined);
}

// ── chronological: normalises newest-first API pages to oldest→newest ────────
{
  const m = (id: string, createdAt: string): Message =>
    ({
      id,
      chatId: "c1",
      content: id,
      editCount: 0,
      isSystem: false,
      isDeleted: false,
      version: 1,
      createdAt,
      reactions: [],
    }) as Message;
  // Newest-first input (what GET /chats/{id|global}/messages returns).
  const desc = [
    m("m3", "2026-07-18T12:02:00Z"),
    m("m2", "2026-07-18T12:01:00Z"),
    m("m1", "2026-07-18T12:00:00Z"),
  ];
  assert.deepStrictEqual(
    chronological(desc).map((x) => x.id),
    ["m1", "m2", "m3"],
    "DESC page → chronological",
  );
  // Already-chronological input (ChatDetail.recentMessages) is a no-op.
  const asc = [...desc].reverse();
  assert.deepStrictEqual(
    chronological(asc).map((x) => x.id),
    ["m1", "m2", "m3"],
    "ASC input unchanged",
  );
  // Does not mutate its input.
  assert.strictEqual(desc[0].id, "m3", "input array not mutated");
  // Equal timestamps → deterministic id tiebreak.
  const tie = [m("b", "2026-07-18T12:00:00Z"), m("a", "2026-07-18T12:00:00Z")];
  assert.deepStrictEqual(
    chronological(tie).map((x) => x.id),
    ["a", "b"],
    "timestamp tie broken by id",
  );
}

// ── peerOf: the uuid in the dm_key that isn't me ─────────────────────────────
{
  const me = "11111111-1111-1111-1111-111111111111";
  const other = "22222222-2222-2222-2222-222222222222";
  assert.strictEqual(peerOf(`${me}:${other}`, me), other);
  assert.strictEqual(peerOf(`${other}:${me}`, me), other);
  assert.strictEqual(peerOf("bad", me), null);
  assert.strictEqual(peerOf(undefined, me), null);
}

// ── chatTitle for global + modmail (localised, with a marker glyph) ──────────
{
  assert.ok(chatTitle({ id: "x", type: "global" } as any).includes("Global"));
  assert.ok(chatTitle({ id: "x", type: "modmail" } as any).includes("Modmail"));
}

// ── clan media URLs: callable + string in bare Bun (no active client → "") ────
{
  // No active client in bare Bun → these return "" ; assert callable + string type.
  assert.strictEqual(typeof clanAvatarUrl("abc"), "string");
  assert.strictEqual(typeof clanBannerUrl("abc"), "string");
}

console.log("community-api: OK");
