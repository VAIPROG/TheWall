/**
 * Admin console (V3) — the logic behind the Admin super-tab.
 *
 * Sections (segmented sub-nav, one visible at a time — see buildAdminPane):
 *   Dashboard  — /admin/stats + /admin/maintenance + /admin/metrics
 *   Users      — /admin/users search → per-user action panel (ban/mute/promote/
 *                sessions/notes/wipeout/impersonate…)
 *   Moderation — /moderation/reports review, /moderation/queue approvals,
 *                /admin/messages/{id} removal, clan takedown/unlock
 *   Broadcast  — legacy titled composer + V3 role-targeted broadcast
 *   System     — /admin/config, /admin/maintenance, /admin/audit
 *   Tools      — legacy template catalog + achievements admin
 *
 * Everything V3 goes through the typed facades (backend/admin.ts,
 * backend/moderation.ts). The handful of features with NO V3 equivalent stay
 * on the legacy root-scoped endpoints via `legacyReq` and are labelled
 * "(legacy)" in the pane:
 *   - /admin/moderation        moderator applications review
 *   - /admin/templates         full catalog list + hard delete
 *   - /admin/notifications     sent-notification inbox view
 *   - /admin/broadcast         titled news/alert broadcast (V3 broadcast has
 *                              no title/kind — see BACKEND GAP note below)
 *   - /v2/admin/templates/backfill-previews
 *
 * The V3 shutdown/restart endpoints are deliberately NOT exposed (see
 * backend/admin.ts — the handlers are no-ops that only audit-log).
 */
import { getActiveClient, getMe, api } from "../backend/index";
import type {
  AdminUserRow,
  AdminSession,
  AdminNoteWire,
  ServerConfigWire,
} from "../backend/admin";
import type { ReportViewWire, RestrictionViewWire } from "../backend/moderation";
import { $, esc, errMsg } from "../helpers";
import { log } from "../log";
import { toast } from "../notify";
import { confirmDlg, errorDlg, infoDlg, promptDlg } from "../dialog";
import { isWalldevDark } from "../theme";
import { badge, loading, emptyState, errorState } from "./kit/primitives";
import {
  statsCards,
  userSearchQuery,
  pageCount,
  parseDuration,
  fmtDuration,
  fmtWhen,
  auditRowVM,
  parseMetrics,
  fmtUptime,
  roleBadgeKind,
} from "./admin-model";
import { takedownBody, takedownClan, unlockClan } from "./community/api";

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

/** Typed V3 facade for the active, authenticated client (null when offline). */
function backendApi() {
  const c = getActiveClient();
  return c && c.token ? api(c) : null;
}

/** Legacy V1/V2 request against the API root (for endpoints with no V3 twin). */
function legacyReq<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const client = getActiveClient();
  if (!client) return Promise.reject(new Error("backend offline"));
  return client.req<T>({ method, path, body, root: true });
}
function legacyRoot(): string {
  return getActiveClient()?.rootUrl ?? "";
}

export function isAdmin(): boolean {
  const me = getMe();
  if (!me) return false;
  // Backend exposes `globalRole` (V3) / `global_role` (rich /v2/auth/me) —
  // keep `role` for legacy bootstraps. Either being admin/owner unlocks the tab.
  const r = String(
    (me as any).globalRole || (me as any).global_role || me.role || "",
  ).toLowerCase();
  return r === "admin" || r === "owner";
}

export function updateAdminVisibility(): void {
  const tab = $("tab-admin");
  if (tab) tab.style.display = isAdmin() ? "" : "none";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Section switching (segmented sub-nav)
// ---------------------------------------------------------------------------

export type AdminSection = "dash" | "users" | "mod" | "bc" | "sys" | "tools";
let curSection: AdminSection = "dash";

export function setAdminSection(sec: AdminSection): void {
  curSection = sec;
  $("admin-subnav")
    ?.querySelectorAll<HTMLElement>("[data-seg]")
    .forEach((b) => b.classList.toggle("is-on", b.dataset.seg === sec));
  document
    .querySelectorAll<HTMLElement>(".wd-adm-sec")
    .forEach((el) => el.classList.toggle("is-on", el.id === `admin-sec-${sec}`));
  loadSection(sec);
}

/** Re-fetch the visible section — window-chrome calls this on tab open. */
export function refreshAdmin(): void {
  if (!isAdmin()) return;
  loadSection(curSection);
}

function loadSection(sec: AdminSection): void {
  switch (sec) {
    case "dash":
      loadAdminStats().catch(() => {});
      break;
    case "users":
      loadAdminUsers().catch(() => {});
      break;
    case "mod":
      loadReports().catch(() => {});
      loadQueue().catch(() => {});
      loadModApps().catch(() => {});
      break;
    case "bc":
      loadAdminNotifs().catch(() => {});
      break;
    case "sys":
      loadConfig().catch(() => {});
      loadMaintenance().catch(() => {});
      loadAudit().catch(() => {});
      break;
    case "tools":
      loadAdminTemplates().catch(() => {});
      break;
  }
}

// ---------------------------------------------------------------------------
// Dashboard — GET /admin/stats (+ maintenance / metrics pills)
// ---------------------------------------------------------------------------

export async function loadAdminStats(): Promise<void> {
  const box = $("admin-stats");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  box.innerHTML = loading();
  try {
    const s = await a.admin.stats();
    box.innerHTML = statsCards(s)
      .map(
        (c) =>
          `<div class="wd-adm-stat${c.alert ? " is-alert" : ""}"` +
          (c.goto ? ` data-goto="${esc(c.goto)}" title="open section"` : "") +
          `><div class="v">${esc(c.value)}</div><div class="k">${esc(c.label)}</div></div>`,
      )
      .join("");
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
  // Health pills are best-effort and independent of the stats fetch.
  const hb = $("admin-dash-health");
  if (!hb) return;
  const [mt, mx] = await Promise.allSettled([a.admin.maintenance(), a.admin.metrics()]);
  const pills: string[] = [];
  if (mt.status === "fulfilled" && mt.value) {
    pills.push(
      mt.value.enabled
        ? `<span class="wd-pill wd-pill--warn">maintenance ON${mt.value.reason ? ` — ${esc(mt.value.reason)}` : ""}</span>`
        : `<span class="wd-pill wd-pill--ok">maintenance off</span>`,
    );
  }
  if (mx.status === "fulfilled" && typeof mx.value === "string") {
    const m = parseMetrics(mx.value);
    pills.push(
      `<span class="wd-pill wd-pill--${m.dbOk === false ? "err" : "ok"}">db ${m.dbOk === false ? "FAIL" : "ok"}</span>`,
      `<span class="wd-pill wd-pill--info">up ${esc(fmtUptime(m.uptimeSeconds))}</span>`,
    );
    if (m.poolActive !== null) {
      pills.push(`<span class="wd-pill wd-pill--info">pool ${esc(String(m.poolActive))}</span>`);
    }
  }
  hb.innerHTML = pills.join(" ");
}

// ---------------------------------------------------------------------------
// Users — GET /admin/users search + the per-user action panel
// ---------------------------------------------------------------------------

const usersState = { q: "", role: "", page: 1, limit: 50, total: 0 };
/** The user currently open in the action panel (null = panel hidden). */
let selUser: AdminUserRow | null = null;

export async function loadAdminUsers(): Promise<void> {
  const box = $("admin-users");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  box.innerHTML = loading();
  try {
    const params = userSearchQuery(usersState.q, usersState.role, usersState.page, usersState.limit);
    const page = await a.admin.listUsers(params);
    usersState.total = page?.total ?? 0;
    usersState.page = page?.page ?? params.page;
    const rows = page?.users ?? [];
    box.innerHTML =
      rows
        .map((u) => {
          const role = String(u.globalRole || u.role || "member").toLowerCase();
          return `<div class="wd-row wd-adm-urow" data-uref="${esc(u.id)}">
            <div class="grow">
              <b>${esc(u.username)}</b> ${badge(role, roleBadgeKind(role))}${
                u.displayName ? ` <span class="sub">${esc(u.displayName)}</span>` : ""
              }
              <br><span class="sub">wall #${esc(u.wall_id)}${
                u.discordUsername ? ` · dc ${esc(u.discordUsername)}` : ""
              } · joined ${esc(fmtWhen(u.createdAt))}</span>
            </div>
            <span class="sub">›</span>
          </div>`;
        })
        .join("") || emptyState("no users match", "👤");
    const pages = pageCount(usersState.total, usersState.limit);
    const lbl = $("admin-users-page");
    if (lbl) lbl.textContent = `page ${usersState.page}/${pages || 1} · ${usersState.total} users`;
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

function usersSearchFromInputs(): void {
  usersState.q = ($("admin-user-q") as HTMLInputElement | null)?.value ?? "";
  usersState.role = ($("admin-user-role") as HTMLSelectElement | null)?.value ?? "";
  usersState.page = 1;
  loadAdminUsers().catch(() => {});
}

function usersPageBy(delta: number): void {
  const pages = pageCount(usersState.total, usersState.limit);
  const next = Math.min(Math.max(1, usersState.page + delta), Math.max(1, pages || 1));
  if (next === usersState.page) return;
  usersState.page = next;
  loadAdminUsers().catch(() => {});
}

/** Human label for an active restriction row (sanction flags → words). */
function restrictionLabel(r: RestrictionViewWire): string {
  const kinds: string[] = [];
  if (r.sanctions?.ban) kinds.push("BAN");
  if (r.sanctions?.mute) kinds.push("MUTE");
  if (r.sanctions?.publishTemplates) kinds.push("no-publish");
  if (r.sanctions?.inviteToClan) kinds.push("no-invite");
  if (r.sanctions?.sendReports) kinds.push("no-reports");
  if (r.sanctions?.sendModmail) kinds.push("no-modmail");
  const kind = kinds.join("+") || "restriction";
  const until = r.expiresAt ? ` until ${fmtWhen(r.expiresAt)}` : " (permanent)";
  return `${kind}${r.reason ? ` — ${r.reason}` : ""}${until}`;
}

async function openUserPanel(ref: string): Promise<void> {
  const panel = $("admin-user-panel");
  if (!panel) return;
  const a = backendApi();
  if (!a) return;
  panel.style.display = "";
  panel.innerHTML = loading("Loading user…");
  try {
    const [u, restr, notes] = await Promise.all([
      a.admin.getUser(ref),
      a.moderation.userRestrictions(ref, { perPage: 20 }).catch(() => null),
      a.admin.notes(ref).catch(() => [] as AdminNoteWire[]),
    ]);
    selUser = u;
    panel.innerHTML = renderUserPanel(u, restr?.items ?? [], notes ?? []);
    panel.scrollIntoView({ block: "nearest" });
  } catch (e: any) {
    panel.innerHTML = errorState(errMsg(e));
  }
}

function renderUserPanel(
  u: AdminUserRow,
  restr: RestrictionViewWire[],
  notes: AdminNoteWire[],
): string {
  const role = String(u.globalRole || u.role || "member").toLowerCase();
  const kv = (k: string, v: string) =>
    v ? `<div class="wd-kv"><span class="wd-kv-k">${esc(k)}</span><span class="wd-kv-v">${esc(v)}</span></div>` : "";
  // The view has no removedAt (backend gap) — filter what we can: expired rows.
  const now = Date.now();
  const active = restr.filter((r) => !r.expiresAt || new Date(r.expiresAt).getTime() > now);
  const restrHtml = active.length
    ? active
        .map((r) => `<div class="wd-pill wd-pill--err">${esc(restrictionLabel(r))}</div>`)
        .join("")
    : `<span class="sub">no active restrictions on record</span>`;
  const notesHtml = notes.length
    ? notes
        .map(
          (n) => `<div class="wd-row"><div class="grow">
            <span class="sub">${esc(n.authorUsername || "?")} · ${esc(fmtWhen(n.createdAt))}</span>
            <br>${esc(n.content)}</div></div>`,
        )
        .join("")
    : emptyState("no mod notes");
  const btn = (act: string, label: string, cls = "") =>
    `<button class="wd-btn wd-btn--sm${cls ? ` ${cls}` : ""}" data-act="${act}">${esc(label)}</button>`;
  return `<div class="wd-adm-phead">
      <b>${esc(u.username)}</b> ${badge(role, roleBadgeKind(role))}
      <button class="wd-btn wd-btn--sm" data-act="close" style="margin-left:auto">✕ close</button>
    </div>
    <div class="wd-kvgrid">
      ${kv("id", u.id)}
      ${kv("wall id", u.wall_id)}
      ${kv("display name", u.displayName || "")}
      ${kv("discord", u.discordUsername ? `${u.discordUsername} (${u.discordId || "?"})` : "")}
      ${kv("source", u.source || "")}
      ${kv("created", fmtWhen(u.createdAt))}
      ${kv("updated", fmtWhen(u.updatedAt))}
    </div>
    <div class="wd-group"><div class="wd-legend">Restrictions</div>
      <div class="wd-adm-restr">${restrHtml}</div>
    </div>
    <div class="wd-group"><div class="wd-legend">Role</div>
      <div class="wd-adm-acts">
        <select id="admin-up-role" class="wp-input" style="font:11px sans-serif;width:auto">
          ${["member", "moderator", "admin", "owner"]
            .map((r) => `<option value="${r}"${r === role ? " selected" : ""}>${r}</option>`)
            .join("")}
        </select>
        ${btn("promote", "Apply role")}
      </div>
      <div class="sub">Promote to admin/owner requires the OWNER account (server-enforced).</div>
    </div>
    <div class="wd-group"><div class="wd-legend">Sanctions</div>
      <div class="wd-adm-acts">
        ${btn("ban", "Ban…", "wd-btn--danger")}${btn("unban", "Unban")}
        ${btn("mute", "Mute…", "wd-btn--danger")}${btn("unmute", "Unmute")}
      </div>
    </div>
    <div class="wd-group"><div class="wd-legend">Hygiene</div>
      <div class="wd-adm-acts">
        ${btn("reset-avatar", "Reset avatar")}${btn("reset-username", "Reset username")}${btn("remove-clan", "Remove from clan")}
      </div>
    </div>
    <div class="wd-group"><div class="wd-legend">Sessions</div>
      <div class="wd-list wd-list--scroll" id="admin-up-sessions"><div class="sub" style="padding:4px 6px">not loaded</div></div>
      <div class="wd-adm-acts" style="margin-top:4px">
        ${btn("sessions-load", "Load sessions")}${btn("sessions-kill", "Terminate ALL", "wd-btn--danger")}
      </div>
    </div>
    <div class="wd-group"><div class="wd-legend">Mod notes</div>
      <div class="wd-list wd-list--scroll" id="admin-up-notes">${notesHtml}</div>
      <div class="wd-adm-acts" style="margin-top:4px">
        <input id="admin-up-note" name="admin_up_note" autocomplete="off" type="text" class="wp-input" placeholder="add a note (1–2000 chars)" style="flex:1">
        ${btn("note-add", "Add")}
      </div>
    </div>
    <div class="wd-danger-zone"><div class="wd-legend">Danger zone</div>
      <div class="wd-adm-acts">
        ${btn("wipeout", "Wipe content…", "wd-btn--danger")}
        ${btn("impersonate", "Impersonate…", "wd-btn--danger")}
        ${btn("delete-legacy", "Delete account (legacy)…", "wd-btn--danger")}
      </div>
      <div class="sub">Wipeout deletes the user's templates/messages/avatar (owner-only, typed confirm). Impersonate mints a temporary session token.</div>
    </div>`;
}

/** Delegated click handler for the user action panel. */
async function onUserPanelClick(e: Event): Promise<void> {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
  if (!el) return;
  const act = el.dataset.act!;
  const panel = $("admin-user-panel");
  if (act === "close") {
    selUser = null;
    if (panel) {
      panel.style.display = "none";
      panel.innerHTML = "";
    }
    return;
  }
  const u = selUser;
  const a = backendApi();
  if (!u || !a) return;
  const reload = () => openUserPanel(u.id);
  try {
    switch (act) {
      case "promote": {
        const role = ($("admin-up-role") as HTMLSelectElement | null)?.value;
        if (!role) return;
        if (!(await confirmDlg(`Set global role of "${u.username}" to ${role}?`, "Promote"))) return;
        await a.admin.promote(u.id, role);
        toast("Admin", `role → ${role}`);
        await reload();
        loadAdminUsers().catch(() => {});
        break;
      }
      case "ban":
      case "mute": {
        const verb = act === "ban" ? "Ban" : "Mute";
        const reason = await promptDlg(`${verb} reason (shown in audit + appeal):`, "", verb);
        if (reason === null) return;
        const durRaw = await promptDlg(
          "Duration — e.g. 30m, 2h, 7d. Leave empty for PERMANENT:",
          "",
          `${verb} duration`,
        );
        if (durRaw === null) return;
        const dur = parseDuration(durRaw);
        if (dur === null) {
          await errorDlg("Couldn't parse that duration. Use 30, 45m, 2h, 7d or 1w.");
          return;
        }
        const durTxt = dur === undefined ? "PERMANENT" : fmtDuration(dur);
        if (!(await confirmDlg(`${verb} "${u.username}" — ${durTxt}?`, `Confirm ${verb}`))) return;
        if (act === "ban") await a.admin.ban(u.id, reason || undefined, dur);
        else await a.admin.mute(u.id, reason || undefined, dur);
        toast("Admin", `${act} applied (${durTxt})`);
        await reload();
        break;
      }
      case "unban":
      case "unmute": {
        await (act === "unban" ? a.admin.unban(u.id) : a.admin.unmute(u.id));
        toast("Admin", `${act} ok`);
        await reload();
        break;
      }
      case "reset-avatar": {
        if (!(await confirmDlg(`Reset the avatar of "${u.username}"?`, "Reset avatar"))) return;
        await a.admin.resetAvatar(u.id);
        toast("Admin", "avatar reset");
        break;
      }
      case "reset-username": {
        if (!(await confirmDlg(`Reset the username of "${u.username}" to a generic handle?`, "Reset username"))) return;
        const r = await a.admin.resetUsername(u.id);
        toast("Admin", `username → ${r?.newUsername || "reset"}`);
        await reload();
        loadAdminUsers().catch(() => {});
        break;
      }
      case "remove-clan": {
        if (!(await confirmDlg(`Remove "${u.username}" from ALL active clan memberships?`, "Remove from clan"))) return;
        await a.admin.removeFromClan(u.id);
        toast("Admin", "removed from clan");
        break;
      }
      case "sessions-load": {
        const box = $("admin-up-sessions");
        if (!box) return;
        box.innerHTML = loading();
        const rows = await a.admin.sessions(u.id);
        box.innerHTML =
          (rows || [])
            .map(
              (s: AdminSession) => `<div class="wd-row"><div class="grow">
                <b>${esc(s.ip || "?")}</b> <span class="sub">${esc((s.userAgent || "").slice(0, 60))}</span>
                <br><span class="sub">created ${esc(fmtWhen(s.createdAt))}${
                  s.lastActivityAt ? ` · active ${esc(fmtWhen(s.lastActivityAt))}` : ""
                }</span></div></div>`,
            )
            .join("") || emptyState("no sessions");
        break;
      }
      case "sessions-kill": {
        if (!(await confirmDlg(`Terminate ALL sessions of "${u.username}"? They will be logged out everywhere.`, "Terminate sessions"))) return;
        const r = await a.admin.terminateSessions(u.id);
        toast("Admin", `terminated ${r?.count ?? "all"} sessions`);
        const box = $("admin-up-sessions");
        if (box) box.innerHTML = emptyState("no sessions");
        break;
      }
      case "note-add": {
        const inp = $("admin-up-note") as HTMLInputElement | null;
        const content = inp?.value.trim();
        if (!content) return;
        await a.admin.addNote(u.id, content);
        toast("Admin", "note added");
        await reload();
        break;
      }
      case "wipeout": {
        // Backend demands the literal word in the body (ConfirmationRequest);
        // we make the human type it rather than auto-filling.
        const typed = await promptDlg(
          `This permanently deletes ALL templates, messages and the avatar of "${u.username}".\nType WIPEOUT to proceed:`,
          "",
          "Wipe user content",
        );
        if (typed === null) return;
        if (typed.trim() !== "WIPEOUT") {
          await errorDlg("Confirmation text did not match — nothing was deleted.");
          return;
        }
        await a.admin.wipeout(u.id, "WIPEOUT");
        toast("Admin", "user content wiped");
        break;
      }
      case "impersonate": {
        if (
          !(await confirmDlg(
            `Mint a temporary (60 min) session token FOR "${u.username}"?\nThe action is audit-logged against your account.`,
            "Impersonate",
          ))
        )
          return;
        const r = await a.admin.impersonate(u.id);
        const token = r?.accessToken || "";
        try {
          await navigator.clipboard.writeText(token);
          await infoDlg("Impersonation token copied to clipboard (valid 60 min).", "Impersonate");
        } catch {
          // Clipboard can be blocked in extension contexts — offer manual copy.
          await promptDlg("Clipboard unavailable — copy the token manually:", token, "Impersonate");
        }
        break;
      }
      case "delete-legacy": {
        // No V3 delete-account endpoint exists; this is the legacy hard delete.
        const typed = await promptDlg(
          `PERMANENTLY DELETE the account "${u.username}"?\nType DELETE to proceed:`,
          "",
          "Delete account (legacy)",
        );
        if (typed === null) return;
        if (typed.trim() !== "DELETE") {
          await errorDlg("Confirmation text did not match — nothing was deleted.");
          return;
        }
        await legacyReq("DELETE", `/admin/users/${u.id}`);
        toast("Admin", "user deleted");
        selUser = null;
        if (panel) {
          panel.style.display = "none";
          panel.innerHTML = "";
        }
        loadAdminUsers().catch(() => {});
        break;
      }
    }
  } catch (err: any) {
    await errorDlg(`${act} failed: ` + errMsg(err));
  }
}

// ---------------------------------------------------------------------------
// Moderation — reports queue (V3), template approvals (V3), tools
// ---------------------------------------------------------------------------

const repState = { status: "open", page: 1, totalPages: 0 };
let lastReports: ReportViewWire[] = [];
/** Inline form open on one report row ("resolve" or "dismiss"). */
let repForm: { id: string; kind: "resolve" | "dismiss" } | null = null;

export async function loadReports(): Promise<void> {
  const box = $("admin-reports");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  box.innerHTML = loading();
  try {
    const page = await a.moderation.listReports({
      page: repState.page,
      perPage: 20,
      status: repState.status === "all" ? undefined : repState.status,
    });
    lastReports = page?.items ?? [];
    repState.totalPages = page?.totalPages ?? 0;
    const lbl = $("admin-rep-page");
    if (lbl) lbl.textContent = `page ${page?.page ?? 1}/${repState.totalPages || 1} · ${page?.total ?? 0} reports`;
    renderReports();
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

const REP_STATUS_PILL: Record<string, string> = {
  open: "warn",
  reviewing: "info",
  resolved: "ok",
  dismissed: "err",
};

function renderReports(): void {
  const box = $("admin-reports");
  if (!box) return;
  if (!lastReports.length) {
    box.innerHTML = emptyState("no reports in this state", "🛡");
    return;
  }
  box.innerHTML = lastReports
    .map((r) => {
      const pill = `<span class="wd-pill wd-pill--${REP_STATUS_PILL[r.status] || "info"}">${esc(r.status)}</span>`;
      const acts: string[] = [];
      if (r.status === "open")
        acts.push(`<button class="wd-btn wd-btn--sm" data-ra="review" data-rid="${esc(r.id)}">Review</button>`);
      if (r.status === "open" || r.status === "reviewing") {
        acts.push(
          `<button class="wd-btn wd-btn--sm" data-ra="resolve" data-rid="${esc(r.id)}">Resolve…</button>`,
          `<button class="wd-btn wd-btn--sm" data-ra="dismiss" data-rid="${esc(r.id)}">Dismiss…</button>`,
        );
      }
      const done =
        r.resolution && (r.status === "resolved" || r.status === "dismissed")
          ? `<br><span class="sub">→ ${esc(r.resolution)}${r.notes ? ` · ${esc(r.notes)}` : ""}</span>`
          : "";
      // Inline resolve/dismiss form (only one open at a time → fixed ids OK).
      let form = "";
      if (repForm?.id === r.id) {
        form =
          repForm.kind === "resolve"
            ? `<div class="wd-adm-inline">
                <select id="admin-res-kind" class="wp-input" style="font:11px sans-serif">
                  ${["content_removed", "no_action_needed", "user_warned", "user_restricted", "other"]
                    .map((k) => `<option value="${k}">${k}</option>`)
                    .join("")}
                </select>
                <input id="admin-res-notes" name="admin_res_notes" autocomplete="off" type="text" class="wp-input" placeholder="notes (optional, ≤1000)">
                <label class="wp-check"><input type="checkbox" id="admin-res-restrict"> also BAN the offending user</label>
                <div class="wd-adm-acts">
                  <button class="wd-btn wd-btn--sm wd-btn--primary" data-ra="res-confirm" data-rid="${esc(r.id)}">Resolve</button>
                  <button class="wd-btn wd-btn--sm" data-ra="form-cancel">Cancel</button>
                </div>
              </div>`
            : `<div class="wd-adm-inline">
                <select id="admin-dis-reason" class="wp-input" style="font:11px sans-serif">
                  ${["not_actionable", "duplicate", "false_report", "other"]
                    .map((k) => `<option value="${k}">${k}</option>`)
                    .join("")}
                </select>
                <div class="wd-adm-acts">
                  <button class="wd-btn wd-btn--sm wd-btn--primary" data-ra="dis-confirm" data-rid="${esc(r.id)}">Dismiss</button>
                  <button class="wd-btn wd-btn--sm" data-ra="form-cancel">Cancel</button>
                </div>
              </div>`;
      }
      return `<div class="wd-row wd-adm-rep">
        <div class="grow">
          <b>${esc(r.type)}</b> ${pill} <span class="sub">by ${esc(r.reporterUsername)} · ${esc(fmtWhen(r.createdAt))}</span>
          <br><span class="sub">${esc(r.reason)}</span>
          ${r.evidence ? `<br><span class="sub">evidence: ${esc(r.evidence)}</span>` : ""}
          <br><span class="wd-adm-mono">${esc(r.targetType)}:${esc(r.targetId)}</span>
          ${done}
          ${form}
        </div>
        <div class="wd-adm-repacts">${acts.join("")}</div>
      </div>`;
    })
    .join("");
}

async function onReportsClick(e: Event): Promise<void> {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-ra]");
  if (!el) return;
  const ra = el.dataset.ra!;
  const rid = el.dataset.rid || repForm?.id || "";
  const a = backendApi();
  if (!a) return;
  try {
    switch (ra) {
      case "review":
        // Moving to `reviewing` with no assignee auto-assigns the caller.
        await a.moderation.updateReport(rid, { status: "reviewing" });
        toast("Admin", "report assigned to you");
        await loadReports();
        break;
      case "resolve":
        repForm = { id: rid, kind: "resolve" };
        renderReports();
        break;
      case "dismiss":
        repForm = { id: rid, kind: "dismiss" };
        renderReports();
        break;
      case "form-cancel":
        repForm = null;
        renderReports();
        break;
      case "res-confirm": {
        const resolution = ($("admin-res-kind") as HTMLSelectElement | null)?.value as any;
        const notes = ($("admin-res-notes") as HTMLInputElement | null)?.value.trim();
        const restrict = ($("admin-res-restrict") as HTMLInputElement | null)?.checked || false;
        if (restrict && !(await confirmDlg("This will also apply a PERMANENT global ban to the reported user. Continue?", "Resolve + ban"))) return;
        await a.moderation.resolveReport(rid, {
          resolution,
          notes: notes || undefined,
          createRestriction: restrict,
        });
        repForm = null;
        toast("Admin", "report resolved");
        await loadReports();
        break;
      }
      case "dis-confirm": {
        const reason = ($("admin-dis-reason") as HTMLSelectElement | null)?.value as any;
        await a.moderation.dismissReport(rid, reason);
        repForm = null;
        toast("Admin", "report dismissed");
        await loadReports();
        break;
      }
    }
  } catch (err: any) {
    await errorDlg("Report action failed: " + errMsg(err));
  }
}

// --- template approval queue (V3 /moderation/queue) --------------------------

export async function loadQueue(): Promise<void> {
  const box = $("admin-queue");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  box.innerHTML = loading();
  try {
    const page = await a.moderation.queue({ page: 1, perPage: 20 });
    const items = page?.items ?? [];
    box.innerHTML =
      items
        .map(
          (t) => `<div class="wd-row">
          <img src="${legacyRoot()}/v2/templates/${encodeURIComponent(t.id)}/preview?size=64" class="wd-thumb" width="24" height="24" loading="lazy" onerror="this.style.opacity=0.25">
          <div class="grow">
            <b>${esc(t.name)}</b> ${badge(t.scope, "member")}
            <br><span class="sub">@${t.x},${t.y} · ${t.scale}x · ${esc(fmtWhen(t.createdAt))}</span>
          </div>
          <button class="wd-btn wd-btn--sm" data-qa="approve" data-tid="${esc(t.id)}">Approve</button>
          <button class="wd-btn wd-btn--sm wd-btn--danger" data-qa="reject" data-tid="${esc(t.id)}">Reject…</button>
        </div>`,
        )
        .join("") || emptyState("approval queue is empty", "✓");
    const lbl = $("admin-queue-count");
    if (lbl) lbl.textContent = `${page?.total ?? 0} pending`;
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

async function onQueueClick(e: Event): Promise<void> {
  const el = (e.target as HTMLElement).closest<HTMLElement>("[data-qa]");
  if (!el?.dataset.tid) return;
  const a = backendApi();
  if (!a) return;
  const tid = el.dataset.tid;
  try {
    if (el.dataset.qa === "approve") {
      if (!(await confirmDlg("Approve this template for the wall?", "Approve"))) return;
      await a.moderation.approveTemplate(tid);
      toast("Admin", "template approved");
    } else {
      const notes = await promptDlg("Rejection reason (sent to the author):", "", "Reject template");
      if (notes === null) return;
      await a.moderation.rejectTemplate(tid, notes || undefined);
      toast("Admin", "template rejected");
    }
    await loadQueue();
  } catch (err: any) {
    await errorDlg("Queue action failed: " + errMsg(err));
  }
}

// --- global message removal (V3 DELETE /admin/messages/{id}) ----------------

async function deleteMessageTool(): Promise<void> {
  const inp = $("admin-msg-id") as HTMLInputElement | null;
  const id = inp?.value.trim() || "";
  if (!UUID_RE.test(id)) {
    await errorDlg("Enter the message UUID (copy it from a report's target line).");
    return;
  }
  const a = backendApi();
  if (!a) return;
  if (!(await confirmDlg(`Soft-delete message ${id.slice(0, 8)}… globally?`, "Delete message"))) return;
  try {
    await a.admin.deleteMessage(id);
    toast("Admin", "message deleted");
    if (inp) inp.value = "";
  } catch (e: any) {
    await errorDlg("Delete failed: " + errMsg(e));
  }
}

// --- clan takedown / unlock (V3 /moderation/clans/{id}) ----------------------

async function clanTakedownTool(unlock: boolean): Promise<void> {
  const clanId = ($("admin-td-clan") as HTMLInputElement | null)?.value.trim() || "";
  if (!UUID_RE.test(clanId)) {
    await errorDlg("Enter the clan UUID.");
    return;
  }
  const fields = [...document.querySelectorAll<HTMLInputElement>("#admin-sec-mod [data-tdf]")]
    .filter((c) => c.checked)
    .map((c) => c.dataset.tdf!);
  if (!fields.length) {
    await errorDlg("Tick at least one field (avatar/banner/description/tag/discoverable).");
    return;
  }
  const reason = ($("admin-td-reason") as HTMLInputElement | null)?.value.trim() || "";
  try {
    if (unlock) {
      if (!(await confirmDlg(`Unlock ${fields.join(", ")} on clan ${clanId.slice(0, 8)}…?`, "Unlock clan"))) return;
      await unlockClan(clanId, fields, reason || undefined);
      toast("Admin", "clan fields unlocked");
    } else {
      const action = ($("admin-td-action") as HTMLSelectElement | null)?.value || "strip_and_lock";
      const body = takedownBody(fields, action, reason);
      if (!body) {
        await errorDlg("Takedown needs a reason (1–1000 chars) and valid fields.");
        return;
      }
      if (!(await confirmDlg(`${action === "strip" ? "Strip" : "Strip AND LOCK"} ${fields.join(", ")} on clan ${clanId.slice(0, 8)}…?`, "Clan takedown"))) return;
      await takedownClan(clanId, body);
      toast("Admin", "clan takedown applied");
    }
  } catch (e: any) {
    await errorDlg("Clan action failed: " + errMsg(e));
  }
}

// --- moderator applications (LEGACY /admin/moderation — no V3 equivalent) ----

export async function loadModApps(): Promise<void> {
  const box = $("admin-modapps");
  if (!box) return;
  try {
    const apps = await legacyReq("GET", "/admin/moderation");
    box.innerHTML =
      (apps || [])
        .map((a: any) => {
          // Show the applicant's current role + clan so the reviewer doesn't
          // have to dig through the user table before deciding.
          const roleBadge =
            a.current_role && a.current_role !== "user"
              ? `<span class="wp-badge mod">${esc(a.current_role)}</span>`
              : "";
          const clanLine = a.clan_id
            ? `<br><span class="sub" title="${esc(a.clan_id)}">🛡 ${esc(a.clan_name || a.clan_id.slice(0, 8))} · ${esc(a.clan_role || "member")}</span>`
            : `<br><span class="sub" style="font-style:italic">no clan</span>`;
          return `<div class="wd-row">
          <div class="grow">
            <b>${esc(a.username)}</b>
            <span class="wp-badge member">${esc(a.status)}</span>
            ${roleBadge}
            <br><span class="sub">${esc(a.message || "(no message)")}</span>
            ${clanLine}
          </div>
          ${
            a.status === "pending"
              ? `
            <button class="wd-btn wd-btn--sm" data-approve-mod="${esc(a.id)}" data-approve-clan="${esc(a.clan_name || "")}">approve</button>
            <button class="wd-btn wd-btn--sm" data-reject-mod="${esc(a.id)}" data-reject-clan="${esc(a.clan_name || "")}">reject</button>
          `
              : ""
          }
        </div>`;
        })
        .join("") || emptyState("no applications");

    box.querySelectorAll<HTMLElement>("[data-approve-mod]").forEach((b) =>
      b.addEventListener("click", async () => {
        const clan = b.dataset.approveClan;
        const ctx = clan ? ` from clan "${clan}"` : "";
        if (!(await confirmDlg(`Approve and grant admin role${ctx}?`, "Confirm"))) return;
        try {
          await legacyReq("PUT", `/admin/moderation/${b.dataset.approveMod}`, {
            status: "approved",
            new_role: "admin",
          });
          toast("Admin", "approved");
          loadModApps();
        } catch (e: any) {
          await errorDlg(errMsg(e));
        }
      }),
    );
    box.querySelectorAll<HTMLElement>("[data-reject-mod]").forEach((b) =>
      b.addEventListener("click", async () => {
        const clan = b.dataset.rejectClan;
        const ctx = clan ? ` from clan "${clan}"` : "";
        if (!(await confirmDlg(`Reject this application${ctx}?`, "Confirm"))) return;
        try {
          await legacyReq("PUT", `/admin/moderation/${b.dataset.rejectMod}`, { status: "rejected" });
          toast("Admin", "rejected");
          loadModApps();
        } catch (e: any) {
          await errorDlg(errMsg(e));
        }
      }),
    );
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// Broadcast — legacy titled composer + V3 role-targeted message
// ---------------------------------------------------------------------------

/** Send the V3 role-targeted broadcast (plain message, no title/kind). */
async function sendV3Broadcast(): Promise<void> {
  const ta = $("admin-bc-msg") as HTMLTextAreaElement | null;
  const message = ta?.value.trim() || "";
  if (!message || message.length > 2000) {
    await errorDlg("Message must be 1–2000 characters.");
    return;
  }
  const role = ($("admin-bc-role") as HTMLSelectElement | null)?.value || "all";
  const a = backendApi();
  if (!a) return;
  const who = role === "all" ? "ALL users" : `every ${role}`;
  if (!(await confirmDlg(`Send this V3 broadcast to ${who}?`, "Broadcast"))) return;
  try {
    const r = await a.admin.broadcast({
      message,
      targetRole: role === "all" ? undefined : role,
    });
    toast("Admin", `broadcast sent to ${r?.recipients ?? "?"} users`);
    if (ta) ta.value = "";
  } catch (e: any) {
    await errorDlg("Broadcast failed: " + errMsg(e));
  }
}

/**
 * Two-field broadcast dialog (title + body) on the LEGACY /admin/broadcast —
 * kept because the V3 broadcast carries neither a title nor the news/alert
 * kind (BACKEND GAP: admin.rs BroadcastRequest hardcodes the "Broadcast"
 * title and has no kind). Built ad-hoc because the standard promptDlg only
 * collects one field. Uses the same Win95 + theme system as dialog.ts so it
 * picks up dark mode automatically.
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
        await legacyReq("POST", "/admin/broadcast", { title, body, kind });
        toast("Admin", `broadcast sent as ${typeLabel}`);
        close();
      } catch (e: any) {
        statusLeft.textContent = "Send failed";
        await errorDlg("Broadcast failed: " + errMsg(e));
      }
    });
  });
}

// --- sent notifications (LEGACY /admin/notifications) ------------------------

export async function loadAdminNotifs(): Promise<void> {
  const box = $("admin-notifs");
  if (!box) return;
  try {
    const items = await legacyReq("GET", "/admin/notifications");
    box.innerHTML =
      (items || [])
        .map(
          (n: any) => `
      <div class="wd-row">
        <div class="grow">
          <b>${esc(n.title)}</b> ${n.read ? '<span class="wp-badge member">read</span>' : '<span class="wp-badge mod">unread</span>'}
          <br><span class="sub">${esc(n.body || "")}</span>
        </div>
        <span class="del" data-admin-del-notif="${esc(n.id)}" title="delete" style="cursor:pointer;color:#c33">🗑</span>
      </div>`,
        )
        .join("") || emptyState("no notifications");

    box.querySelectorAll<HTMLElement>("[data-admin-del-notif]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!(await confirmDlg("Delete this notification?", "Confirm"))) return;
        try {
          await legacyReq("DELETE", `/admin/notifications/${b.dataset.adminDelNotif}`);
          toast("Admin", "notification deleted");
          loadAdminNotifs();
        } catch (e: any) {
          await errorDlg(errMsg(e));
        }
      }),
    );
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// System — config, maintenance, audit log
// ---------------------------------------------------------------------------

/** Editable ServerConfig fields (label → wire key). */
const CFG_NUM_FIELDS: Array<[keyof ServerConfigWire, string]> = [
  ["maxUsersPerClan", "Max users per clan"],
  ["maxTemplatesPerUser", "Max templates per user"],
  ["maxApiKeysPerUser", "Max API keys per user"],
  ["maxFileSizeMb", "Max file size (MB)"],
  ["rateLimitPerMinute", "Rate limit / minute"],
];
const CFG_BOOL_FIELDS: Array<[keyof ServerConfigWire, string]> = [
  ["allowPublicTemplatePublishing", "Allow public template publishing"],
  ["autoApproveModeratorTemplates", "Auto-approve moderator templates"],
];

export async function loadConfig(): Promise<void> {
  const box = $("admin-config");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  box.innerHTML = loading();
  try {
    const cfg = await a.admin.config();
    box.innerHTML =
      CFG_NUM_FIELDS.map(
        ([k, label]) => `<label class="wd-adm-cfgrow">${esc(label)}
          <input data-cfgk="${k}" type="number" min="1" class="wp-input" value="${Number(cfg[k]) || 1}" style="width:70px">
        </label>`,
      ).join("") +
      CFG_BOOL_FIELDS.map(
        ([k, label]) => `<label class="wp-check"><input type="checkbox" data-cfgk="${k}"${cfg[k] ? " checked" : ""}> ${esc(label)}</label>`,
      ).join("") +
      `<div class="sub">feature flags: ${esc(JSON.stringify(cfg.featureFlags || {}))}</div>`;
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

async function saveConfig(): Promise<void> {
  const a = backendApi();
  if (!a) return;
  const body: Record<string, unknown> = {};
  document.querySelectorAll<HTMLInputElement>("#admin-config [data-cfgk]").forEach((inp) => {
    const k = inp.dataset.cfgk!;
    if (inp.type === "checkbox") body[k] = inp.checked;
    else {
      const n = Number(inp.value);
      if (Number.isFinite(n)) body[k] = n;
    }
  });
  if (!Object.keys(body).length) return;
  if (!(await confirmDlg("Apply the runtime config changes? (owner-only, in-memory until restart)", "Update config"))) return;
  try {
    await a.admin.updateConfig(body);
    toast("Admin", "config updated");
    await loadConfig();
  } catch (e: any) {
    await errorDlg("Config update failed: " + errMsg(e));
  }
}

export async function loadMaintenance(): Promise<void> {
  const box = $("admin-maint");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  try {
    const m = await a.admin.maintenance();
    box.innerHTML = m.enabled
      ? `<span class="wd-pill wd-pill--warn">MAINTENANCE ON</span>
         ${m.reason ? `<span class="sub">${esc(m.reason)}</span>` : ""}
         ${m.estimatedEndTime ? `<span class="sub">until ${esc(fmtWhen(m.estimatedEndTime))}</span>` : ""}`
      : `<span class="wd-pill wd-pill--ok">maintenance off</span>`;
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

async function setMaintenanceMode(enabled: boolean): Promise<void> {
  const a = backendApi();
  if (!a) return;
  let reason: string | undefined;
  let mins: number | undefined;
  if (enabled) {
    reason = ($("admin-maint-reason") as HTMLInputElement | null)?.value.trim() || undefined;
    const durRaw = ($("admin-maint-dur") as HTMLInputElement | null)?.value || "";
    const dur = parseDuration(durRaw);
    if (dur === null) {
      await errorDlg("Couldn't parse the duration. Use 30, 45m, 2h…");
      return;
    }
    mins = dur;
  }
  const q = enabled
    ? `Enable maintenance mode${reason ? ` — "${reason}"` : ""}${mins ? ` for ${fmtDuration(mins)}` : ""}? Users will see the banner.`
    : "Disable maintenance mode?";
  if (!(await confirmDlg(q, "Maintenance"))) return;
  try {
    await a.admin.setMaintenance({ enabled, reason, estimatedDurationMinutes: mins });
    toast("Admin", `maintenance ${enabled ? "enabled" : "disabled"}`);
    await loadMaintenance();
  } catch (e: any) {
    await errorDlg("Maintenance toggle failed: " + errMsg(e));
  }
}

// --- audit log (V3 /admin/audit — filterable, paged) --------------------------

const auditState = { page: 1, totalPages: 0, action: "", ttype: "" };

export async function loadAudit(): Promise<void> {
  const box = $("admin-audit");
  if (!box) return;
  const a = backendApi();
  if (!a) {
    box.innerHTML = errorState("backend offline");
    return;
  }
  box.innerHTML = loading();
  try {
    const page = await a.admin.audit({
      page: auditState.page,
      perPage: 20,
      action: auditState.action || undefined,
      targetType: auditState.ttype || undefined,
    });
    auditState.totalPages = page?.totalPages ?? 0;
    const lbl = $("admin-audit-page");
    if (lbl) lbl.textContent = `page ${page?.page ?? 1}/${auditState.totalPages || 1} · ${page?.total ?? 0} entries`;
    box.innerHTML =
      (page?.items ?? [])
        .map((entry) => {
          const vm = auditRowVM(entry);
          return `<div class="wd-row">
            <div class="grow">
              <b>${esc(vm.action)}</b> <span class="wd-adm-mono">${esc(vm.target)}</span>
              <br><span class="sub">${esc(vm.who)} · ${esc(vm.when)}${vm.details ? ` · ${esc(vm.details)}` : ""}</span>
            </div>
          </div>`;
        })
        .join("") || emptyState("no audit entries");
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

function auditPageBy(delta: number): void {
  const next = Math.min(Math.max(1, auditState.page + delta), Math.max(1, auditState.totalPages || 1));
  if (next === auditState.page) return;
  auditState.page = next;
  loadAudit().catch(() => {});
}

// ---------------------------------------------------------------------------
// Tools — legacy template catalog
// ---------------------------------------------------------------------------

export async function loadAdminTemplates(): Promise<void> {
  const box = $("admin-templates");
  if (!box) return;
  try {
    const items = await legacyReq("GET", "/admin/templates");
    box.innerHTML =
      (items || [])
        .map((tp: any) => {
          const b =
            tp.status === "approved"
              ? `<span class="wp-badge mod">approved</span>`
              : `<span class="wp-badge member">${esc(tp.status)}</span>`;
          // Surface the owning clan when the template is clan-scoped. Falls back
          // to "(clan ?)" when the clan row has been deleted but the template
          // hasn't been migrated yet — that way the admin can still tell it's
          // clan-scoped instead of public.
          const clanLine =
            tp.scope === "clan"
              ? `<span class="wp-badge mod" title="${esc(tp.clan_id || "")}">🛡 ${esc(tp.clan_name || `clan ${tp.clan_id?.slice(0, 8) || "?"}`)}</span>`
              : "";
          const thumb = `<img src="${legacyRoot()}/v2/templates/${encodeURIComponent(tp.id)}/preview?size=64" class="wd-thumb" width="24" height="24" loading="lazy" onerror="this.style.opacity=0.25">`;
          return `<div class="wd-row">${thumb}
        <div class="grow">
          <b>${esc(tp.name)}</b> ${b} <span class="wp-badge member">${esc(tp.scope)}</span> ${clanLine}
          <br><span class="sub">@${tp.x},${tp.y} · ${tp.scale}x · by ${esc(tp.author || "?")}</span>
        </div>
        <span class="del" data-admin-del-tpl="${esc(tp.id)}" title="delete" style="cursor:pointer;color:#c33">🗑</span>
      </div>`;
        })
        .join("") || emptyState("no templates");

    box.querySelectorAll<HTMLElement>("[data-admin-del-tpl]").forEach((b) =>
      b.addEventListener("click", async () => {
        const ok = await confirmDlg("Delete this template?", "Confirm Delete");
        if (!ok) return;
        try {
          await legacyReq("DELETE", `/admin/templates/${b.dataset.adminDelTpl}`);
          toast("Admin", "template deleted");
          loadAdminTemplates();
        } catch (e: any) {
          await errorDlg(errMsg(e));
        }
      }),
    );
  } catch (e: any) {
    box.innerHTML = errorState(errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// Wiring — called once from wireAdmin (ui/admin.ts). Every lookup is null-safe:
// this runs for non-admins too (the pane exists but is hidden), and a missing
// element must never abort wireExtensionUI (that would kill auth for the whole
// extension — see scripts/wire-check.ts).
// ---------------------------------------------------------------------------

export function wireAdminConsole(): void {
  // Sub-nav
  $("admin-subnav")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]");
    if (b?.dataset.seg) setAdminSection(b.dataset.seg as AdminSection);
  });

  // Dashboard
  $("btn-admin-dash-refresh")?.addEventListener("click", () => loadAdminStats().catch(() => {}));
  $("admin-stats")?.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-goto]");
    if (card?.dataset.goto) setAdminSection(card.dataset.goto as AdminSection);
  });

  // Users
  $("btn-admin-user-search")?.addEventListener("click", usersSearchFromInputs);
  $("admin-user-q")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") usersSearchFromInputs();
  });
  $("admin-user-role")?.addEventListener("change", usersSearchFromInputs);
  $("btn-admin-users-prev")?.addEventListener("click", () => usersPageBy(-1));
  $("btn-admin-users-next")?.addEventListener("click", () => usersPageBy(1));
  $("admin-users")?.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-uref]");
    if (row?.dataset.uref) openUserPanel(row.dataset.uref).catch(() => {});
  });
  $("admin-user-panel")?.addEventListener("click", (e) => {
    onUserPanelClick(e).catch((err) => log("ADMIN", "ERR", String(err)));
  });

  // Moderation
  $("admin-rep-filter")?.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-seg]");
    if (!b?.dataset.seg) return;
    $("admin-rep-filter")
      ?.querySelectorAll<HTMLElement>("[data-seg]")
      .forEach((x) => x.classList.toggle("is-on", x === b));
    repState.status = b.dataset.seg;
    repState.page = 1;
    repForm = null;
    loadReports().catch(() => {});
  });
  $("btn-admin-rep-prev")?.addEventListener("click", () => {
    if (repState.page > 1) { repState.page--; loadReports().catch(() => {}); }
  });
  $("btn-admin-rep-next")?.addEventListener("click", () => {
    if (repState.page < (repState.totalPages || 1)) { repState.page++; loadReports().catch(() => {}); }
  });
  $("admin-reports")?.addEventListener("click", (e) => {
    onReportsClick(e).catch((err) => log("ADMIN", "ERR", String(err)));
  });
  $("admin-queue")?.addEventListener("click", (e) => {
    onQueueClick(e).catch((err) => log("ADMIN", "ERR", String(err)));
  });
  $("btn-admin-msg-del")?.addEventListener("click", () => deleteMessageTool().catch(() => {}));
  $("btn-admin-td")?.addEventListener("click", () => clanTakedownTool(false).catch(() => {}));
  $("btn-admin-td-unlock")?.addEventListener("click", () => clanTakedownTool(true).catch(() => {}));

  // Broadcast (the legacy composer button is wired in ui/admin.ts)
  $("btn-admin-bc-v3")?.addEventListener("click", () => sendV3Broadcast().catch(() => {}));

  // System
  $("btn-admin-cfg-save")?.addEventListener("click", () => saveConfig().catch(() => {}));
  $("btn-admin-maint-on")?.addEventListener("click", () => setMaintenanceMode(true).catch(() => {}));
  $("btn-admin-maint-off")?.addEventListener("click", () => setMaintenanceMode(false).catch(() => {}));
  $("btn-admin-audit-apply")?.addEventListener("click", () => {
    auditState.action = ($("admin-audit-action") as HTMLInputElement | null)?.value.trim() ?? "";
    auditState.ttype = ($("admin-audit-ttype") as HTMLInputElement | null)?.value.trim() ?? "";
    auditState.page = 1;
    loadAudit().catch(() => {});
  });
  $("btn-admin-audit-prev")?.addEventListener("click", () => auditPageBy(-1));
  $("btn-admin-audit-next")?.addEventListener("click", () => auditPageBy(1));
}

// ---------------------------------------------------------------------------
// Broadcast dialog CSS (unchanged from the previous console)
// ---------------------------------------------------------------------------

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
