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
import { replaceEmotes } from "../../emoji";
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
  messagesFingerprint,
  isGlobalModerator,
  type ChatRef,
  type Message,
} from "./api";
import { renderMessage } from "./render";

// ---------------------------------------------------------------------------
// Poll teardown (MODULE-level single timer + teardown).
//
// PanelStack has no teardown hook: pushing/popping a screen replaces the stack
// container's innerHTML, which detaches this thread's DOM. So instead of an
// unmount callback we self-clear: a single module-level interval whose tick
// checks whether `#comm-msgs` is still in the document. Once the user navigates
// away (or a new thread re-mounts and calls stopPoll first), the element is
// gone and the next tick clears the timer. One timer max, ever.
//
// `threadTeardown` rides along: the mentions autocomplete reparents its suggest
// node to document.body and binds window resize/scroll(capture) listeners, so
// it MUST be torn down whenever the poll dies. Previously only the tick's
// detach path did that — a stack.refresh() (every Community-tab click) ran
// stopPoll() in the next onMount BEFORE the old tick could fire, leaking one
// capture-phase window scroll listener + one orphaned body node per refresh.
// Those stale listeners fire on every page scroll — a real sluggishness source.
// ---------------------------------------------------------------------------
let pollTimer: ReturnType<typeof setInterval> | null = null;
let threadTeardown: (() => void) | null = null;
function stopPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (threadTeardown) {
    threadTeardown();
    threadTeardown = null;
  }
}

/** i18n labels handed to the pure renderer (keeps render.ts dict-free). */
function actionLabels() {
  return {
    react: t("commReact"),
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
      // Fingerprint of what #comm-msgs currently shows (null = not message
      // HTML, e.g. loading/error state → next paint always renders). Painting
      // recreates every animated-emote <img>, so unchanged polls must skip.
      let paintedKey: string | null = null;
      // The CONCRETE chat id (read/react/edit/pin routes are Uuid-only). Clan
      // refs carry it; global/DM/modmail refs resolve it from the first loaded
      // (or sent) message. Null until then — read-state simply waits.
      let cid: string | null = ref.kind === "clan" ? ref.chatId : null;
      // Newest message id we've already marked read — avoids re-POSTing
      // /read on every 5s poll when nothing changed.
      let lastReadMsgId: string | null = null;

      // Global chat + own-modmail moderation is gated on the caller's GLOBAL
      // role (clan threads derive it from the chat detail below).
      if (ref.kind === "global" || ref.kind === "modmail") {
        canModerate = isGlobalModerator();
      }

      /** Resolve `cid` from the loaded messages and mark the thread read once
       *  per new newest-message. markRead is best-effort (never throws). */
      const syncRead = (): void => {
        if (!cid && msgs.length) cid = msgs[msgs.length - 1].chatId;
        const newest = msgs.length ? msgs[msgs.length - 1].id : null;
        if (!cid || !newest || newest === lastReadMsgId) return;
        lastReadMsgId = newest;
        void markRead(cid, newest);
      };

      // --- render one batch into #comm-msgs, preserving scroll-at-bottom ---
      // Skips the innerHTML swap entirely when nothing visible changed since
      // the last paint (canModerate is part of the key — it gates the action
      // buttons, so a role resolving late repaints once). Without this, the 5s
      // poll rebuilt the whole list every tick, re-decoding every animated
      // emote <img> and thrashing layout — the emote-lag root cause.
      const paint = (list: Message[]): void => {
        const box = $("comm-msgs");
        if (!box) return;
        const key = `${canModerate ? "m" : "-"}|${meId ?? ""}|${messagesFingerprint(list)}`;
        if (key === paintedKey) return;
        // Was the user pinned near the bottom before we re-render? If so, keep
        // them there; otherwise leave their scroll position untouched.
        const nearBottom =
          box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        const labels = actionLabels();
        box.innerHTML = list.length
          ? list.map((m) => renderMessage(m, { meId, canModerate, emotes: replaceEmotes }, labels)).join("")
          : `<div class="wd-empty">${esc(t("commNoMessages"))}</div>`;
        paintedKey = key;
        if (nearBottom) box.scrollTop = box.scrollHeight;
      };

      // --- fetch + render ---
      const load = async (): Promise<void> => {
        const box = $("comm-msgs");
        if (!box) return;
        // Not connected → error state with an in-place retry (the user may
        // connect from Settings and come back; never reload the whole page).
        if (!getActiveClient()?.token) {
          box.innerHTML = `${errorState(t("commConnectFirst"))}<div class="wd-comm-actions" style="margin-top:6px"><button class="wd-btn" id="comm-retry" type="button">${esc(t("commRetry"))}</button></div>`;
          paintedKey = null; // box no longer shows message HTML
          $("comm-retry")?.addEventListener("click", () => void load());
          return;
        }
        try {
          msgs = await listMessages(ref);
        } catch {
          // A transient poll failure must not wipe a thread the user is
          // reading — only surface the error state when nothing is on screen.
          if (msgs.length) return;
          box.innerHTML = `${errorState(t("commLoadErr"))}<div class="wd-comm-actions" style="margin-top:6px"><button class="wd-btn" id="comm-retry" type="button">${esc(t("commRetry"))}</button></div>`;
          paintedKey = null; // box no longer shows message HTML
          $("comm-retry")?.addEventListener("click", () => void load());
          return;
        }
        paint(msgs);
        syncRead();
      };

      // Derive moderation ability for by-id threads from the chat detail (clan
      // chats → clan role; a mod-opened modmail thread → viewer.role
      // "moderator"). DM: stays false. Backend enforces regardless — this only
      // gates which buttons we bother to show.
      if (ref.kind === "clan") {
        void getChat(ref.chatId)
          .then((detail) => {
            const role = detail?.viewer?.role;
            canModerate = role === "moderator" || role === "admin" || role === "owner";
            // canModerate is part of the paint key — repaints only on change.
            if (msgs.length) paint(msgs);
          })
          .catch(() => {});
      }

      // Initial load (marks read once messages + the concrete id are known).
      void load();

      // --- composer ---
      const ta = $("comm-input") as HTMLTextAreaElement | null;
      const sendBtn = $("comm-send");
      const emojiBtn = $("comm-emoji");
      const suggestEl = $("comm-mention-suggest");

      // Mentions autocomplete. No clan roster endpoint handy here, so fall back
      // to the usernames visible in the thread (attachMentions does this when
      // fetchUsers returns []). Capture the handle so we can tear it down on
      // unmount — attachMentions reparents suggestEl to document.body and binds
      // window resize/scroll listeners; without destroy() those leak per open.
      const mentions = (ta && suggestEl) ? attachMentions(ta, suggestEl, async () => []) : null;
      // Registered module-level so EVERY stopPoll() path tears it down —
      // including a re-mount (stack.refresh / another thread opening) that
      // kills the timer before the tick's detach path could run. destroy()
      // drops the window listeners but does NOT remove the body-reparented
      // suggest node, so remove() it too or orphans accumulate.
      threadTeardown = () => {
        mentions?.destroy();
        suggestEl?.remove();
      };

      // --- 5s poll while mounted (self-clears on navigate-away) ---
      const tick = async (): Promise<void> => {
        const list = document.getElementById("comm-msgs");
        if (!list) {
          // Screen popped/replaced → element gone → self-clear (stopPoll also
          // runs the registered mentions teardown).
          stopPoll();
          return;
        }
        // Community pane hidden (user is on another top-level tab, or the
        // window is closed)? The thread stays mounted, so the element is still
        // in the document — but polling + repainting an invisible list burned
        // network and CPU forever in the background. Pause; switching back to
        // the tab re-mounts via refreshCommunity() (fresh load) anyway.
        if (!list.offsetParent) return;
        if (inFlight) return; // single-in-flight guard
        inFlight = true;
        try {
          await load();
        } finally {
          inFlight = false;
        }
      };
      pollTimer = setInterval(tick, 5000);

      const doSend = async (): Promise<void> => {
        if (!ta) return;
        const text = ta.value.trim();
        if (!text) return; // guard empty / whitespace-only
        try {
          const sent = await sendMessage(ref, text);
          // First message in a fresh global/DM/modmail thread: the response
          // carries the concrete chat id the ref lacks.
          if (!cid && sent?.chatId) cid = sent.chatId;
          ta.value = ""; // clear only on success
          await load(); // paints + syncRead()s
          // The sender always wants to see their message land — jump to the
          // bottom even if they had scrolled up.
          const box = $("comm-msgs");
          if (box) box.scrollTop = box.scrollHeight;
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
          void react(cidFor(ref, m), mid, emoji, !isOn)
            .then(() => load())
            .catch(() => toast(t("commThread"), t("commActionFail")));
          return;
        }

        const actBtn = el.closest<HTMLElement>("[data-action]");
        if (!actBtn) return;
        const action = actBtn.dataset.action;
        const mid = actBtn.dataset.mid || "";
        const m = msgs.find((x) => x.id === mid);
        if (!m) return;
        const cid = cidFor(ref, m);

        if (action === "react") {
          // Open the shared emoji picker anchored to the clicked button; its
          // onPick delivers the chosen shortcode (composer insertion is
          // bypassed). PUT the reaction (on=true), then reload to show the chip.
          // ta is a harmless placeholder target — onPick short-circuits insert.
          if (ta) {
            actBtn.setAttribute("data-wd-emoji-anchor", "1");
            void openEmojiPicker(ta, actBtn, {
              onPick: (emoji) => {
                void react(cidFor(ref, m), m.id, emoji, true)
                  .then(() => load())
                  .catch(() => toast(t("commThread"), t("commActionFail")));
              },
            });
          }
        } else if (action === "edit") {
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
