/**
 * 7TV emote integration.
 *
 * Syntax:
 *   :emote:           — global set (global + filian merged)
 *   :channel:emote:   — channel-specific set
 *
 * Configuration:
 *   cfg.emoteChannels — Array of channel descriptors. Each entry is either:
 *     { id: "198633200", name: "filian" }   (preferred)
 *     "filian"                              (legacy: name only; we ship a
 *                                            tiny built-in lookup for the
 *                                            popular twitch logins so old
 *                                            configs keep working)
 *
 *   7TV's REST API is `/v3/users/twitch/{twitch_user_id}` — the path
 *   parameter is the *numeric Twitch user ID*, NOT the login. There is no
 *   login→ID resolver in the public 7TV REST surface, so we either need the
 *   id from the user or a built-in mapping.
 *
 * Public API:
 *   initEmotes()          — fetch (or load from cache) all configured sets
 *   getEmoteMap()         — flat lookup for ":name:" syntax
 *   getEmotesGrouped()    — Map<group_label, Map<name, id>> for the picker
 *   replaceEmotes(html)   — apply both syntaxes to a snippet of HTML
 *   reloadEmotes()        — force refresh
 */
import { cfg } from "./config";
import { log } from "./log";
import { CACHE_TTL_EMOTES_MS } from "./constants";

const CACHE_KEY = "wd_7tv_emotes_v4";
/** Re-export under the local name kept by older call sites. */
const CACHE_TTL_MS = CACHE_TTL_EMOTES_MS;

export type EmoteChannel = { id: string; name: string };

/** Tiny built-in lookup so we can still resolve a few well-known logins
 *  without forcing every user to hand-enter their Twitch ID. */
const KNOWN_TWITCH_IDS: Record<string, string> = {
  filian: "198633200",
};

interface CacheEntry { ts: number; groups: Record<string, Record<string, string>> }

let groups: Map<string, Map<string, string>> = new Map();
let globalMap: Map<string, string> = new Map();
let loadPromise: Promise<void> | null = null;

function rebuildGlobal(): void {
  globalMap = new Map();
  const g = groups.get("global");
  if (g) for (const [n, i] of g) globalMap.set(n, i);
  const fil = groups.get("#filian");
  if (fil) for (const [n, i] of fil) if (!globalMap.has(n)) globalMap.set(n, i);
}

function loadFromCache(): boolean {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.ts > CACHE_TTL_MS) return false;
    groups = new Map();
    for (const [k, v] of Object.entries(entry.groups)) groups.set(k, new Map(Object.entries(v)));
    rebuildGlobal();
    return groups.size > 0;
  } catch { return false; }
}

function saveToCache(): void {
  try {
    const obj: Record<string, Record<string, string>> = {};
    for (const [k, v] of groups) obj[k] = Object.fromEntries(v);
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), groups: obj } as CacheEntry));
  } catch {}
}

async function fetchEmoteSet(url: string): Promise<Map<string, string>> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`7TV ${r.status}`);
  const j = await r.json();
  const emotes: Array<{ name: string; id: string }> = j?.emote_set?.emotes ?? j?.emotes ?? [];
  const m = new Map<string, string>();
  for (const e of emotes) if (e?.name && e?.id) m.set(e.name, e.id);
  return m;
}

async function fetchByTwitchId(twitchId: string): Promise<Map<string, string>> {
  const url = `https://7tv.io/v3/users/twitch/${encodeURIComponent(twitchId)}`;
  return fetchEmoteSet(url);
}

/** Coerce a raw config entry into a canonical {id, name} pair. Returns null
 *  if we can't figure out a Twitch ID — the caller skips it. */
function resolveChannel(raw: string | EmoteChannel): EmoteChannel | null {
  if (typeof raw === "string") {
    const v = raw.trim();
    if (!v) return null;
    if (/^\d+$/.test(v)) return { id: v, name: v };
    const id = KNOWN_TWITCH_IDS[v.toLowerCase()];
    if (id) return { id, name: v.toLowerCase() };
    return null;
  }
  if (raw && raw.id && raw.name) return { id: String(raw.id), name: String(raw.name) };
  return null;
}

function logTwitchResolveFail(raw: string | EmoteChannel): void {
  if (typeof raw === "string") {
    log.warn(
      "7TV",
      `don't know Twitch ID for login "${raw}" — add { id, name } to cfg.emoteChannels`,
    );
  } else {
    log.warn("7TV", "channel entry missing id or name", raw);
  }
}

export async function initEmotes(force = false): Promise<void> {
  if (!force && groups.size > 0) return;
  if (!force && loadFromCache()) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    groups = new Map();
    // 1. 7TV global set.
    try {
      const g = await fetchEmoteSet("https://7tv.io/v3/emote-sets/global");
      groups.set("global", g);
      log.ok("7TV", `global set: ${g.size} emotes`);
    } catch (e) { log.warn("7TV", "global set fetch failed", e); }

    // 2. Channels (filian always included, folded into "global").
    const raw = (cfg.emoteChannels && cfg.emoteChannels.length
      ? cfg.emoteChannels.slice()
      : []) as Array<string | EmoteChannel>;
    // Ensure filian is present.
    if (!raw.some(ch => {
      const r = resolveChannel(ch);
      return r && r.name.toLowerCase() === "filian";
    })) {
      raw.push({ id: KNOWN_TWITCH_IDS.filian, name: "filian" });
    }
    const seen = new Set<string>();
    for (const entry of raw) {
      const ch = resolveChannel(entry);
      if (!ch) { logTwitchResolveFail(entry); continue; }
      if (seen.has(ch.id)) { log.trace("7TV", `dedupe channel ${ch.name} (${ch.id})`); continue; }
      seen.add(ch.id);
      try {
        const set = await fetchByTwitchId(ch.id);
        if (set.size) {
          groups.set(`#${ch.name}`, set);
          log.ok("7TV", `channel #${ch.name} (${ch.id}): ${set.size} emotes`);
        } else {
          log.warn("7TV", `channel #${ch.name} (${ch.id}): empty set`);
        }
      } catch (e) { log.warn("7TV", `channel #${ch.name}(${ch.id}) fetch failed`, e); }
    }
    rebuildGlobal();
    saveToCache();
    log.ok("7TV", `init complete: ${groups.size} sets, ${globalMap.size} global emotes`);
  })();

  try { await loadPromise; } finally { loadPromise = null; }
}

export async function reloadEmotes(): Promise<void> {
  try { localStorage.removeItem(CACHE_KEY); } catch {}
  return initEmotes(true);
}

export function getEmoteMap(): Map<string, string> { return globalMap; }

export function getEmotesGrouped(): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  out.set("global", globalMap);
  for (const [k, v] of groups) {
    if (k === "global" || k === "#filian") continue;
    out.set(k, v);
  }
  return out;
}

function imgTag(id: string, name: string): string {
  // decoding="async" keeps (animated-webp) emote decode off the main paint
  // path; height matches the .wd-emote CSS so layout doesn't shift when the
  // image arrives. 1x is the smallest 7TV rendition.
  return `<img src="https://cdn.7tv.app/emote/${id}/1x.webp" alt=":${name}:" class="wd-emote" loading="lazy" decoding="async" height="20">`;
}

export function replaceEmotes(html: string): string {
  if (groups.size === 0) return html;
  let out = html.replace(/:([a-zA-Z0-9_]+):([a-zA-Z0-9_]+):/g, (m, ch: string, name: string) => {
    const set = groups.get(`#${ch}`);
    if (!set) return m;
    const id = set.get(name);
    return id ? imgTag(id, `${ch}:${name}`) : m;
  });
  out = out.replace(/:([a-zA-Z0-9_]+):/g, (m, name: string) => {
    const id = globalMap.get(name);
    return id ? imgTag(id, name) : m;
  });
  return out;
}
