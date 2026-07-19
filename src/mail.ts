/**
 * Mail — the V3 notifications inbox (Profile super-tab › Mail sub-section).
 *
 * A focused read surface over /api/v3/notifications: the list with client-side
 * type filters, unread badge, per-item ack/dismiss, mark-all-read, and an
 * "Open" deep-link for notifications that reference a template. All the pure
 * mapping (filters, badge labels/colours, actionUrl parsing) lives in
 * mail-model.ts so it stays unit-testable.
 *
 * DMs and chat threads are owned by the Community super-tab (src/ui/community)
 * — the DM composer and standalone chat list that used to live here were
 * removed with it, together with their `#dm-*` / `#chat-*` wiring.
 */
import { $, esc, mdToHtml, errMsg } from "./helpers";
import { ic } from "./icons";
import { toast } from "./notify";
import { log } from "./log";
import { replaceEmotes } from "./emoji";
import { renderMentions } from "./mentions";
import { errorDlg, confirmDlg } from "./dialog";
import { t } from "./i18n";
import { getActiveClient, api } from "./backend/index";
import type { NotificationView } from "./backend/notifications";
import {
  type MailFilter,
  applyFilter,
  unreadCount,
  typeColor,
  typeLabel,
  timeAgo,
  openTarget,
} from "./mail-model";
import { openDetail } from "./ui/templates/shell";

// Active filter tab + the last fetched page. Filter switches re-render from
// this cache (no refetch); Refresh / ack / dismiss re-pull the list.
let mailFilter: MailFilter = "all";
let lastItems: NotificationView[] = [];

function notificationHtml(n: NotificationView): string {
  const ts = timeAgo(n.createdAt);
  const unread = !n.isRead;
  const style = unread
    ? "border-left:3px solid var(--accent);background:rgba(40,137,255,.10);"
    : "opacity:.85;";
  const body = renderMentions(replaceEmotes(mdToHtml(n.body || "")));
  const target = openTarget(n.actionUrl);
  return `<div class="wp-li mail-item" data-id="${esc(n.id)}" data-type="${esc(n.type)}" data-unread="${unread ? "1" : "0"}" style="${style}align-items:flex-start">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:4px">
        <span style="font-size:9px;font-weight:bold;color:#fff;background:${typeColor(n.type)};padding:0 5px;border-radius:2px">${esc(typeLabel(n.type))}</span>
        <b>${esc(n.title)}</b>
        <span style="margin-left:auto;color:var(--sub);font-size:10px">${ts}</span>
      </div>
      <div class="bd" style="margin-top:3px;line-height:1.4;word-wrap:break-word">${body}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:3px;align-items:stretch">
      ${target ? `<button class="wp-btn" data-open="${esc(n.id)}" style="padding:2px 6px;margin:0" title="Open">↗</button>` : ""}
      ${unread ? `<button class="wp-btn" data-read="${esc(n.id)}" style="padding:2px 6px;margin:0" title="Mark as read">✓</button>` : ""}
      <button class="wp-btn" data-dismiss="${esc(n.id)}" style="padding:2px 6px;margin:0" title="Dismiss">${ic("trash", 10)}</button>
    </div>
  </div>`;
}

function refreshUnreadBadge(count: number): void {
  const el = $("mail-unread-count");
  if (!el) return;
  el.textContent = count > 0 ? `· ${t("mailUnreadBadge", { n: count })}` : "";
}

/** Navigate to whatever the notification references (template detail today).
 *  Acks the row first so the deep-link also clears the unread state. */
function openNotification(n: NotificationView): void {
  const target = openTarget(n.actionUrl);
  if (!target) return;
  const client = getActiveClient();
  if (client?.on && !n.isRead) {
    api(client).notifications.ack([n.id]).then(() => loadNotifications()).catch(() => {});
  }
  // Flip to the Templates super-tab (its click handler activates the pane and
  // kicks the list loads) and drill into the referenced template.
  document.querySelector<HTMLElement>('.wp-tab[data-p="tp"]')?.click();
  openDetail(target.id);
}

/** Paint the cached page through the active filter and wire per-item buttons. */
function renderMailList(): void {
  const box = $("mail-list");
  if (!box) return;
  const client = getActiveClient();
  refreshUnreadBadge(unreadCount(lastItems));
  const list = applyFilter(lastItems, mailFilter);
  if (!list.length) {
    box.innerHTML = `<div style="padding:6px;color:var(--sub)">— no notifications —</div>`;
    return;
  }
  box.innerHTML = list.map(notificationHtml).join("");
  box.querySelectorAll("[data-read]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = (b as HTMLElement).dataset.read || "";
      if (!id || !client?.on) return;
      try { await api(client).notifications.ack([id]); loadNotifications(); }
      catch (e: any) { toast("Notifications", "ack fail: " + errMsg(e)); }
    }),
  );
  box.querySelectorAll("[data-dismiss]").forEach((b) =>
    b.addEventListener("click", async () => {
      const id = (b as HTMLElement).dataset.dismiss || "";
      if (!id || !client?.on) return;
      try { await api(client).notifications.dismiss(id); loadNotifications(); }
      catch (e: any) { toast("Notifications", "dismiss fail: " + errMsg(e)); }
    }),
  );
  box.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => {
      const id = (b as HTMLElement).dataset.open || "";
      const n = lastItems.find((x) => x.id === id);
      if (n) openNotification(n);
    }),
  );
}

export async function loadNotifications(): Promise<void> {
  const box = $("mail-list");
  const client = getActiveClient();
  if (!box || !client?.on) {
    log("NOTIF", "INFO", `loadNotifications skipped — box=${!!box} backend=${client?.on ?? false}`);
    return;
  }
  if (!lastItems.length) box.innerHTML = `<div style="padding:6px;color:var(--sub)">Loading…</div>`;
  try {
    const page = await api(client).notifications.list({ perPage: 100 });
    lastItems = page.items || [];
    log("NOTIF", "OK", `${lastItems.length} items`);
    renderMailList();
  } catch (e: any) {
    box.innerHTML = `<div style="padding:6px;color:#b33">notifications error: ${esc(errMsg(e))}</div>`;
    log("NOTIF", "ERR", errMsg(e));
  }
}

export function wireMailUI(): void {
  $("btn-mail-refresh")?.addEventListener("click", loadNotifications);

  // Filter tabbar — client-side over the cached page (see mail-model.ts).
  $("mail-filters")
    ?.querySelectorAll<HTMLElement>("[data-mail-filter]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        mailFilter = (btn.dataset.mailFilter || "all") as MailFilter;
        $("mail-filters")
          ?.querySelectorAll<HTMLElement>("[data-mail-filter]")
          .forEach((x) => x.classList.toggle("active", x === btn));
        renderMailList();
      });
    });

  $("btn-mail-markread")?.addEventListener("click", async () => {
    const client = getActiveClient();
    if (!client?.on) return;
    // Count over the WHOLE cached page, not the DOM — a narrowed filter tab
    // must not make mark-all under-report what it is about to touch.
    const unread = unreadCount(lastItems);
    if (unread === 0) {
      toast("Notifications", "Nothing unread.");
      return;
    }
    if (unread > 10) {
      const ok = await confirmDlg(
        `Mark all ${unread} notifications as read?`,
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
}

let mailTimer: number | null = null;
export function startMailPolling(): void {
  if (mailTimer != null) return;
  mailTimer = window.setInterval(() => {
    // Mail lives inside the Profile super-tab — only poll when the Profile
    // pane is active AND its Mail sub-section is the visible one.
    if (document.querySelector('.wp-pane[data-p="pr"].active #profile-sub-mail.is-on'))
      loadNotifications();
  }, 30_000);
}
