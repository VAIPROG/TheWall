import { $, esc, errMsg } from "../helpers";
import { t } from "../i18n";
import { ic } from "../icons";
import { toast } from "../notify";
import { confirmDlg, errorDlg, infoDlg } from "../dialog";
import { log } from "../log";
import { getActiveClient } from "../backend/index";
import { wireAdminConsole, broadcastNotification } from "./admin-ui";
import { segmented, loading } from "./kit/primitives";
import {
  listCatalogue,
  adminGrant,
  adminRevoke,
  adminGrantByName,
  adminRevokeByName,
  adminCreate,
} from "../achievements";

export function wireAdmin(_win: HTMLElement): void {
  // The V3 console (sub-nav, dashboard, users, moderation, broadcast, system)
  // wires itself — see ui/admin-ui.ts wireAdminConsole. Everything below is
  // the Tools section: achievements admin + the legacy preview backfill.
  wireAdminConsole();
  $("btn-broadcast")?.addEventListener("click", broadcastNotification);

  // Admin: achievement grant/revoke. Populate the picker from the catalogue
  // the first time the tab is opened (we lazy-load so non-admins never see it).
  let achCatalogueLoaded = false;
  async function loadAchCatalogue(): Promise<void> {
    if (achCatalogueLoaded) return;
    achCatalogueLoaded = true;
    const sel = $("admin-ach-id") as HTMLSelectElement | null;
    if (!sel) return;
    const cat = await listCatalogue();
    if (!cat.length) {
      achCatalogueLoaded = false;
      return;
    }
    const byCat = new Map<string, typeof cat>();
    for (const a of cat) {
      const arr = byCat.get(a.category) || [];
      arr.push(a);
      byCat.set(a.category, arr);
    }
    sel.innerHTML =
      `<option value="" disabled selected>${esc(t("achAdminPickAch"))}</option>` +
      [...byCat.entries()]
        .map(
          ([cat, items]) =>
            `<optgroup label="${esc(cat)}">${items
              .map(
                (a) =>
                  `<option value="${esc(a.id)}">${esc(a.title)} · ${a.points} pts${a.secret ? " 🔒" : ""}</option>`,
              )
              .join("")}</optgroup>`,
        )
        .join("");
  }
  document
    .querySelectorAll('.wp-tab[data-p="ad"]')
    .forEach((b) => b.addEventListener("click", () => loadAchCatalogue()));
  // The same input field accepts either a UUID (legacy direct path) or a
  // username (looked up server-side). We pick the route by sniffing for a
  // standard UUID v4 shape — anything that doesn't match goes through the
  // username endpoint, which 404s for unknown names.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  $("btn-admin-ach-grant")?.addEventListener("click", async () => {
    const who = ($("admin-ach-uid") as HTMLInputElement)?.value.trim();
    const aid = ($("admin-ach-id") as HTMLSelectElement)?.value;
    if (!who || !aid) {
      await errorDlg("Enter a username or UUID and pick an achievement");
      return;
    }
    try {
      const r = UUID_RE.test(who)
        ? await adminGrant(who, aid)
        : await adminGrantByName(who, aid);
      if (r) {
        toast("Admin", `granted "${r.achievement.title}" (new=${r.wasNew})`);
      } else {
        await errorDlg("Grant failed (see console)");
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      await errorDlg(
        msg.includes("no such user")
          ? `No such user: ${who}`
          : `Grant failed: ${msg}`,
      );
    }
  });
  $("btn-admin-ach-revoke")?.addEventListener("click", async () => {
    const who = ($("admin-ach-uid") as HTMLInputElement)?.value.trim();
    const aid = ($("admin-ach-id") as HTMLSelectElement)?.value;
    if (!who || !aid) {
      await errorDlg("Enter a username or UUID and pick an achievement");
      return;
    }
    if (!(await confirmDlg(`Revoke "${aid}" from ${who}?`, "Revoke"))) return;
    try {
      const ok = UUID_RE.test(who)
        ? await adminRevoke(who, aid)
        : await adminRevokeByName(who, aid);
      if (ok) toast("Admin", "revoked");
      else await errorDlg("Revoke failed");
    } catch (e: any) {
      const msg = e?.message || String(e);
      await errorDlg(
        msg.includes("no such user")
          ? `No such user: ${who}`
          : `Revoke failed: ${msg}`,
      );
    }
  });
  $("btn-admin-ach-create")?.addEventListener("click", async () => {
    const id = ($("admin-ach-new-id") as HTMLInputElement)?.value.trim();
    const name = ($("admin-ach-new-name") as HTMLInputElement)?.value.trim();
    const desc = ($("admin-ach-new-desc") as HTMLInputElement)?.value.trim();
    const icon =
      ($("admin-ach-new-icon") as HTMLSelectElement)?.value || "medal";
    const category =
      ($("admin-ach-new-cat") as HTMLSelectElement)?.value || "general";
    const points = Number(
      ($("admin-ach-new-pts") as HTMLInputElement)?.value || "10",
    );
    const secret =
      ($("admin-ach-new-secret") as HTMLInputElement)?.checked || false;
    if (!id || !name || !desc) {
      await errorDlg("ID, name and description are required");
      return;
    }
    if (!/^[a-z0-9_]+$/.test(id)) {
      await errorDlg("ID must be lowercase snake_case (a–z, 0–9, _)");
      return;
    }
    try {
      const row = await adminCreate({
        id,
        title: name,
        description: desc,
        iconUrl: icon,
        category,
        points,
        secret,
      });
      if (row) {
        toast("Admin", `${t("achAdminCreated")}: ${row.title}`);
        // Refresh the grant dropdown.
        const opt = document.createElement("option");
        opt.value = row.id;
        opt.textContent = `${row.title} · ${row.points} pts${row.secret ? " 🔒" : ""}`;
        ($("admin-ach-id") as HTMLSelectElement | null)?.appendChild(opt);
        // Reset the form.
        ($("admin-ach-new-id") as HTMLInputElement).value = "";
        ($("admin-ach-new-name") as HTMLInputElement).value = "";
        ($("admin-ach-new-desc") as HTMLInputElement).value = "";
      }
    } catch (e: any) {
      await errorDlg("Create failed: " + errMsg(e));
    }
  });

  $("btn-backfill-previews")?.addEventListener("click", async () => {
    const ok = await confirmDlg(
      "Generate previews for every template that doesn't have one yet?\nThis can take a while on a large catalog.",
      "Backfill previews",
    );
    if (!ok) return;
    const btn = $("btn-backfill-previews") as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Working…";
    }
    try {
      const client = getActiveClient();
      if (!client) throw new Error("backend offline");
      // NOTE: V3 only has /admin/templates/backfill-documents (a different
      // op — document-format migration, not thumbnails). Stays on V2.
      const r = await client.postRoot<any>(
        "/v2/admin/templates/backfill-previews",
        {},
      );
      log("ADMIN", "OK", "backfill: " + JSON.stringify(r));
      await infoDlg(
        `Scanned ${r.scanned}\n` +
          `Generated ${r.generated}\n` +
          `Skipped (undecodable share) ${r.skipped_undecodable}\n` +
          `Skipped (already cached) ${r.skipped_already_cached}\n` +
          `Failed ${r.failed}`,
        "Backfill complete",
      );
    } catch (e: any) {
      await errorDlg("Backfill failed: " + errMsg(e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = ic("scan") + "Backfill missing previews";
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pane markup — sectioned V3 admin console. Section visibility is toggled by
// setAdminSection (admin-ui.ts) via the `.wd-adm-sec.is-on` class; loaders run
// lazily on section open, so non-admins pay nothing for the hidden pane.
// ---------------------------------------------------------------------------

/** One Win95 group box (trusted body — callers esc() their own dynamic text). */
function grp(icon: string, legend: string, body: string): string {
  return `<div class="wp-group"><div class="wp-legend">${ic(icon)}${esc(legend)}</div>${body}</div>`;
}

export function buildAdminPane(): string {
  return `<div class="wp-pane" data-p="ad">
      <div id="admin-subnav">${segmented(
        [
          { value: "dash", label: "▤ Board" },
          { value: "users", label: "Users" },
          { value: "mod", label: "Mod" },
          { value: "bc", label: "Cast" },
          { value: "sys", label: "System" },
          { value: "tools", label: "Tools" },
        ],
        "dash",
      )}</div>

      <!-- 1 · Dashboard — /admin/stats + maintenance/metrics health pills -->
      <div class="wd-adm-sec is-on" id="admin-sec-dash">
        ${grp("shield", "Platform overview", `
          <div class="wd-adm-stats" id="admin-stats">${loading()}</div>
          <div class="wd-adm-health" id="admin-dash-health"></div>
          <button class="wd-btn wd-btn--sm" id="btn-admin-dash-refresh" style="margin-top:6px">↻ Refresh</button>
          <div class="wp-note" style="color:var(--sub)">Click a card to jump to its section.</div>
        `)}
      </div>

      <!-- 2 · Users — /admin/users search → per-user action panel -->
      <div class="wd-adm-sec" id="admin-sec-users">
        ${grp("user", "User search", `
          <div class="wd-adm-bar">
            <input id="admin-user-q" name="admin_user_q" autocomplete="off" type="text" class="wp-input" placeholder="username / display name / wall id">
            <select id="admin-user-role" name="admin_user_role" class="wp-input" style="font:11px sans-serif;width:auto">
              <option value="">any role</option>
              <option value="member">member</option>
              <option value="moderator">moderator</option>
              <option value="admin">admin</option>
              <option value="owner">owner</option>
            </select>
            <button class="wd-btn wd-btn--sm" id="btn-admin-user-search">🔍</button>
          </div>
          <div class="wd-list wd-list--scroll" id="admin-users" style="margin-top:6px;max-height:220px">${loading()}</div>
          <div class="wd-adm-pager">
            <button class="wd-btn wd-btn--sm" id="btn-admin-users-prev">‹</button>
            <span id="admin-users-page">page 1</span>
            <button class="wd-btn wd-btn--sm" id="btn-admin-users-next">›</button>
          </div>
        `)}
        <div class="wd-card wd-adm-panel" id="admin-user-panel" style="display:none"></div>
      </div>

      <!-- 3 · Moderation — reports, template queue, message removal, clans -->
      <div class="wd-adm-sec" id="admin-sec-mod">
        ${grp("shield", "Reports", `
          <div id="admin-rep-filter">${segmented(
            [
              { value: "open", label: "open" },
              { value: "reviewing", label: "reviewing" },
              { value: "resolved", label: "resolved" },
              { value: "dismissed", label: "dismissed" },
              { value: "all", label: "all" },
            ],
            "open",
          )}</div>
          <div class="wd-list wd-list--scroll" id="admin-reports" style="margin-top:6px">${loading()}</div>
          <div class="wd-adm-pager">
            <button class="wd-btn wd-btn--sm" id="btn-admin-rep-prev">‹</button>
            <span id="admin-rep-page">page 1</span>
            <button class="wd-btn wd-btn--sm" id="btn-admin-rep-next">›</button>
          </div>
        `)}
        ${grp("disk", "Template approval queue", `
          <div class="wd-list wd-list--scroll" id="admin-queue">${loading()}</div>
          <div class="wp-note" style="color:var(--sub)"><span id="admin-queue-count"></span> Oldest first; rejection notes reach the author's mailbox.</div>
        `)}
        ${grp("trash", "Remove a message (global)", `
          <div class="wd-adm-bar">
            <input id="admin-msg-id" name="admin_msg_id" autocomplete="off" type="text" class="wp-input" placeholder="message UUID">
            <button class="wd-btn wd-btn--sm" id="btn-admin-msg-del">Delete</button>
          </div>
          <div class="wp-note" style="color:var(--sub)">Soft-deletes (tombstones) in any chat — no membership needed.</div>
        `)}
        ${grp("shield", "Clan takedown / unlock", `
          <input id="admin-td-clan" name="admin_td_clan" autocomplete="off" type="text" class="wp-input" placeholder="clan UUID">
          <div class="wd-adm-tdfields">
            ${["avatar", "banner", "description", "tag", "discoverable"]
              .map((f) => `<label class="wp-check"><input type="checkbox" data-tdf="${f}"> ${f}</label>`)
              .join("")}
          </div>
          <div class="wd-adm-bar" style="margin-top:4px">
            <select id="admin-td-action" name="admin_td_action" class="wp-input" style="font:11px sans-serif;width:auto">
              <option value="strip_and_lock">strip + lock</option>
              <option value="strip">strip only</option>
            </select>
            <input id="admin-td-reason" name="admin_td_reason" autocomplete="off" type="text" class="wp-input" placeholder="reason (required for takedown)">
          </div>
          <div class="wd-adm-acts" style="margin-top:4px">
            <button class="wd-btn wd-btn--sm wd-btn--danger" id="btn-admin-td">Takedown</button>
            <button class="wd-btn wd-btn--sm" id="btn-admin-td-unlock">Unlock fields</button>
          </div>
        `)}
        ${grp("user", "Moderator applications (legacy)", `
          <div class="wd-list wd-list--scroll" id="admin-modapps">${loading()}</div>
        `)}
      </div>

      <!-- 4 · Broadcast — legacy titled composer + V3 role-targeted -->
      <div class="wd-adm-sec" id="admin-sec-bc">
        ${grp("bell", "Broadcast (title + news/alert)", `
          <button class="wp-btn primary" id="btn-broadcast">${ic("bell")}Compose broadcast…</button>
          <div class="wp-note" style="color:var(--sub)">Titled news/alert via the legacy pipe — the V3 broadcast can't carry a title or the alert kind yet.</div>
        `)}
        ${grp("bell", "Targeted broadcast (V3)", `
          <textarea id="admin-bc-msg" name="admin_bc_msg" class="wp-input" rows="3" placeholder="plain message, 1–2000 chars" autocomplete="off"></textarea>
          <div class="wd-adm-bar" style="margin-top:4px">
            <select id="admin-bc-role" name="admin_bc_role" class="wp-input" style="font:11px sans-serif;width:auto">
              <option value="all">everyone</option>
              <option value="member">members</option>
              <option value="moderator">moderators</option>
              <option value="admin">admins</option>
              <option value="owner">owners</option>
            </select>
            <button class="wd-btn wd-btn--sm wd-btn--primary" id="btn-admin-bc-v3">Send</button>
          </div>
          <div class="wp-note" style="color:var(--sub)">Lands as a "Broadcast" system notification for the picked role.</div>
        `)}
        ${grp("bell", "Sent notifications (legacy)", `
          <div class="wd-list wd-list--scroll" id="admin-notifs" style="max-height:200px">${loading()}</div>
        `)}
      </div>

      <!-- 5 · System — runtime config, maintenance, audit log -->
      <div class="wd-adm-sec" id="admin-sec-sys">
        ${grp("plug", "Runtime config", `
          <div class="wd-adm-form" id="admin-config">${loading()}</div>
          <button class="wd-btn wd-btn--sm" id="btn-admin-cfg-save" style="margin-top:6px">Save config</button>
          <div class="wp-note" style="color:var(--sub)">PATCH is owner-only; values live in memory until the next restart.</div>
        `)}
        ${grp("moon", "Maintenance mode", `
          <div class="wd-adm-health" id="admin-maint">${loading()}</div>
          <div class="wd-adm-bar" style="margin-top:4px">
            <input id="admin-maint-reason" name="admin_maint_reason" autocomplete="off" type="text" class="wp-input" placeholder="reason (optional)">
            <input id="admin-maint-dur" name="admin_maint_dur" autocomplete="off" type="text" class="wp-input" placeholder="eta, e.g. 2h" style="width:70px;flex:none">
          </div>
          <div class="wd-adm-acts" style="margin-top:4px">
            <button class="wd-btn wd-btn--sm wd-btn--danger" id="btn-admin-maint-on">Enable</button>
            <button class="wd-btn wd-btn--sm" id="btn-admin-maint-off">Disable</button>
          </div>
        `)}
        ${grp("scan", "Audit log", `
          <div class="wd-adm-bar">
            <input id="admin-audit-action" name="admin_audit_action" autocomplete="off" type="text" class="wp-input" placeholder="action contains…">
            <input id="admin-audit-ttype" name="admin_audit_ttype" autocomplete="off" type="text" class="wp-input" placeholder="target type…" style="width:90px;flex:none">
            <button class="wd-btn wd-btn--sm" id="btn-admin-audit-apply">Filter</button>
          </div>
          <div class="wd-list wd-list--scroll" id="admin-audit" style="margin-top:6px;max-height:240px">${loading()}</div>
          <div class="wd-adm-pager">
            <button class="wd-btn wd-btn--sm" id="btn-admin-audit-prev">‹</button>
            <span id="admin-audit-page">page 1</span>
            <button class="wd-btn wd-btn--sm" id="btn-admin-audit-next">›</button>
          </div>
        `)}
        <div class="wp-note" style="color:var(--sub)">Server shutdown/restart is deliberately not exposed here — the V3 handlers only log the request; use the VPS operator tooling.</div>
      </div>

      <!-- 6 · Tools — legacy template catalog + achievements admin -->
      <div class="wd-adm-sec" id="admin-sec-tools">
        ${grp("disk", "All templates (legacy)", `
          <div class="wd-list wd-list--scroll" id="admin-templates" style="max-height:200px">${loading()}</div>
          <button class="wp-btn" id="btn-backfill-previews" style="margin-top:6px;width:100%">${ic("scan")}Backfill missing previews</button>
          <div class="wp-note" style="color:var(--sub);font-size:10px">Generates 64/128/256 thumbnails for every template that doesn't have one yet. Heavy on large catalogs.</div>
        `)}
        <div class="wp-group"><div class="wp-legend">${ic("user")}${t("achAdminGrantTitle")}</div>
            <input id="admin-ach-uid" name="admin_ach_uid" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminUserId")}">
            <select id="admin-ach-id" name="admin_ach_id" class="wp-input" style="font:11px sans-serif">
                <option value="" disabled selected>${t("achAdminPickAch")}</option>
            </select>
            <div style="display:flex;gap:4px;margin-top:4px">
                <button class="wp-btn primary" id="btn-admin-ach-grant" style="flex:1">${ic("plus")}${t("achAdminGrant")}</button>
                <button class="wp-btn" id="btn-admin-ach-revoke" style="flex:1">${ic("trash")}${t("achAdminRevoke")}</button>
            </div>
        </div>
        <div class="wp-group"><div class="wp-legend">${ic("plus")}${t("achAdminCreateTitle")}</div>
            <input id="admin-ach-new-id" name="admin_ach_new_id" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminCreateId")}">
            <input id="admin-ach-new-name" name="admin_ach_new_name" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminCreateName")}">
            <input id="admin-ach-new-desc" name="admin_ach_new_desc" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminCreateDesc")}">
            <div style="display:flex;gap:4px;margin-top:4px">
                <select id="admin-ach-new-icon" name="admin_ach_new_icon" class="wp-input" style="font:11px sans-serif;flex:1">
                    <option value="medal">medal</option>
                    <option value="crown">crown</option>
                    <option value="trophy">trophy</option>
                    <option value="palette">palette</option>
                    <option value="spark">spark</option>
                    <option value="sparkle">sparkle</option>
                    <option value="shield">shield</option>
                    <option value="plug">plug</option>
                    <option value="user">user</option>
                    <option value="globe">globe</option>
                    <option value="discord">discord</option>
                    <option value="telegram">telegram</option>
                    <option value="moon">moon</option>
                    <option value="check">check</option>
                    <option value="bell">bell</option>
                    <option value="bolt">bolt</option>
                    <option value="pin">pin</option>
                    <option value="grid">grid</option>
                    <option value="scan">scan</option>
                    <option value="star">star</option>
                </select>
                <select id="admin-ach-new-cat" name="admin_ach_new_cat" class="wp-input" style="font:11px sans-serif;flex:1">
                    <option value="general">${t("achCategoryGeneral")}</option>
                    <option value="pixels">${t("achCategoryPixels")}</option>
                    <option value="templates">${t("achCategoryTemplates")}</option>
                    <option value="clan">${t("achCategoryClan")}</option>
                    <option value="social">${t("achCategorySocial")}</option>
                    <option value="tools">${t("achCategoryTools")}</option>
                    <option value="time">${t("achCategoryTime")}</option>
                    <option value="easter">${t("achCategoryEaster")}</option>
                </select>
            </div>
            <div style="display:flex;gap:4px;margin-top:4px;align-items:center">
                <label style="flex:1;font-size:11px">${t("achAdminCreatePoints")} <input id="admin-ach-new-pts" name="admin_ach_new_pts" type="number" class="wp-input" value="10" min="0" max="1000" style="width:60px;display:inline"></label>
                <label class="wp-check" style="flex:1.4"><input type="checkbox" id="admin-ach-new-secret"> ${t("achAdminCreateSecret")}</label>
            </div>
            <button class="wp-btn primary" id="btn-admin-ach-create" style="margin-top:4px;width:100%">${ic("plus")}${t("achAdminCreate")}</button>
        </div>
      </div>

      <div class="wp-note" style="color:var(--sub)">Admin actions are server-validated. You see this tab because your backend role is admin/owner.</div>
  </div>`;
}
