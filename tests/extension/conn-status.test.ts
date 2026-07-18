/**
 * Tests for the connection-status resolver — the pure core behind the
 * Settings connection card. Historically the card checked cfg.backendToken
 * (a mirror that was never written after the multi-backend migration) and
 * showed "not connected" over healthy sessions; the resolver derives status
 * from the client snapshot instead.
 *
 * Run: bun tests/extension/conn-status.test.ts
 */
import assert from "node:assert";
import { resolveConnState, CONN_LIVE_WINDOW_MS } from "../../src/backend/conn-status";

const NOW = 1_800_000_000_000;

// --- 1. token + url + enabled = connected, regardless of any legacy flag ---
{
  const st = resolveConnState({ enabled: true, hasUrl: true, hasToken: true, now: NOW });
  assert.strictEqual(st.connected, true, "token+url+enabled is connected");
  assert.strictEqual(st.who, "connected", "placeholder name until identity loads");
  assert.strictEqual(st.live, false, "no evidence yet → not live");
}
console.log("conn-status.test.ts: basic connected OK");

// --- 2. any missing leg → not connected ---
{
  assert.strictEqual(
    resolveConnState({ enabled: false, hasUrl: true, hasToken: true, now: NOW }).connected,
    false, "disabled backend");
  assert.strictEqual(
    resolveConnState({ enabled: true, hasUrl: false, hasToken: true, now: NOW }).connected,
    false, "no url");
  assert.strictEqual(
    resolveConnState({ enabled: true, hasUrl: true, hasToken: false, now: NOW }).connected,
    false, "no token");
  assert.strictEqual(
    resolveConnState({ enabled: false, hasUrl: false, hasToken: false, now: NOW }).who,
    "", "disconnected has no display name");
}
console.log("conn-status.test.ts: missing legs OK");

// --- 3. identity present → live + named ---
{
  const st = resolveConnState({
    enabled: true, hasUrl: true, hasToken: true, username: "vai", now: NOW,
  });
  assert.strictEqual(st.live, true, "cached identity proves a successful session call");
  assert.strictEqual(st.who, "vai");
}
console.log("conn-status.test.ts: identity liveness OK");

// --- 4. recent successful request → live; stale one → not live ---
{
  const fresh = resolveConnState({
    enabled: true, hasUrl: true, hasToken: true,
    lastOkAt: NOW - CONN_LIVE_WINDOW_MS + 1000, now: NOW,
  });
  assert.strictEqual(fresh.live, true, "recent request counts as live");

  const stale = resolveConnState({
    enabled: true, hasUrl: true, hasToken: true,
    lastOkAt: NOW - CONN_LIVE_WINDOW_MS - 1000, now: NOW,
  });
  assert.strictEqual(stale.live, false, "stale request is no longer evidence");
  assert.strictEqual(stale.connected, true, "…but the session itself still counts");
}
console.log("conn-status.test.ts: lastOkAt window OK");

// --- 5. liveness never applies while disconnected ---
{
  const st = resolveConnState({
    enabled: true, hasUrl: true, hasToken: false,
    username: "ghost", lastOkAt: NOW, now: NOW,
  });
  assert.strictEqual(st.connected, false);
  assert.strictEqual(st.live, false, "no token → evidence is moot");
}
console.log("conn-status.test.ts: disconnected gating OK");

console.log("conn-status.test.ts: all assertions passed");
