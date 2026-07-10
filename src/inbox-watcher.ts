/**
 * Background notification watcher.
 *
 * The Notifications tab polls `/api/v3/notifications` every 30 seconds —
 * but only when the Notifications pane is visible. That means a critical
 * alert landing while the user is on the Overlay tab gets noticed only when
 * they eventually navigate to Notifications.
 *
 * This module runs an independent low-frequency poll that:
 *
 *   1. Hits `/api/v3/notifications?read=false` so we never waste bytes on
 *      items we've already surfaced.
 *   2. Diffs the returned id list against an in-memory `seenIds` set so
 *      the same item never fires twice in a single session.
 *   3. On the FIRST poll after boot, we silently absorb everything into
 *      `seenIds` without firing. This is the same "no replay on cold
 *      start" pattern `loadAnnouncements()` uses.
 *   4. For each NEW item, dispatches to a surfacing path based on type:
 *
 *        type = "system_announcement" / "news_announcement"  → toast + OS notif
 *        type = "restriction_update" / "mod_action"          → toast + OS notif
 *        type = "mention"                                    → toast + OS notif
 *        type = "template_status_change"                     → toast + OS notif
 *        type = "clan_invite"                                → toast + OS notif
 *
 *      The V3 notification model does not have a separate "critical popup"
 *      type; if one is added in the future, surface it with `infoDlg` here.
 *
 *   5. Skips polling entirely while the page is hidden (visibility API)
 *      to avoid hammering the backend when no one's looking. The first
 *      visible tick after a hidden period does fire so the user catches
 *      up on items that landed while they were away.
 *
 * The seenIds set is intentionally NOT persisted to localStorage.
 */
import { log } from "./log";
import { notify, toast } from "./notify";
import { mdToHtml, errMsg } from "./helpers";
import { ANNOUNCEMENT_POLL_MS } from "./constants";
import { getActiveClient, api } from "./backend/index";
import type { NotificationView } from "./backend/notifications";

const seenIds = new Set<string>();
let pollTimer: number | null = null;
let firstPoll = true;

/** Strip HTML to plain text for the OS notification body. */
function plainTextOf(raw: string): string {
  const html = mdToHtml(raw);
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || "").trim();
}

function surfaceItem(item: NotificationView): void {
  const title = item.title || "Notification";
  const bodyPlain = plainTextOf(item.body || "");
  notify(title, bodyPlain);
  toast(title, bodyPlain.slice(0, 140));
  log.ok(
    "NOTIF_WATCH",
    `surfaced type=${item.type} id=${item.id}`,
  );
}

async function tick(): Promise<void> {
  const client = getActiveClient();
  if (!client?.on) return;
  if (document.hidden) {
    log.trace("NOTIF_WATCH", "skipped — tab hidden");
    return;
  }
  try {
    const page = await api(client).notifications.list({ read: false, perPage: 50 });
    const list = page.items || [];
    if (firstPoll) {
      for (const it of list) if (it?.id) seenIds.add(String(it.id));
      firstPoll = false;
      log.info("NOTIF_WATCH", `baseline: ${list.length} unread item(s)`);
      return;
    }
    const newItems: NotificationView[] = [];
    for (const it of list) {
      if (!it?.id) continue;
      const id = String(it.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newItems.push(it);
    }
    if (newItems.length === 0) return;
    log.info("NOTIF_WATCH", `surfacing ${newItems.length} new item(s)`);
    // Surface in chronological order — server returns DESC by createdAt.
    for (let i = newItems.length - 1; i >= 0; i--) {
      surfaceItem(newItems[i]);
    }
  } catch (e: any) {
    log.warn("NOTIF_WATCH", `poll failed: ${errMsg(e)}`);
  }
}

/** Begin the background watcher. Idempotent. */
export function startInboxWatcher(): void {
  if (pollTimer !== null) return;
  log.info("NOTIF_WATCH", `start — every ${ANNOUNCEMENT_POLL_MS / 1000}s`);
  setTimeout(() => tick(), 5_000);
  pollTimer = window.setInterval(() => tick(), ANNOUNCEMENT_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
}

export function stopInboxWatcher(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  log.info("NOTIF_WATCH", "stopped");
}
