/**
 * Tests for the foundation kit primitives — class mapping, readout formatting,
 * status/badge variants, and HTML escaping.
 *
 * Run: bun tests/extension/kit-primitives.test.ts
 */
import assert from "node:assert";
import {
  button,
  segmented,
  statusPill,
  statusText,
  readout,
  badge,
  emptyState,
} from "../../src/ui/kit/primitives";

// --- button: variant / size / state → classes ---
{
  const primary = button("Save", { variant: "primary", full: true });
  assert.ok(primary.includes("wd-btn"), "base class");
  assert.ok(primary.includes("wd-btn--primary"), "primary variant");
  assert.ok(primary.includes("wd-btn--full"), "full width");
  assert.ok(primary.includes(">Save<") || primary.includes("Save</button>"), "label present");

  const def = button("Plain");
  assert.ok(!def.includes("wd-btn--default"), "default variant adds no modifier");

  const danger = button("Delete", { variant: "danger", size: "sm", disabled: true });
  assert.ok(danger.includes("wd-btn--danger"), "danger variant");
  assert.ok(danger.includes("wd-btn--sm"), "small size");
  assert.ok(danger.includes("disabled"), "disabled attr");

  const working = button("Go", { working: true });
  assert.ok(working.includes("is-working"), "working class");
  assert.ok(working.includes("wd-spin"), "spinner shown when working");
}
console.log("kit-primitives.test.ts: button OK");

// --- button: emoji icon passes through escaped, data attrs render ---
{
  const b = button("Load", { icon: "🖼", attrs: { "data-x": "1" } });
  assert.ok(b.includes("🖼"), "emoji icon passes through");
  assert.ok(b.includes('data-x="1"'), "data attribute rendered");
}
console.log("kit-primitives.test.ts: button icon+attrs OK");

// --- segmented: active option gets is-on ---
{
  const seg = segmented(
    [
      { value: "list", label: "List" },
      { value: "grid", label: "Grid" },
    ],
    "grid",
  );
  assert.ok(seg.includes('data-seg="grid"'), "value attr");
  const gridOn = /data-seg="grid"[^>]*class="is-on"|class="is-on"[^>]*data-seg="grid"/.test(seg);
  // class is rendered before data-seg in our template:
  assert.ok(seg.includes('class="is-on" data-seg="grid"'), "active option is-on");
  assert.ok(seg.includes('class="" data-seg="list"'), "inactive option not on");
}
console.log("kit-primitives.test.ts: segmented OK");

// --- status pill / text ---
{
  assert.ok(statusPill("err", "failed").includes("wd-pill--err"), "err pill class");
  assert.ok(statusText("ok", "saved").includes("wd-status--ok"), "ok status class");
  assert.ok(statusText("muted", "x").includes("wd-status--muted"), "muted status class");
}
console.log("kit-primitives.test.ts: status OK");

// --- readout: separators + boxed ---
{
  const r = readout(["X 1024", "Y 768", "100%"]);
  assert.ok(r.includes("wd-readout"), "readout class");
  assert.strictEqual((r.match(/class="sep"/g) || []).length, 2, "n-1 separators");
  assert.ok(r.includes("X 1024"), "value present");
  assert.ok(readout([1, 2], { boxed: true }).includes("wd-readout--boxed"), "boxed modifier");
}
console.log("kit-primitives.test.ts: readout OK");

// --- badge kinds ---
{
  assert.ok(badge("OWNER", "owner").includes("wd-badge--owner"), "owner badge");
  assert.ok(!badge("x").includes("wd-badge--"), "plain badge has no kind modifier");
}
console.log("kit-primitives.test.ts: badge OK");

// --- escaping: no HTML injection through labels/values ---
{
  const b = button("<b>x</b> & 'q'");
  assert.ok(!b.includes("<b>x</b>"), "label markup escaped");
  assert.ok(b.includes("&lt;b&gt;"), "angle brackets escaped");
  assert.ok(emptyState("<script>").includes("&lt;script&gt;"), "empty-state message escaped");
}
console.log("kit-primitives.test.ts: escaping OK");

console.log("kit-primitives.test.ts: all assertions passed");
