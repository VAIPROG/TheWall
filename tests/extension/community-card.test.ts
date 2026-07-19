import assert from "node:assert";
import { clanCard } from "../../src/ui/community/card";

const clan = {
  id: "c1", name: "Snackers<script>", tag: "SNK", ownerVerified: true,
  memberCount: 128, stats: { memberCount: 128, templateCount: 42, onlineCount: 7 },
} as any;

const html = clanCard(clan, { context: "hub" });
assert.ok(html.includes("wd-clancard"), "has card root class");
assert.ok(html.includes("128"), "shows member count");
assert.ok(html.includes("42"), "shows template count");
assert.ok(!html.includes("<script>"), "escapes the clan name (XSS)");
assert.ok(html.includes("&lt;script&gt;") || html.includes("Snackers"), "name present, escaped");
assert.strictEqual(typeof clanCard(clan, { context: "browse" }), "string");
console.log("community-card: OK");
