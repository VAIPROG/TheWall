/**
 * Hub screen (root of the Community super-tab): the caller's clan card, a list
 * of their chats (clan + DMs + modmail), Browse/Create buttons, and a static
 * "about" card. Tapping the clan card drills into Clan; tapping a chat row
 * drills into Thread; the buttons open Browse. Data from the V3 chats/clans
 * endpoints. Mirrors the Templates Browse onMount discipline (fetch → swap a
 * container's innerHTML through loading() → content or errorState()).
 */
import type { PanelScreen } from "../kit/panel-stack";
import { card, badge, button, loading, errorState, emptyState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import {
  myClan,
  listChats,
  chatTitle,
  type ChatSummary,
  type ChatRef,
  type ClanSummary,
} from "./api";
import { openClan, openThread, openBrowse } from "./shell";

// External community links (from landing/about.html — authoritative).
const AUTHOR_URL = "https://vai-rice.space";
const GITHUB_URL = "https://github.com/Vadim-Khristenko";
const X_URL = "https://x.com/VAI_PROG";
const DISCORD_URL = "https://discord.gg/snackersru";

// Loaded state, kept module-level (like browse.ts `rows`) so delegated row
// clicks can look a summary up by id and derive its ChatRef.
let clan: ClanSummary | null = null;
let chats: ChatSummary[] = [];

/** Derive a ChatRef from a chat summary (for openThread on a row click).
 *  - clan   → { kind:"clan", chatId }
 *  - dm     → { kind:"dm", userRef }. `dmKey` is an opaque, canonically-ordered
 *             id pair (not a single peer id), so it can't cleanly yield the peer
 *             here; we pass `dmKey` (or the chat id) through as the ref and let
 *             Task 4's Thread resolve the actual peer from ChatDetail.
 *  - modmail/global → { kind:"modmail" } */
function refOf(c: ChatSummary): ChatRef {
  if (c.type === "clan") return { kind: "clan", chatId: c.id };
  if (c.type === "dm") return { kind: "dm", userRef: c.dmKey ?? c.id };
  return { kind: "modmail" };
}

/** My-clan card body (or an empty-state when the user has no clan). */
function renderClan(): string {
  if (!clan) return emptyState(t("commNoClan"), "🏳️");
  const ver = clan.ownerVerified ? badge(t("commVerified"), "owner") : "";
  return `
    <div class="wd-comm-clan" role="button" tabindex="0">
      <div class="wd-comm-clan-body">
        <div class="wd-comm-clan-name">${esc(clan.name)}</div>
        <div class="wd-comm-clan-sub">${esc(t("commMembers", { n: clan.memberCount }))}${ver}</div>
      </div>
      <span class="wd-comm-clan-arr" aria-hidden="true">›</span>
    </div>`;
}

/** Chats list body (or an empty-state when there are none). */
function renderChats(): string {
  if (!chats.length) return emptyState(t("commChats"), "💬");
  const rows = chats
    .map((c) => {
      const unread =
        c.unreadCount > 0
          ? `<span class="wd-comm-unread" title="${esc(t("commUnread"))}">${esc(String(c.unreadCount))}</span>`
          : "";
      return `<div class="wd-row wd-comm-chat" data-chat="${esc(c.id)}" role="button" tabindex="0"><span class="grow">${esc(chatTitle(c))}</span>${unread}</div>`;
    })
    .join("");
  return `<div class="wd-list wd-list--scroll">${rows}</div>`;
}

/** Static "about / community" card at the foot of the Hub. */
function renderInfo(): string {
  const link = (href: string, label: string) =>
    `<a href="${href}" target="_blank" rel="noopener">${esc(label)}</a>`;
  const body = `<div class="wd-comm-info">
      ${link(AUTHOR_URL, `${t("commInfoAuthor")}: vai-rice.space`)}
      ${link(GITHUB_URL, `${t("commInfoGitHub")}: Vadim-Khristenko`)}
      ${link(X_URL, `${t("commInfoX")}: @VAI_PROG`)}
      ${link(DISCORD_URL, `Discord: ${t("commInfoDiscord")}`)}
    </div>`;
  return card(`<div class="wd-legend">${esc(t("commInfoTitle"))}</div>${body}`);
}

export function hubScreen(): PanelScreen {
  return {
    title: "Community",
    render: () => `
      <div id="comm-hub" class="wd-comm-hub">
        <div id="comm-myclan">${card(loading(), "wd-comm-clan-card")}</div>
        <div id="comm-chats">${loading()}</div>
        <div class="wd-comm-actions">
          <button class="wd-btn wd-btn--primary" id="comm-browse">${esc(t("commBrowse"))}</button>
          <button class="wd-btn" id="comm-create">${esc(t("commCreateClan"))}</button>
        </div>
        ${renderInfo()}
      </div>`,
    onMount: () => {
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
        } catch {
          const msg = errorState(t("commLoadErr"));
          clanBox.innerHTML = card(msg);
          chatBox.innerHTML = `${msg}<div class="wd-comm-actions" style="margin-top:6px"><button class="wd-btn" id="comm-retry">${esc(t("commRetry"))}</button></div>`;
          $("comm-retry")?.addEventListener("click", () => void load());
          return;
        }
        clanBox.innerHTML = card(renderClan());
        chatBox.innerHTML = renderChats();
      };

      // My-clan card → open the clan (only when one is loaded). Delegated on the
      // container, which is recreated fresh each mount (no listener build-up).
      $("comm-myclan")?.addEventListener("click", () => {
        if (clan && ($("comm-myclan")?.querySelector(".wd-comm-clan"))) openClan(clan.id);
      });

      // Chat rows → look the summary up by data-chat id and open its Thread.
      $("comm-chats")?.addEventListener("click", (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>("[data-chat]");
        const id = row?.dataset.chat;
        if (!id) return;
        const c = chats.find((x) => x.id === id);
        if (c) openThread(refOf(c));
      });

      // Browse / Create both land in Browse (create is reached from its chooser).
      $("comm-browse")?.addEventListener("click", openBrowse);
      $("comm-create")?.addEventListener("click", openBrowse);

      void load();
    },
  };
}
