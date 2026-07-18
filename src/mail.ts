/**
 * Notifications + chat inbox tab.
 *
 * Replaces the legacy `/v2/mailbox` UI with V3 primitives:
 *   - notifications list for system/news/alert items
 *   - V3 chats for clan chat and DMs
 */
import { $, esc, mdToHtml, errMsg } from "./helpers";
import { ic } from "./icons";
import { toast } from "./notify";
import { log } from "./log";
import { replaceEmotes } from "./emoji";
import { renderMentions } from "./mentions";
import { promptDlg, errorDlg, confirmDlg } from "./dialog";
import { t } from "./i18n";
import { getActiveClient, api } from "./backend/index";
import type { NotificationView } from "./backend/notifications";
import type { MessageView, ChatSummary } from "./backend/chats";

let activeChatId = "";

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h";
  return Math.floor(diff / 86400_000) + "d";
}

function notificationHtml(n: NotificationView): string {
  const ts = timeAgo(n.createdAt);
  const unread = !n.isRead;
  const style = unread
    ? "border-left:3px solid var(--accent);background:rgba(40,137,255,.10);"
    : "opacity:.85;";
  const body = renderMentions(replaceEmotes(mdToHtml(n.body || "")));
  return `<div class="wp-li mail-item" data-id="${esc(n.id)}" data-type="${esc(n.type)}" data-unread="${unread ? "1" : "0"}" style="${style}align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:4px">
        <span style="font-size:9px;font-weight:bold;color:#fff;background:${typeColor(n.type)};padding:0 5px;border-radius:2px">${typeLabel(n.type)}</span>
        <b>${esc(n.title)}</b>
        <span style="margin-left:auto;color:var(--sub);font-size:10px">${ts}</span>
      </div>
      <div class="bd" style="margin-top:3px;line-height:1.4;word-wrap:break-word">${body}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:3px;align-items:stretch">
      ${unread ? `<button class="wp-btn" data-read="${esc(n.id)}" style="padding:2px 6px;margin:0" title="Mark as read">✓</button>` : ""}
      <button class="wp-btn" data-dismiss="${esc(n.id)}" style="padding:2px 6px;margin:0" title="Dismiss">${ic("trash", 10)}</button>
    </div>
  </div>`;
}

function typeColor(type: string): string {
  switch (type) {
    case "system_announcement": return "#08a";
    case "news_announcement": return "#48a";
    case "clan_invite": return "#c93";
    case "restriction_update": return "#c33";
    case "mod_action": return "#a3a";
    case "mention": return "#393";
    case "template_status_change": return "#393";
    default: return "var(--sub)";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "system_announcement": return "SYS";
    case "news_announcement": return "NEWS";
    case "clan_invite": return "CLAN";
    case "restriction_update": return "BAN";
    case "mod_action": return "MOD";
    case "mention": return "@";
    case "template_status_change": return "TPL";
    default: return type.split("_").map((s) => s[0]).join("").toUpperCase();
  }
}

function messageHtml(m: MessageView): string {
  const ts = timeAgo(m.createdAt);
  const author = esc(m.authorUsername || "system");
  const body = m.isDeleted
    ? `<i style="color:var(--sub)">deleted</i>`
    : renderMentions(replaceEmotes(mdToHtml(m.content)));
  return `<div class="m" data-msg="${esc(m.id)}">
    <div class="bd">
      <span class="au" data-user="${author}">${author}</span>
      ${ts ? ` <span class="ts" title="${esc(m.createdAt)}">${ts}</span>` : ""}
      ${body}
    </div>
  </div>`;
}

function refreshUnreadBadge(count: number): void {
  const el = $("mail-unread-count");
  if (!el) return;
  el.textContent = count > 0 ? `· ${t("mailUnreadBadge", { n: count })}` : "";
}

export async function loadNotifications(): Promise<void> {
  const box = $("mail-list");
  const client = getActiveClient();
  if (!box || !client?.on) {
    log("NOTIF", "INFO", `loadNotifications skipped — box=${!!box} backend=${client?.on ?? false}`);
    return;
  }
  box.innerHTML = `<div style="padding:6px;color:var(--sub)">Loading…</div>`;
  try {
    const page = await api(client).notifications.list({ perPage: 100 });
    const list = page.items || [];
    log("NOTIF", "OK", `${list.length} items`);
    if (!list.length) {
      box.innerHTML = `<div style="padding:6px;color:var(--sub)">— no notifications —</div>`;
      refreshUnreadBadge(0);
      return;
    }
    box.innerHTML = list.map(notificationHtml).join("");
    refreshUnreadBadge(list.filter((n) => !n.isRead).length);
    box.querySelectorAll("[data-read]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = (b as HTMLElement).dataset.read!;
        try { await api(client).notifications.ack([id]); loadNotifications(); }
        catch (e: any) { toast("Notifications", "ack fail: " + errMsg(e)); }
      }),
    );
    box.querySelectorAll("[data-dismiss]").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = (b as HTMLElement).dataset.dismiss!;
        try { await api(client).notifications.dismiss(id); loadNotifications(); }
        catch (e: any) { toast("Notifications", "dismiss fail: " + errMsg(e)); }
      }),
    );
  } catch (e: any) {
    box.innerHTML = `<div style="padding:6px;color:#b33">notifications error: ${esc(errMsg(e))}</div>`;
    log("NOTIF", "ERR", errMsg(e));
  }
}

export async function loadChatMessages(chatId: string): Promise<void> {
  activeChatId = chatId;
  const box = $("chat-messages");
  const client = getActiveClient();
  if (!box || !client?.on || !chatId) return;
  try {
    const msgs = await api(client).chats.messages(chatId, { limit: 50 });
    box.innerHTML = (msgs || []).map(messageHtml).join("") || `<div style="color:var(--sub)">— empty —</div>`;
    box.scrollTop = box.scrollHeight;
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33">chat error: ${esc(errMsg(e))}</div>`;
  }
}

export async function sendChatMessage(): Promise<void> {
  const ta = $("chat-input") as HTMLTextAreaElement | null;
  const text = ta?.value.trim();
  if (!text || !activeChatId) return;
  const client = getActiveClient();
  if (!client?.on) { await errorDlg("Connect to backend first"); return; }
  try {
    await api(client).chats.send(activeChatId, { content: text });
    if (ta) ta.value = "";
    await loadChatMessages(activeChatId);
  } catch (e: any) { await errorDlg("Send failed: " + errMsg(e)); }
}

export async function sendDm(): Promise<void> {
  const to = (($("dm-to") as HTMLInputElement)?.value || "").trim().replace(/^@/, "");
  const body = ($("dm-body") as HTMLTextAreaElement)?.value.trim();
  if (!to || !body) { await errorDlg("Both recipient and body are required"); return; }
  const client = getActiveClient();
  if (!client?.on) return;
  try {
    await api(client).chats.sendDm(to, { content: body });
    ($("dm-to") as HTMLInputElement).value = "";
    ($("dm-body") as HTMLTextAreaElement).value = "";
    toast("DM", `Sent to @${to}`);
  } catch (e: any) { await errorDlg("Send failed: " + errMsg(e)); }
}

export function wireMailUI(): void {
  $("btn-mail-refresh")?.addEventListener("click", loadNotifications);

  $("btn-mail-markread")?.addEventListener("click", async () => {
    const client = getActiveClient();
    if (!client?.on) return;
    const box = $("mail-list");
    const unreadCount = box
      ? box.querySelectorAll<HTMLElement>('.mail-item[data-unread="1"]').length
      : 0;
    if (unreadCount === 0) {
      toast("Notifications", "Nothing unread.");
      return;
    }
    if (unreadCount > 10) {
      const ok = await confirmDlg(
        `Mark all ${unreadCount} notifications as read?`,
        "Mark all as read",
      );
      if (!ok) return;
    }
    try {
      await api(client).notifications.ackAll();
      toast("Notifications", "Marked all as read.");
      loadNotifications();
    } catch (e: any) {
      errorDlg("Mark-all failed: " + errMsg(e));
    }
  });

  $("btn-dm-send")?.addEventListener("click", () => void sendDm());
  $("dm-body")?.addEventListener("keydown", (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) {
      k.preventDefault();
      void sendDm();
    }
  });

  $("chat-send")?.addEventListener("click", () => void sendChatMessage());
  $("chat-input")?.addEventListener("keydown", (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) {
      k.preventDefault();
      void sendChatMessage();
    }
  });
}

let mailTimer: number | null = null;
export function startMailPolling(): void {
  if (mailTimer != null) return;
  mailTimer = window.setInterval(() => {
    // Mail now lives inside the Profile super-tab — only poll when the Profile
    // pane is active AND its Mail sub-section is the visible one.
    if (document.querySelector('.wp-pane[data-p="pr"].active #profile-sub-mail.is-on'))
      loadNotifications();
  }, 30_000);
}

export async function loadChatList(): Promise<void> {
  const box = $("chat-list");
  const client = getActiveClient();
  if (!box || !client?.on) return;
  try {
    const chats = await api(client).chats.list();
    box.innerHTML = (chats || [])
      .map((c: ChatSummary) => {
        const unread = c.unreadCount > 0 ? ` <span class="sub">(${c.unreadCount})</span>` : "";
        return `<div class="wp-li chat-row${c.id === activeChatId ? " active" : ""}" data-chat="${esc(c.id)}" style="cursor:pointer">
          <span>${esc(c.topic || c.type)}${unread}</span>
          <span class="ts">${timeAgo(c.lastMessageAt)}</span>
        </div>`;
      })
      .join("") || `<div style="color:var(--sub)">— no chats —</div>`;
    box.querySelectorAll("[data-chat]").forEach((b) =>
      b.addEventListener("click", () => {
        const id = (b as HTMLElement).dataset.chat!;
        void loadChatMessages(id);
        void loadChatList();
      }),
    );
  } catch (e: any) {
    box.innerHTML = `<div style="color:#b33">chat list error: ${esc(errMsg(e))}</div>`;
  }
}
