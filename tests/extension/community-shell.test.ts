/**
 * Tests for the Community super-tab shell — screen factories + pane markup.
 *
 * Run: bun tests/extension/community-shell.test.ts
 */
import assert from "node:assert";
import { makeStackScreens, buildCommunityPane } from "../../src/ui/community/shell";

// --- screen factories: hub / thread / clan / browse ---
{
  const s = makeStackScreens();
  const thread = s.thread({ kind: "clan", chatId: "x" }, "Clan chat");
  const clan = s.clan("abc");
  const browse = s.browse();
  assert.strictEqual(typeof s.hub().render, "function");
  assert.strictEqual(typeof thread.render, "function");
  assert.strictEqual(typeof clan.render, "function");
  assert.strictEqual(typeof browse.render, "function");
  // Each stub render hosts its own drill-in container.
  assert.ok(s.hub().render().includes("comm-hub"), "hub render hosts the hub container");
  assert.ok(thread.render().includes("comm-msgs"), "thread render hosts the message list container");
  assert.ok(clan.render().includes("comm-clan"), "clan render hosts the clan container");
  assert.ok(browse.render().includes("comm-browse"), "browse render hosts the browse container");
  assert.strictEqual(thread.title, "Clan chat");
  assert.strictEqual(clan.title, "Clan");
  assert.strictEqual(browse.title, "Browse");
}

// --- pane markup hosts the stack container ---
{
  const html = buildCommunityPane();
  assert.ok(html.includes('data-p="co"'), "pane has data-p=co");
  assert.ok(html.includes('id="comm-stack"'), "pane hosts comm-stack");
}

console.log("community-shell: OK");
