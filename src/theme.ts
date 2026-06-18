import { cfg } from "./config";
import { $ } from "./helpers";

export function currentTheme(): "light" | "dark" {
  return cfg.theme === "auto"
    ? document.body.classList.contains("dark")
      ? "dark"
      : "light"
    : cfg.theme;
}

/**
 * Single source of truth for "should body-level popups be dark?".
 *
 * cfg.theme is authoritative: applyTheme() syncs every panel/popup to it,
 * but at boot the walldev-tool class may not yet be in sync — that's how
 * the site emoji button used to render white in dark mode the first time
 * after a reload. We therefore consult cfg first and fall back to the
 * class only as a safety net for callers that run before currentTheme()
 * has a config to read.
 */
export function isWalldevDark(): boolean {
  try {
    return currentTheme() === "dark";
  } catch {
    return !!document.getElementById("walldev-tool")?.classList.contains("wd-dark");
  }
}

export function applyTheme(): void {
  const dark = currentTheme() === "dark";
  ["walldev-tool", "walldev-toasts", "walldev-reopen", "walldev-dialogs"].forEach((id) => {
    const el = $(id);
    if (el) el.classList.toggle("wd-dark", dark);
  });
  // Body-level popups (emoji picker, broadcast, profile modal) self-sync the
  // wd-dark class on their root when opened, but also react to live theme
  // toggles via this event.
  document.dispatchEvent(new CustomEvent("wd:theme-changed", { detail: { dark } }));
}

export function applyUiScale(): void {
  const el = $("walldev-tool") as HTMLElement | null;
  if (el) (el.style as any).zoom = cfg.uiScale;
}

export function applyCozy(): void {
  const el = $("walldev-tool");
  if (el) el.classList.toggle("wd-cozy", !!cfg.cozy);
}

let themeObs: MutationObserver | null = null;

export function watchSiteTheme(): void {
  if (themeObs) return;
  themeObs = new MutationObserver(() => {
    if (cfg.theme === "auto") applyTheme();
  });
  themeObs.observe(document.body, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
