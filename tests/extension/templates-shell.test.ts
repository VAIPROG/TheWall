/**
 * Tests for the Templates super-tab shell — screen factories + pane markup.
 *
 * Run: bun tests/extension/templates-shell.test.ts
 */
import assert from "node:assert";
import { makeStackScreens, buildTemplatesPane } from "../../src/ui/templates/shell";

// --- screen factories: browse / detail / publish ---
{
  const s = makeStackScreens();
  const detail = s.detail("abc");
  const publish = s.publish({});
  assert.strictEqual(typeof s.browse().render, "function");
  assert.strictEqual(typeof detail.render, "function");
  assert.strictEqual(typeof publish.render, "function");
  // detail embeds its id; publish is a distinct titled screen.
  assert.ok(detail.render().includes("abc"), "detail render embeds id");
  assert.strictEqual(publish.title, "Publish");
}

// --- pane markup hosts the stack container ---
{
  const html = buildTemplatesPane();
  assert.ok(html.includes('data-p="tp"'), "pane has data-p=tp");
  assert.ok(html.includes('id="tpl-stack"'), "pane hosts tpl-stack");
}

console.log("templates-shell: OK");
