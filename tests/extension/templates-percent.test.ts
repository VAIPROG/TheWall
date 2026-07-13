/**
 * Tests for the Templates % painted formatters (pure math only; the tile diff
 * is integration and lives behind dynamic imports).
 *
 * Run: bun tests/extension/templates-percent.test.ts
 */
import assert from "node:assert";
import { abbrev, formatPct } from "../../src/ui/templates/percent";

// --- abbrev: compact counts ---
{
  assert.strictEqual(abbrev(0), "0");
  assert.strictEqual(abbrev(999), "999");
  assert.strictEqual(abbrev(1200), "1.2k");
  assert.strictEqual(abbrev(15000), "15k");
  assert.strictEqual(abbrev(1_500_000), "1.5M");
}

// --- formatPct: "NN% · <left> left", dash for empty ---
{
  assert.strictEqual(formatPct(0, 0), "—");
  assert.strictEqual(formatPct(1000, 710), "71% · 290 left");
  assert.strictEqual(formatPct(2000, 800), "40% · 1.2k left");
  assert.strictEqual(formatPct(100, 100), "100% · 0 left");
}

console.log("templates-percent: OK");
