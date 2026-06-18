import { cfg, saveCfg } from "./config";
import { SITE, WS_HOST } from "./constants";
import { $, esc, errMsg, noteBox, guildIcon, avatarSrcs, avImg, wireAvatars, mdToHtml } from "./helpers";
import { ic } from "./icons";
import { t, setRemoteDict } from "./i18n";
import { log } from "./log";
import { notify, toast } from "./notify";
import { siteApi } from "./site-api";
import { Backend, getMe, setMe, BackendUser } from "./backend";
import { overlayData } from "./overlay";
import { replaceEmotes } from "./emoji";
import { renderMentions } from "./mentions";
import { promptDlg, confirmDlg, errorDlg, infoDlg } from "./dialog";
import { recheckMine, triggerEvent } from "./achievements";
import { getCached, setCached } from "./cache";
import { ANNOUNCEMENT_POLL_MS, CACHE_TTL_TEMPLATES_MS } from "./constants";
import { applyCursorMode } from "./cursors";
import { importShare } from "./share";
import { updateAdminVisibility } from "./admin-ui";

function roleBadge(role: string | undefined): string {
  const r = String(role || "member").toLowerCase();
  if (r === "just a dev" || r === "dev")
    return `<span class="wp-badge dev">${esc(t("justDev"))}</span>`;
  if (r.includes("owner"))
    return `<span class="wp-badge owner">Clan Owner</span>`;
  if (r.includes("moder"))
    return `<span class="wp-badge mod">Clan Moderator</span>`;
  if (r === "admin") return `<span class="wp-badge owner">Admin</span>`;
  return `<span class="wp-badge member">${esc(role || "member")}</span>`;
}

function displayRole(prof: any): string {
  if (prof && prof.username && String(prof.username).toLowerCase() === "vai")
    return "Just a Dev";
  const me = getMe();
  if (me && me.clan_role) return me.clan_role;
  return (prof && prof.role) || "member";
}

export function canModerate(prof?: any): boolean {
  if (prof && String(prof.username || "").toLowerCase() === "vai") return true;
  const me = getMe();
  const r = String(
    (me && (me.clan_role || me.role)) || (prof && prof.role) || "",
  ).toLowerCase();
  return r.includes("owner") || r.includes("moder") || r === "admin";
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h";
  return Math.floor(diff / 86400_000) + "d";
}

export async function syncProfile(): Promise<void> {
  const prof = await siteApi("me");
  const card = $("profile-card");
  const status = $("wp-status");
  const bar = $("wp-drag");
  if (!prof) {
    if (card) card.innerHTML = `<div style="padding:6px">${t("guest")}</div>`;
    if (status) status.textContent = t("offline");
    return;
  }
  if (status) status.textContent = prof.username;
  if (bar) bar.classList.add("on");
  const role = displayRole(prof);
  if (card) {
    const discordTag = prof.discord_username ? `@${esc(prof.discord_username)}` : (prof.discord_id ? `discord #${esc(prof.discord_id)}` : "");
    card.innerHTML = `<div class="wp-card">
      ${avImg(avatarSrcs(prof.id, prof.discord_id, Backend.base, !!(getMe() && getMe()!.has_custom_avatar)))}
      <div style="flex:1">
        <div class="nm">${esc(prof.username)} <span class="sub">#${prof.id}</span>${roleBadge(role)}</div>
        <div class="sub">wall: <b>${esc(prof.username)}</b>${discordTag ? ` · discord: <b>${discordTag}</b>` : ""}</div>
        <div class="sub">region: ${esc(prof.country_code || "Global")} · cursor: ${prof.cursor_id}</div>
      </div>
    </div>`;
    wireAvatars(card);
  }

  const clanCard = $("clan-card");
  if (clanCard) {
    if (prof.clan) {
      const icon = guildIcon(prof.clan.discord_id, prof.clan.icon);
      clanCard.innerHTML = `<div class="wp-card">
        ${icon ? `<img src="${icon}">` : '<div class="ph"></div>'}
        <div><div class="nm">${esc(prof.clan.display_name || prof.clan.name)}</div>
        <div class="sub">${t("pixels")}: ${(prof.clan.stat_pixels_changed || 0).toLocaleString()} · ${t("members")}: ${prof.clan.stat_member_count || 0}</div>
        <div class="sub">${t("visible")}: ${(prof.clan.stat_paint_visible || 0).toLocaleString()} · discord ~${(prof.clan.approx_discord_members || 0).toLocaleString()}</div></div></div>`;
    } else {
      clanCard.innerHTML = `<div style="padding:6px;color:var(--sub)">${t("noClan")}</div>`;
    }
  }
  renderNotifications(prof.unread_notifications || []);
  updateAdminVisibility();

  // Show announce group for mods/admins
  const announceGroup = $("clan-announce-group");
  if (announceGroup) {
    announceGroup.style.display = canModerate(prof) ? "" : "none";
  }
  // Store clan id for announcement sending
  if (prof.clan && prof.clan.id) {
    (window as any).__wallClanId = prof.clan.id;
  }

  // Fetch the v2-rich profile (bio, social_links, pinned_templates, etc.)
  // and dispatch so the Profile pane wire-up can refresh.
  if (Backend.on) {
    Backend.req("GET", "/v2/auth/me").then((v2) => {
      document.dispatchEvent(new CustomEvent("wd:profile-loaded", { detail: v2 }));
    }).catch(() => {});
  }
}

export async function loadGuilds(): Promise<void> {
  const guilds = await siteApi("discordGuilds");
  const box = $("social-guilds");
  if (!box) return;
  if (!Array.isArray(guilds)) {
    box.innerHTML = `<div style="padding:6px;color:#b33">guild list offline</div>`;
    return;
  }
  box.innerHTML = guilds
    .sort((a: any, b: any) => (b.approximate_member_count || 0) - (a.approximate_member_count || 0))
    .map((g: any) => {
      const ic2 = guildIcon(g.id, g.icon);
      return `<div class="wp-li">${ic2 ? `<img src="${ic2}">` : '<div class="ph"></div>'}
        <div><b>${esc(g.name)}</b><br><span class="sub">${(g.approximate_member_count || 0).toLocaleString()} ${t("members").toLowerCase()}${g.owner ? " · crown" : ""}</span></div></div>`;
    })
    .join("");
  log("GUILDS", "OK", `${guilds.length} guilds`);
}

export async function loadRoster(): Promise<void> {
  const box = $("clan-roster");
  if (!box || !Backend.on) return;
  try {
    const ms = await Backend.clanMembers();
    box.innerHTML =
      (ms || [])
        .map((m: any) => `<div class="wp-li">${avImg(avatarSrcs(m.id, m.discord_id, Backend.base, !!m.has_custom_avatar), "")}
          <div><b>${esc(m.username)}</b> ${roleBadge(m.clan_role || m.role)}<br><span class="sub">cursor ${esc(m.cursor_id || "?")}</span></div></div>`)
        .join("") ||
      `<div style="padding:6px;color:var(--sub)">— empty —</div>`;
    wireAvatars(box);
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33;padding:6px">roster error: ${esc(errMsg(e))}</div>`;
  }
}

let knownNotifs: any[] = [];

const notifiedIds = new Set<string>();
const SEEN_KEY = "walldev_notif_seen";
try {
  const stored = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
  if (Array.isArray(stored)) stored.forEach((k) => notifiedIds.add(String(k)));
} catch {}

function persistSeen(): void {
  // Cap the stored set so it never grows unboundedly.
  const arr = Array.from(notifiedIds).slice(-500);
  localStorage.setItem(SEEN_KEY, JSON.stringify(arr));
}

function renderNotifications(list: any[]): void {
  knownNotifs = list || [];
  const box = $("notif-list");
  if (!box) {
    // Still update the seen set so we don't re-notify if the panel is closed.
    knownNotifs.forEach((n: any) => notifiedIds.add(String(n.id ?? n.title)));
    persistSeen();
    return;
  }
  if (!knownNotifs.length) {
    box.innerHTML = `<div style="padding:6px;color:var(--sub)">— no unread —</div>`;
    return;
  }
  box.innerHTML = knownNotifs
    .map((n: any) => `<div class="wp-li"><div style="flex:none">${ic("bell", 18)}</div>
      <div><b>${esc(n.title)}</b><br><span class="sub">${esc(n.body || "")}</span></div></div>`)
    .join("");
  // Notify only items we haven't seen this session (or previous sessions).
  let newCount = 0;
  knownNotifs.forEach((n: any) => {
    const key = String(n.id ?? n.title);
    if (notifiedIds.has(key)) return;
    notifiedIds.add(key);
    notify(n.title, n.body || "");
    newCount++;
  });
  if (newCount) persistSeen();
}

export async function refreshNotifications(): Promise<void> {
  if (Backend.on) {
    try {
      const ext = await Backend.notifications();
      if (Array.isArray(ext) && ext.length)
        renderNotifications([...(knownNotifs || []), ...ext]);
    } catch {}
  }
}

export function markAllRead(): void {
  const ids = knownNotifs.map((n: any) => n.id);
  renderNotifications([]);
  if (Backend.on) Backend.ackNotifications(ids).catch(() => {});
  toast(t("notifs"), "cleared");
}

export async function backendConnect(): Promise<void> {
  cfg.backendUrl = (($("cfg-backend-url") as HTMLInputElement)?.value || "").trim() || cfg.backendUrl;
  saveCfg();
  if (cfg.backendToken) {
    cfg.backendToken = "";
    cfg.refreshToken = "";
    setMe(null);
    saveCfg();
    const btn = $("btn-backend-connect");
    if (btn) btn.textContent = t("connect");
    toast(t("backend"), t("disconnect"));
    return;
  }
  if (!cfg.backendUrl) { await errorDlg("Set backend URL first"); return; }
  try {
    await Backend.login();
    try { setMe(await Backend.me()); } catch {}
    const btn = $("btn-backend-connect");
    if (btn) btn.textContent = t("disconnect");
    toast(t("backend"), "connected");
    // First handshake = the "extension_installed" achievement.
    triggerEvent("extension_installed").catch(() => {});
    if (cfg.remoteI18n) loadRemoteI18n();
    loadAnnouncements();
    loadClanChat();
    loadTemplates();
    loadPublicTemplates();
    loadMyTemplates();
    loadRoster();
    refreshNotifications();
    if (cfg.cursorMode === "clan") applyCursorMode();
    syncProfile();
    startChatPolling();
  } catch (e: any) {
    log("BACKEND", "ERR", e.toString());
    await errorDlg("Backend connect failed: " + errMsg(e));
  }
}

export async function loadRemoteI18n(): Promise<void> {
  if (!Backend.on) return;
  try {
    const d = await Backend.i18n(localStorage.getItem("wall_overlay_lang") || "en");
    if (d && typeof d === "object") {
      setRemoteDict(d);
      log("I18N", "OK", "remote loaded");
    }
  } catch (e: any) { log("I18N", "WARN", e.toString()); }
}

/**
 * Pop a toast for every NEW announcement since the last time we ran. We
 * remember the highest seen id in a tiny localStorage cache so old signals
 * don't re-fire on every reload.
 */
const ANNOUNCE_SEEN_KEY = "wd_announce_seen_v1";

function loadAnnounceSeenIds(): Set<string> {
  try {
    const raw = localStorage.getItem(ANNOUNCE_SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}

function saveAnnounceSeenIds(ids: Set<string>): void {
  try {
    // Keep at most the 200 most recent — list ordering is server-defined.
    const arr = [...ids].slice(-200);
    localStorage.setItem(ANNOUNCE_SEEN_KEY, JSON.stringify(arr));
  } catch { /* quota or json error — ignore */ }
}

export async function loadAnnouncements(): Promise<void> {
  if (!Backend.on) return;
  try {
    const list = (await Backend.listMailbox("announcement")) || [];
    const seen = loadAnnounceSeenIds();
    const firstTime = seen.size === 0;
    let added = 0;
    for (const a of list) {
      const id = String(a.id ?? a.uid ?? a.created_at ?? a.title);
      if (seen.has(id)) continue;
      seen.add(id);
      added += 1;
      // On the very first run we silently absorb everything into "seen"
      // — old signals shouldn't pop notifications on a fresh install.
      if (!firstTime) notify(a.title || "Announcement", a.body || "");
    }
    if (added) saveAnnounceSeenIds(seen);
  } catch (e: any) { log("ANNOUNCE", "WARN", e.toString()); }
}

export async function loadClanChat(): Promise<void> {
  const box = $("clan-chat");
  if (!box || !Backend.on) return;
  const mod = canModerate();
  try {
    const msgs = await Backend.clanMessages();
    box.innerHTML =
      (msgs || [])
        .map((m: any) => {
          const ts = m.created_at ? timeAgo(m.created_at) : "";
          return `<div class="m"><div class="bd"><span class="au" data-user="${esc(m.author)}">${esc(m.author)}</span>${ts ? ` <span class="ts" title="${esc(m.created_at)}">${ts}</span>` : ""} ${renderMentions(replaceEmotes(mdToHtml(m.text)))}</div>${mod && m.id != null ? `<span class="del" data-del="${esc(m.id)}" title="${t("delete")}">${ic("trash", 12)}</span>` : ""}</div>`;
        })
        .join("") || `<div style="color:var(--sub)">— empty —</div>`;
    box.querySelectorAll("[data-del]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDlg(t("delete") + "?"))) return;
        try { await Backend.deleteClanMessage((b as HTMLElement).dataset.del!); loadClanChat(); }
        catch (e: any) { await errorDlg("Delete failed: " + errMsg(e)); }
      }),
    );
    (box as HTMLElement).scrollTop = (box as HTMLElement).scrollHeight;
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33">chat error: ${esc(errMsg(e))}</div>`;
  }
}

let chatPollTimer: number | null = null;
let lastChatSig = "";

export function startChatPolling(): void {
  if (chatPollTimer != null) return;
  const tick = async () => {
    if (!Backend.on) return;
    try {
      const msgs = await Backend.clanMessages();
      const sig = JSON.stringify((msgs || []).map((m: any) => m.id));
      if (sig !== lastChatSig) {
        const wasAtBottom = (() => {
          const box = $("clan-chat");
          if (!box) return true;
          return (box as HTMLElement).scrollTop + (box as HTMLElement).clientHeight >= (box as HTMLElement).scrollHeight - 10;
        })();
        // Detect a new incoming message
        if (lastChatSig) {
          const prevIds = new Set(JSON.parse(lastChatSig));
          const newMsgs = (msgs || []).filter((m: any) => !prevIds.has(m.id));
          newMsgs.forEach((m: any) => {
            const me = getMe();
            if (!me || m.author !== me.username) {
              toast("Clan chat", `${m.author}: ${(m.text || "").slice(0, 60)}`);
            }
          });
        }
        lastChatSig = sig;
        await loadClanChat();
        if (wasAtBottom) {
          const box = $("clan-chat");
          if (box) (box as HTMLElement).scrollTop = (box as HTMLElement).scrollHeight;
        }
      }
    } catch {}
  };
  tick();
  chatPollTimer = window.setInterval(tick, 8000);
}

let notifPollTimer: number | null = null;

export function startNotifPolling(): void {
  if (notifPollTimer != null) return;
  const tick = async () => {
    try {
      const prof = await siteApi("me");
      const list = (prof && prof.unread_notifications) || [];
      // Funnel through renderNotifications so we share a single de-dupe set.
      renderNotifications(list);
    } catch {}
  };
  tick();
  notifPollTimer = window.setInterval(tick, 60_000);
}

/**
 * Background poll for new mailbox announcements. The `seen ids` cache in
 * loadAnnouncements() prevents toast spam on reload; this just makes sure we
 * surface fresh announcements without the user opening any UI.
 */
let announcePollTimer: number | null = null;

export function startAnnouncementPolling(): void {
  if (announcePollTimer !== null) return;
  log("ANNOUNCE_POLL", "OK", `every ${ANNOUNCEMENT_POLL_MS / 1000}s`);
  announcePollTimer = window.setInterval(() => {
    loadAnnouncements().catch(() => { /* surfaced as a warn inside */ });
  }, ANNOUNCEMENT_POLL_MS);
}

export function clearNotifSeen(): void {
  notifiedIds.clear();
  localStorage.removeItem(SEEN_KEY);
}

export async function resetAvatar(): Promise<void> {
  if (!Backend.on) { await errorDlg("Connect to VAI-PROG backend first"); return; }
  try {
    // DELETE /me/avatar — fallback to PUT with empty if no DELETE route
    await Backend.req("DELETE", "/me/avatar");
    toast(t("customAvatar"), "reset to Discord avatar");
    syncProfile();
  } catch (e: any) {
    await errorDlg("Reset avatar failed: " + errMsg(e));
  }
}

export async function sendClanMessage(): Promise<void> {
  const ta = $("clan-chat-input") as HTMLTextAreaElement | null;
  const text = ta?.value.trim();
  if (!text) return;
  if (!Backend.on) { await errorDlg("Connect to VAI-PROG backend first (Settings)"); return; }
  // Detect 7TV usage so we can grant the "emote_explorer" achievement.
  const usedEmote = /:[a-zA-Z0-9_]+(?::[a-zA-Z0-9_]+)?:/.test(text);
  try {
    await Backend.sendClanMessage(text);
    if (ta) ta.value = "";
    loadClanChat();
    if (usedEmote) triggerEvent("emote_explorer").catch(() => {});
  } catch (e: any) { await errorDlg("Send failed: " + errMsg(e)); }
}

function templateRow(tp: any, opts: { pending?: boolean; pub?: boolean }): string {
  const thumb = Backend.base && tp.id != null
    ? `<img src="${Backend.base}/v2/templates/${encodeURIComponent(tp.id)}/preview?size=64" class="wp-tpl-thumb" loading="lazy" onerror="this.style.opacity=0.3">`
    : '<div class="ph"></div>';
  const isPending = opts.pending || tp.status === "pending";
  const badge = isPending
    ? `<span class="wp-badge member">unverified</span>`
    : opts.pub ? `<span class="wp-badge mod">verified</span>` : "";
  // Carry both the share payload (`data-tpl`) and the backend template id
  // (`data-tpl-id`) on the Load button. The Share tab uses the latter to
  // build the short `?the_wall_dev=…/json` URL and the Charity config —
  // without it, a freshly-loaded template (one the user didn't publish
  // themselves) would be missing `__wd_last_shared_template_id` and the
  // export buttons would refuse to run.
  let btns = `<button class="wp-btn" style="width:auto;margin:0;padding:2px 6px" data-tpl="${esc(tp.share)}" data-tpl-id="${esc(tp.id || "")}">${t("load")}</button>`;
  const me = getMe();
  const isOwner = !!(me && tp.user_id && me.id === tp.user_id);
  if (isOwner)
    btns += `<span class="del" data-pin-tpl="${esc(tp.id)}" title="Pin to profile" style="cursor:pointer;color:#08a">${ic("pin", 12)}</span>`;
  if (opts.pub)
    btns += `<span class="del" data-report="${esc(tp.id)}" title="${t("report")}" style="cursor:pointer;color:#c93">${ic("flag", 12)}</span>`;
  if (isPending && canModerate())
    btns += `<span class="del" data-approve="${esc(tp.id)}" title="${t("approve")}" style="cursor:pointer;color:#2a2">${ic("check", 12)}</span>`;
  if (canModerate() || isOwner)
    btns += `<span class="del" data-del-tpl="${esc(tp.id)}" title="${t("delete")}" style="cursor:pointer;color:#c33">${ic("trash", 12)}</span>`;
  // `data-tpl-*` carry the structured fields the smart search parser reads
  // (x:N-N / y:N-N / author:foo / plain-text name match). Keeping them as
  // dedicated attributes — rather than fishing them out of textContent —
  // avoids fragile string parsing and survives translation of labels.
  const dataAttrs =
    ` data-tpl-name="${esc((tp.name || "").toLowerCase())}"` +
    ` data-tpl-author="${esc((tp.author || "").toLowerCase())}"` +
    ` data-tpl-x="${Number(tp.x) || 0}"` +
    ` data-tpl-y="${Number(tp.y) || 0}"`;
  return `<div class="wp-li"${dataAttrs}>${thumb}<div style="flex:1"><b>${esc(tp.name)}</b>${badge}<br><span class="sub">@${tp.x},${tp.y} · ${tp.scale || 1}x · ${esc(tp.author || "?")}</span></div><div style="display:flex;gap:4px;align-items:center">${btns}</div></div>`;
}

function wireTemplateRows(box: Element): void {
  box.querySelectorAll("button[data-tpl]").forEach((b) =>
    b.addEventListener("click", () => {
      const el = b as HTMLElement;
      importShare(el.dataset.tpl!);
      // A loaded template already lives on the backend, so the Share tab's
      // "Copy share URL" / "Charity config" buttons should work without
      // forcing the user to republish. Stash the id under the same
      // window-scoped key that `shareCurrentTemplate` uses on a fresh
      // publish — single source of truth for "what template am I on?".
      const id = el.dataset.tplId;
      if (id) (window as any).__wd_last_shared_template_id = id;
    }),
  );
  box.querySelectorAll("[data-report]").forEach((b) =>
    b.addEventListener("click", async () => {
      const reason = await promptDlg(t("report") + " — reason:", "", "Report Template");
      if (reason == null || !String(reason).trim()) return;
      try { await Backend.reportTemplate((b as HTMLElement).dataset.report!, String(reason).trim()); toast(t("report"), "sent"); }
      catch (e: any) { await errorDlg("Report failed: " + errMsg(e)); }
    }),
  );
  box.querySelectorAll("[data-approve]").forEach((b) =>
    b.addEventListener("click", async () => {
      try {
        await Backend.approveTemplate((b as HTMLElement).dataset.approve!);
        toast(t("approve"), "done");
        loadPublicTemplates();
        loadTemplates();
      }
      catch (e: any) { await errorDlg("Approve failed: " + errMsg(e)); }
    }),
  );
  box.querySelectorAll("[data-del-tpl]").forEach((b) =>
    b.addEventListener("click", async () => {
      const ok = await confirmDlg("Delete this template?", "Confirm Delete");
      if (!ok) return;
      try {
        await Backend.req("DELETE", `/templates/${(b as HTMLElement).dataset.delTpl}`);
        toast("Templates", "deleted");
        loadPublicTemplates();
        loadTemplates();
      } catch (e: any) { await errorDlg("Delete failed: " + errMsg(e)); }
    }),
  );
  box.querySelectorAll("[data-pin-tpl]").forEach((b) =>
    b.addEventListener("click", async () => {
      const slotStr = await promptDlg("Pin to slot? (1, 2, or 3)", "1", "Pin Template");
      if (slotStr == null) return;
      const slot = parseInt(String(slotStr), 10);
      if (!(slot >= 1 && slot <= 3)) { await errorDlg("Slot must be 1, 2 or 3"); return; }
      try {
        await Backend.req("POST", `/v2/templates/${(b as HTMLElement).dataset.pinTpl}/pin`, { slot });
        toast("Templates", `pinned to slot ${slot}`);
        syncProfile();
      } catch (e: any) { await errorDlg("Pin failed: " + errMsg(e)); }
    }),
  );
  wireAvatars(box as HTMLElement);
}

/**
 * Template lists are cached for CACHE_TTL_TEMPLATES_MS (5 minutes) — enough
 * to make tab-switching feel instant, short enough that a fresh share lands
 * within a refill window. The Reload button next to each list invalidates
 * the cache and refetches.
 */
function renderTemplateList(box: HTMLElement, tpls: any[], opts?: { pub?: boolean }): void {
  const decorate = opts?.pub
    ? (tp: any) => templateRow(tp, { pub: true, pending: tp.status === "pending" })
    : (tp: any) => templateRow(tp, { pending: tp.status === "pending" });
  box.innerHTML =
    (tpls || []).map(decorate).join("") ||
    `<div style="color:var(--sub);padding:6px">— none —</div>`;
  wireTemplateRows(box);
}

/* --- animated rows inside the per-scope template lists --------------------
 * The renderer lives in anim-protect-wire.ts (it owns apply/approve/delete
 * for animated configs) and registers itself here, so data.ts never imports
 * it back (no cycle). Loaders call the hook after rendering classic rows;
 * renderTemplateList resets innerHTML, so appended rows can't duplicate. */
export type AnimScope = "public" | "clan" | "private";
let animRowsAppender:
  | ((box: HTMLElement, scope: AnimScope) => Promise<void>)
  | null = null;
export function setAnimRowsAppender(
  fn: (box: HTMLElement, scope: AnimScope) => Promise<void>,
): void {
  animRowsAppender = fn;
}
function appendAnimIfEnabled(box: HTMLElement, scope: AnimScope): void {
  const hidden =
    scope === "public"
      ? cfg.hideAnimatedPub
      : scope === "clan"
        ? cfg.hideAnimatedClan
        : cfg.hideAnimatedMine;
  if (!hidden && animRowsAppender) {
    animRowsAppender(box, scope).catch(() => {});
  }
}

interface TemplateBoard {
  boxId: string;
  scope: "clan" | "private" | "public";
  cacheKey: string;
  label: string;
  /** Public board shows verified/unverified badges. */
  pub?: boolean;
  /** Also pull pending rows (clan/public only; private is always approved). */
  showUnverified?: boolean;
}

// The three template tabs all do the same dance: paint the cache, fetch,
// re-paint, append any animated rows, and leave a partial view in place if
// the network fails. This drives all three from one place.
async function loadTemplateBoard(b: TemplateBoard, forceRefresh: boolean): Promise<void> {
  const box = $(b.boxId);
  if (!box || !Backend.on) return;
  const paint = (rows: any[]) => {
    renderTemplateList(box, rows, b.pub ? { pub: true } : undefined);
    appendAnimIfEnabled(box, b.scope);
  };
  if (!forceRefresh) {
    const cached = getCached<any[]>(b.cacheKey, CACHE_TTL_TEMPLATES_MS);
    if (cached) paint(cached);
  }
  try {
    let rows: any[];
    if (b.scope === "private") {
      rows = (await Backend.listTemplatesV2({ scope: b.scope })) || [];
    } else {
      rows = (await Backend.listTemplatesV2({ scope: b.scope, status: "approved" })) || [];
      if (b.showUnverified) {
        const pending = await Backend.listTemplatesV2({ scope: b.scope, status: "pending" });
        rows = rows.concat(pending || []);
      }
    }
    setCached(b.cacheKey, rows);
    paint(rows);
  } catch (e) {
    if (!box.children.length) box.innerHTML = noteBox(`${b.label}: ${errMsg(e)}`, "err");
  }
}

export function loadTemplates(forceRefresh = false): Promise<void> {
  return loadTemplateBoard(
    {
      boxId: "clan-templates",
      scope: "clan",
      label: "templates",
      cacheKey: `tpl:clan:${cfg.showUnverifiedClan ? "all" : "approved"}`,
      showUnverified: cfg.showUnverifiedClan,
    },
    forceRefresh,
  );
}

/** Personal templates the backend only ever returns to their owner; animated
 *  private configs render below the classic ones. */
export function loadMyTemplates(forceRefresh = false): Promise<void> {
  return loadTemplateBoard(
    { boxId: "my-templates", scope: "private", label: "my templates", cacheKey: "tpl:mine" },
    forceRefresh,
  );
}

export function loadPublicTemplates(forceRefresh = false): Promise<void> {
  return loadTemplateBoard(
    {
      boxId: "pub-templates",
      scope: "public",
      label: "public templates",
      pub: true,
      cacheKey: `tpl:public:${cfg.showUnverified ? "all" : "approved"}`,
      showUnverified: cfg.showUnverified,
    },
    forceRefresh,
  );
}

export async function shareCurrentTemplate(): Promise<void> {
  if (!overlayData.src) { await errorDlg("Load an overlay first"); return; }
  if (!Backend.on) { await errorDlg("Connect to VAI-PROG backend first (Settings)"); return; }
  const scope = ($("share-scope") as HTMLSelectElement)?.value || "clan";
  const pass = (($("share-pass") as HTMLInputElement)?.value ?? "").trim();
  const nameRaw = await promptDlg("Template name:", "", "Share Template");
  if (nameRaw == null) return;
  const name = String(nameRaw).trim() || "untitled";
  try {
    // Share the *original* image so peers can re-scale without quality loss.
    const origSrc = overlayData.srcOrig || overlayData.src;
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify({
      x: overlayData.x, y: overlayData.y, scale: cfg.overlayScale, src: origSrc,
    }))));
    const resp = await Backend.createTemplateV2({
      name,
      x: overlayData.x,
      y: overlayData.y,
      scale: cfg.overlayScale,
      scope,
      share: `the-wall-dev://${b64}`,
      ...(pass ? { access_password: pass } : {}),
    });
    log("TEMPLATE_SHARE", "OK", `id=${resp?.id} status=${resp?.status}`);
    // Stash the last-shared template id so the Share-tab's "Save Charity
    // config" button can reference our hosted PNG without asking the user
    // to type the URL. Window-scoped to keep this out of the persisted
    // config — it's a per-session hint, not a setting.
    if (resp?.id) (window as any).__wd_last_shared_template_id = resp.id;
    toast(t("templates"), `shared (${resp?.status || "?"})`);
    // Password-shared template → hand over a ready-to-send access code,
    // same UX as animated configs (see anim-protect-wire.uploadAnimConfig).
    if (pass && resp?.id) {
      try { await navigator.clipboard.writeText(String(resp.id)); } catch {}
      await infoDlg(
        `${t("animShareCodeReady")}\n\nID: ${resp.id}\n${t("animSharePass")}: ${pass}`,
        t("sharePublishLegend"),
      );
    }
    if (scope === "clan") loadTemplates();
    else if (scope === "private") loadMyTemplates(true);
    else loadPublicTemplates();
    // Re-evaluate counter-based achievements (first_template, approved_5, …).
    recheckMine().catch(() => {});
  } catch (e: any) {
    log("TEMPLATE_SHARE", "ERR", e.toString());
    await errorDlg("Share failed: " + errMsg(e));
  }
}
