import { VERSION, __WALLDEV_DEV__ } from "./constants";
import { errMsg } from "./helpers";
import { cfg } from "./config";
import { log } from "./log";
import { WallEvents } from "./events";
import { setThemeApplier } from "./notify";
import { applyTheme } from "./theme";
import { initLayers } from "./overlay";
import { buildUI } from "./ui-build";
import { startUpdateChecker } from "./update-check";
import { getActiveClient, api, setMe } from "./backend/index";
import { siteToken } from "./site-api";
import {
  syncProfile,
  refreshNotifications,
  startChatPolling,
  startNotifPolling,
  startAnnouncementPolling,
  loadAnnouncements,
  loadTemplates,
  loadPublicTemplates,
} from "./data";
import { errorDlg, confirmDlg, promptDlg, infoDlg } from "./dialog";
import { initEmotes } from "./emoji";
import { startSiteChatEmotes } from "./site-chat-emotes";
import { startSiteProfileInject } from "./site-profile-inject";
import "./profile-modal";
import { startMailPolling, loadNotifications, loadChatList } from "./mail";
import { startPaintWatch } from "./paint-state";
import { PAINT_REFILL_AWAY_THRESHOLD_MS } from "./constants";
import { playPaintRefillSound } from "./paint-sound";
import { startSignalsCache } from "./signals-cache";
import { maybeAutoloadFromUrl } from "./url-autoload";
import { restoreLastOverlay } from "./overlay-persist";
import { startInboxWatcher } from "./inbox-watcher";
import { installDevTools } from "./dev-tools";

/** Random body for the refill toast. The translator owns the phrases — we
 *  just pick a key in 1..N. Extend the range if more phrases are added. */
function pickRefillPhraseKey(): string {
  const n = 8;
  const i = 1 + Math.floor(Math.random() * n);
  return `paintPhrase${i}`;
}
import { notify } from "./notify";
import { t, pluralize } from "./i18n";

(function () {
  "use strict";
  if ((window as any).__WALL_DEV_LOADED__) return;
  (window as any).__WALL_DEV_LOADED__ = true;

  log("BOOT", "OK", `The Wall Dev v${VERSION} — VAI_PROG`);

  // Replace native alert/confirm/prompt with Win95-styled dialogs.
  // These return Promises but the original APIs are sync. We monkeypatch with
  // best-effort sync semantics: alert/confirm/prompt now show our dialog and
  // return undefined/false/null synchronously — callers that await still work,
  // and "fire-and-forget" alerts simply show the dialog asynchronously.
  const w: any = window;
  w.__nativeAlert = w.alert;
  w.__nativeConfirm = w.confirm;
  w.__nativePrompt = w.prompt;
  w.alert = (msg: any) => {
    errorDlg(String(msg));
  };
  w.confirm = (msg: any) => {
    return confirmDlg(String(msg)) as any;
  };
  w.prompt = (msg: any, def?: any) => {
    return promptDlg(String(msg), def ? String(def) : "") as any;
  };

  setThemeApplier(applyTheme);

  function init(): void {
    initLayers();
    buildUI();
    if (cfg.interceptEvents) WallEvents.startDom();
    if (cfg.wsTap) WallEvents.startWsTap();
    startUpdateChecker();
    initEmotes().then(() => startSiteChatEmotes());
    startSiteProfileInject();
    startPaintWatch();
    startSignalsCache();
    // Load priority once the overlay layer is mounted (setOverlaySrc /
    // setOverlayPos must be live first):
    //   1. ?the_wall_dev=…  share link / export
    //   2. ?charity=<url>   Charity config URL
    //   3. the last overlay remembered from a previous session
    // maybeAutoloadFromUrl handles 1 & 2 and reports whether it loaded
    // anything; only then do we skip the remembered overlay.
    setTimeout(async () => {
      const loaded = await maybeAutoloadFromUrl().catch(() => false);
      if (!loaded) await restoreLastOverlay().catch(() => {});
    }, 500);
    document.addEventListener("wd:paint-refilled", (ev: any) => {
      // The CustomEvent detail carries a fully-derived PaintRefillDetail
      // (px + totalCans + extraCans + partial + awayMs). Read totalCans
      // directly — local Math.round(px / PAINT_PER_CAN) was the same bug
      // class that made the sell dialog show "10 cans" for 9 cans worth
      // of paint (off-by-one when partial is < 50px).
      const totalCans: number = ev?.detail?.totalCans ?? 0;
      const awayMs: number = ev?.detail?.awayMs || 0;
      const cans = Math.max(1, totalCans);
      const cansLabel = pluralize(cans, "paintCan");
      if (cfg.notifyOnPaintRefill) {
        // "Were you away long enough that this is news?" — if so, use the
        // dedicated welcome-back title; otherwise pick a random phrase from
        // the pool so the toast doesn't read identically every time.
        if (awayMs >= PAINT_REFILL_AWAY_THRESHOLD_MS) {
          notify(
            t("paintRefilledAwayTitle"),
            t("paintRefilledAwayBody", { cans, cansLabel }),
          );
        } else {
          notify(
            t("paintRefilledTitle"),
            t(pickRefillPhraseKey(), { cans, cansLabel }),
          );
        }
      }
      // The toast and the chime are independent toggles — some users want
      // only the sound, others only the visual cue.
      playPaintRefillSound();
    });
    document.addEventListener("wd:paint-empty", (ev: any) => {
      if (cfg.notifyOnPaintRefill) {
        notify(t("paintEmptyTitle"), t("paintEmptyBody"));
      }
      // Remote refill reminder: the paint bar knows when the refill lands —
      // file it with the backend so the linked Telegram/Discord gets a DM
      // even with the browser closed. Replaces any pending reminder.
      const client = getActiveClient();
      if (cfg.paintReminderRemote && client?.on) {
        const nextRefill: number = ev?.detail?.nextRefill || 0;
        const dueInSecs =
          nextRefill > Date.now()
            ? Math.ceil((nextRefill - Date.now()) / 1000)
            : 60 * 60; // refill time unknown — fall back to the 1h cycle
        api(client).mailbox.setPaintReminder(dueInSecs)
          .then(() =>
            log("PAINT", "OK", `refill reminder filed (+${dueInSecs}s)`),
          )
          .catch((e: any) =>
            log("PAINT", "WARN", "reminder failed: " + errMsg(e)),
          );
      }
    });
    autoAttachBackend();

    if (__WALLDEV_DEV__) installDevTools();

    log("INIT", "OK", "all systems nominal");
  }

  async function autoAttachBackend(): Promise<void> {
    if (!cfg.backendUrl) return;
    if (!siteToken()) {
      log(
        "AUTO_AUTH",
        "WARN",
        "no site token — login on filianislost.com first",
      );
      return;
    }
    const client = getActiveClient();
    if (!client) return;
    const a = api(client);
    try {
      // Try to use existing token; if it fails (401), re-login.
      if (cfg.backendToken) {
        try {
          const me = await a.auth.me();
          setMe(me);
          log("AUTO_AUTH", "OK", "session restored");
        } catch {
          log("AUTO_AUTH", "WARN", "stored token rejected, re-logging in");
          cfg.backendToken = "";
          await a.auth.loginWithSiteToken("filianislost", siteToken() || "");
          setMe(await a.auth.me());
        }
      } else {
        await a.auth.loginWithSiteToken("filianislost", siteToken() || "");
        setMe(await a.auth.me());
        log("AUTO_AUTH", "OK", "first-time login");
      }
      // Refresh UI state
      syncProfile();
      loadAnnouncements();
      loadTemplates();
      loadPublicTemplates();
      loadNotifications();
      loadChatList();
      refreshNotifications();
      startChatPolling();
      startNotifPolling();
      startMailPolling();
      // The unified inbox watcher (kind-aware: alerts → popup, news → toast)
      // supersedes the legacy announcement poller. Kept the latter wired up
      // so any in-flight code path still gets a baseline ingest, but the
      // real surfacing happens in `startInboxWatcher()` below.
      startAnnouncementPolling();
      startInboxWatcher();
    } catch (e: any) {
      log("AUTO_AUTH", "ERR", e.toString());
    }
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    setTimeout(init, 300);
  } else {
    document.addEventListener("DOMContentLoaded", () => setTimeout(init, 300));
  }
})();
