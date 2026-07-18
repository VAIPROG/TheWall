/**
 * Browse screen (Community super-tab drill-in): a search + a clan list where
 * each row offers a policy-aware Join and drills into the read-only clan
 * preview, plus a three-path "Create clan" chooser (Discord / site / manual)
 * that reuses the v6.2.8 create endpoints. On any successful create → openClan.
 *
 * Mirrors the SHIPPED Templates `browse.ts` list discipline (module state,
 * `render()`/`onMount()`, a `#…-list` container whose innerHTML is swapped
 * through `loading()` → content / `errorState()`, delegated clicks on the
 * freshly-rendered container) and the clan.ts form/dialog discipline
 * (`group()`/`button()`, `confirmDlg`/`promptDlg`, `toast`).
 */
import type { PanelScreen } from "../kit/panel-stack";
import { button, group, loading, errorState, emptyState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { toast } from "../../notify";
import { promptDlg } from "../../dialog";
import { cfg } from "../../config";
import {
  listClans,
  joinClan,
  createManual,
  ownedGuilds,
  siteSuggestion,
  createFromGuild,
  createFromSite,
  type ClanSummary,
  type OwnedGuild,
  type SiteSuggestion,
} from "./api";
import { clanCard } from "./card";
import { openClan } from "./shell";

// Landing origin for the Discord-connect handoff (mirrors links-wire.ts). The
// real Discord round-trip goes through the landing's link-manager, which plants
// a Wall JWT on the landing origin first, so we NEVER build an inline OAuth URL.
const LANDING_BASE = "https://the-wall.vai-rice.space";

// ---------------------------------------------------------------------------
// Module state (like templates/browse.ts keeps `rows`/`search`). `mode` swaps
// the same `#comm-br-body` container between the list and the create chooser.
// ---------------------------------------------------------------------------
let search = "";
let rows: ClanSummary[] = [];
let mode: "list" | "chooser" = "list";

/** Human label for a join policy value. */
function policyLabel(policy?: string | null): string {
  switch (policy) {
    case "invite_only":
      return t("commJoinInvite") || "Invite only";
    case "approval_required":
      return t("commJoinApproval") || "Approval required";
    default:
      return t("commJoinOpen") || "Open";
  }
}

/** Join-button label per policy (Apply for approval-gated clans). */
function joinLabel(policy?: string | null): string {
  if (policy === "approval_required") return t("commApply") || "Apply";
  return t("commJoin") || "Join";
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

/** One clan row: the shared advanced clan card (compact — banner + avatar +
 *  name/tag/verified + stat chips), a policy meta line, and a policy-aware
 *  Join/Apply button. The row container carries `data-open` so a row click (but
 *  NOT a `[data-join]` button click, which the delegation checks first) drills
 *  into the read-only clan preview. */
function renderRow(cl: ClanSummary): string {
  const policy = cl.joinPolicy;
  const meta = `${esc(policyLabel(policy))}`;
  const join = button(joinLabel(policy), {
    size: "sm",
    variant: "primary",
    attrs: { "data-join": cl.id, "data-policy": policy || "open" },
  });
  return `
    <div class="wd-comm-br-row" data-open="${esc(cl.id)}" role="button" tabindex="0">
      ${clanCard(cl, { context: "browse" })}
      <div class="wd-comm-br-foot">
        <span class="wd-comm-br-meta grow">${meta}</span>
        ${join}
      </div>
    </div>`;
}

/** The list body (rows / empty state). */
function renderList(): string {
  if (!rows.length) return emptyState(t("commBrowseNone") || "No clans found.", "🔍");
  return `<div class="wd-list wd-list--scroll">${rows.map(renderRow).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Create-clan chooser rendering (extracted per path, like clan.ts sections).
// ---------------------------------------------------------------------------

function renderChooserShell(inner: string): string {
  const back = button(`‹ ${t("commBrowseBackList") || "Back to list"}`, {
    size: "sm",
    id: "comm-br-back",
  });
  return `<div class="wd-comm-br-chooser"><div class="wd-clan-more">${back}</div>${inner}</div>`;
}

/** Discord path. `guilds` empty → graceful degradation (landing link, NOT an
 *  inline OAuth flow — the real round-trip is eyeball-tested later). */
function renderDiscordPath(guilds: OwnedGuild[] | null): string {
  let body: string;
  if (guilds === null) {
    body = loading();
  } else if (guilds.length) {
    const opts = guilds
      .map((g) => `<option value="${esc(g.id)}">${esc(g.id)}</option>`)
      .join("");
    body = `
      <label class="wd-clan-fld"><span>${esc(t("commCreateGuild") || "Server (guild id)")}</span>
        <select id="comm-br-guild">${opts}</select></label>
      <label class="wd-clan-fld"><span>${esc(t("commCreateName") || "Clan name (optional)")}</span>
        <input id="comm-br-guild-name" type="text" maxlength="32" placeholder="${esc(t("commCreateNamePh") || "Leave blank to use the server name")}"></label>
      <label class="wd-clan-fld"><span>${esc(t("commCreateTag") || "Tag (optional)")}</span>
        <input id="comm-br-guild-tag" type="text" maxlength="8"></label>
      <div class="wd-clan-more">${button(t("commCreateSubmit") || "Create", { size: "sm", variant: "primary", id: "comm-br-guild-go" })}</div>`;
  } else {
    // No owned guilds → point the user at the landing link-manager to connect
    // Discord, then come back. No inline OAuth is attempted here.
    body = `
      <div class="wd-comm-br-note">${esc(t("commCreateDiscordConnect") || "Connect Discord to import a server you own.")}</div>
      <div class="wd-clan-more">${button(t("commCreateDiscordConnectBtn") || "Connect Discord…", { size: "sm", id: "comm-br-discord-connect" })}</div>`;
  }
  return group(t("commCreateFromDiscord") || "From a Discord server", body);
}

/** Site path. `sug` null (204) → muted note. */
function renderSitePath(sug: SiteSuggestion | null | undefined): string {
  let body: string;
  if (sug === undefined) {
    body = loading();
  } else if (sug) {
    const name = sug.displayName || sug.name;
    body = `
      <div class="wd-comm-br-suggest">${esc(name)}</div>
      <div class="wd-clan-more">${button(t("commCreateFromThis") || "Create from this", { size: "sm", variant: "primary", id: "comm-br-site-go" })}</div>`;
  } else {
    body = `<div class="wd-comm-br-note wd-comm-br-muted">${esc(t("commCreateNoSite") || "No site suggestion available.")}</div>`;
  }
  return group(t("commCreateFromSite") || "From your site clan", body);
}

/** Manual path: name (required, 2–32) + optional description. */
function renderManualPath(): string {
  const body = `
    <label class="wd-clan-fld"><span>${esc(t("commCreateName") || "Clan name")}</span>
      <input id="comm-br-man-name" type="text" maxlength="32" placeholder="${esc(t("commCreateNamePh2") || "2–32 characters")}"></label>
    <label class="wd-clan-fld"><span>${esc(t("commCreateDesc") || "Description (optional)")}</span>
      <textarea id="comm-br-man-desc" rows="2" maxlength="500"></textarea></label>
    <div class="wd-clan-more">${button(t("commCreateSubmit") || "Create", { size: "sm", variant: "primary", id: "comm-br-man-go" })}</div>`;
  return group(t("commCreateManual") || "Manual", body);
}

export function browseScreen(): PanelScreen {
  return {
    // NOTE: EN dict value for `commBrowseTitle` is "Browse" so the shell test's
    // `browse.title === "Browse"` assertion still holds.
    title: t("commBrowseTitle") || "Browse clans",
    render: () => `
      <div id="comm-browse" class="wd-comm-browse">
        <div class="wd-comm-br-bar">
          <input id="comm-br-search" class="wd-comm-br-search" type="text"
            placeholder="${esc(t("commBrowseSearch") || "Search clans…")}" value="${esc(search)}">
          <button class="wd-btn wd-btn--sm" id="comm-br-reload" title="${esc(t("commRetry") || "Reload")}">↻</button>
          ${button(`＋ ${t("commCreateClan") || "Create clan"}`, { size: "sm", variant: "primary", id: "comm-br-create" })}
        </div>
        <div id="comm-br-body">${loading()}</div>
      </div>`,
    onMount: () => {
      const body = () => $("comm-br-body");

      // --- list mode -------------------------------------------------------
      const load = async (): Promise<void> => {
        mode = "list";
        const b = body();
        if (!b) return;
        b.innerHTML = loading();
        try {
          const page = await listClans({ search: search.trim() || undefined, perPage: 50 });
          rows = page.items;
        } catch {
          b.innerHTML = `${errorState(t("commBrowseErr") || "Failed to load clans.")}<div class="wd-clan-more">${button(
            t("commRetry") || "Retry",
            { size: "sm", id: "comm-br-retry" },
          )}</div>`;
          $("comm-br-retry")?.addEventListener("click", () => void load());
          return;
        }
        b.innerHTML = renderList();
      };

      const doJoin = async (id: string, policy: string): Promise<void> => {
        try {
          if (policy === "invite_only") {
            const code = await promptDlg(
              t("commJoinInvitePrompt") || "Enter an invite code:",
              "",
              t("commJoin") || "Join",
            );
            if (code == null || !code.trim()) return;
            await joinClan(id, code.trim());
            toast(t("commJoin") || "Join", t("commJoinOk") || "Joined the clan.");
            openClan(id);
          } else if (policy === "approval_required") {
            await joinClan(id);
            toast(t("commApply") || "Apply", t("commApplyOk") || "Application submitted.");
          } else {
            await joinClan(id);
            toast(t("commJoin") || "Join", t("commJoinOk") || "Joined the clan.");
            openClan(id);
          }
        } catch {
          toast(t("commJoin") || "Join", t("commActionFail") || "Action failed. Please try again.");
        }
      };

      // --- chooser mode ----------------------------------------------------
      // Cached async results; undefined = not-yet-loaded, null = loaded-empty.
      let guilds: OwnedGuild[] | null = null;
      let sug: SiteSuggestion | null | undefined = undefined;

      const renderChooser = (): void => {
        const b = body();
        if (!b) return;
        b.innerHTML = renderChooserShell(
          renderDiscordPath(guilds) + renderSitePath(sug) + renderManualPath(),
        );
        wireChooser();
      };

      const openChooser = async (): Promise<void> => {
        mode = "chooser";
        guilds = null;
        sug = undefined;
        renderChooser();
        // Fetch both suggestions in parallel; re-render as each resolves.
        void ownedGuilds()
          .then((g) => (guilds = g))
          .catch(() => (guilds = []))
          .finally(() => {
            if (mode === "chooser") renderChooser();
          });
        void siteSuggestion()
          .then((s) => (sug = s))
          .catch(() => (sug = null))
          .finally(() => {
            if (mode === "chooser") renderChooser();
          });
      };

      // All create handlers funnel here on success.
      const created = (id?: string): void => {
        if (id) openClan(id);
      };

      const wireChooser = (): void => {
        $("comm-br-back")?.addEventListener("click", () => void load());

        // Discord: connect (degradation) OR create from a picked guild.
        $("comm-br-discord-connect")?.addEventListener("click", () => {
          window.open(
            `${LANDING_BASE}/me.html#wd_jwt=${encodeURIComponent(cfg.backendToken || "")}`,
            "_blank",
            "noopener",
          );
        });
        $("comm-br-guild-go")?.addEventListener("click", async () => {
          const guildId = ($("comm-br-guild") as HTMLSelectElement | null)?.value || "";
          const name = ($("comm-br-guild-name") as HTMLInputElement | null)?.value.trim() || undefined;
          const tag = ($("comm-br-guild-tag") as HTMLInputElement | null)?.value.trim() || undefined;
          if (!guildId) return;
          try {
            const res = await createFromGuild({ guildId, name, tag });
            toast(t("commCreateClan") || "Create clan", t("commCreateOk") || "Clan created.");
            created(res.id);
          } catch {
            toast(t("commCreateClan") || "Create clan", t("commActionFail") || "Action failed. Please try again.");
          }
        });

        // Site: create from the stored suggestion (no body).
        $("comm-br-site-go")?.addEventListener("click", async () => {
          try {
            const res = await createFromSite();
            toast(t("commCreateClan") || "Create clan", t("commCreateOk") || "Clan created.");
            created(res.id);
          } catch {
            toast(t("commCreateClan") || "Create clan", t("commActionFail") || "Action failed. Please try again.");
          }
        });

        // Manual: validate name length client-side, then createManual.
        $("comm-br-man-go")?.addEventListener("click", async () => {
          const name = ($("comm-br-man-name") as HTMLInputElement | null)?.value.trim() || "";
          const desc = ($("comm-br-man-desc") as HTMLTextAreaElement | null)?.value ?? "";
          if (name.length < 2 || name.length > 32) {
            toast(t("commCreateClan") || "Create clan", t("commCreateNameLen") || "Name must be 2–32 characters.");
            return;
          }
          try {
            const res = await createManual(name, desc.trim() || undefined);
            toast(t("commCreateClan") || "Create clan", t("commCreateOk") || "Clan created.");
            created(res.id);
          } catch {
            toast(t("commCreateClan") || "Create clan", t("commActionFail") || "Action failed. Please try again.");
          }
        });
      };

      // --- top bar (persistent — wired once on mount) ----------------------
      $("comm-br-search")?.addEventListener("input", (e) => {
        search = (e.target as HTMLInputElement).value;
        if (mode === "list") void load();
      });
      $("comm-br-reload")?.addEventListener("click", () => void load());
      $("comm-br-create")?.addEventListener("click", () => void openChooser());

      // Delegated clicks bound ONCE on the persistent #comm-br-body (it survives
      // every innerHTML swap, so re-binding per load() would stack listeners and
      // fire Join/openClan N times). In chooser mode there are no [data-join]/
      // [data-open] targets, so this no-ops there; chooser controls are wired by
      // id in wireChooser(). Mirrors templates/browse.ts's once-in-onMount bind.
      $("comm-br-body")?.addEventListener("click", (e) => {
        const joinBtn = (e.target as HTMLElement).closest<HTMLElement>("[data-join]");
        if (joinBtn?.dataset.join) {
          void doJoin(joinBtn.dataset.join, joinBtn.dataset.policy || "open");
          return;
        }
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-open]");
        if (row?.dataset.open) openClan(row.dataset.open);
      });

      void load();
    },
  };
}
