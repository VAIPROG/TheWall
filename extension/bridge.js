/* Isolated-world bridge: relays OS-notification requests from the MAIN-world
 * core (which cannot touch chrome.*) to the background service worker.
 * Under a userscript this file is absent and the core falls back to the
 * page Notification API automatically. */
window.addEventListener(
  "message",
  (e) => {
    const d = e.data;
    if (!d || d.source !== "wall-core" || d.type !== "os-notify") return;
    try {
      chrome.runtime.sendMessage({
        type: "os-notify",
        title: d.title || "The Wall Dev",
        body: d.body || "",
      });
    } catch (_) {
      /* extension context gone */
    }
  },
  false,
);
