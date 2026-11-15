/**
 * Hub screen (root of the Community super-tab): the caller's clan card, a list
 * of their chats (clan + DMs + modmail), Browse/Create buttons, and a static
 * "about" card. Tapping the clan card drills into Clan; tapping a chat row
 * drills into Thread; the buttons open Browse. Data from the V3 chats/clans
 * endpoints. Mirrors the Templates Browse onMount discipline (fetch → swap a
 * container's innerHTML through loading() → content or errorState()).
 */
import type { PanelScreen } from "../kit/panel-stack";
import { card, button, loading, errorState, emptyState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { ic } from "../../icons";
import { t } from "../../i18n";
import { toast } from "../../notify";
import { promptDlg } from "../../dialog";
import { attachMentions } from "../../mentions";
import { getActiveClient } from "../../backend/index";
import {
  myClan,
  listChats,
  chatOrder,
  chatTitle,
  peerOf,
  getUsername,
  getUserId,
  getModmailThread,
  isGlobalModerator,
  type ChatSummary,
  type ChatRef,
  type ClanSummary,
} from "./api";
import { clanCard } from "./card";
import { openClan, openThread, openBrowse } from "./shell";

// External community links (from landing/about.html — authoritative).
const AUTHOR_URL = "https://vai-rice.space";
const WIKI_URL = "https://snackers.vai-rice.space";
const GITHUB_URL = "https://github.com/VAIPROG";
const X_URL = "https://x.com/VAI_PROG";
const DISCORD_SNACKERS_URL = "https://discord.gg/filian";
const DISCORD_URL = "https://discord.gg/snackersru";

// Loaded state, kept module-level (like browse.ts `rows`) so delegated row
// clicks can look a summary up by id and derive its ChatRef.
let clan: ClanSummary | null = null;
let chats: ChatSummary[] = [];

// Resolved DM peer usernames, keyed by the DM chat row id. Populated lazily
// after render (getUsername is async) so DM rows can show a friendly name and
// openThread can pass it through as the thread title.
const peerName = new Map<string, string>();

/** Derive a ChatRef from a chat summary (for openThread on a row click).
 *  - clan   → { kind:"clan", chatId }
 *  - global → { kind:"global" }   (site-wide chat — NOT modmail)
 *  - modmail→ { kind:"modmail" }
 *  - dm     → { kind:"dm", userRef }. `dmKey` is the canonical "uuidA:uuidB"
 *             participant pair; the peer is the one that isn't me. Fall back to
 *             the raw dmKey / chat id if we can't resolve me/the peer. */
function refOf(c: ChatSummary): ChatRef {
  if (c.type === "clan") return { kind: "clan", chatId: c.id };
  if (c.type === "global") return { kind: "global" };
  if (c.type === "modmail") return { kind: "modmail" };
  const me = getActiveClient()?.me?.id;
  const peer = peerOf(c.dmKey ?? undefined, me);
  return { kind: "dm", userRef: peer ?? c.dmKey ?? c.id };
}

/** Best display title for a row: for a DM, the resolved peer username when we
 *  have it, else the generic `chatTitle`. */
function rowTitle(c: ChatSummary): string {
  if (c.type === "dm") return peerName.get(c.id) || chatTitle(c);
  return chatTitle(c);
}

// Teardown for the DM-compose mentions autocomplete, module-level so a
// RE-MOUNT (stack.refresh on every Community-tab click) can drop the previous
// mount's handle. attachMentions reparents the suggest node to document.body
// and binds window resize/scroll(capture) listeners; before this, re-mounting
// with the composer open leaked one of each per refresh.
let hubMentionsTeardown: (() => void) | null = null;
function teardownHubMentions(): void {
  if (hubMentionsTeardown) {
    hubMentionsTeardown();
    hubMentionsTeardown = null;
  }
}

/** My-clan card body (or an empty-state when the user has no clan). Uses the
 *  shared advanced clan card (banner + avatar + stat chips); the card's
 *  `data-clan` root carries the id for the delegated open-clan click below. */
function renderClan(): string {
  if (!clan) return emptyState(t("commNoClan"), "🏳️");
  return clanCard(clan, { context: "hub" });
}

/** Leading per-type SVG icon for a chat row (crisp Win95 glyphs, not emoji):
 *  modmail → shield, global → globe, clan → the fused chat+shield clan mark,
 *  dm → person. Trusted `ic()` markup — never esc()'d. */
function chatIcon(kind: ChatSummary["type"]): string {
  switch (kind) {
    case "modmail":
      return ic("shield");
    case "global":
      return ic("globe");
    case "clan":
      return ic("clanChat");
    default:
      return ic("user"); // dm — a person, distinct from the "mail" compose btn
  }
}

/** Chats list body (or an empty-state when there are none). Rows come
 *  pre-ordered by `chatOrder` (modmail → global → clan → dm). DM row labels
 *  carry a `.wd-comm-chat-label` span so the async peer-name resolver can
 *  update them in place after render. */
function renderChats(): string {
  if (!chats.length) return emptyState(t("commNoChats"), "💬");
  const rows = chats
    .map((c) => {
      const unread =
        c.unreadCount > 0
          ? `<span class="wd-comm-unread" title="${esc(t("commUnread"))}">${esc(String(c.unreadCount))}</span>`
          : "";
      return `<div class="wd-row wd-comm-chat" data-chat="${esc(c.id)}" role="button" tabindex="0">${chatIcon(c.type)}<span class="grow wd-comm-chat-label">${esc(rowTitle(c))}</span>${unread}</div>`;
    })
    .join("");
  // A modmail row only exists once the thread has been created server-side, so
  // without this starter a user has NO way to first contact the staff. Only
  // shown when we actually have data (chats non-empty ⇒ connected). It IS
  // modmail, so it sits at the TOP — same slot the real row takes in chatOrder.
  const starter = chats.some((c) => c.type === "modmail")
    ? ""
    : `<div class="wd-row wd-comm-chat" data-modmail="1" role="button" tabindex="0">${ic("shield")}<span class="grow wd-comm-chat-label">${esc(t("commModmail"))} · ${esc(t("commModmailStart"))}</span></div>`;
  return `<div class="wd-list wd-list--scroll">${starter}${rows}</div>`;
}

/** Resolve DM peer usernames for the rendered rows and patch their labels in
 *  place. Best-effort: any failure leaves the generic title untouched. Skips
 *  rows already resolved. */
function resolveDmPeers(): void {
  const me = getActiveClient()?.me?.id;
  for (const c of chats) {
    if (c.type !== "dm" || peerName.has(c.id)) continue;
    const peer = peerOf(c.dmKey ?? undefined, me);
    if (!peer) continue;
    void getUsername(peer).then((name) => {
      if (!name) return;
      peerName.set(c.id, name);
      const row = document.querySelector<HTMLElement>(`.wd-comm-chat[data-chat="${CSS.escape(c.id)}"] .wd-comm-chat-label`);
      if (row) row.textContent = name;
    });
  }
}

/** Static "about / community" card at the foot of the Hub — a Win95 "About"
 *  box. Author + donate lead in a sunken group well (the donate note is the
 *  emphasised line — it funds the projects), then the wiki / GitHub / X links,
 *  each with a small leading SVG, and the two Discord servers as beveled
 *  link-buttons. URLs are authoritative (landing/about.html); icon markup from
 *  `ic()` is trusted, labels are esc()'d. */
function renderInfo(): string {
  const link = (href: string, icon: string, label: string) =>
    `<a class="wd-comm-info-link" href="${href}" target="_blank" rel="noopener">${ic(icon)}<span>${esc(label)}</span></a>`;
  const dbtn = (href: string, label: string) =>
    `<a class="wd-btn wd-btn--sm wd-comm-info-dbtn" href="${href}" target="_blank" rel="noopener">${ic("discord")}${esc(label)}</a>`;
  const body = `<div class="wd-comm-info">
      <div class="wd-comm-info-author">
        ${link(AUTHOR_URL, "globe", `${t("commInfoAuthor")}: vai-rice.space`)}
        <div class="wd-comm-info-note">${esc(t("commInfoDonateNote"))}</div>
      </div>
      ${link(WIKI_URL, "star", t("commInfoWiki"))}
      ${link(GITHUB_URL, "github", `${t("commInfoGitHub")}: VAIPROG`)}
      ${link(X_URL, "xcom", `${t("commInfoX")}: @VAI_PROG`)}
      <div class="wd-comm-info-discord">
        ${dbtn(DISCORD_SNACKERS_URL, t("commInfoDiscordSnackers"))}
        ${dbtn(DISCORD_URL, t("commInfoDiscord"))}
      </div>
    </div>`;
  return card(`<div class="wd-legend">${esc(t("commInfoTitle"))}</div>${body}`);
}

export function hubScreen(): PanelScreen {
  return {
    title: "Community",
    render: () => `
      <div id="comm-hub" class="wd-comm-hub">
        <div id="comm-myclan">${card(loading())}</div>
        <div class="wd-comm-chats-head">
          <span class="wd-legend grow">${esc(t("commChats"))}</span>
          ${isGlobalModerator() ? `<button class="wd-btn wd-btn--sm" id="comm-modmail-triage" type="button" title="${esc(t("commModmailTriageHint"))}">${ic("shield")}${esc(t("commModmailTriage"))}</button>` : ""}
          <button class="wd-btn wd-btn--sm" id="comm-new-dm" type="button">${ic("mail")}${esc(t("commNewMessage"))}</button>
        </div>
        <div id="comm-dm-compose" class="wd-comm-dm-compose" hidden>
          <input id="comm-dm-to" class="wp-input" type="text" autocomplete="off"
            placeholder="${esc(t("commDmTo"))}" />
          <button class="wd-btn wd-btn--primary wd-btn--sm" id="comm-dm-go" type="button">${esc(t("commSend"))}</button>
          <div id="comm-dm-suggest" class="wp-mention-suggest"></div>
        </div>
        <div id="comm-chats">${loading()}</div>
        <div class="wd-comm-actions">
          ${button(t("commBrowse"), { variant: "primary", id: "comm-browse" })}
          ${button(t("commCreateClan"), { id: "comm-create" })}
        </div>
        ${renderInfo()}
      </div>`,
    onMount: () => {
      // Drop any previous mount's compose-mentions handle first: a re-mount
      // (refreshCommunity on tab focus) replaces the composer DOM, but the old
      // handle's window listeners + body-reparented node would survive it.
      teardownHubMentions();

      const load = async () => {
        const clanBox = $("comm-myclan");
        const chatBox = $("comm-chats");
        if (!clanBox || !chatBox) return;
        clanBox.innerHTML = card(loading());
        chatBox.innerHTML = loading();
        try {
          // Not-connected degrades gently: myClan()/listChats() return null/[]
          // (no throw), so this renders empty states rather than an error.
          [clan, chats] = await Promise.all([myClan(), listChats()]);
          // Fixed row order: Modmail → Global → Clan → DMs (stable within type).
          chats = chatOrder(chats);
        } catch {
          const msg = errorState(t("commLoadErr"));
          clanBox.innerHTML = card(msg);
          chatBox.innerHTML = `${msg}<div class="wd-comm-actions" style="margin-top:6px"><button class="wd-btn" id="comm-retry">${esc(t("commRetry"))}</button></div>`;
          $("comm-retry")?.addEventListener("click", () => void load());
          return;
        }
        clanBox.innerHTML = card(renderClan());
        chatBox.innerHTML = renderChats();
        resolveDmPeers(); // patch DM row labels with peer usernames (async)
      };

      // My-clan card → open the clan (only when one is loaded). Delegated on the
      // container, which is recreated fresh each mount (no listener build-up).
      $("comm-myclan")?.addEventListener("click", () => {
        if (clan && ($("comm-myclan")?.querySelector(".wd-clancard"))) {
          teardownMentions(); // leaving the Hub → drop any open compose mentions
          openClan(clan.id);
        }
      });

      // Chat rows → look the summary up by data-chat id and open its Thread.
      // The modmail starter row (no summary behind it) opens the caller's own
      // modmail thread — the backend get-or-creates it on first fetch.
      $("comm-chats")?.addEventListener("click", (e) => {
        const starter = (e.target as HTMLElement).closest<HTMLElement>("[data-modmail]");
        if (starter) {
          teardownMentions();
          openThread({ kind: "modmail" }, t("commModmail"));
          return;
        }
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-chat]");
        const id = row?.dataset.chat;
        if (!id) return;
        const c = chats.find((x) => x.id === id);
        if (!c) return;
        teardownMentions(); // leaving the Hub → drop any open compose mentions
        openThread(refOf(c), rowTitle(c));
      });

      // Modmail triage (global mods only; hidden otherwise): username → that
      // user's modmail thread, opened BY CONCRETE CHAT ID so replies land in
      // the user's thread (POST /chats/global/modmail would post into the
      // moderator's own thread instead).
      $("comm-modmail-triage")?.addEventListener("click", () => {
        void (async () => {
          const name = await promptDlg(t("commModmailTriagePrompt"), "", t("commModmailTriage"));
          const ref = (name ?? "").trim().replace(/^@+/, "");
          if (!ref) return;
          const uid = await getUserId(ref);
          if (!uid) {
            toast(t("commModmailTriage"), t("commDmUnknownUser"));
            return;
          }
          try {
            const detail = await getModmailThread(uid);
            if (!detail?.id) throw new Error("no modmail thread");
            teardownMentions();
            openThread({ kind: "clan", chatId: detail.id }, `${t("commModmail")} · ${ref}`);
          } catch {
            toast(t("commModmailTriage"), t("commActionFail"));
          }
        })();
      });

      // Browse / Create both land in Browse (create is reached from its chooser).
      // Leaving the Hub (stack.push wipes it) → drop any open compose mentions
      // first, else the body-reparented #comm-dm-suggest + window listeners leak.
      const goBrowse = () => { teardownMentions(); openBrowse(); };
      $("comm-browse")?.addEventListener("click", goBrowse);
      $("comm-create")?.addEventListener("click", goBrowse);

      // --- "New message" compose: reveal an inline username → open-DM box. ---
      // attachMentions reparents #comm-dm-suggest to document.body and binds
      // window listeners, so we keep the handle and tear it down whenever we hide
      // the composer (and re-attach on the next reveal) — no orphaned body node /
      // duplicate ids / leaked listeners across repeated open/close.
      const composeBox = $("comm-dm-compose");
      const toInput = $("comm-dm-to") as HTMLInputElement | null;
      let dmMentions: { destroy(): void } | null = null;
      // The exact suggest node the handle was attached to — teardown must
      // remove THIS element (it gets reparented to document.body, and an id
      // lookup after a re-mount could hit the fresh in-composer node instead).
      let dmSuggestEl: HTMLElement | null = null;

      const teardownMentions = () => {
        dmMentions?.destroy();
        dmMentions = null;
        // destroy() drops window listeners but not the body-reparented node.
        dmSuggestEl?.remove();
        dmSuggestEl = null;
        hubMentionsTeardown = null;
      };

      const openDm = async (): Promise<void> => {
        const raw = (toInput?.value ?? "").trim().replace(/^@+/, "").trim();
        if (!raw) {
          toast(t("commNewMessage"), t("commDmUnknownUser"));
          return;
        }
        // Pre-validate the target so a typo fails HERE with a clear message,
        // not later as a failed send inside an empty thread. Also catch
        // self-DMs (the backend 400s them anyway).
        const uid = await getUserId(raw);
        if (!uid) {
          toast(t("commNewMessage"), t("commDmUnknownUser"));
          return;
        }
        if (uid === getActiveClient()?.me?.id) {
          toast(t("commNewMessage"), t("commDmSelf"));
          return;
        }
        // The DM send endpoint (/dm/{userRef}) get-or-creates the thread, so a
        // bare username works as the ref; the peer name doubles as the title.
        teardownMentions(); // leaving the Hub → drop the compose mentions handle
        openThread({ kind: "dm", userRef: raw }, raw);
      };

      $("comm-new-dm")?.addEventListener("click", () => {
        if (!composeBox) return;
        // Toggle: currently visible → hide + tear the mentions handle down.
        if (!composeBox.hasAttribute("hidden")) {
          composeBox.setAttribute("hidden", "");
          teardownMentions();
          return;
        }
        // Reveal → (re)attach mentions to a fresh suggest node. teardownMentions
        // removes the body-reparented #comm-dm-suggest, so on a second open we
        // recreate it inside the composer before re-attaching.
        composeBox.removeAttribute("hidden");
        let suggestEl = $("comm-dm-suggest");
        if (!suggestEl) {
          suggestEl = document.createElement("div");
          suggestEl.id = "comm-dm-suggest";
          suggestEl.className = "wp-mention-suggest";
          composeBox.appendChild(suggestEl);
        }
        if (toInput && !dmMentions) {
          // attachMentions is typed for a textarea but only uses value +
          // selectionStart/End, which <input> supports; the cast is safe.
          dmMentions = attachMentions(toInput as unknown as HTMLTextAreaElement, suggestEl, async () => []);
          dmSuggestEl = suggestEl;
          hubMentionsTeardown = teardownMentions;
        }
        toInput?.focus();
      });

      $("comm-dm-go")?.addEventListener("click", () => void openDm());
      toInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void openDm();
        }
      });

      void load();
    },
  };
}
