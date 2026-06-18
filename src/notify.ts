import { $ } from "./helpers";
import { esc } from "./helpers";

let _applyTheme: (() => void) | null = null;
export function setThemeApplier(fn: () => void): void {
  _applyTheme = fn;
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
  const el = document.createElement("div");
  el.className = "wp-toast";
  el.innerHTML = `<b>${esc(title)}</b><br><span>${esc(body)}</span>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, 6000);
}
