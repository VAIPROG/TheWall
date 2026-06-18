/**
 * Generic localStorage cache with optional TTLs.
 *
 * Why this exists:
 *   Several lists in the extension (the user's own achievements, the public /
 *   clan template lists, the signal archive) don't change every second, but
 *   we'd previously re-fetch them on every navigation. On a slow connection
 *   that meant the Profile and Templates panes flashed empty for a second or
 *   two before the network responded. With a small client-side cache we can
 *   *paint immediately from last-known data*, then refetch in the background.
 *
 *   The backend already sends gzipped responses, so this is purely about
 *   getting pixels on screen faster — it's not a CDN. We do NOT replace the
 *   network round-trip; we just complement it.
 *
 * Storage layout:
 *   localStorage["wd_cache_v1__<key>"] = { ts: number, data: T }
 *
 * The PREFIX is versioned (`wd_cache_v1__`) so a future schema change can
 * silently invalidate every old entry by bumping `V1` to `V2`.
 *
 * Public API:
 *   getCached<T>(key, maxAgeMs?)  read; returns null on miss or stale
 *   setCached(key, data)          write a fresh entry
 *   clearCached(key)              drop one key
 *   clearAllCache()               drop every wd_cache_v1__* entry
 *
 * Each TTL has a named constant in src/constants.ts (CACHE_TTL_PROFILE_MS,
 * CACHE_TTL_TEMPLATES_MS, …) so the policy lives in one place.
 */
import { log } from "./log";
import { errMsg } from "./helpers";

const PREFIX = "wd_cache_v1__";

interface Envelope<T> { ts: number; data: T; }

function read<T>(key: string): Envelope<T> | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const env = JSON.parse(raw) as Envelope<T>;
    if (typeof env.ts !== "number") return null;
    return env;
  } catch { return null; }
}

function write<T>(key: string, data: T): void {
  try {
    const env: Envelope<T> = { ts: Date.now(), data };
    localStorage.setItem(PREFIX + key, JSON.stringify(env));
    log.trace("CACHE", `set ${key}`);
  } catch (e: any) {
    log.warn("CACHE", `write ${key} failed: ${errMsg(e)}`);
  }
}

/** Read a cached entry. Returns null if missing or older than `maxAgeMs`
 *  (when provided). Without a TTL the entry is considered fresh forever. */
export function getCached<T>(key: string, maxAgeMs?: number): T | null {
  const env = read<T>(key);
  if (!env) return null;
  if (maxAgeMs && Date.now() - env.ts > maxAgeMs) {
    log.trace("CACHE", `stale ${key} (age ${Date.now() - env.ts}ms > ${maxAgeMs}ms)`);
    return null;
  }
  return env.data;
}

export function setCached<T>(key: string, data: T): void {
  write(key, data);
}

export function clearCached(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
    log.trace("CACHE", `cleared ${key}`);
  } catch { /* ignore */ }
}

/** Drop every wd_cache_v1__* entry. Wired up to a future "clear cache"
 *  Settings button; safe to call from the console as well. */
export function clearAllCache(): void {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) keys.push(k);
  }
  for (const k of keys) localStorage.removeItem(k);
  log.ok("CACHE", `cleared ${keys.length} entries`);
}
