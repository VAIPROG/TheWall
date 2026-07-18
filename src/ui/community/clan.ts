/**
 * Clan management drill-in for the Community super-tab. Fetches the clan detail
 * (with viewer context) plus its roster, then renders a header + role-gated
 * sections: Roster (roles/kick), Invites, Applications, Settings, and a Danger
 * zone (Leave / Disband). Mirrors the SHIPPED templates `detail.ts` drill-in
 * discipline: fetch-on-mount → render sections with `group()` → wire per-id
 * listeners → each action does `api call → toast → refresh`.
 *
 * Role-gating here is UX-only (privileged controls are hidden unless the
 * viewer's context allows); the V3 backend still enforces every mutation, so
 * gating is never a security boundary — only a nicety.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { badge, button, group, loading, errorState, emptyState, segmented } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { ic } from "../../icons";
import { toast } from "../../notify";
import { confirmDlg } from "../../dialog";
import { getActiveClient } from "../../backend/index";
import {
  getClan,
  listMembers,
  setMemberRole,
  kickMember,
  listInvites,
  createInvite,
  revokeInvite,
  listApplications,
  reviewApplication,
  getSettings,
  updateSettings,
  updateClan,
  leaveClan,
  disbandClan,
  avatarUrl,
  uploadClanAvatar,
  deleteClanAvatar,
  uploadClanBanner,
  deleteClanBanner,
  isGlobalModerator,
  isGlobalAdmin,
  takedownBody,
  takedownClan,
  unlockClan,
  TAKEDOWN_FIELDS,
  type ClanDetail,
  type ClanMember,
  type ClanInvite,
  type ClanApplication,
  type ClanSettings,
  type ClanRole,
  type Page,
} from "./api";
import { clanCard } from "./card";
import { resetToHub, openThread } from "./shell";

// ---------------------------------------------------------------------------
// Module state (like detail.ts keeps the fetched entity in scope). Reset each
// mount; `load()` re-fetches + re-renders the whole `#comm-clan` root so every
// action can simply call `load()` after its toast (no partial-DOM surgery).
// ---------------------------------------------------------------------------
let clan: ClanDetail | null = null;
let members: ClanMember[] = [];
let memberPage = 1;
let memberTotal = 0;
let memberPerPage = 50;
let invites: ClanInvite[] = [];
let applications: ClanApplication[] = [];
let settings: ClanSettings | null = null;

const ROSTER_PER_PAGE = 50;

/** Map a clan role to a badge colour kind. */
function roleBadgeKind(role: ClanRole): "owner" | "admin" | "mod" | "member" {
  if (role === "owner") return "owner";
  if (role === "admin") return "admin";
  if (role === "moderator") return "mod";
  return "member";
}

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** One label→value row in the info grid (mirrors detail.ts `infoRow`). */
function infoRow(label: string, value: string): string {
  return `<div class="wd-kv"><span class="wd-kv-k">${esc(label)}</span><span class="wd-kv-v">${esc(value)}</span></div>`;
}

// ---------------------------------------------------------------------------
// Section renderers (small helpers, like detail.ts extracts render fragments).
// ---------------------------------------------------------------------------

/** Admin-only media block (clan avatar + banner upload / remove). Rendered
 *  inside Overview only when the viewer may manage settings. */
function renderMedia(): string {
  return `<div class="wp-group"><div class="wp-legend">${ic("brush")}${esc(t("clanMedia") || "Media")}</div>
  <div class="wd-clan-media">
    <label class="wd-clan-fld"><span>${esc(t("clanAvatarLbl") || "Clan avatar")}</span>
      <input type="file" id="clan-av-file" accept="image/*" class="wp-input"></label>
    <label class="wd-clan-fld"><span>${esc(t("clanBannerLbl") || "Clan banner")}</span>
      <input type="file" id="clan-bn-file" accept="image/*" class="wp-input"></label>
    <div class="wd-clan-more">
      ${button(t("clanMediaRemoveAv") || "Remove avatar", { size: "sm", id: "clan-av-del" })}
      ${button(t("clanMediaRemoveBn") || "Remove banner", { size: "sm", id: "clan-bn-del" })}
    </div>
  </div>
</div>`;
}

/** Overview: verified-owner binding source (`ownerVerifiedVia`), description,
 *  and an info grid — plus the admin-only Media block. The clanCard header
 *  already covers name / tag / verified badge / stat chips. */
function renderOverview(cl: ClanDetail): string {
  const via =
    cl.ownerVerified && cl.ownerVerifiedVia
      ? `<span class="wd-clan-via">${esc((t("clanVia") || "via") + " " + cl.ownerVerifiedVia)}</span>`
      : "";
  const memberCount = cl.stats?.memberCount ?? cl.memberCount ?? 0;
  const tplCount = cl.stats?.templateCount ?? 0;
  const info = [
    infoRow(t("clanMembers") || "Members", String(memberCount)),
    cl.tag ? infoRow(t("clanTag") || "Tag", cl.tag) : "",
    infoRow(t("clanJoinPolicy") || "Join policy", cl.joinPolicy || "—"),
    infoRow(t("clanTemplates") || "Templates", String(tplCount)),
    infoRow(t("clanYourRole") || "Your role", cl.viewer?.role || t("clanNonMember") || "—"),
  ]
    .filter(Boolean)
    .join("");
  const desc = cl.description
    ? `<div class="wd-clan-desc">${esc(cl.description)}</div>`
    : "";
  // Media (avatar/banner) is editable by clan admins AND server (global)
  // admins — the backend's require_clan_admin folds global admins into
  // effective_clan_role, so both are permitted (regular members are not:
  // canManageSettings is false for them and isGlobalAdmin() is false too).
  const media = cl.viewer?.canManageSettings || isGlobalAdmin() ? renderMedia() : "";
  // Direct clan-chat access for members. ALWAYS rendered for a member — legacy
  // clans (created before clan chats shipped) have `chatId: null`, which used
  // to silently hide the button; the click handler now re-resolves the chat id
  // (the backend detail read get-or-creates the clan chat). The kit `chat`
  // icon replaces the raw 💬 prefix so the glyph follows the theme.
  const isMember = cl.viewer?.membershipStatus === "member";
  const openChat = isMember
    ? `<div class="wd-clan-more">${button(t("clanOpenChat") || "Open clan chat", { size: "sm", variant: "primary", icon: "chat", id: "clan-open-chat" })}</div>`
    : "";
  return `
    <div class="wd-clan-head">
      ${via ? `<div class="wd-tpl-pills">${via}</div>` : ""}
      ${desc}
      ${openChat}
    </div>
    ${group(t("clanInfo") || "Info", `<div class="wd-kvgrid">${info}</div>`)}
    ${media}`;
}

/** One roster row. Role `<select>` + Kick appear only when the viewer may
 *  manage members AND outranks the target (owner rows are never editable). */
function renderMemberRow(cl: ClanDetail, m: ClanMember): string {
  const av = avatarUrl(m.userId);
  const name = esc(m.displayName || m.username);
  const roleBadge = badge(m.role, roleBadgeKind(m.role));
  const viewerRank = cl.viewer?.role ? rankOf(cl.viewer.role) : -1;
  const canManage = !!cl.viewer?.canManageMembers && m.role !== "owner" && m.roleRank < viewerRank;

  let controls = "";
  if (canManage) {
    const opt = (v: string, label: string) =>
      `<option value="${esc(v)}"${m.role === v ? " selected" : ""}>${esc(label)}</option>`;
    const sel = `<select class="wd-clan-role" data-uid="${esc(m.userId)}">${
      opt("member", t("clanRoleMember") || "Member") +
      opt("moderator", t("clanRoleModerator") || "Moderator") +
      opt("admin", t("clanRoleAdmin") || "Admin")
    }</select>`;
    const kick = button(t("clanKick") || "Kick", {
      variant: "danger",
      size: "sm",
      attrs: { "data-kick": m.userId, "data-name": m.displayName || m.username },
    });
    controls = `<span class="wd-clan-mctl">${sel}${kick}</span>`;
  }
  return `
    <div class="wd-row wd-clan-member">
      <img class="wd-thumb wd-clan-av" width="20" height="20" src="${esc(av)}" alt="">
      <span class="grow">${name} ${roleBadge}</span>
      ${controls}
    </div>`;
}

/** Roster section: page-1 rows + a simple "Load more" when there are more. */
function renderRoster(cl: ClanDetail): string {
  const rows = members.length
    ? `<div class="wd-list wd-list--scroll">${members.map((m) => renderMemberRow(cl, m)).join("")}</div>`
    : emptyState(t("clanNoMembers") || "No members.");
  const more =
    members.length < memberTotal
      ? `<div class="wd-clan-more">${button(t("clanLoadMore") || "Load more", { size: "sm", id: "clan-roster-more" })}</div>`
      : "";
  return group(`${t("clanRoster") || "Roster"} (${memberTotal})`, rows + more);
}

/** Invites section (only when viewer.canManageMembers). */
function renderInvites(): string {
  const rows = invites.length
    ? `<div class="wd-list">${invites
        .map((iv) => {
          const uses = iv.maxUses != null ? `${iv.useCount}/${iv.maxUses}` : `${iv.useCount}/∞`;
          const exp = iv.expiresAt ? fmtDate(iv.expiresAt) : t("clanNoExpiry") || "no expiry";
          return `<div class="wd-row">
              <span class="grow"><code class="wd-clan-code">${esc(iv.code)}</code></span>
              <span class="wd-clan-imeta">${esc((t("clanUses") || "uses") + ": " + uses)} · ${esc(exp)}</span>
              ${button(t("clanRevoke") || "Revoke", { size: "sm", variant: "danger", attrs: { "data-revoke": iv.id } })}
            </div>`;
        })
        .join("")}</div>`
    : emptyState(t("clanNoInvites") || "No active invites.");
  const create = `<div class="wd-clan-more">${button(t("clanCreateInvite") || "Create invite", { size: "sm", id: "clan-invite-new" })}</div>`;
  return group(t("clanInvites") || "Invites", rows + create);
}

/** Applications section (only when viewer.canManageMembers). */
function renderApplications(): string {
  const body = applications.length
    ? `<div class="wd-list">${applications
        .map((ap) => {
          const who = esc(ap.applicant.displayName || ap.applicant.username);
          const msg = ap.message ? `<div class="wd-clan-appmsg">${esc(ap.message)}</div>` : "";
          return `<div class="wd-row wd-clan-app">
              <div class="grow"><div class="wd-clan-appwho">${who}</div>${msg}</div>
              ${button(t("clanApprove") || "Approve", { size: "sm", variant: "primary", attrs: { "data-approve": ap.id } })}
              ${button(t("clanDeny") || "Deny", { size: "sm", variant: "danger", attrs: { "data-deny": ap.id } })}
            </div>`;
        })
        .join("")}</div>`
    : emptyState(t("clanNoApplications") || "No pending applications.");
  return group(t("clanApplications") || "Applications", body);
}

/** Settings form (only when viewer.canManageSettings). Compact: name +
 *  description (→ updateClan) and join policy + template scope + discoverable
 *  (→ updateSettings), each group with its own Save button. */
function renderSettings(cl: ClanDetail): string {
  const joinPolicy = settings?.joinPolicy || cl.joinPolicy || "open";
  const scope = settings?.templateScopeDefault || "clan";
  const discoverable = settings?.discoverable ?? cl.discoverable ?? false;
  const jpOpt = (v: string, label: string) =>
    `<option value="${esc(v)}"${joinPolicy === v ? " selected" : ""}>${esc(label)}</option>`;
  const scOpt = (v: string, label: string) =>
    `<option value="${esc(v)}"${scope === v ? " selected" : ""}>${esc(label)}</option>`;

  const profile = `
    <label class="wd-clan-fld"><span>${esc(t("clanFieldName") || "Name")}</span>
      <input id="clan-set-name" type="text" value="${esc(cl.name)}" maxlength="64"></label>
    <label class="wd-clan-fld"><span>${esc(t("clanFieldDesc") || "Description")}</span>
      <textarea id="clan-set-desc" rows="2" maxlength="500">${esc(cl.description || "")}</textarea></label>
    <div class="wd-clan-more">${button(t("clanSave") || "Save", { size: "sm", id: "clan-save-profile" })}</div>`;

  const policy = `
    <label class="wd-clan-fld"><span>${esc(t("clanJoinPolicy") || "Join policy")}</span>
      <select id="clan-set-join">${
        jpOpt("open", t("clanJoinOpen") || "Open") +
        jpOpt("invite_only", t("clanJoinInvite") || "Invite only") +
        jpOpt("approval_required", t("clanJoinApproval") || "Approval required")
      }</select></label>
    <label class="wd-clan-fld"><span>${esc(t("clanTplScope") || "Default template scope")}</span>
      <select id="clan-set-scope">${
        scOpt("public", "public") + scOpt("clan", "clan") + scOpt("private", "private")
      }</select></label>
    <label class="wd-clan-chk"><input id="clan-set-disc" type="checkbox"${discoverable ? " checked" : ""}>
      <span>${esc(t("clanDiscoverable") || "Discoverable in browse")}</span></label>
    <div class="wd-clan-more">${button(t("clanSave") || "Save", { size: "sm", id: "clan-save-policy" })}</div>`;

  return (
    group(t("clanSettingsProfile") || "Profile", profile) +
    group(t("clanSettingsPolicy") || "Membership & templates", policy)
  );
}

/** Danger zone: Leave (non-owner members — the backend 409s an owner leave
 *  with "transfer ownership first", so don't offer it) + Disband (owner). */
function renderDanger(cl: ClanDetail): string {
  const me = getActiveClient()?.me;
  const isOwner = cl.viewer?.role === "owner" || (!!me && cl.ownerId === me.id);
  const leave = isOwner
    ? ""
    : button(t("clanLeave") || "Leave clan", { size: "sm", variant: "danger", id: "clan-leave" });
  const disband = isOwner
    ? button(t("clanDisband") || "Disband clan", { size: "sm", variant: "danger", id: "clan-disband" })
    : "";
  return group(t("clanDanger") || "Danger zone", `<div class="wd-clan-danger">${leave}${disband}</div>`, {
    danger: true,
  });
}

/** Global-moderation section (GLOBAL moderator+ only; never shown to plain
 *  clan staff). Takedown strips (and optionally locks) presentation fields;
 *  Unlock releases an existing lock; Disband is offered to global admins on
 *  clans they don't own (the owner path lives in the Danger zone). Gating here
 *  is UX-only — the backend re-checks the caller's global role on every call. */
function renderModeration(cl: ClanDetail): string {
  const fieldChecks = TAKEDOWN_FIELDS.map(
    (f) =>
      `<label class="wd-clan-chk"><input type="checkbox" class="clan-mod-field" value="${esc(f)}"><span>${esc(f)}</span></label>`,
  ).join("");
  const takedown = `
    <div class="wd-clan-modfields">${fieldChecks}</div>
    <label class="wd-clan-fld"><span>${esc(t("clanModReason") || "Reason (required)")}</span>
      <input id="clan-mod-reason" type="text" maxlength="1000"></label>
    <label class="wd-clan-fld"><span>${esc(t("clanModAction") || "Action")}</span>
      <select id="clan-mod-action">
        <option value="strip">${esc(t("clanModStrip") || "Strip only")}</option>
        <option value="strip_and_lock" selected>${esc(t("clanModStripLock") || "Strip and lock")}</option>
      </select></label>
    <div class="wd-clan-more">${button(t("clanModTakedown") || "Takedown", { size: "sm", variant: "danger", id: "clan-mod-takedown" })}</div>`;

  const locked = cl.moderation?.lockedFields?.length
    ? `<div class="wd-clan-modlocked">${esc((t("clanModLocked") || "Locked fields") + ": " + cl.moderation.lockedFields.join(", "))}${
        cl.moderation.reason ? `<div class="wd-clan-modwhy">${esc(cl.moderation.reason)}</div>` : ""
      }</div>
      <div class="wd-clan-more">${button(t("clanModUnlock") || "Unlock", { size: "sm", icon: "unlock", id: "clan-mod-unlock" })}</div>`
    : "";

  const me = getActiveClient()?.me;
  const isOwner = cl.viewer?.role === "owner" || (!!me && cl.ownerId === me.id);
  const adminDisband =
    isGlobalAdmin() && !isOwner
      ? `<div class="wd-clan-more">${button(t("clanModDisband") || "Disband clan (admin)", { size: "sm", variant: "danger", id: "clan-mod-disband" })}</div>`
      : "";

  return group(
    t("clanModTitle") || "Global moderation",
    `${locked}${takedown}${adminDisband}`,
    { danger: true, icon: "shield" },
  );
}

/** Rank ordering for outranks-checks (higher = more privileged). Mirrors the
 *  backend role hierarchy; used only for UX gating of the roster controls. */
function rankOf(role: ClanRole | string): number {
  switch (role) {
    case "owner":
      return 3;
    case "admin":
      return 2;
    case "moderator":
      return 1;
    default:
      return 0;
  }
}

/** Compose the whole screen body: the advanced clanCard header + a role-gated
 *  segmented sub-nav (Overview / Members / Requests / Settings) with one
 *  sub-section shown at a time. Mirrors the profile-tab sub-nav idiom. */
/** All sub-section ids — single source for render() + the two nav togglers. */
const SUBSECTIONS = ["overview", "members", "requests", "settings", "moderation"] as const;

/** Toggle the segmented sub-nav + the matching section to `seg`. */
function activateSub(seg: string): void {
  $("comm-clan-subnav")
    ?.querySelectorAll<HTMLElement>("[data-seg]")
    .forEach((x) => x.classList.toggle("is-on", x.dataset.seg === seg));
  SUBSECTIONS.forEach((s) => $(`comm-clan-sub-${s}`)?.classList.toggle("is-on", s === seg));
}

function render(cl: ClanDetail): string {
  const v = cl.viewer;
  const isMember = v?.membershipStatus === "member";
  const globalMod = isGlobalModerator();

  // Sub-nav items: Overview + Members always; Requests / Settings only when the
  // viewer is permitted; Moderation for GLOBAL moderators+ on any clan
  // (backend still enforces every mutation regardless).
  const segItems: Array<{ value: string; label: string }> = [
    { value: "overview", label: t("clanTabOverview") || "Overview" },
    { value: "members", label: t("clanTabMembers") || "Members" },
  ];
  if (v?.canManageMembers) segItems.push({ value: "requests", label: t("clanTabRequests") || "Requests" });
  if (v?.canManageSettings) segItems.push({ value: "settings", label: t("clanTabSettings") || "Settings" });
  if (globalMod) segItems.push({ value: "moderation", label: t("clanTabModeration") || "Mod" });

  // Requests = invites + applications (admin only). Settings = the settings form
  // (admin only). The Danger zone (Leave / Disband) lives in the always-visible
  // Overview and is gated on membership — leaving a clan is a member action, not
  // an admin one; Disband stays owner-only (inside renderDanger).
  const requests = v?.canManageMembers ? renderInvites() + renderApplications() : "";
  const settingsBody = v?.canManageSettings ? renderSettings(cl) : "";
  const danger = isMember ? renderDanger(cl) : "";
  const moderation = globalMod ? renderModeration(cl) : "";

  return `
    ${clanCard(cl, { context: "manage" })}
    <div id="comm-clan-subnav">${segmented(segItems, "overview")}</div>
    <div class="wd-tpl-detail">
      <div class="wd-clan-sub is-on" id="comm-clan-sub-overview">${renderOverview(cl)}${danger}</div>
      <div class="wd-clan-sub" id="comm-clan-sub-members">${renderRoster(cl)}</div>
      <div class="wd-clan-sub" id="comm-clan-sub-requests">${requests}</div>
      <div class="wd-clan-sub" id="comm-clan-sub-settings">${settingsBody}</div>
      <div class="wd-clan-sub" id="comm-clan-sub-moderation">${moderation}</div>
    </div>`;
}

export function clanScreen(id: string): PanelScreen {
  return {
    title: t("commClanManage") || "Clan",
    render: () => `<div id="comm-clan">${loading()}</div>`,
    onMount: async () => {
      const root = $("comm-clan");
      if (!root) return;
      const c = getActiveClient();
      if (!c) {
        root.innerHTML = errorState(t("clanLoadErr") || "Not connected.");
        return;
      }

      // Full re-fetch + re-render + re-wire. Called on mount and after every
      // mutating action (detail.ts re-runs its render on mount; we make that a
      // reusable `load()` so actions can refresh cheaply).
      const load = async (): Promise<void> => {
        root.innerHTML = loading();
        try {
          clan = await getClan(id);
          if (!clan) {
            root.innerHTML = errorState(t("clanLoadErr") || "Failed to load clan.");
            return;
          }
          // Roster page 1. Invites/applications/settings only when the viewer
          // may see them (avoids 403 noise for plain members).
          const v = clan.viewer;
          memberPage = 1;
          const pageP: Promise<Page<ClanMember>> = listMembers(id, 1, ROSTER_PER_PAGE);
          const invP = v?.canManageMembers ? listInvites(id) : Promise.resolve([]);
          const appP = v?.canManageMembers ? listApplications(id) : Promise.resolve([]);
          const setP = v?.canManageSettings ? getSettings(id) : Promise.resolve(null);
          const [page, inv, apps, sett] = await Promise.all([pageP, invP, appP, setP]);
          members = page.items;
          memberTotal = page.total;
          memberPerPage = page.perPage || ROSTER_PER_PAGE;
          invites = inv;
          applications = apps;
          settings = sett;
        } catch {
          root.innerHTML = `${errorState(t("clanLoadErr") || "Failed to load clan.")}<div class="wd-clan-more">${button(
            t("clanRetry") || "Retry",
            { size: "sm", id: "clan-retry" },
          )}</div>`;
          $("clan-retry")?.addEventListener("click", () => void load());
          return;
        }
        root.innerHTML = render(clan);
        wire();
      };

      // Wire per-id / delegated listeners after each render (detail.ts pattern:
      // re-wire on each innerHTML swap). All mutating handlers end in load().
      const wire = (): void => {
        if (!clan) return;

        // Sub-nav: toggle `is-on` on the segmented buttons AND on the matching
        // `#comm-clan-sub-<seg>` section (mirrors wireProfile exactly). All
        // sections are already rendered, so switching needs no data fetch.
        const subnav = $("comm-clan-subnav");
        subnav?.querySelectorAll<HTMLElement>("[data-seg]").forEach((btn) => {
          btn.addEventListener("click", () => activateSub(btn.dataset.seg || "overview"));
        });

        // Open clan chat: drill into the thread screen for this clan's chat.
        // Legacy clans may still carry `chatId: null` — re-fetch the detail
        // once (the backend detail read get-or-creates the clan chat) before
        // giving up. Rendered for every member; backend enforces access.
        $("clan-open-chat")?.addEventListener("click", () => {
          void (async () => {
            if (!clan) return;
            let chatId = clan.chatId ?? null;
            if (!chatId) {
              try {
                const fresh = await getClan(id);
                chatId = fresh?.chatId ?? null;
                if (fresh) clan = fresh;
              } catch {
                /* fall through to the toast below */
              }
            }
            if (chatId) openThread({ kind: "clan", chatId }, `${clan.name} chat`);
            else toast(t("clanOpenChat") || "Open clan chat", t("commActionFail") || "Action failed.");
          })();
        });

        // Media (admin-only): file inputs upload the clan avatar / banner;
        // remove buttons confirm then delete. Each ends in load() so the card
        // header re-fetches the new image (stable public URL, short backend
        // cache). Mirrors profile-tab's FileReader.readAsDataURL upload.
        const pickAndUpload = (
          fileId: string,
          up: (id: string, dataUrl: string) => Promise<void>,
          okMsg: string,
        ) => {
          const inp = $(fileId) as HTMLInputElement | null;
          inp?.addEventListener("change", () => {
            const f = inp.files?.[0];
            if (!f) return;
            if (f.size > 10 * 1024 * 1024) {
              toast(t("clanMedia") || "Media", t("clanMediaTooLarge") || "Image too large.");
              inp.value = "";
              return;
            }
            const rd = new FileReader();
            rd.onload = async () => {
              try {
                await up(id, String(rd.result));
                toast(t("clanMedia") || "Media", okMsg);
                await load();
              } catch {
                toast(t("clanMedia") || "Media", t("commActionFail") || "Action failed.");
              }
            };
            rd.readAsDataURL(f);
          });
        };
        pickAndUpload("clan-av-file", uploadClanAvatar, t("clanAvatarLbl") || "Clan avatar");
        pickAndUpload("clan-bn-file", uploadClanBanner, t("clanBannerLbl") || "Clan banner");
        $("clan-av-del")?.addEventListener("click", async () => {
          const ok = await confirmDlg(
            t("clanMediaRemoveAv") || "Remove avatar?",
            t("clanMedia") || "Media",
          );
          if (!ok) return;
          try {
            await deleteClanAvatar(id);
            toast(t("clanMedia") || "Media", t("clanMediaRemoveAv") || "Avatar removed.");
            await load();
          } catch {
            toast(t("clanMedia") || "Media", t("commActionFail") || "Action failed.");
          }
        });
        $("clan-bn-del")?.addEventListener("click", async () => {
          const ok = await confirmDlg(
            t("clanMediaRemoveBn") || "Remove banner?",
            t("clanMedia") || "Media",
          );
          if (!ok) return;
          try {
            await deleteClanBanner(id);
            toast(t("clanMedia") || "Media", t("clanMediaRemoveBn") || "Banner removed.");
            await load();
          } catch {
            toast(t("clanMedia") || "Media", t("commActionFail") || "Action failed.");
          }
        });

        // Roster: "Load more" appends the next page (keeps prior rows). The
        // wholesale re-render resets the sub-nav to Overview, so re-activate the
        // Members section afterwards (the user was there to click Load more).
        $("clan-roster-more")?.addEventListener("click", async () => {
          try {
            const next = await listMembers(id, memberPage + 1, memberPerPage);
            memberPage += 1;
            members = members.concat(next.items);
            memberTotal = next.total;
            if (clan) root.innerHTML = render(clan);
            wire();
            activateSub("members");
          } catch {
            toast(t("commClanManage") || "Clan", t("commActionFail") || "Action failed.");
          }
        });

        // Roster: role change (delegated on the roster; each select carries uid).
        root.querySelectorAll<HTMLSelectElement>(".wd-clan-role").forEach((sel) => {
          sel.addEventListener("change", async () => {
            const uid = sel.dataset.uid;
            const role = sel.value as "member" | "moderator" | "admin";
            if (!uid) return;
            try {
              await setMemberRole(id, uid, role);
              toast(t("clanRoster") || "Roster", t("clanRoleOk") || "Role updated.");
            } catch {
              toast(t("clanRoster") || "Roster", t("commActionFail") || "Action failed.");
            }
            await load();
          });
        });

        // Roster: kick (confirm first).
        root.querySelectorAll<HTMLElement>("[data-kick]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const uid = btn.dataset.kick;
            const name = btn.dataset.name || uid || "";
            if (!uid) return;
            const ok = await confirmDlg(
              (t("clanKickConfirm") || "Remove this member?") + `\n${name}`,
              t("clanKick") || "Kick",
            );
            if (!ok) return;
            try {
              await kickMember(id, uid);
              toast(t("clanKick") || "Kick", t("clanKickOk") || "Member removed.");
            } catch {
              toast(t("clanKick") || "Kick", t("commActionFail") || "Action failed.");
            }
            await load();
          });
        });

        // Invites: create (default public invite — no-args) / revoke.
        $("clan-invite-new")?.addEventListener("click", async () => {
          try {
            await createInvite(id, {});
            toast(t("clanInvites") || "Invites", t("clanInviteOk") || "Invite created.");
          } catch {
            toast(t("clanInvites") || "Invites", t("commActionFail") || "Action failed.");
          }
          await load();
        });
        root.querySelectorAll<HTMLElement>("[data-revoke]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            const iid = btn.dataset.revoke;
            if (!iid) return;
            try {
              await revokeInvite(id, iid);
              toast(t("clanInvites") || "Invites", t("clanRevokeOk") || "Invite revoked.");
            } catch {
              toast(t("clanInvites") || "Invites", t("commActionFail") || "Action failed.");
            }
            await load();
          });
        });

        // Applications: approve / deny.
        const review = async (aid: string, decision: "approve" | "reject") => {
          try {
            await reviewApplication(id, aid, decision);
            toast(t("clanApplications") || "Applications", t("clanReviewOk") || "Application reviewed.");
          } catch {
            toast(t("clanApplications") || "Applications", t("commActionFail") || "Action failed.");
          }
          await load();
        };
        root.querySelectorAll<HTMLElement>("[data-approve]").forEach((btn) => {
          btn.addEventListener("click", () => void review(btn.dataset.approve as string, "approve"));
        });
        root.querySelectorAll<HTMLElement>("[data-deny]").forEach((btn) => {
          btn.addEventListener("click", () => void review(btn.dataset.deny as string, "reject"));
        });

        // Settings: profile (name + description) → updateClan.
        $("clan-save-profile")?.addEventListener("click", async () => {
          const name = ($("clan-set-name") as HTMLInputElement | null)?.value.trim() || "";
          const description = ($("clan-set-desc") as HTMLTextAreaElement | null)?.value ?? "";
          if (!name) {
            toast(t("clanSave") || "Save", t("clanNameRequired") || "Name is required.");
            return;
          }
          try {
            await updateClan(id, { name, description });
            toast(t("clanSave") || "Save", t("clanSaveOk") || "Saved.");
          } catch {
            toast(t("clanSave") || "Save", t("commActionFail") || "Action failed.");
          }
          await load();
        });

        // Settings: policy + template scope + discoverable → updateSettings.
        $("clan-save-policy")?.addEventListener("click", async () => {
          const joinPolicy = ($("clan-set-join") as HTMLSelectElement | null)?.value;
          const templateScopeDefault = ($("clan-set-scope") as HTMLSelectElement | null)?.value;
          const discoverable = ($("clan-set-disc") as HTMLInputElement | null)?.checked ?? false;
          try {
            await updateSettings(id, { joinPolicy, templateScopeDefault, discoverable });
            toast(t("clanSave") || "Save", t("clanSaveOk") || "Saved.");
          } catch {
            toast(t("clanSave") || "Save", t("commActionFail") || "Action failed.");
          }
          await load();
        });

        // Danger: leave / disband → confirm → reset to Hub.
        $("clan-leave")?.addEventListener("click", async () => {
          const ok = await confirmDlg(
            t("clanLeaveConfirm") || "Leave this clan?",
            t("clanLeave") || "Leave clan",
          );
          if (!ok) return;
          try {
            await leaveClan(id);
            toast(t("clanLeave") || "Leave clan", t("clanLeaveOk") || "You left the clan.");
            resetToHub();
          } catch {
            toast(t("clanLeave") || "Leave clan", t("commActionFail") || "Action failed.");
          }
        });
        const doDisband = async (): Promise<void> => {
          const ok = await confirmDlg(
            t("clanDisbandConfirm") || "Permanently disband this clan? This cannot be undone.",
            t("clanDisband") || "Disband clan",
          );
          if (!ok) return;
          try {
            await disbandClan(id);
            toast(t("clanDisband") || "Disband clan", t("clanDisbandOk") || "Clan disbanded.");
            resetToHub();
          } catch {
            toast(t("clanDisband") || "Disband clan", t("commActionFail") || "Action failed.");
          }
        };
        $("clan-disband")?.addEventListener("click", () => void doDisband());

        // Global moderation (moderator+ only; buttons exist only when the
        // section rendered). Takedown validates locally via takedownBody —
        // mirrors the backend checks so a bad form fails with a clear message.
        $("clan-mod-takedown")?.addEventListener("click", async () => {
          const fields = Array.from(
            root.querySelectorAll<HTMLInputElement>(".clan-mod-field:checked"),
          ).map((x) => x.value);
          const reason = ($("clan-mod-reason") as HTMLInputElement | null)?.value ?? "";
          const action = ($("clan-mod-action") as HTMLSelectElement | null)?.value ?? "strip_and_lock";
          const body = takedownBody(fields, action, reason);
          if (!body) {
            toast(t("clanModTakedown") || "Takedown", t("clanModInvalid") || "Pick at least one field and give a reason.");
            return;
          }
          const ok = await confirmDlg(
            (t("clanModTakedownConfirm") || "Strip these fields?") + `\n${body.fields.join(", ")}`,
            t("clanModTakedown") || "Takedown",
          );
          if (!ok) return;
          try {
            await takedownClan(id, body);
            toast(t("clanModTakedown") || "Takedown", t("clanSaveOk") || "Saved.");
          } catch {
            toast(t("clanModTakedown") || "Takedown", t("commActionFail") || "Action failed.");
          }
          await load();
        });
        $("clan-mod-unlock")?.addEventListener("click", async () => {
          const locked = clan?.moderation?.lockedFields ?? [];
          if (!locked.length) return;
          try {
            await unlockClan(id, locked);
            toast(t("clanModUnlock") || "Unlock", t("clanSaveOk") || "Saved.");
          } catch {
            toast(t("clanModUnlock") || "Unlock", t("commActionFail") || "Action failed.");
          }
          await load();
        });
        // Same endpoint as the owner Disband — the backend allows global
        // admin+ on any clan; this button only exists for them.
        $("clan-mod-disband")?.addEventListener("click", () => void doDisband());
      };

      await load();
    },
  };
}
