/**
 * Tests for client-side domainsWhitelist enforcement (pure).
 *
 * Run: bun tests/extension/domain-guard.test.ts
 */
import assert from "node:assert";
import { isAllowedOnDomain, domainsOf } from "../../src/domain-guard";

// --- isAllowedOnDomain ---
{
  // empty/absent → allowed everywhere
  assert.strictEqual(isAllowedOnDomain(undefined, "filianislost.com"), true);
  assert.strictEqual(isAllowedOnDomain([], "anything"), true);
  // exact hostname match
  assert.strictEqual(isAllowedOnDomain(["filianislost.com"], "filianislost.com"), true);
  assert.strictEqual(isAllowedOnDomain(["wplace.live"], "filianislost.com"), false);
  // subdomains of a listed domain are allowed
  assert.strictEqual(isAllowedOnDomain(["filianislost.com"], "www.filianislost.com"), true);
  assert.strictEqual(isAllowedOnDomain(["*.filianislost.com"], "sub.filianislost.com"), true);
  // case-insensitive
  assert.strictEqual(isAllowedOnDomain(["Filianislost.COM"], "filianislost.com"), true);
  // a sneaky suffix that isn't a real subdomain boundary is rejected
  assert.strictEqual(isAllowedOnDomain(["place.live"], "evilplace.live"), false);
}

// --- domainsOf: pull the list from an object or JSON string ---
{
  assert.deepStrictEqual(domainsOf({ domainsWhitelist: ["a", "b"] }), ["a", "b"]);
  assert.deepStrictEqual(domainsOf('{"domainsWhitelist":["a"]}'), ["a"]);
  assert.strictEqual(domainsOf({ nope: 1 }), undefined);
  assert.strictEqual(domainsOf("not json"), undefined);
  assert.strictEqual(domainsOf({ domainsWhitelist: "notarray" }), undefined);
}

console.log("domain-guard: OK");
