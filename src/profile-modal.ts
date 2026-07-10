/**
 * Public profile modal — shown when clicking a username/mention anywhere.
 * Resolves usernames to UUIDs via /clan/members (cached) and then fetches
 * /api/v2/users/{id} for the rich payload.
 *
 * Win95-themed and follows the same dark/light auto-detection as dialog.ts.
 */
import { getActiveClient, api } from "./backend/index";

// Public-profile reads still use the V2 user surface (rich shape the modal
// renders). They resolve against the API root, not the V3 base.
// TODO(phase3): move to /api/v3/users/{ref} once the modal adopts the V3 shape.
function pmReq<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const client = getActiveClient();
  if (!client) return Promise.reject(new Error("backend offline"));
  return client.req<T>({ method, path, body, root: true });
}
function pmRoot(): string {
  return getActiveClient()?.rootUrl ?? "";
}
import { esc, errMsg } from "./helpers";
import { replaceEmotes } from "./emoji";
import { promptDlg, errorDlg, infoDlg } from "./dialog";
import { isWalldevDark } from "./theme";
import { t, pluralize } from "./i18n";
import { triggerFoundTheDev } from "./achievements";

let modalEl: HTMLElement | null = null;
const idCache = new Map<string, string>();

function injectCss(): void {
  if (document.getElementById("wd-profile-modal-css")) return;
  const style = document.createElement("style");
  style.id = "wd-profile-modal-css";
  style.textContent = `
  @keyframes wd-pm-pop { from { transform:translate(-50%,-50%) scale(.9); opacity:0 } to { transform:translate(-50%,-50%) scale(1); opacity:1 } }
  .wd-pm-host {
    position:fixed; inset:0; z-index:1000001;
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    --bg:#c0c0c0; --text:#000; --light:#fff; --shadow:#808080; --dark:#404040;
    --field:#fff; --fieldtext:#000;
    --title-a:#000080; --title-b:#1084d0;
    --accent:#000080; --sub:#555;
  }
  .wd-pm-host.wd-dark {
    --bg:#2c2c2c; --text:#fff; --light:#5a5a5a; --shadow:#141414; --dark:#000;
    --field:#0f0f0f; --fieldtext:#fff;
    --title-a:#3838aa; --title-b:#1084d0;
    --accent:#2889ff; --sub:#aaa;
  }
  .wd-pm-back { position:absolute; inset:0; background:rgba(0,0,0,.45) }
  .wd-pm-dlg {
    position:absolute; left:50%; top:42%;
    transform:translate(-50%,-50%);
    width:380px; max-width:92vw;
    background:var(--bg); color:var(--text);
    border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:
      inset -1px -1px 0 var(--shadow),
      inset  1px  1px 0 var(--bg),
      4px 4px 0 rgba(0,0,0,.6);
    animation:wd-pm-pop .15s ease-out;
  }
  .wd-pm-tb {
    background:linear-gradient(90deg, var(--title-a), var(--title-b));
    color:#fff; font-weight:bold; font-size:12px;
    padding:3px 3px 3px 6px;
    display:flex; align-items:center; justify-content:space-between;
    height:20px; line-height:14px;
  }
  .wd-pm-tb-title { display:flex; align-items:center; gap:6px }
  .wd-pm-led { width:8px; height:8px; border-radius:50%;
    background:#3f6; box-shadow:0 0 4px #3f6, inset 0 0 1px rgba(255,255,255,.5) }
  .wd-pm-x {
    width:18px; height:16px;
    display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--text);
    border:1px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:bold 10px Verdana,sans-serif; cursor:pointer; padding:0;
  }
  .wd-pm-x:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
    padding:1px 0 0 1px;
  }
  .wd-pm-bd { padding:12px; min-height:140px; background:var(--bg) }
  .wd-pm-bio {
    margin:8px 0; padding:8px;
    background:var(--field); color:var(--fieldtext);
    border-left:3px solid var(--accent);
    border:1px solid;
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset 1px 1px 0 var(--shadow);
    font-size:12px; line-height:1.4;
  }
  .wd-pm-links { display:flex; flex-wrap:wrap; gap:4px; margin:6px 0 }
  .wd-pm-links a {
    display:inline-flex; align-items:center; gap:4px;
    padding:3px 8px;
    background:var(--bg); color:var(--accent);
    border:1px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    text-decoration:none; font-size:11px;
  }
  .wd-pm-links a:hover { text-decoration:underline }
  .wd-pm-pin-grid { display:flex; gap:4px; margin-top:4px }
  .wd-pm-pin {
    width:52px; height:52px;
    background-size:cover; background-position:center;
    border:1px solid; border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset 1px 1px 0 var(--shadow);
    cursor:pointer; image-rendering:pixelated;
  }
  .wd-pm-pin:hover { outline:2px solid var(--accent); outline-offset:-1px }
  .wd-pm-section-h {
    font-size:11px; font-weight:bold;
    margin:10px 0 4px; color:var(--text);
    border-bottom:1px solid var(--shadow);
    box-shadow:inset 0 -1px 0 var(--bg);
    padding-bottom:2px;
  }
  .wd-pm-meta { color:var(--sub); font-size:11px }
  .wd-pm-btns {
    padding:8px 12px 10px;
    display:flex; gap:6px; justify-content:flex-end;
    background:var(--bg);
    border-top:1px solid var(--shadow);
    box-shadow:inset 0 1px 0 var(--light);
  }
  .wd-pm-btn {
    min-width:96px; padding:5px 14px;
    background:var(--bg); color:var(--text);
    border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    cursor:pointer;
  }
  .wd-pm-btn.primary { font-weight:bold }
  .wd-pm-btn:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
    padding:6px 13px 4px 15px;
  }
  .wd-pm-avatar {
    width:64px; height:64px;
    border:2px solid; border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset 1px 1px 0 var(--shadow);
  }
  `;
  document.head.appendChild(style);
}

function ensureModal(): HTMLElement {
  if (modalEl) return modalEl;
  injectCss();
  const el = document.createElement("div");
  el.className = "wd-pm-host";
  el.style.display = "none";
  el.innerHTML = `
    <div class="wd-pm-back"></div>
    <div class="wd-pm-dlg" role="dialog" aria-modal="true">
      <div class="wd-pm-tb">
        <span class="wd-pm-tb-title"><span class="wd-pm-led"></span><span>Profile</span></span>
        <span class="wd-pm-x" role="button" title="Close">✕</span>
      </div>
      <div class="wd-pm-bd">loading…</div>
      <div class="wd-pm-btns">
        <button class="wd-pm-btn wd-pm-dm">💬 Send DM</button>
        <button class="wd-pm-btn wd-pm-close primary">Close</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  const close = () => { el.style.display = "none"; };
  el.querySelector(".wd-pm-back")?.addEventListener("click", close);
  el.querySelector(".wd-pm-x")?.addEventListener("click", close);
  el.querySelector(".wd-pm-close")?.addEventListener("click", close);
  // Live theme sync while modal is open.
  document.addEventListener("wd:theme-changed", () => applyTheme(el));
  modalEl = el;
  return el;
}

async function resolveUsernameToId(name: string): Promise<string | null> {
  if (idCache.has(name)) return idCache.get(name)!;
  try {
    const roster = await pmReq("GET", "/clan/members") as any[];
    for (const m of roster || []) if (m.username && m.id) idCache.set(m.username, m.id);
  } catch {}
  return idCache.get(name) ?? null;
}

function applyTheme(el: HTMLElement): void {
  el.classList.toggle("wd-dark", isWalldevDark());
}

export async function openProfile(usernameOrId: string): Promise<void> {
  const el = ensureModal();
  applyTheme(el);
  el.style.display = "block";
  const body = el.querySelector(".wd-pm-bd") as HTMLElement;
  const dmBtn = el.querySelector(".wd-pm-dm") as HTMLButtonElement;
  body.innerHTML = `<div style="color:var(--sub);padding:18px;text-align:center">Loading…</div>`;
  dmBtn.style.display = "none";

  const isUuid = /^[0-9a-f-]{36}$/i.test(usernameOrId);
  const id = isUuid ? usernameOrId : await resolveUsernameToId(usernameOrId);
  if (!id) {
    body.innerHTML = `<div style="color:#b33;padding:8px">User "${esc(usernameOrId)}" not found in the visible roster.</div>`;
    return;
  }

  let prof: any, ach: any[] = [];
  try {
    prof = await pmReq("GET", `/v2/users/${id}`);
  } catch (e: any) {
    body.innerHTML = `<div style="color:#b33;padding:8px">Failed to load profile: ${esc(errMsg(e))}</div>`;
    return;
  }
  try { ach = (await pmReq("GET", `/v2/users/${id}/achievements`)) as any[]; } catch {}

  const displayName = prof.username || "unknown";
  const vai = displayName.trim().toLowerCase() === "vai";
  if (vai) triggerFoundTheDev();

  const bio = prof.bio
    ? `<div class="wd-pm-bio">${replaceEmotes(esc(prof.bio))}</div>`
    : "";
  const links = (prof.social_links || []).map((l: any) => {
    const safeUrl = (l.url || "").replace(/"/g, "&quot;");
    return `<a href="${safeUrl}" target="_blank" rel="noopener">${esc(l.label || l.url || "link")}</a>`;
  }).join("");
  const pins = (prof.pinned_templates || []).map((p: any) =>
    `<div class="wd-pm-pin" data-tpl="${esc(p.id)}" title="${esc(p.name || "")}"
       style="background-image:url('${pmRoot()}/v2/templates/${encodeURIComponent(p.id)}/preview?size=64')"></div>`
  ).join("");
  const achCount = ach?.length ?? 0;

  // Localized role line — handles global + clan roles + VAI easter egg.
  const localiseGlobal = (r: string) => {
    const k = (r || "user").toLowerCase();
    if (k === "owner")     return t("profileRoleOwner");
    if (k === "admin")     return t("profileRoleAdmin");
    if (k === "moderator") return t("profileRoleModerator");
    return t("profileRoleUser");
  };
  const localiseClan = (r: string | undefined) => {
    const k = (r || "").toLowerCase();
    if (k === "admin")     return t("profileClanRoleAdmin");
    if (k === "moderator") return t("profileClanRoleModerator");
    if (k === "member")    return t("profileClanRoleMember");
    return null;
  };
  const globalRole = localiseGlobal(prof.global_role);
  const clanRole   = localiseClan(prof.primary_clan_role);
  const clanName   = prof.primary_clan_name || prof.clans?.[0]?.clan_name || null;
  const roleLine = vai
    ? `<span style="background:linear-gradient(90deg,#7a3eb0,#d04ec0);color:#fff;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:bold;letter-spacing:.5px">${esc(t("profileVaiDevBadge"))}</span>` +
      (clanName ? ` · ${esc(clanName)}` : "")
    : [
        esc(globalRole),
        clanRole ? esc(clanRole) : null,
        clanName ? `· ${esc(clanName)}` : null,
      ].filter(Boolean).join(" ");

  const achLabel = pluralize(achCount, "profileAchievement");
  const vaiNote  = vai
    ? `<div style="margin:6px 0;padding:4px 8px;background:rgba(122,62,176,.16);border-left:3px solid #7a3eb0;font-style:italic;font-size:11px">${esc(t("profileVaiDevNote"))}</div>`
    : "";

  body.innerHTML = `
    <div style="display:flex;gap:10px;align-items:flex-start">
      <img class="wd-pm-avatar" src="${pmRoot()}/avatar?userId=${encodeURIComponent(id)}" onerror="this.style.display='none'">
      <div style="flex:1;min-width:0">
        <div style="font-weight:bold;font-size:14px">${esc(displayName)}</div>
        <div class="wd-pm-meta">${roleLine}</div>
        <div class="wd-pm-meta">${achCount} ${esc(achLabel)}</div>
      </div>
    </div>
    ${vaiNote}
    ${bio}
    ${links ? `<div class="wd-pm-section-h">${esc(t("profileLinks"))}</div><div class="wd-pm-links">${links}</div>` : ""}
    ${pins ? `<div class="wd-pm-section-h">${esc(t("profilePinned"))}</div><div class="wd-pm-pin-grid">${pins}</div>` : ""}`;

  dmBtn.style.display = "";
  dmBtn.onclick = async () => {
    const text = await promptDlg(`Message to @${displayName}:`, "", t("profileSendDM"));
    if (text == null || !String(text).trim()) return;
    try {
      const client = getActiveClient();
      if (!client) throw new Error("backend offline");
      await api(client).chats.sendDm(id, { content: String(text).trim() });
      await infoDlg("Sent!", "DM");
    } catch (e: any) { await errorDlg("Failed: " + errMsg(e)); }
  };
}

// Global access for username-click handlers elsewhere.
(window as any).__wallOpenProfile = openProfile;
