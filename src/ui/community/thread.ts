/**
 * Thread screen (clan chat / DM / modmail) — the drill-in from Hub. A scrollable
 * message list + a composer, with read-state, a 5s poll while mounted, reactions
 * and message actions. The pure message → HTML lives in `render.ts`; this file
 * owns the DOM (poll, composer wiring, delegated actions, inline edit).
 *
 * Mirrors the Templates browse/detail screen discipline: fetch → swap a
 * container's innerHTML through loading()/errorState(); listeners live in
 * onMount and are delegated on freshly-rendered containers.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { loading, errorState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { ic } from "../../icons";
import { t } from "../../i18n";
import { toast } from "../../notify";
import { confirmDlg, promptDlg } from "../../dialog";
import { getActiveClient } from "../../backend/index";
import { openEmojiPicker } from "../../emoji-picker";
import { attachMentions } from "../../mentions";
import {
  listMessages,
  sendMessage,
  markRead,
  react,
  editMessage,
  deleteMessage,
  reportMessage,
  pinMessage,
  getChat,
  type ChatRef,
  type Message,
} from "./api";
import { renderMessage } from "./render";

// ---------------------------------------------------------------------------
// Poll teardown (MODULE-level single timer).
//
// PanelStack has no teardown hook: pushing/popping a screen replaces the stack
// container's innerHTML, which detaches this thread's DOM. So instead of an
// unmount callback we self-clear: a single module-level interval whose tick
// checks whether `#comm-msgs` is still in the document. Once the user navigates
// away (or a new thread re-mounts and calls stopPoll first), the element is
// gone and the next tick clears the timer. One timer max, ever.
// ---------------------------------------------------------------------------
let pollTimer: ReturnType<typeof setInterval> | null = null;
function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** i18n labels handed to the pure renderer (keeps render.ts dict-free). */
function actionLabels() {
  return {
    edit: t("commMsgEdit"),
    delete: t("commMsgDelete"),
    report: t("commMsgReport"),
    pin: t("commMsgPin"),
    deleted: t("commMsgDeleted"),
    edited: t("commMsgEdited"),
  };
}

/** The chat id to use for message-scoped endpoints (react/edit/delete/pin/...).
 *  Clan threads carry it on the ref; DM/modmail don't, so we take it from the
 *  message itself (its `chatId` is the real chat id — those endpoints are all
 *  `/chats/{cid}/...`). */
function cidFor(ref: ChatRef, m: Message): string {
  return ref.kind === "clan" ? ref.chatId : m.chatId;
}

export function threadScreen(ref: ChatRef, title: string): PanelScreen {
  return {
    title: title || t("commThread"),
    render: () => `
      <div class="wd-comm-thread">
        <div id="comm-msgs" class="wd-comm-msglist">${loading()}</div>
        <div class="wd-comm-composer">
          <textarea id="comm-input" class="wp-input wd-comm-input" rows="2"
            autocomplete="off" placeholder="${esc(t("commComposerPh"))}"></textarea>
          <button class="wp-btn wp-emoji-btn" id="comm-emoji" type="button"
            title="${esc(t("commEmoji"))}" aria-label="${esc(t("commEmoji"))}">${ic("emote")}</button>
          <button class="wd-btn wd-btn--primary" id="comm-send" type="button">${ic("send")}${esc(t("commSend"))}</button>
          <div id="comm-mention-suggest" class="wp-mention-suggest"></div>
        </div>
      </div>`,
    onMount: () => {
      // Kill any prior thread's poll before this one starts (re-mount resets it).
      stopPoll();

      const c = getActiveClient();
      const meId = c?.me?.id;
      // Cache of the last-rendered messages so delegated handlers can look a
      // message up by id (e.g. to get its real chatId for DM/modmail).
      let msgs: Message[] = [];
      let canModerate = false;
      let inFlight = false;

      // --- render one batch into #comm-msgs, preserving scroll-at-bottom ---
      const paint = (list: Message[]): void => {
        const box = $("comm-msgs");
        if (!box) return;
        // Was the user pinned near the bottom before we re-render? If so, keep
        // them there; otherwise leave their scroll position untouched.
        const nearBottom =
          box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        const labels = actionLabels();
        box.innerHTML = list.length
          ? list.map((m) => renderMessage(m, { meId, canModerate }, labels)).join("")
          : `<div class="wd-empty">${esc(t("commNoMessages"))}</div>`;
        if (nearBottom) box.scrollTop = box.scrollHeight;
      };

      // --- fetch + render ---
      const load = async (): Promise<void> => {
        const box = $("comm-msgs");
        if (!box) return;
        try {
          msgs = await listMessages(ref);
        } catch {
          box.innerHTML = `${errorState(t("commLoadErr"))}<div class="wd-comm-actions" style="margin-top:6px"><button class="wd-btn" id="comm-retry" type="button">${esc(t("commRetry"))}</button></div>`;
          $("comm-retry")?.addEventListener("click", () => void load());
          return;
        }
        paint(msgs);
      };

      // Not connected → error state with retry (backend calls no-op otherwise).
      if (!c) {
        const box = $("comm-msgs");
        if (box) {
          box.innerHTML = `${errorState(t("commLoadErr"))}<div class="wd-comm-actions" style="margin-top:6px"><button class="wd-btn" id="comm-retry" type="button">${esc(t("commRetry"))}</button></div>`;
          $("comm-retry")?.addEventListener("click", () => location.reload());
        }
        return;
      }

      // Derive moderation ability for clan threads (cheap-ish; best-effort).
      // DM/modmail: leave false. Backend enforces regardless — this only gates
      // which buttons we bother to show.
      if (ref.kind === "clan") {
        void getChat(ref.chatId)
          .then((detail) => {
            const role = detail?.viewer?.role;
            canModerate = role === "moderator" || role === "admin" || role === "owner";
            if (canModerate && msgs.length) paint(msgs);
          })
          .catch(() => {});
      }

      // Initial: mark read + first load.
      void markRead(ref);
      void load();

      // --- 5s poll while mounted (self-clears on navigate-away) ---
      const tick = async (): Promise<void> => {
        const list = document.getElementById("comm-msgs");
        if (!list) {
          stopPoll(); // screen popped/replaced → element gone → self-clear
          return;
        }
        if (inFlight) return; // single-in-flight guard
        inFlight = true;
        try {
          await load();
        } finally {
          inFlight = false;
        }
      };
      pollTimer = setInterval(tick, 5000);

      // --- composer ---
      const ta = $("comm-input") as HTMLTextAreaElement | null;
      const sendBtn = $("comm-send");
      const emojiBtn = $("comm-emoji");
      const suggestEl = $("comm-mention-suggest");

      const doSend = async (): Promise<void> => {
        if (!ta) return;
        const text = ta.value.trim();
        if (!text) return; // guard empty / whitespace-only
        try {
          await sendMessage(ref, text);
          ta.value = ""; // clear only on success
          await load();
          void markRead(ref);
        } catch {
          // Keep the textarea text so the user doesn't lose their message.
          toast(t("commSend"), t("commSendFail"));
        }
      };

      sendBtn?.addEventListener("click", () => void doSend());
      // Enter sends; Shift+Enter = newline.
      ta?.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void doSend();
        }
      });

      // Emoji picker (mirror chats.ts wiring).
      emojiBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        if (ta && emojiBtn) {
          emojiBtn.setAttribute("data-wd-emoji-anchor", "1");
          openEmojiPicker(ta, emojiBtn);
        }
      });

      // Mentions autocomplete. No clan roster endpoint handy here, so fall back
      // to the usernames visible in the thread (attachMentions does this when
      // fetchUsers returns []).
      if (ta && suggestEl) {
        attachMentions(ta, suggestEl, async () => []);
      }

      // --- delegated message actions (fresh container each mount) ---
      $("comm-msgs")?.addEventListener("click", (e) => {
        const el = e.target as HTMLElement;

        // Reaction toggle.
        const reactBtn = el.closest<HTMLElement>("[data-react]");
        if (reactBtn) {
          const mid = reactBtn.dataset.mid || "";
          const emoji = decodeURIComponent(reactBtn.dataset.react || "");
          const isOn = reactBtn.classList.contains("is-on");
          const m = msgs.find((x) => x.id === mid);
          if (!m) return;
          void react(cidFor(ref, m), mid, emoji, !isOn).then(() => load());
          return;
        }

        const actBtn = el.closest<HTMLElement>("[data-action]");
        if (!actBtn) return;
        const action = actBtn.dataset.action;
        const mid = actBtn.dataset.mid || "";
        const m = msgs.find((x) => x.id === mid);
        if (!m) return;
        const cid = cidFor(ref, m);

        if (action === "edit") {
          startInlineEdit(m, cid);
        } else if (action === "delete") {
          void (async () => {
            const ok = await confirmDlg(t("commMsgDeleteConfirm"), t("commMsgDelete"));
            if (!ok) return;
            try {
              await deleteMessage(cid, mid);
              await load();
            } catch {
              toast(t("commMsgDelete"), t("commActionFail"));
            }
          })();
        } else if (action === "report") {
          void (async () => {
            const reason = await promptDlg(t("commMsgReportPrompt"), "", t("commMsgReport"));
            if (!reason || !reason.trim()) return;
            try {
              await reportMessage(cid, mid, reason.trim());
              toast(t("commMsgReport"), t("commMsgReportOk"));
            } catch {
              toast(t("commMsgReport"), t("commActionFail"));
            }
          })();
        } else if (action === "pin") {
          void (async () => {
            try {
              await pinMessage(cid, mid, true);
              toast(t("commMsgPin"), t("commMsgPinOk"));
              await load();
            } catch {
              toast(t("commMsgPin"), t("commActionFail"));
            }
          })();
        }
      });

      // --- inline edit: swap the message body for a textarea + save/cancel ---
      function startInlineEdit(m: Message, cid: string): void {
        const row = document.querySelector<HTMLElement>(`.wd-comm-msg[data-mid="${CSS.escape(m.id)}"]`);
        const bodyEl = row?.querySelector<HTMLElement>(".wd-comm-msg-body");
        if (!row || !bodyEl) return;
        // Version for optimistic concurrency (from the rendered row).
        const ver = Number(row.dataset.ver || m.version);
        const original = bodyEl.innerHTML;
        bodyEl.innerHTML = `
          <textarea class="wp-input wd-comm-edit-ta" rows="2"></textarea>
          <div class="wd-comm-edit-actions">
            <button class="wd-btn wd-btn--primary wd-btn--sm" data-edit="save" type="button">${esc(t("commSave"))}</button>
            <button class="wd-btn wd-btn--sm" data-edit="cancel" type="button">${esc(t("commCancel"))}</button>
          </div>`;
        const editTa = bodyEl.querySelector<HTMLTextAreaElement>(".wd-comm-edit-ta");
        if (editTa) {
          editTa.value = m.content;
          editTa.focus();
        }
        const restore = () => {
          bodyEl.innerHTML = original;
        };
        bodyEl.querySelector('[data-edit="cancel"]')?.addEventListener("click", restore);
        bodyEl.querySelector('[data-edit="save"]')?.addEventListener("click", () => {
          const next = editTa?.value.trim() ?? "";
          if (!next || next === m.content) {
            restore();
            return;
          }
          void (async () => {
            try {
              await editMessage(cid, m.id, next, ver);
              await load();
            } catch {
              toast(t("commMsgEdit"), t("commActionFail"));
              restore();
            }
          })();
        });
      }
    },
  };
}
