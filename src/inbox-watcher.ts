/**
 * Background mailbox watcher.
 *
 * The Mail tab polls the unified `/v2/mailbox` endpoint every 30 seconds —
 * but only when the Mail pane is visible. That means a critical alert
 * landing while the user is on the Overlay tab gets noticed only when they
 * eventually navigate to Mail.
 *
 * This module runs an independent low-frequency poll that:
 *
 *   1. Hits `/v2/mailbox?unread=true` so we never waste bytes on items
 *      we've already surfaced.
 *   2. Diffs the returned id list against an in-memory `seenIds` set so
 *      the same item never fires twice in a single session.
 *   3. On the FIRST poll after boot, we silently absorb everything into
 *      `seenIds` without firing. This is the same "no replay on cold
 *      start" pattern `loadAnnouncements()` uses; without it, every
 *      reload would re-pop every previously-seen item.
 *   4. For each NEW item, dispatches to a surfacing path based on `kind`:
 *
 *        kind = "alert" / "clan_alert" / "mod_alert"  → critical popup + toast + OS notif
 *        kind = "announcement" / others               → toast + OS notif only
 *        kind = "dm" / "modmail"                      → toast + OS notif (no popup)
 *
 *      `alert` is global (admin broadcast). `clan_alert` is clan-scoped.
 *      `mod_alert` targets mods of a clan. All three are popup-worthy from
 *      the user's perspective. Plain `announcement` is news — toast only.
 *
 *      The "critical" path uses `infoDlg` for the popup — a modal that
 *      *requires* dismissal so a high-stakes admin alert can't sit
 *      invisible behind another tab.
 *
 *   5. Skips polling entirely while the page is hidden (visibility API)
 *      to avoid hammering the backend when no one's looking. The first
 *      visible tick after a hidden period does fire so the user catches
 *      up on items that landed while they were away.
 *
 * The seenIds set is intentionally NOT persisted to localStorage: every
 * new session shows EVERY currently-unread item once. That matches user
 * expectations ("I just opened, show me what's new") and avoids the
 * complexity of stale persistence buckets.
 *
 * Public API:
 *   startInboxWatcher()
 *   stopInboxWatcher()
 */
import { Backend } from "./backend";
import { log } from "./log";
import { notify, toast } from "./notify";
import { infoDlg } from "./dialog";
import { mdToHtml, errMsg } from "./helpers";
import { ANNOUNCEMENT_POLL_MS } from "./constants";

const seenIds = new Set<string>();
let pollTimer: number | null = null;
let firstPoll = true;

/** Strip HTML to plain text for the OS notification body — Notification
 *  API doesn't render markup and would otherwise leak raw tags. */
function plainTextOf(raw: string): string {
  // mdToHtml already escapes, so we can safely strip tags.
  const html = mdToHtml(raw);
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return (tmp.textContent || "").trim();
}

function isAlertKind(kind: string): boolean {
  // Any kind that demands immediate user attention via a modal popup.
  // Global admin `alert`, clan-scoped `clan_alert`, and mod-scoped
  // `mod_alert` all qualify. Plain `announcement` does NOT — it's the
  // news channel that surfaces only via toast + OS notification.
  return kind === "alert" || kind === "clan_alert" || kind === "mod_alert";
}

function surfaceItem(item: any): void {
  const kind = String(item.kind || "");
  const title = String(item.title || "Inbox");
  const bodyPlain = plainTextOf(String(item.body || ""));
  const sender = item.sender_username ? ` from @${item.sender_username}` : "";
  // OS notification + toast for every kind — these are the lightweight
  // surfaces. Critical kinds ALSO get a modal popup right after.
  notify(title, bodyPlain);
  toast(title, bodyPlain.slice(0, 140) + sender);
  if (isAlertKind(kind)) {
    // Don't block the surfacing loop on the dialog — fire-and-forget so
    // a slow click-through doesn't delay subsequent items.
    infoDlg(bodyPlain || title, `⚠ ${title}`).catch(() => {});
  }
  log.ok(
    "INBOX_WATCH",
    `surfaced kind=${kind} id=${item.id}${isAlertKind(kind) ? " (POPUP)" : ""}`,
  );
}

async function tick(): Promise<void> {
  if (!Backend.on) return;
  if (document.hidden) {
    log.trace("INBOX_WATCH", "skipped — tab hidden");
    return;
  }
  try {
    const list = (await Backend.req(
      "GET",
      "/v2/mailbox?unread=true&limit=50",
    )) as any[];
    if (!Array.isArray(list)) return;
    if (firstPoll) {
      for (const it of list) if (it?.id) seenIds.add(String(it.id));
      firstPoll = false;
      log.info("INBOX_WATCH", `baseline: ${list.length} unread item(s)`);
      return;
    }
    const newItems: any[] = [];
    for (const it of list) {
      if (!it?.id) continue;
      const id = String(it.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      newItems.push(it);
    }
    if (newItems.length === 0) return;
    log.info("INBOX_WATCH", `surfacing ${newItems.length} new item(s)`);
    // Surface in chronological order — server returns DESC by created_at,
    // so we walk the array backwards.
    for (let i = newItems.length - 1; i >= 0; i--) {
      surfaceItem(newItems[i]);
    }
  } catch (e: any) {
    log.warn("INBOX_WATCH", `poll failed: ${errMsg(e)}`);
  }
}

/** Begin the background watcher. Idempotent. */
export function startInboxWatcher(): void {
  if (pollTimer !== null) return;
  log.info("INBOX_WATCH", `start — every ${ANNOUNCEMENT_POLL_MS / 1000}s`);
  // First tick after a short delay so the page can finish booting before
  // we add load. Subsequent ticks follow the shared cadence.
  setTimeout(() => tick(), 5_000);
  pollTimer = window.setInterval(() => tick(), ANNOUNCEMENT_POLL_MS);
  // The hidden-tab guard above stops the timer from firing useful work,
  // but the first visibilitychange after becoming visible is a great
  // moment to catch up immediately rather than waiting for the next tick.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
}

export function stopInboxWatcher(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  log.info("INBOX_WATCH", "stopped");
}
