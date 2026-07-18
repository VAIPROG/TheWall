/**
 * Unit tests for the PURE Community message renderer (`renderMessage`).
 * Bare Bun + node:assert (mirrors tests/extension/templates-*.test.ts). No DOM:
 * render.ts imports only string transforms + the DOM-free api facade.
 *
 * Run: bun tests/extension/community-render.test.ts
 */
import assert from "node:assert";
import { renderMessage, fmtTime } from "../../src/ui/community/render";
import type { Message } from "../../src/ui/community/api";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    chatId: "c1",
    authorId: "u1",
    authorUsername: "alice",
    content: "hello world",
    replyToId: null,
    editedAt: null,
    editCount: 0,
    deletedAt: null,
    deletedBy: null,
    isSystem: false,
    isDeleted: false,
    version: 1,
    createdAt: "2026-07-18T12:00:00.000Z",
    reactions: [],
    ...over,
  };
}

// --- normal message: body rendered, author escaped, data-mid present ---
{
  const html = renderMessage(msg({ content: "hello **world**" }));
  assert.ok(html.includes('data-mid="m1"'), "carries data-mid");
  assert.ok(html.includes('data-ver="1"'), "carries data-ver for optimistic edit");
  assert.ok(html.includes(">alice<"), "author name shown");
  assert.ok(html.includes("<b>world</b>"), "markdown bold rendered");
}

// --- XSS: HTML-special + bold + mention are escaped/transformed, not injected ---
{
  const html = renderMessage(
    msg({ content: "<img src=x onerror=alert(1)> **bold** hi @bob" }),
  );
  assert.ok(!html.includes("<img src=x onerror=alert(1)>"), "raw <img> not injected");
  assert.ok(html.includes("&lt;img"), "angle brackets escaped");
  assert.ok(html.includes("<b>bold</b>"), "bold transformed");
  assert.ok(
    html.includes('class="wp-mention" data-user="bob"'),
    "@mention transformed into a span",
  );
}

// --- author name is escaped (no raw injection via username) ---
{
  const html = renderMessage(msg({ authorUsername: "<script>x</script>" }));
  assert.ok(!html.includes("<script>x</script>"), "author name not raw-injected");
  assert.ok(html.includes("&lt;script&gt;"), "author name escaped");
}

// --- deleted message: placeholder, no raw content, no edit/delete ---
{
  const html = renderMessage(
    msg({ isDeleted: true, content: "secret text @nope" }),
    { meId: "u1" },
  );
  assert.ok(html.includes("[deleted]"), "shows deleted placeholder");
  assert.ok(!html.includes("secret text"), "raw content not shown");
  assert.ok(!html.includes('data-action="edit"'), "no edit on deleted");
  assert.ok(!html.includes('data-action="delete"'), "no delete on deleted");
}

// --- own message: edit + delete present ---
{
  const html = renderMessage(msg({ authorId: "u1" }), { meId: "u1" });
  assert.ok(html.includes('data-action="edit"'), "own message has edit");
  assert.ok(html.includes('data-action="delete"'), "own message has delete");
  assert.ok(!html.includes('data-action="report"'), "own message has no report");
}

// --- other's message: no edit/delete; report present ---
{
  const html = renderMessage(msg({ authorId: "u2" }), { meId: "u1" });
  assert.ok(!html.includes('data-action="edit"'), "other's message: no edit");
  assert.ok(!html.includes('data-action="delete"'), "other's message: no delete");
  assert.ok(html.includes('data-action="report"'), "other's message: report present");
}

// --- moderator sees pin + delete on others' messages (backend permits mod
// deletion in clan/global/modmail chats; DMs never set canModerate) ---
{
  const html = renderMessage(msg({ authorId: "u2" }), { meId: "u1", canModerate: true });
  assert.ok(html.includes('data-action="pin"'), "moderator sees pin");
  assert.ok(html.includes('data-action="delete"'), "moderator sees delete on others' messages");
  assert.ok(!html.includes('data-action="edit"'), "moderator still cannot edit others' messages");
}

// --- reactions: chips with counts + is-on when reactedByMe ---
{
  const html = renderMessage(
    msg({
      reactions: [
        { emoji: "👍", count: 3, reactedByMe: true },
        { emoji: "🔥", count: 1, reactedByMe: false },
      ],
    }),
  );
  assert.ok(html.includes("wd-comm-react is-on"), "reacted-by-me chip is on");
  assert.ok(html.includes(">3<"), "count 3 rendered");
  assert.ok(html.includes(">1<"), "count 1 rendered");
  assert.ok(
    html.includes(`data-react="${encodeURIComponent("👍")}"`),
    "emoji URL-encoded in data attr",
  );
  // The un-reacted chip must NOT carry the is-on class.
  assert.ok(
    html.includes(`data-react="${encodeURIComponent("🔥")}" data-mid="m1"`),
    "second chip present without is-on",
  );
}

// --- edited marker only when editedAt is set ---
{
  assert.ok(!renderMessage(msg()).includes("(edited)"), "no edited marker by default");
  assert.ok(
    renderMessage(msg({ editedAt: "2026-07-18T13:00:00.000Z" })).includes("(edited)"),
    "edited marker present when editedAt set",
  );
}

// --- fmtTime: valid date → non-empty; garbage → "" ---
{
  assert.ok(fmtTime("2026-07-18T12:00:00.000Z").length > 0, "valid date formats");
  assert.strictEqual(fmtTime("not-a-date"), "", "bad date → empty string");
}

console.log("community-render: OK");
