/**
 * Mail tab — unified inbox over /api/v2/mailbox.
 *
 * Renders DMs, announcements, clan alerts, modmail, template events with
 * filtering, reply-in-thread, mark-as-read, and quick reply.
 */
import { Backend } from "./backend";
import { $, esc, mdToHtml, errMsg } from "./helpers";
import { ic } from "./icons";
import { toast } from "./notify";
import { log } from "./log";
import { replaceEmotes } from "./emoji";
import { renderMentions } from "./mentions";
import { promptDlg, errorDlg, infoDlg, confirmDlg } from "./dialog";
import { t } from "./i18n";

let activeKind = "";

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h";
  return Math.floor(diff / 86400_000) + "d";
}

function kindColor(kind: string): string {
  switch (kind) {
    case "dm": return "#08a";
    case "announcement": return "#08a";
    case "clan_alert": return "#c93";
    case "clan_announcement": return "#48a";
    case "mod_alert": return "#c33";
    case "modmail": return "#a3a";
    case "template_event": return "#393";
    default: return "var(--sub)";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "dm": return "DM";
    case "announcement": return "NEWS";
    case "clan_alert": return "ALERT";
    case "clan_announcement": return "CLAN";
    case "mod_alert": return "MOD";
    case "modmail": return "MODMAIL";
    case "template_event": return "TPL";
    default: return kind.toUpperCase();
  }
}

function itemHtml(it: any): string {
  const k = String(it.kind || "");
  const unread = !it.is_read;
  const ts = timeAgo(it.created_at);
  const title = it.title ? esc(it.title) : "";
  const body = renderMentions(replaceEmotes(mdToHtml(String(it.body || ""))));
  // DMs lead with sender prominently. Other kinds show the sender as small
  // metadata because the title / channel context matters more.
  const isPerson = k === "dm" || k === "modmail";
  const senderName = it.sender_username || "system";
  const senderHtml = it.sender_username
    ? `<span class="wp-mention" data-user="${esc(it.sender_username)}">@${esc(it.sender_username)}</span>`
    : `<span style="color:var(--sub)">system</span>`;
  const replyBtn = isPerson
    ? `<button class="wp-btn" data-reply="${esc(it.id)}" data-reply-to="${esc(senderName)}" style="padding:2px 6px;margin:0" title="Reply to ${esc(senderName)}">${ic("send", 10)}Reply</button>`
    : "";
  const readBtn = unread
    ? `<button class="wp-btn" data-read="${esc(it.id)}" style="padding:2px 6px;margin:0" title="Mark as read">✓</button>`
    : "";
  const unreadStyle = unread
    ? "border-left:3px solid var(--accent);background:rgba(40,137,255,.10);"
    : "opacity:.85;";
  // For DM-style items: header is "@sender  · time" with the kind tag on
  // the right. For announcements / alerts: header is "[KIND] Title · time".
  const header = isPerson
    ? `<div style="display:flex;align-items:center;gap:6px">
         <span style="font-size:11px;font-weight:bold;color:${kindColor(k)}">${senderHtml}</span>
         ${title ? `<span style="color:var(--sub)">·</span><b>${title}</b>` : ""}
         <span style="margin-left:auto;font-size:9px;font-weight:bold;color:#fff;background:${kindColor(k)};padding:0 5px;border-radius:2px">${kindLabel(k)}</span>
         <span style="color:var(--sub);font-size:10px;min-width:32px;text-align:right">${ts}</span>
       </div>`
    : `<div style="display:flex;align-items:center;gap:4px">
         <span style="font-size:9px;font-weight:bold;color:#fff;background:${kindColor(k)};padding:0 5px;border-radius:2px">${kindLabel(k)}</span>
         ${title ? `<b>${title}</b>` : ""}
         <span style="margin-left:auto;color:var(--sub);font-size:10px">${ts}</span>
       </div>
       <div style="margin:2px 0;color:var(--sub);font-size:10px">from ${senderHtml}</div>`;
  return `<div class="wp-li mail-item" data-id="${esc(it.id)}" data-kind="${esc(k)}" data-unread="${unread ? "1" : "0"}" style="${unreadStyle}align-items:flex-start">
    <div style="flex:1;min-width:0">
      ${header}
      <div class="bd" style="margin-top:3px;line-height:1.4;word-wrap:break-word">${body}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:3px;align-items:stretch">${readBtn}${replyBtn}</div>
  </div>`;
}

/** Update the unread count chip in the Inbox legend. */
function refreshUnreadBadge(list: any[]): void {
  const el = $("mail-unread-count");
  if (!el) return;
  const n = list.filter((it) => !it.is_read).length;
  el.textContent = n > 0 ? `· ${t("mailUnreadBadge", { n })}` : "";
}

export async function loadMail(): Promise<void> {
  const box = $("mail-list");
  if (!box || !Backend.on) {
    log("MAIL", "INFO", `loadMail skipped — box=${!!box} backend=${Backend.on}`);
    return;
  }
  box.innerHTML = `<div style="padding:6px;color:var(--sub)">Loading…</div>`;
  log("MAIL", "INFO", `loading kind="${activeKind || "all"}"`);
  try {
    const list = await Backend.listMailbox(activeKind || undefined);
    log("MAIL", "OK", `${list?.length || 0} items`);
    if (!list?.length) {
      box.innerHTML = `<div style="padding:6px;color:var(--sub)">— inbox empty —</div>`;
      return;
    }
    box.innerHTML = list.map(itemHtml).join("");
    refreshUnreadBadge(list);
    // Mark-read
    box.querySelectorAll("[data-read]").forEach((b) => {
      b.addEventListener("click", async () => {
        const id = (b as HTMLElement).dataset.read!;
        try { await Backend.req("POST", `/v2/mailbox/${id}/read`); loadMail(); }
        catch (e: any) { toast("Mail", "read fail: " + errMsg(e)); }
      });
    });
    // Reply — the dialog title now carries the recipient name so the
    // sender knows who they're replying to without scanning the inbox.
    box.querySelectorAll("[data-reply]").forEach((b) => {
      b.addEventListener("click", async () => {
        const el = b as HTMLElement;
        const id = el.dataset.reply!;
        const to = el.dataset.replyTo || "user";
        const text = await promptDlg(
          `Reply to @${to}:`,
          "",
          "Send reply",
        );
        if (text == null || !String(text).trim()) return;
        try {
          await Backend.req("POST", `/v2/mailbox/${id}/reply`, { body: String(text).trim() });
          toast("Mail", `reply to @${to} sent`);
          loadMail();
        } catch (e: any) { errorDlg("Reply failed: " + errMsg(e)); }
      });
    });
  } catch (e: any) {
    box.innerHTML = `<div style="padding:6px;color:#b33">mail error: ${esc(errMsg(e))}</div>`;
    log("MAIL", "ERR", errMsg(e));
  }
}

export function wireMailUI(): void {
  document.querySelectorAll("[data-mail-kind]").forEach((b) => {
    b.addEventListener("click", () => {
      activeKind = (b as HTMLElement).dataset.mailKind || "";
      document.querySelectorAll("[data-mail-kind]").forEach((x) => x.classList.toggle("active", x === b));
      loadMail();
    });
  });
  $("btn-mail-refresh")?.addEventListener("click", loadMail);

  /**
   * Mark every item in the current filter as read. The backend handles
   * direct + broadcast scopes — the response carries the row counts so we
   * can show a concise confirmation toast.
   *
   * We ask for an explicit confirm only when there's enough unread mail
   * to plausibly need a second look (more than 10). For small inboxes the
   * round-trip would be more friction than the action.
   */
  $("btn-mail-markread")?.addEventListener("click", async () => {
    const box = $("mail-list");
    const unreadCount = box
      ? box.querySelectorAll<HTMLElement>(".mail-item[data-unread=\"1\"]").length
      : 0;
    if (unreadCount === 0) {
      toast("Mail", "Nothing unread in this view.");
      return;
    }
    if (unreadCount > 10) {
      const ok = await confirmDlg(
        `Mark all ${unreadCount} unread items as read?`,
        "Mark all as read",
      );
      if (!ok) return;
    }
    try {
      const q = activeKind ? `?kind=${encodeURIComponent(activeKind)}` : "";
      const res = await Backend.req("POST", `/v2/mailbox/read-all${q}`);
      const direct = res?.direct_marked ?? 0;
      const broadcast = res?.broadcast_marked ?? 0;
      toast("Mail", `Marked ${direct + broadcast} item(s) as read.`);
      loadMail();
    } catch (e: any) {
      errorDlg("Mark-all failed: " + errMsg(e));
    }
  });

  $("btn-dm-send")?.addEventListener("click", async () => {
    const toRaw = ($("dm-to") as HTMLInputElement)?.value.trim().replace(/^@/, "");
    const body = ($("dm-body") as HTMLTextAreaElement)?.value.trim();
    if (!toRaw || !body) { await errorDlg("Both recipient and body are required"); return; }
    let toId = toRaw;
    if (!/^[0-9a-f-]{36}$/i.test(toRaw)) {
      try {
        const roster = await Backend.req("GET", "/clan/members") as any[];
        const found = (roster || []).find((m: any) => m.username?.toLowerCase() === toRaw.toLowerCase());
        if (!found) { await errorDlg(`Unknown user @${toRaw}`); return; }
        toId = found.id;
      } catch (e: any) { await errorDlg("Roster lookup: " + errMsg(e)); return; }
    }
    try {
      await Backend.req("POST", "/v2/mailbox/dm", { to: toId, body });
      ($("dm-to") as HTMLInputElement).value = "";
      ($("dm-body") as HTMLTextAreaElement).value = "";
      toast("DM", `Sent to @${toRaw}`);
      loadMail();
    } catch (e: any) { await errorDlg("Send failed: " + errMsg(e)); }
  });

  // Ctrl/⌘+Enter inside the DM body submits — matches the chat send
  // shortcut on filianislost and the clan-chat textarea.
  $("dm-body")?.addEventListener("keydown", (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) {
      k.preventDefault();
      ($("btn-dm-send") as HTMLButtonElement | null)?.click();
    }
  });
}

let mailTimer: number | null = null;
export function startMailPolling(): void {
  if (mailTimer != null) return;
  mailTimer = window.setInterval(() => {
    if (document.querySelector('.wp-pane[data-p="ma"].active')) loadMail();
  }, 30_000);
}
