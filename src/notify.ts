import { $ } from "./helpers";
import { esc } from "./helpers";
import { cfg } from "./config";

let _applyTheme: (() => void) | null = null;
export function setThemeApplier(fn: () => void): void {
  _applyTheme = fn;
}

/** Apply the configured 3×3 anchor + size classes to the toast host. Safe to
 *  call live from Settings; the host is created on first toast. */
export function applyToastPlacement(): void {
  const host = $("walldev-toasts") as HTMLElement | null;
  if (!host) return;
  const dark = host.classList.contains("wd-dark");
  host.className = `wd-tp-${cfg.toastPosition || "br"} wd-ts-${cfg.toastSize || "m"}`;
  if (dark) host.classList.add("wd-dark");
}

export function notify(title: string, body: string): void {
  window.postMessage(
    { source: "wall-core", type: "os-notify", title, body },
    "*",
  );
  try {
    if (window.Notification && Notification.permission === "granted")
      new Notification(title, { body });
    else if (window.Notification && Notification.permission !== "denied")
      Notification.requestPermission();
  } catch { /* ignore */ }
  toast(title, body);
}

export function toast(title: string, body: string): void {
  let host = $("walldev-toasts") as HTMLElement | null;
  if (!host) {
    host = document.createElement("div");
    host.id = "walldev-toasts";
    document.body.appendChild(host);
    if (_applyTheme) _applyTheme();
  }
  applyToastPlacement();
  const el = document.createElement("div");
  el.className = "wp-toast";
  el.innerHTML = `<b>${esc(title)}</b><br><span>${esc(body)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, 6000);
}
