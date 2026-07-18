import { cfg, saveCfg } from "../config";
import {
  WINDOW_MIN_WIDTH_PX,
  WINDOW_MIN_HEIGHT_PX,
  WINDOW_MAX_WIDTH_PX,
  WINDOW_MAX_HEIGHT_PX,
} from "../constants";
import { $ } from "../helpers";
import { log } from "../log";
import { mountReopener } from "../reopen";
import { loadNotifications, loadChatList } from "../mail";
import {
  loadTemplates,
  loadPublicTemplates,
  syncProfile,
  refreshNotifications,
} from "../data";
import {
  loadAdminUsers,
  loadModApps,
  loadAdminTemplates,
  loadAdminNotifs,
} from "./admin-ui";
import { loadAchievementList } from "./achievements-tab";
import { refreshCommunity } from "./community/shell";

export function wireWindowChrome(win: HTMLElement): void {
  // tab switching
  win.querySelectorAll(".wp-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      win
        .querySelectorAll(".wp-tab")
        .forEach((x) => x.classList.remove("active"));
      win
        .querySelectorAll(".wp-pane")
        .forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      win
        .querySelector(`.wp-pane[data-p="${(tab as HTMLElement).dataset.p}"]`)
        ?.classList.add("active");
      if ((tab as HTMLElement).dataset.p === "tp") {
        loadTemplates().catch(() => {});
        loadPublicTemplates().catch(() => {});
      }
      if ((tab as HTMLElement).dataset.p === "co") {
        // Re-fetch on focus: the Community stack mounts once at startup (often
        // before login), so its first load can no-op without a token. Refresh
        // now that the client is authenticated.
        refreshCommunity();
      }
      if ((tab as HTMLElement).dataset.p === "ad") {
        loadAdminUsers().catch(() => {});
        loadModApps().catch(() => {});
        loadAdminTemplates().catch(() => {});
        loadAdminNotifs().catch(() => {});
      }
      if ((tab as HTMLElement).dataset.p === "pr") {
        syncProfile().catch(() => {});
        refreshNotifications().catch(() => {});
        document.dispatchEvent(new CustomEvent("wd:tab-open-pr"));
      }
      if ((tab as HTMLElement).dataset.p === "ah") {
        // Achievements now live in their own tab so the Profile pane stays
        // focused on identity / coins / paint actions.
        loadAchievementList().catch(() => {});
      }
    }),
  );

  // draggable titlebar — accounts for CSS zoom on the window
  const bar = $("wp-drag")!;
  let dx = 0,
    dy = 0,
    drag = false;
  bar.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if ((me.target as HTMLElement).classList.contains("wp-tbtn")) return;
    drag = true;
    const zoom = parseFloat((win.style as any).zoom) || 1;
    const r = win.getBoundingClientRect();
    dx = (me.clientX - r.left) / zoom;
    dy = (me.clientY - r.top) / zoom;
    win.style.right = "auto";
    win.style.left = r.left / zoom + "px";
    win.style.top = r.top / zoom + "px";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const zoom = parseFloat((win.style as any).zoom) || 1;
    win.style.left = e.clientX / zoom - dx + "px";
    win.style.top = e.clientY / zoom - dy + "px";
  });
  document.addEventListener("mouseup", () => (drag = false));

  // ----- Resize grip (bottom-right corner) ---------------------------------
  // Lets the user adjust the panel size between MIN and MAX limits defined in
  // constants.ts. The new size is persisted to cfg so it survives reloads.
  //
  // Careful: applyUiScale() sets `win.style.zoom`, which multiplies layout
  // sizes. `offsetWidth` returns the POST-zoom value, so naively saving
  // offsetWidth and reapplying via `style.width` on the next boot would
  // multiply the saved size by zoom each cycle (cumulative growth). We track
  // the un-zoomed values we just set in the move handler and save those
  // directly.
  const grip = $("wp-resize-handle");
  if (grip) {
    let rx = 0;
    let ry = 0;
    let rwBase = 0;
    let rhBase = 0;
    let currentW = 0;
    let currentH = 0;
    let rdrag = false;
    grip.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      me.preventDefault();
      me.stopPropagation();
      rdrag = true;
      rx = me.clientX;
      ry = me.clientY;
      const zoom = parseFloat((win.style as any).zoom) || 1;
      // `offsetWidth` is post-zoom — bring it back to base pixels so our
      // deltas compose correctly.
      rwBase = win.offsetWidth / zoom;
      rhBase = win.offsetHeight / zoom;
      currentW = rwBase;
      currentH = rhBase;
    });
    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (!rdrag) return;
      const zoom = parseFloat((win.style as any).zoom) || 1;
      const dw = (e.clientX - rx) / zoom;
      const dh = (e.clientY - ry) / zoom;
      currentW = Math.max(
        WINDOW_MIN_WIDTH_PX,
        Math.min(WINDOW_MAX_WIDTH_PX, rwBase + dw),
      );
      currentH = Math.max(
        WINDOW_MIN_HEIGHT_PX,
        Math.min(WINDOW_MAX_HEIGHT_PX, rhBase + dh),
      );
      win.style.width = currentW + "px";
      const content = win.querySelector(".wp-content") as HTMLElement | null;
      if (content) content.style.maxHeight = currentH - 60 + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!rdrag) return;
      rdrag = false;
      cfg.windowWidth = Math.round(currentW);
      cfg.windowHeight = Math.round(currentH);
      saveCfg();
      log.ok(
        "UI",
        `resized to ${cfg.windowWidth}×${cfg.windowHeight} (base px)`,
      );
    });
  } else {
    log.warn("UI", "resize grip element not found");
  }

  // minimize / close
  $("wp-min")!.addEventListener("click", () =>
    win.classList.toggle("collapsed"),
  );
  $("wp-close")!.addEventListener("click", () => {
    win.style.display = "none";
    mountReopener();
  });

  // Load mail when user clicks the mail tab
  document.querySelectorAll('.wp-tab[data-p="ma"]').forEach((b) => {
    b.addEventListener("click", () => { loadNotifications(); loadChatList(); });
  });
}
