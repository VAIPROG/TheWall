/**
 * The Wall Dev achievement system — client side.
 *
 * Backend lives at `/api/v2/me/achievements/*` and `/api/v2/admin/achievements`.
 * This module:
 *   - exposes thin async helpers that wrap each endpoint;
 *   - dedupes rapid trigger fires inside one session;
 *   - shows a styled unlock dialog the first time an achievement lands.
 *
 * The unlock dialog deliberately spells out "From The Wall Dev — not the
 * site itself" so users never confuse an extension badge with a
 * filianislost.com one.
 *
 * For `found_the_dev` we additionally show the one-time Discord paint claim
 * line. The actual claim is manual (user pings @vai_prog), so we don't track
 * redemption server-side.
 */
import { Backend } from "./backend";
import { log } from "./log";
import { t } from "./i18n";
import { isWalldevDark } from "./theme";
import { esc, errMsg } from "./helpers";
import { achIcon } from "./icons";
import { getCached, setCached } from "./cache";
import { CACHE_TTL_PROFILE_MS, CACHE_TTL_ACH_CATALOGUE_MS } from "./constants";

export type AchievementRow = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  points: number;
  secret: boolean;
  unlocked_at?: string | null;
};

type GrantResult = { achievement: AchievementRow; was_new: boolean };

const triggeredThisSession = new Set<string>();

/** Idempotent per-page-life trigger so repeated UI events don't re-call. */
function gateOnce(key: string): boolean {
  if (triggeredThisSession.has(key)) return false;
  triggeredThisSession.add(key);
  return true;
}

/**
 * Public: viewer opened VAI's profile. Always fires once per session; the
 * backend takes care of idempotency across sessions.
 */
export async function triggerFoundTheDev(): Promise<void> {
  if (!gateOnce("found_the_dev")) return;
  if (!Backend.on) {
    log.debug("ACHIEVE", "found-the-dev skipped: backend offline");
    return;
  }
  try {
    const res = (await Backend.req(
      "POST",
      "/v2/me/achievements/found-the-dev",
      {},
    )) as GrantResult;
    log.info("ACHIEVE", `found-the-dev was_new=${res.was_new}`);
    if (res.was_new) showUnlock(res.achievement);
  } catch (e: any) {
    log.warn("ACHIEVE", "found-the-dev grant failed: " + errMsg(e));
  }
}

/**
 * Generic UX-event trigger. Wraps the `/v2/me/achievements/event` endpoint
 * which knows the allowlist of meaningful events.
 */
export async function triggerEvent(event: string): Promise<void> {
  if (!gateOnce("event:" + event)) return;
  if (!Backend.on) return;
  try {
    const res = (await Backend.req("POST", "/v2/me/achievements/event", {
      event,
    })) as { new: boolean; achievement?: AchievementRow };
    log.info("ACHIEVE", `event=${event} new=${res?.new}`);
    if (res?.new && res.achievement) showUnlock(res.achievement);
  } catch (e: any) {
    log.warn("ACHIEVE", `event=${event} failed: ${errMsg(e)}`);
  }
}

/**
 * Re-evaluate counter-based achievements against current DB state. Call after
 * actions that bump backend counters (template share, profile save, …).
 */
export async function recheckMine(): Promise<void> {
  if (!Backend.on) return;
  try {
    const res = (await Backend.req(
      "POST",
      "/v2/me/achievements/recheck",
      {},
    )) as { newly_unlocked: string[] };
    log.info("ACHIEVE", `recheck newly=${res?.newly_unlocked?.length || 0}`);
    const newlyIds = res?.newly_unlocked || [];
    if (newlyIds.length) {
      // Pull the catalogue rows so we can render names/icons.
      const all = (await Backend.req(
        "GET",
        "/v2/me/achievements",
      )) as AchievementRow[];
      const byId = new Map(all.map((a) => [a.id, a]));
      for (const id of newlyIds) {
        const row = byId.get(id);
        if (row) showUnlock(row);
      }
    }
  } catch (e: any) {
    log.warn("ACHIEVE", `recheck failed: ${errMsg(e)}`);
  }
}

/**
 * Per-user achievement state. We keep a 1-hour cache (CACHE_TTL_PROFILE_MS)
 * for the Profile pane so it paints instantly on reload, then refetch in the
 * background. After the TTL elapses we go straight to network — the backend
 * already gzips responses, so this cache is a *paint hint*, not a CDN.
 */
export async function listMine(): Promise<AchievementRow[]> {
  if (!Backend.on) {
    return getCached<AchievementRow[]>("ach:mine", CACHE_TTL_PROFILE_MS) || [];
  }
  try {
    const fresh = (await Backend.req("GET", "/v2/me/achievements")) as AchievementRow[];
    setCached("ach:mine", fresh);
    return fresh;
  } catch (e: any) {
    log.warn("ACHIEVE", "listMine failed: " + errMsg(e));
    return getCached<AchievementRow[]>("ach:mine", CACHE_TTL_PROFILE_MS) || [];
  }
}

/**
 * Admin-only achievement catalogue. Cached for CACHE_TTL_ACH_CATALOGUE_MS
 * (~24h) — the catalogue only changes when an admin edits it, and the create
 * flow already pushes the new row into the in-page dropdown.
 */
const CAT_CACHE_KEY = "ach:catalogue";

export async function listCatalogue(): Promise<AchievementRow[]> {
  const cached = getCached<AchievementRow[]>(CAT_CACHE_KEY, CACHE_TTL_ACH_CATALOGUE_MS);
  try {
    const fresh = (await Backend.req(
      "GET",
      "/v2/admin/achievements",
    )) as AchievementRow[];
    setCached(CAT_CACHE_KEY, fresh);
    return fresh;
  } catch {
    return cached || [];
  }
}

/** Synchronous read of the cached catalogue. Used by the admin UI to paint
 *  before the network round-trip lands. */
export function listCatalogueCached(): AchievementRow[] {
  return getCached<AchievementRow[]>(CAT_CACHE_KEY, CACHE_TTL_ACH_CATALOGUE_MS) || [];
}

export type NewAchievement = {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  points: number;
  secret: boolean;
};

export async function adminCreate(body: NewAchievement): Promise<AchievementRow | null> {
  try {
    return (await Backend.req(
      "POST",
      "/v2/admin/achievements",
      body,
    )) as AchievementRow;
  } catch (e: any) {
    log.err("ACHIEVE", `admin create failed: ${errMsg(e)}`);
    throw e;
  }
}

export async function adminGrant(
  userId: string,
  achievementId: string,
): Promise<GrantResult | null> {
  try {
    return (await Backend.req(
      "POST",
      `/v2/admin/users/${userId}/achievements/${achievementId}`,
      {},
    )) as GrantResult;
  } catch (e: any) {
    log.err("ACHIEVE", `admin grant failed: ${errMsg(e)}`);
    return null;
  }
}

export async function adminRevoke(
  userId: string,
  achievementId: string,
): Promise<boolean> {
  try {
    await Backend.req(
      "DELETE",
      `/v2/admin/users/${userId}/achievements/${achievementId}`,
    );
    return true;
  } catch (e: any) {
    log.err("ACHIEVE", `admin revoke failed: ${errMsg(e)}`);
    return false;
  }
}

/** Grant by username — backend resolves the user. Throws on 404 so the UI
 *  can show the "no such user" message; returns null on other errors. */
export async function adminGrantByName(
  username: string,
  achievementId: string,
): Promise<GrantResult | null> {
  return (await Backend.req(
    "POST",
    `/v2/admin/achievements/${achievementId}/by-username`,
    { username },
  )) as GrantResult;
}

export async function adminRevokeByName(
  username: string,
  achievementId: string,
): Promise<boolean> {
  await Backend.req(
    "DELETE",
    `/v2/admin/achievements/${achievementId}/by-username/${encodeURIComponent(username)}`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Unlock dialog
// ---------------------------------------------------------------------------

function injectUnlockCss(): void {
  if (document.getElementById("wd-ach-unlock-css")) return;
  const style = document.createElement("style");
  style.id = "wd-ach-unlock-css";
  style.textContent = `
  @keyframes wd-ach-pop { from { transform:translate(-50%,-50%) scale(.85); opacity:0 } to { transform:translate(-50%,-50%) scale(1); opacity:1 } }
  @keyframes wd-ach-glow { 0%,100% { box-shadow: 0 0 24px rgba(255,210,80,.4), 4px 4px 0 rgba(0,0,0,.6) } 50% { box-shadow: 0 0 40px rgba(255,210,80,.7), 4px 4px 0 rgba(0,0,0,.6) } }
  .wd-ach-host {
    position:fixed; inset:0; z-index:1000003;
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    --bg:#c0c0c0; --text:#000; --light:#fff; --shadow:#808080; --dark:#404040;
    --field:#fff; --fieldtext:#000;
    --title-a:#7a5a00; --title-b:#d4a000;
    --accent:#a87500; --sub:#555;
  }
  .wd-ach-host.wd-dark {
    --bg:#2c2c2c; --text:#fff; --light:#5a5a5a; --shadow:#141414; --dark:#000;
    --field:#0f0f0f; --fieldtext:#fff;
    --title-a:#6a4a00; --title-b:#c49000;
    --accent:#d4a000; --sub:#aaa;
  }
  .wd-ach-back {
    position:absolute; inset:0; background:rgba(0,0,0,.55);
  }
  .wd-ach-dlg {
    position:absolute; left:50%; top:50%;
    transform:translate(-50%,-50%);
    width:380px; max-width:92vw;
    background:var(--bg); color:var(--text);
    border:3px solid; border-color:#fff #2a1a00 #2a1a00 #fff;
    animation:wd-ach-pop .2s ease-out, wd-ach-glow 2s ease-in-out infinite .2s;
  }
  .wd-ach-tb {
    background:linear-gradient(90deg, var(--title-a), var(--title-b));
    color:#fff; font-weight:bold;
    padding:5px 6px;
    display:flex; align-items:center; gap:6px;
    height:22px;
    text-shadow:1px 1px 0 rgba(0,0,0,.45);
  }
  .wd-ach-tb .wd-ach-tb-led {
    width:8px; height:8px; border-radius:50%;
    background:#ffd84a; box-shadow:0 0 4px #ffd84a;
  }
  .wd-ach-tb .wd-ach-tb-spacer { flex:1 }
  .wd-ach-tb .wd-ach-x {
    width:20px; height:18px;
    background:var(--bg); color:var(--text);
    border:1px solid; border-color:#fff #404040 #404040 #fff;
    font:bold 12px Verdana,sans-serif;
    display:flex; align-items:center; justify-content:center;
    cursor:pointer;
  }
  .wd-ach-bd { padding:14px 16px }
  .wd-ach-head {
    display:flex; gap:12px; align-items:flex-start;
    margin-bottom:8px;
  }
  .wd-ach-icon {
    width:56px; height:56px; flex:none;
    display:flex; align-items:center; justify-content:center;
    filter: drop-shadow(2px 2px 3px rgba(0,0,0,.45));
  }
  .wd-ach-icon .wd-ach-svg { display:block }
  .wd-ach-meta { flex:1; min-width:0 }
  .wd-ach-meta .wd-ach-eyebrow {
    font-size:10px; font-weight:bold; color:var(--accent);
    text-transform:uppercase; letter-spacing:1.5px;
    margin-bottom:2px;
  }
  .wd-ach-meta .wd-ach-name {
    font-size:16px; font-weight:bold;
    color:var(--text); line-height:1.2;
    margin-bottom:3px;
  }
  .wd-ach-meta .wd-ach-pts {
    display:inline-block;
    padding:2px 8px; border-radius:3px;
    background:var(--accent); color:#fff;
    font-size:11px; font-weight:bold;
  }
  .wd-ach-desc {
    padding:6px 8px;
    background:var(--field); color:var(--fieldtext);
    border:1px solid; border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset 1px 1px 0 var(--shadow);
    font-size:11px; line-height:1.5;
    margin:6px 0;
  }
  .wd-ach-from {
    font-size:10px; color:var(--sub);
    font-style:italic;
    margin-top:6px;
    text-align:center;
  }
  .wd-ach-prize {
    margin-top:8px;
    padding:8px 10px;
    background:linear-gradient(90deg,rgba(122,62,176,.18),rgba(208,78,192,.18));
    border-left:3px solid #7a3eb0;
    color:var(--text);
    font-size:11px;
    font-weight:bold;
  }
  .wd-ach-btns {
    padding:8px 14px 12px;
    display:flex; gap:6px; justify-content:flex-end;
    background:var(--bg);
    border-top:1px solid var(--shadow);
    box-shadow:inset 0 1px 0 var(--light);
  }
  .wd-ach-btn {
    min-width:84px; padding:5px 14px;
    background:var(--bg); color:var(--text);
    border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:bold 11px "MS Sans Serif",Tahoma,sans-serif;
    cursor:pointer;
  }
  .wd-ach-btn:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    padding:6px 13px 4px 15px;
  }
  `;
  document.head.appendChild(style);
}

function iconChar(name: string): string {
  // Render a real SVG medallion (no emoji). The icon library lives in
  // src/icons.ts and exposes achIcon(name, size). The unlock dialog uses
  // a large 44px medallion in the gold-gradient circle.
  return achIcon(name, 44);
}

/** Show the unlock dialog. Stacks if multiple unlocks fire quickly. */
let unlockQueue: AchievementRow[] = [];
let unlockShowing = false;

function showUnlock(ach: AchievementRow): void {
  unlockQueue.push(ach);
  if (unlockShowing) return;
  drainUnlock();
}

function drainUnlock(): void {
  const ach = unlockQueue.shift();
  if (!ach) { unlockShowing = false; return; }
  unlockShowing = true;
  injectUnlockCss();

  const wrap = document.createElement("div");
  wrap.className = "wd-ach-host" + (isWalldevDark() ? " wd-dark" : "");

  const prizeBlock = ach.id === "found_the_dev"
    ? `<div class="wd-ach-prize">${esc(t("achFoundDevPrize"))}</div>`
    : "";

  wrap.innerHTML = `
    <div class="wd-ach-back"></div>
    <div class="wd-ach-dlg" role="alertdialog" aria-modal="true">
      <div class="wd-ach-tb">
        <span class="wd-ach-tb-led"></span>
        <span>🏆 ${esc(t("achTitle"))}</span>
        <span class="wd-ach-tb-spacer"></span>
        <span class="wd-ach-x" role="button" title="Close">✕</span>
      </div>
      <div class="wd-ach-bd">
        <div class="wd-ach-head">
          <div class="wd-ach-icon">${iconChar(ach.icon)}</div>
          <div class="wd-ach-meta">
            <div class="wd-ach-eyebrow">${esc(t("achTitle"))}</div>
            <div class="wd-ach-name">${esc(ach.name)}</div>
            <span class="wd-ach-pts">+${ach.points} ${esc(t("achPoints"))}</span>
          </div>
        </div>
        <div class="wd-ach-desc">${esc(ach.description)}</div>
        ${prizeBlock}
        <div class="wd-ach-from">${esc(t("achFromDev"))}</div>
      </div>
      <div class="wd-ach-btns">
        <button class="wd-ach-btn">OK</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const close = () => {
    wrap.remove();
    window.removeEventListener("keydown", onKey, true);
    drainUnlock();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); close(); }
  };
  window.addEventListener("keydown", onKey, true);
  wrap.querySelector(".wd-ach-back")?.addEventListener("click", close);
  wrap.querySelector(".wd-ach-x")?.addEventListener("click", close);
  wrap.querySelector(".wd-ach-btn")?.addEventListener("click", close);

  log.ok("ACHIEVE", `unlock dialog shown for "${ach.id}"`);
}
