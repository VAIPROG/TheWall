import { getActiveClient, getMe } from "../backend/index";
import { $, esc, errMsg } from "../helpers";
import { ic } from "../icons";
import { log } from "../log";
import { toast } from "../notify";
import { confirmDlg, errorDlg, openDialog, promptDlg } from "../dialog";
import { isWalldevDark } from "../theme";

// This console still drives the legacy V1/V2 admin surface (`/admin/*` list
// endpoints, `/v2/templates/*` previews). Those resolve against the API root,
// not the V3 base — hence `root: true`.
// TODO(phase3): move to the V3 admin/moderation endpoints (richer, per-user).
function adminReq<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const client = getActiveClient();
  if (!client) return Promise.reject(new Error("backend offline"));
  return client.req<T>({ method, path, body, root: true });
}
function adminRoot(): string {
  return getActiveClient()?.rootUrl ?? "";
}

/** Global roles in V2: user / admin / owner. */
const GLOBAL_ROLES = ["user", "admin", "owner"] as const;

export function isAdmin(): boolean {
  const me = getMe();
  if (!me) return false;
  // Backend now exposes `global_role` (rich /v2/auth/me) — keep `role` for
  // legacy bootstraps. Either being admin/owner unlocks the tab.
  const r = String((me as any).global_role || me.role || "").toLowerCase();
  return r === "admin" || r === "owner";
}

export async function loadAdminUsers(): Promise<void> {
  const box = $("admin-users");
  if (!box) return;
  try {
    const users = await adminReq("GET", "/admin/users");
    box.innerHTML = (users || [])
      .map((u: any) => {
        const role = String(u.global_role || u.role || "user").toLowerCase();
        const badgeCls = role === "owner" ? "owner" : role === "admin" ? "mod" : "member";
        return `<div class="wp-li">
          <div style="flex:1">
            <b data-user="${esc(u.username)}" style="cursor:pointer">${esc(u.username)}</b>
            <span class="wp-badge ${badgeCls}">${esc(role)}</span>
            <br><span class="sub">wall #${esc(u.wall_id || u.external_id || "")}${u.discord_id ? ` · discord ${esc(u.discord_id)}` : ""}</span>
          </div>
          <select class="wp-input wd-role-sel" data-uid="${esc(u.id)}" style="font:11px sans-serif;width:auto">
            ${GLOBAL_ROLES.map(r => `<option value="${r}"${r === role ? " selected" : ""}>${r}</option>`).join("")}
          </select>
          <span class="del" data-del-uid="${esc(u.id)}" title="delete" style="cursor:pointer;color:#c33">${ic("trash", 12)}</span>
        </div>`;
      })
      .join("") || `<div style="padding:6px;color:var(--sub)">— no users —</div>`;

    box.querySelectorAll<HTMLSelectElement>(".wd-role-sel").forEach((sel) =>
      sel.addEventListener("change", async () => {
        try {
          await adminReq("PUT", `/admin/users/${sel.dataset.uid}/role`, { role: sel.value });
          toast("Admin", "role updated");
        } catch (e: any) { await errorDlg("Role update failed: " + errMsg(e)); }
      }),
    );
    box.querySelectorAll<HTMLElement>("[data-del-uid]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDlg("Delete this user permanently?", "Confirm Delete"))) return;
        try {
          await adminReq("DELETE", `/admin/users/${b.dataset.delUid}`);
          toast("Admin", "user deleted");
          loadAdminUsers();
        } catch (e: any) { await errorDlg("Delete failed: " + errMsg(e)); }
      }),
    );
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33;padding:6px">${esc(errMsg(e))}</div>`;
  }
}

export async function loadModApps(): Promise<void> {
  const box = $("admin-modapps");
  if (!box) return;
  try {
    const apps = await adminReq("GET", "/admin/moderation");
    box.innerHTML = (apps || [])
      .map((a: any) => {
        // Show the applicant's current role + clan so the reviewer doesn't
        // have to dig through the user table before deciding.
        const roleBadge = a.current_role && a.current_role !== "user"
          ? `<span class="wp-badge mod">${esc(a.current_role)}</span>` : "";
        const clanLine = a.clan_id
          ? `<br><span class="sub" title="${esc(a.clan_id)}">🛡 ${esc(a.clan_name || a.clan_id.slice(0, 8))} · ${esc(a.clan_role || "member")}</span>`
          : `<br><span class="sub" style="font-style:italic">no clan</span>`;
        return `<div class="wp-li">
          <div style="flex:1">
            <b>${esc(a.username)}</b>
            <span class="wp-badge member">${esc(a.status)}</span>
            ${roleBadge}
            <br><span class="sub">${esc(a.message || "(no message)")}</span>
            ${clanLine}
          </div>
          ${a.status === "pending" ? `
            <button class="wp-btn" style="width:auto;margin:0;padding:2px 6px" data-approve-mod="${esc(a.id)}" data-approve-clan="${esc(a.clan_name || "")}">approve</button>
            <button class="wp-btn" style="width:auto;margin:0;padding:2px 6px" data-reject-mod="${esc(a.id)}" data-reject-clan="${esc(a.clan_name || "")}">reject</button>
          ` : ""}
        </div>`;
      })
      .join("") || `<div style="padding:6px;color:var(--sub)">— no applications —</div>`;

    box.querySelectorAll<HTMLElement>("[data-approve-mod]").forEach((b) =>
      b.addEventListener("click", async () => {
        const clan = b.dataset.approveClan;
        const ctx = clan ? ` from clan "${clan}"` : "";
        if (!(await confirmDlg(`Approve and grant admin role${ctx}?`, "Confirm"))) return;
        try {
          await adminReq("PUT", `/admin/moderation/${b.dataset.approveMod}`, { status: "approved", new_role: "admin" });
          toast("Admin", "approved");
          loadModApps();
        } catch (e: any) { await errorDlg(errMsg(e)); }
      }),
    );
    box.querySelectorAll<HTMLElement>("[data-reject-mod]").forEach((b) =>
      b.addEventListener("click", async () => {
        const clan = b.dataset.rejectClan;
        const ctx = clan ? ` from clan "${clan}"` : "";
        if (!(await confirmDlg(`Reject this application${ctx}?`, "Confirm"))) return;
        try {
          await adminReq("PUT", `/admin/moderation/${b.dataset.rejectMod}`, { status: "rejected" });
          toast("Admin", "rejected");
          loadModApps();
        } catch (e: any) { await errorDlg(errMsg(e)); }
      }),
    );
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33;padding:6px">${esc(errMsg(e))}</div>`;
  }
}

/**
 * Two-field broadcast dialog (title + body). Built ad-hoc because the standard
 * promptDlg only collects one field. Uses the same Win95 + theme system as
 * dialog.ts so it picks up dark mode automatically.
 */
export async function broadcastNotification(): Promise<void> {
  injectBroadcastCss();
  const wrap = document.createElement("div");
  wrap.className = "wd-bc-host" + (isWalldevDark() ? " wd-dark" : "");
  const onThemeChange = () => wrap.classList.toggle("wd-dark", isWalldevDark());
  document.addEventListener("wd:theme-changed", onThemeChange);
  wrap.innerHTML = `
    <div class="wd-bc-back"></div>
    <div class="wd-bc-dlg" role="dialog" aria-modal="true">
      <div class="wd-bc-tb">
        <span class="wd-bc-tb-title"><span class="wd-bc-led"></span><span>📣 Broadcast to all users</span></span>
        <span class="wd-bc-x" role="button" title="Close">✕</span>
      </div>
      <div class="wd-bc-bd">
        <div class="wd-bc-icon">📢</div>
        <div class="wd-bc-fields">
          <label for="wd-bc-title">
            <span class="wd-bc-lbl">Title</span>
            <input id="wd-bc-title" name="wd_bc_title" type="text" class="wd-bc-title" placeholder="A short, descriptive subject" maxlength="120" autocomplete="off">
          </label>
          <label for="wd-bc-body">
            <span class="wd-bc-lbl">Body <span class="wd-bc-hint">(markdown supported)</span></span>
            <textarea id="wd-bc-body" name="wd_bc_body" class="wd-bc-body" rows="6" placeholder="Markdown OK — **bold**, *italic*, [links](url), :emote:" autocomplete="off"></textarea>
          </label>
          <label>
            <span class="wd-bc-lbl">Type <span class="wd-bc-hint">— how it surfaces on the client</span></span>
            <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
                <input type="radio" name="wd-bc-kind" value="announcement" checked>
                <span><b>News</b> — toast + OS notification, no popup</span>
              </label>
              <label style="display:flex;align-items:center;gap:4px;cursor:pointer">
                <input type="radio" name="wd-bc-kind" value="alert">
                <span><b>Alert</b> — critical popup + toast + OS notification (global, not clan-scoped)</span>
              </label>
            </div>
          </label>
          <div class="wd-bc-warn">⚠ This will reach every registered user.</div>
        </div>
      </div>
      <div class="wd-bc-btns">
        <button class="wd-bc-btn wd-bc-cancel">Cancel</button>
        <button class="wd-bc-btn primary wd-bc-send">📣 Send</button>
      </div>
      <div class="wd-bc-status"><span class="left">Ready</span><span class="right">Admin Console</span></div>
    </div>`;
  document.body.appendChild(wrap);

  const titleInput = wrap.querySelector<HTMLInputElement>(".wd-bc-title")!;
  const bodyInput = wrap.querySelector<HTMLTextAreaElement>(".wd-bc-body")!;
  const statusLeft = wrap.querySelector<HTMLElement>(".wd-bc-status .left")!;
  titleInput.focus();

  await new Promise<void>((resolve) => {
    const close = () => {
      wrap.remove();
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("wd:theme-changed", onThemeChange);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey, true);

    wrap.querySelector(".wd-bc-cancel")!.addEventListener("click", close);
    wrap.querySelector(".wd-bc-x")!.addEventListener("click", close);
    wrap.querySelector(".wd-bc-back")!.addEventListener("click", close);

    wrap.querySelector(".wd-bc-send")!.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      const body = bodyInput.value.trim();
      const kindEl = wrap.querySelector<HTMLInputElement>('input[name="wd-bc-kind"]:checked');
      const kind = kindEl?.value || "announcement";
      if (!title) {
        statusLeft.textContent = "Title is required";
        titleInput.focus();
        return;
      }
      statusLeft.textContent = "Confirming…";
      const typeLabel = kind === "alert" ? "ALERT (global popup)" : "News (toast)";
      const ok = await confirmDlg(
        `Send broadcast "${title}" as ${typeLabel} to ALL users?`,
        "Final Confirmation",
      );
      if (!ok) { statusLeft.textContent = "Cancelled"; return; }
      statusLeft.textContent = "Sending…";
      try {
        await adminReq("POST", "/admin/broadcast", { title, body, kind });
        toast("Admin", `broadcast sent as ${typeLabel}`);
        close();
      } catch (e: any) {
        statusLeft.textContent = "Send failed";
        await errorDlg("Broadcast failed: " + errMsg(e));
      }
    });
  });
}

function injectBroadcastCss(): void {
  if (document.getElementById("wd-bc-css")) return;
  const style = document.createElement("style");
  style.id = "wd-bc-css";
  style.textContent = `
  @keyframes wd-bc-pop { from { transform:translate(-50%,-50%) scale(.9); opacity:0 } to { transform:translate(-50%,-50%) scale(1); opacity:1 } }
  .wd-bc-host {
    position:fixed; inset:0; z-index:1000002;
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    --bg:#c0c0c0; --text:#000; --light:#fff; --shadow:#808080; --dark:#404040;
    --field:#fff; --fieldtext:#000;
    --title-a:#000080; --title-b:#1084d0;
    --accent:#000080; --sub:#555;
  }
  .wd-bc-host.wd-dark {
    --bg:#2c2c2c; --text:#fff; --light:#5a5a5a; --shadow:#141414; --dark:#000;
    --field:#0f0f0f; --fieldtext:#fff;
    --title-a:#3838aa; --title-b:#1084d0;
    --accent:#2889ff; --sub:#aaa;
  }
  .wd-bc-back {
    position:absolute; inset:0; background:rgba(0,0,0,.45);
  }
  .wd-bc-dlg {
    position:absolute; left:50%; top:42%;
    transform:translate(-50%,-50%);
    width:460px; max-width:92vw;
    background:var(--bg); color:var(--text);
    border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:
      inset -1px -1px 0 var(--shadow),
      inset  1px  1px 0 var(--bg),
      4px 4px 0 rgba(0,0,0,.6);
    animation:wd-bc-pop .15s ease-out;
  }
  .wd-bc-tb {
    background:linear-gradient(90deg, var(--title-a), var(--title-b));
    color:#fff; font-weight:bold; font-size:12px;
    padding:3px 3px 3px 6px;
    display:flex; align-items:center; justify-content:space-between;
    height:20px; line-height:14px;
    user-select:none;
  }
  .wd-bc-tb-title { display:flex; align-items:center; gap:6px }
  .wd-bc-led { width:8px; height:8px; border-radius:50%;
    background:#3f6; box-shadow:0 0 4px #3f6, inset 0 0 1px rgba(255,255,255,.5) }
  .wd-bc-x {
    width:18px; height:16px;
    display:flex; align-items:center; justify-content:center;
    background:var(--bg); color:var(--text);
    border:1px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:bold 10px Verdana,sans-serif; cursor:pointer; padding:0;
  }
  .wd-bc-x:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
    padding:1px 0 0 1px;
  }
  .wd-bc-bd {
    padding:14px 16px;
    display:flex; gap:14px; align-items:flex-start;
    background:var(--bg);
  }
  .wd-bc-icon {
    font-size:32px; line-height:1; flex:none;
    filter:drop-shadow(1px 1px 0 rgba(0,0,0,.4));
  }
  .wd-bc-fields { flex:1; display:flex; flex-direction:column; gap:8px; min-width:0 }
  .wd-bc-host .wd-bc-fields label {
    display:flex !important;
    flex-direction:column !important;
    gap:3px !important;
    font-size:11px !important;
    background:transparent !important;
    color:var(--text) !important;
    padding:0 !important;
    margin:0 !important;
    border:0 !important;
  }
  .wd-bc-host .wd-bc-lbl {
    display:inline-flex !important; align-items:center !important; gap:4px !important;
    font-weight:bold !important;
    color:var(--text) !important;
    background:transparent !important;
    padding:0 !important;
    border:0 !important;
  }
  .wd-bc-host .wd-bc-hint {
    font-weight:normal !important;
    color:var(--sub) !important;
    background:transparent !important;
    font-size:10px !important;
  }
  /* Force our own values regardless of what the host site sets — pages like
   * filianislost.com style input { background:#fff !important } which would
   * otherwise leak through. */
  .wd-bc-host .wd-bc-title,
  .wd-bc-host .wd-bc-body {
    all:revert;
    display:block !important;
    width:100% !important; box-sizing:border-box !important;
    padding:4px 6px !important;
    margin:0 !important;
    background:var(--field) !important; color:var(--fieldtext) !important;
    border:2px solid !important;
    border-color:var(--dark) var(--light) var(--light) var(--dark) !important;
    box-shadow:inset 1px 1px 0 var(--shadow), inset -1px -1px 0 var(--bg) !important;
    font:12px "MS Sans Serif", monospace !important;
    outline:none !important;
    resize:none !important;
  }
  .wd-bc-host .wd-bc-body {
    font-family:Consolas,"Courier New",monospace !important;
    resize:vertical !important;
    min-height:80px !important;
  }
  .wd-bc-host .wd-bc-title:focus,
  .wd-bc-host .wd-bc-body:focus {
    outline:1px dotted var(--accent) !important;
    outline-offset:1px !important;
  }
  .wd-bc-warn {
    background:rgba(228,160,0,.18); color:var(--text);
    border-left:3px solid #e8a600; padding:6px 8px; font-size:11px;
  }
  .wd-bc-host.wd-dark .wd-bc-warn { background:rgba(228,160,0,.22) }
  .wd-bc-btns {
    padding:10px 14px 12px;
    display:flex; gap:6px; justify-content:flex-end;
    background:var(--bg);
    border-top:1px solid var(--shadow);
    box-shadow:inset 0 1px 0 var(--light);
  }
  .wd-bc-btn {
    min-width:96px; padding:5px 14px;
    background:var(--bg); color:var(--text);
    border:2px solid; border-color:var(--light) var(--dark) var(--dark) var(--light);
    box-shadow:inset 1px 1px 0 var(--bg), inset -1px -1px 0 var(--shadow);
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    cursor:pointer;
  }
  .wd-bc-btn:hover { filter:brightness(1.04) }
  .wd-bc-btn:active {
    border-color:var(--dark) var(--light) var(--light) var(--dark);
    box-shadow:inset -1px -1px 0 var(--bg), inset 1px 1px 0 var(--shadow);
    padding:6px 13px 4px 15px;
  }
  .wd-bc-btn.primary { font-weight:bold }
  .wd-bc-btn:focus { outline:1px dotted currentColor; outline-offset:-3px }
  .wd-bc-status {
    border-top:1px solid var(--shadow); box-shadow:inset 0 1px 0 var(--light);
    padding:2px 8px; background:var(--bg); color:var(--sub);
    font:10px "MS Sans Serif",sans-serif;
    display:flex; justify-content:space-between;
  }
  `;
  document.head.appendChild(style);
}

export function updateAdminVisibility(): void {
  const tab = $("tab-admin");
  if (tab) tab.style.display = isAdmin() ? "" : "none";
}

export async function loadAdminTemplates(): Promise<void> {
  const box = $("admin-templates");
  if (!box) return;
  try {
    const items = await adminReq("GET", "/admin/templates");
    box.innerHTML = (items || []).map((tp: any) => {
      const badge = tp.status === "approved"
        ? `<span class="wp-badge mod">approved</span>`
        : `<span class="wp-badge member">${esc(tp.status)}</span>`;
      // Surface the owning clan when the template is clan-scoped. Falls back
      // to "(clan ?)" when the clan row has been deleted but the template
      // hasn't been migrated yet — that way the admin can still tell it's
      // clan-scoped instead of public.
      const clanLine = tp.scope === "clan"
        ? `<span class="wp-badge mod" title="${esc(tp.clan_id || "")}">🛡 ${esc(tp.clan_name || `clan ${tp.clan_id?.slice(0, 8) || "?"}`)}</span>`
        : "";
      const thumb = `<img src="${adminRoot()}/v2/templates/${encodeURIComponent(tp.id)}/preview?size=64" class="wp-tpl-thumb" loading="lazy" onerror="this.style.opacity=0.3">`;
      return `<div class="wp-li">${thumb}
        <div style="flex:1">
          <b>${esc(tp.name)}</b> ${badge} <span class="wp-badge member">${esc(tp.scope)}</span> ${clanLine}
          <br><span class="sub">@${tp.x},${tp.y} · ${tp.scale}x · by ${esc(tp.author || "?")}</span>
        </div>
        <span class="del" data-admin-del-tpl="${esc(tp.id)}" title="delete" style="cursor:pointer;color:#c33">${ic("trash", 12)}</span>
      </div>`;
    }).join("") || `<div style="padding:6px;color:var(--sub)">— no templates —</div>`;

    box.querySelectorAll<HTMLElement>("[data-admin-del-tpl]").forEach((b) =>
      b.addEventListener("click", async () => {
        const ok = await confirmDlg("Delete this template?", "Confirm Delete");
        if (!ok) return;
        try {
          await adminReq("DELETE", `/admin/templates/${b.dataset.adminDelTpl}`);
          toast("Admin", "template deleted");
          loadAdminTemplates();
        } catch (e: any) { await errorDlg(errMsg(e)); }
      }),
    );
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33;padding:6px">${esc(errMsg(e))}</div>`;
  }
}

export async function loadAdminNotifs(): Promise<void> {
  const box = $("admin-notifs");
  if (!box) return;
  try {
    const items = await adminReq("GET", "/admin/notifications");
    box.innerHTML = (items || []).map((n: any) => `
      <div class="wp-li">
        <div style="flex:1">
          <b>${esc(n.title)}</b> ${n.read ? '<span class="wp-badge member">read</span>' : '<span class="wp-badge mod">unread</span>'}
          <br><span class="sub">${esc(n.body || "")}</span>
        </div>
        <span class="del" data-admin-del-notif="${esc(n.id)}" title="delete" style="cursor:pointer;color:#c33">${ic("trash", 12)}</span>
      </div>`).join("") || `<div style="padding:6px;color:var(--sub)">— no notifications —</div>`;

    box.querySelectorAll<HTMLElement>("[data-admin-del-notif]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDlg("Delete this notification?", "Confirm"))) return;
        try {
          await adminReq("DELETE", `/admin/notifications/${b.dataset.adminDelNotif}`);
          toast("Admin", "notification deleted");
          loadAdminNotifs();
        } catch (e: any) { await errorDlg(errMsg(e)); }
      }),
    );
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33;padding:6px">${esc(errMsg(e))}</div>`;
  }
}
