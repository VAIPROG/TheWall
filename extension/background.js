/**
 * The Wall Dev — MV3 service worker (Chrome) / event script (Firefox).
 *
 * Responsibilities:
 *   1. Receive `os-notify` messages from the page bridge and surface them as
 *      OS notifications with an icon + click-to-open behaviour.
 *   2. Handle clicks on the toolbar action — open or focus the filianislost
 *      tab so the user can jump straight back to the canvas.
 *   3. Track per-notification metadata (URL) so the click handler can route
 *      the user to the right tab even after the worker has been put to
 *      sleep and re-spawned.
 *   4. Log lifecycle transitions (install / update / startup) at INFO so the
 *      browser's service-worker console gives a clear timeline when
 *      debugging.
 *
 * Cross-browser:
 *   We resolve `chrome` or `browser` once and use that. Firefox's
 *   `browser.*` returns Promises; Chrome's `chrome.*` uses callbacks. We
 *   wrap the few APIs we care about in promiseified helpers so the rest of
 *   the file is a single async-friendly code path.
 *
 * Notifications API quirks worth remembering:
 *   - Chrome's `notifications.create` requires "notifications" permission
 *     in MV3 (we declare it).
 *   - Firefox supports the same API but doesn't fire `onClicked` for
 *     `basic` notifications when the user clicks the body in some versions;
 *     we therefore also listen on `onButtonClicked` and fall back to the
 *     close path on unknown ids.
 *   - On both platforms, notification IDs must be unique-per-creation. We
 *     prefix with a monotonic counter so rapid refill chimes don't collapse
 *     onto each other.
 *
 * No user data is collected here. The bridge never sends anything beyond
 * `{ type, title, body, url }`.
 */

const api = typeof browser !== "undefined" ? browser : chrome;
const SITE_URL = "https://filianislost.com/";

let notifSeq = 0;
const notifMeta = new Map(); // id → { url }

function log(level, msg, extra) {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const prefix = `[WallDev/bg ${ts}]`;
  if (level === "warn") console.warn(prefix, msg, extra ?? "");
  else if (level === "err") console.error(prefix, msg, extra ?? "");
  else console.log(prefix, msg, extra ?? "");
}

/** Promise wrapper for either Promise-based (Firefox) or callback-based
 *  (Chrome) extension APIs. We feature-detect by checking the return
 *  type — Firefox returns a Promise immediately. */
function call(ns, method, ...args) {
  try {
    const result = ns[method](...args);
    if (result && typeof result.then === "function") return result;
  } catch (_) {
    /* fall through to callback shape */
  }
  return new Promise((resolve, reject) => {
    try {
      ns[method](...args, (out) => {
        const err = api.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(out);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/* ---------------------------------------------------------------------------
 * Notifications
 * ------------------------------------------------------------------------ */

async function createNotification(msg) {
  const id = `wd-${Date.now()}-${++notifSeq}`;
  const opts = {
    type: "basic",
    iconUrl: api.runtime.getURL("icons/128.png"),
    title: msg.title || "The Wall Dev",
    message: msg.body || "",
  };
  // Chrome supports `requireInteraction` to keep the toast around until the
  // user dismisses it. Firefox ignores the field gracefully. Default off —
  // we don't want to spam the notification center.
  if (msg.requireInteraction) opts.requireInteraction = true;
  try {
    await call(api.notifications, "create", id, opts);
    notifMeta.set(id, { url: msg.url || SITE_URL });
    log("info", `notif "${opts.title}" (id=${id})`);
  } catch (e) {
    log("warn", `notif create failed: ${e.message || e}`);
  }
}

/** Open or focus the configured URL in a tab. */
async function openOrFocus(url) {
  try {
    const tabs = await call(api.tabs, "query", { url: `${SITE_URL}*` });
    if (tabs && tabs.length) {
      const tab = tabs[0];
      await call(api.tabs, "update", tab.id, { active: true });
      if (tab.windowId !== undefined) {
        await call(api.windows, "update", tab.windowId, { focused: true });
      }
      return;
    }
    await call(api.tabs, "create", { url });
  } catch (e) {
    log("warn", `openOrFocus failed: ${e.message || e}`);
  }
}

api.notifications.onClicked.addListener((id) => {
  const meta = notifMeta.get(id);
  notifMeta.delete(id);
  openOrFocus(meta?.url || SITE_URL);
  // Cleanly close the toast — some platforms leave it pinned otherwise.
  try { api.notifications.clear(id); } catch (_) {}
});

// Firefox: some versions don't fire onClicked for body clicks on basic
// notifications. Listen on close + button so we at least free our map.
api.notifications.onClosed.addListener((id) => {
  notifMeta.delete(id);
});

/* ---------------------------------------------------------------------------
 * Messaging — from bridge.js (isolated content script)
 * ------------------------------------------------------------------------ */

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "os-notify") {
    createNotification(msg);
    sendResponse?.({ ok: true });
    return true;
  }
  if (msg.type === "open-site") {
    openOrFocus(msg.url || SITE_URL);
    sendResponse?.({ ok: true });
    return true;
  }
});

/* ---------------------------------------------------------------------------
 * Toolbar action — clicking the icon focuses the wall tab.
 * ------------------------------------------------------------------------ */

if (api.action?.onClicked) {
  api.action.onClicked.addListener(() => openOrFocus(SITE_URL));
} else if (api.browserAction?.onClicked) {
  // MV2 / older Firefox fallback.
  api.browserAction.onClicked.addListener(() => openOrFocus(SITE_URL));
}

/* ---------------------------------------------------------------------------
 * Lifecycle
 * ------------------------------------------------------------------------ */

api.runtime.onInstalled.addListener((details) => {
  log("info", `installed (reason=${details.reason})`);
  if (details.reason === "update") {
    const prev = details.previousVersion || "?";
    const next = api.runtime.getManifest().version;
    log("info", `updated ${prev} → ${next}`);
  }
});

if (api.runtime.onStartup) {
  api.runtime.onStartup.addListener(() => log("info", "browser startup"));
}

log("info", `bg loaded (v${api.runtime.getManifest().version})`);
