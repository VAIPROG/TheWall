import { cfg, saveCfg } from "./config";
import {
  WINDOW_MIN_WIDTH_PX,
  WINDOW_MIN_HEIGHT_PX,
  WINDOW_MAX_WIDTH_PX,
  WINDOW_MAX_HEIGHT_PX,
} from "./constants";
import { $, esc } from "./helpers";
import { achIcon as achIconHelper } from "./icons";
import { t } from "./i18n";
import { setActiveColor } from "./palette";
import { downloadWallSnapshot } from "./snapshot";
import { mountReopener } from "./reopen";
import { wireMailUI, loadMail } from "./mail";
import {
  loadTemplates,
  loadPublicTemplates,
  loadRoster,
  loadClanChat,
  syncProfile,
  refreshNotifications,
} from "./data";
import {
  loadAdminUsers,
  loadModApps,
  loadAdminTemplates,
  loadAdminNotifs,
} from "./admin-ui";
import { log } from "./log";
import { listMine } from "./achievements";
import { wireAnimAndProtect } from "./anim-protect-wire";
import { wireLinks } from "./links-wire";
import {
  wireAdmin,
  wireChats,
  wireOverlay,
  wireProfile,
  wireSettings,
  wireShare,
  wireTemplates,
} from "./ui";

export function wireUI(win: HTMLElement): void {
  // Animation + region-protection groups live in their own wiring module.
  wireAnimAndProtect();
  wireLinks();
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
      if ((tab as HTMLElement).dataset.p === "cl") {
        loadRoster().catch(() => {});
        loadClanChat().catch(() => {});
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

  // overlay tab
  wireOverlay(win);
  // share tab (import / export wiring)
  wireShare(win);

  // draw tab
  win.querySelectorAll(".wp-sw button").forEach((b) =>
    b.addEventListener("click", () => {
      setActiveColor((b as HTMLElement).dataset.hex || "");
      win
        .querySelectorAll(".wp-sw button")
        .forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    }),
  );

  // templates tab
  wireTemplates(win);

  // social tab
  // Wall snapshot — fetch every tile from ws.filianislost.com/tiles, stitch
  // onto a brick-background canvas, downscale to chosen quality, download PNG.
  $("btn-snapshot")!.addEventListener("click", () => {
    const sel = $("snapshot-quality") as HTMLSelectElement | null;
    const q = (sel?.value || "high") as "low" | "medium" | "high";
    downloadWallSnapshot(q);
  });

  // profile tab
  wireProfile(win);

  // mail tab
  wireMailUI();
  wireChats(win);
  // Load mail when user clicks the mail tab
  document.querySelectorAll('.wp-tab[data-p="ma"]').forEach((b) => {
    b.addEventListener("click", () => loadMail());
  });

  // settings tab
  wireSettings(win);

  wireAdmin(win);
}

// ---------------------------------------------------------------------------
// Achievement list (Profile pane)
// ---------------------------------------------------------------------------

const ACH_CATEGORY_KEYS: Record<string, string> = {
  general: "achCategoryGeneral",
  pixels: "achCategoryPixels",
  templates: "achCategoryTemplates",
  clan: "achCategoryClan",
  social: "achCategorySocial",
  tools: "achCategoryTools",
  time: "achCategoryTime",
  easter: "achCategoryEaster",
};

// Render a small SVG medallion (24px) from icons.ts for each row. The
// previous emoji-based map has been replaced — see achIcon() in icons.ts.
function renderAchIcon(name: string): string {
  return achIconHelper(name, 24);
}

async function loadAchievementList(): Promise<void> {
  const list = $("ach-list");
  const summary = $("ach-summary");
  if (!list) return;

  const all = await listMine();
  if (!all.length) {
    list.innerHTML = `<div style="padding:6px;color:var(--sub)">${esc(t("achLocked"))}</div>`;
    if (summary) summary.textContent = "";
    return;
  }

  const unlocked = all.filter((a) => a.unlocked_at);
  const totalPts = unlocked.reduce((s, a) => s + a.points, 0);
  if (summary) {
    summary.textContent =
      t("achUnlockedCount", {
        got: String(unlocked.length),
        all: String(all.length),
      }) +
      " · " +
      t("achTotalPoints", { n: String(totalPts), label: t("achPoints") });
  }

  // Group by category
  const byCat = new Map<string, typeof all>();
  for (const a of all) {
    const arr = byCat.get(a.category) || [];
    arr.push(a);
    byCat.set(a.category, arr);
  }

  let html = "";
  for (const [cat, items] of byCat) {
    const catLabel = t(ACH_CATEGORY_KEYS[cat] || "achCategoryGeneral");
    html += `<div style="font-weight:bold;font-size:10px;color:var(--sub);margin:6px 0 2px;text-transform:uppercase;letter-spacing:.5px">${esc(catLabel)}</div>`;
    for (const a of items) {
      const got = !!a.unlocked_at;
      const icon = renderAchIcon(a.icon);
      const opacity = got ? "1" : "0.35";
      const name = got
        ? esc(a.name)
        : a.secret
          ? esc(t("achSecret"))
          : esc(a.name);
      const desc = got
        ? esc(a.description)
        : a.secret
          ? "???"
          : esc(a.description);
      const pts = `<span style="margin-left:auto;font-size:9px;color:var(--sub)">${a.points} ${esc(t("achPoints"))}</span>`;
      const dateStr = a.unlocked_at
        ? `<span style="font-size:9px;color:var(--sub);margin-left:6px">${new Date(a.unlocked_at).toLocaleDateString()}</span>`
        : "";
      html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;opacity:${opacity};border-bottom:1px solid rgba(128,128,128,.15)">
        <span style="flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:bold;font-size:11px">${name}${dateStr}</div>
          <div style="font-size:10px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>
        </div>
        ${pts}
      </div>`;
    }
  }
  list.innerHTML = html;
}

// pickCharityTemplate removed — generic pickLayer() in overlay-share-dialogs.ts
// now handles all multi-template selection for any WallTemplateSet.
