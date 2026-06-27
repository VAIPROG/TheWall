import { cfg, saveCfg } from "./config";
import {
  WINDOW_MIN_WIDTH_PX,
  WINDOW_MIN_HEIGHT_PX,
  WINDOW_MAX_WIDTH_PX,
  WINDOW_MAX_HEIGHT_PX,
} from "./constants";
import { $, esc, errMsg } from "./helpers";
import { achIcon as achIconHelper } from "./icons";
import { t } from "./i18n";
import { toast } from "./notify";
import { setActiveColor } from "./palette";
import { applyTheme, applyUiScale, applyCozy } from "./theme";
import { applyCursorMode } from "./cursors";
import { WallEvents } from "./events";
import { Backend } from "./backend";
import { downloadWallSnapshot } from "./snapshot";
import { mountReopener } from "./reopen";
import { reloadEmotes } from "./emoji";
import { wireMailUI, loadMail } from "./mail";
import {
  loadTemplates,
  loadPublicTemplates,
  loadRoster,
  loadClanChat,
  loadRemoteI18n,
  syncProfile,
  refreshNotifications,
  backendConnect,
} from "./data";
import {
  loadAdminUsers,
  loadModApps,
  loadAdminTemplates,
  loadAdminNotifs,
} from "./admin-ui";
import { manualCheck, skipVersion, cmpVersion } from "./update-check";
import { VERSION } from "./constants";
import { promptDlg, confirmDlg, errorDlg, infoDlg } from "./dialog";
import { log } from "./log";
import { listMine } from "./achievements";
import { playPaintRefillSound } from "./paint-sound";
import { wireAnimAndProtect } from "./anim-protect-wire";
import { wireLinks } from "./links-wire";
import {
  wireAdmin,
  wireChats,
  wireOverlay,
  wireProfile,
  wireShare,
  wireTemplates,
  updatePaintCurrent,
  updateProfileBalance,
  wireSellButton,
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
  $("cfg-theme")!.addEventListener("change", (e: Event) => {
    cfg.theme = (e.target as HTMLSelectElement).value as any;
    saveCfg();
    applyTheme();
  });
  $("cfg-uiscale")!.addEventListener("input", (e: Event) => {
    cfg.uiScale = parseFloat((e.target as HTMLInputElement).value);
    saveCfg();
    $("uiscale-val")!.textContent = Math.round(cfg.uiScale * 100) + "%";
    applyUiScale();
  });
  $("cfg-cozy")!.addEventListener("change", (e: Event) => {
    cfg.cozy = (e.target as HTMLInputElement).checked;
    saveCfg();
    applyCozy();
  });
  $("lang-select")!.addEventListener("change", (e: Event) => {
    localStorage.setItem(
      "wall_overlay_lang",
      (e.target as HTMLSelectElement).value,
    );
    location.reload();
  });
  $("cfg-remote-i18n")!.addEventListener("change", (e: Event) => {
    cfg.remoteI18n = (e.target as HTMLInputElement).checked;
    saveCfg();
    if (cfg.remoteI18n) loadRemoteI18n();
  });
  $("cfg-cursors")!.addEventListener("change", (e: Event) => {
    cfg.cursorMode = (e.target as HTMLSelectElement).value as any;
    saveCfg();
    applyCursorMode();
  });
  $("cfg-cursor-sel")!.addEventListener("change", (e: Event) => {
    cfg.cursorSelector =
      (e.target as HTMLInputElement).value.trim() || '[class*="cursor"]';
    saveCfg();
    applyCursorMode();
  });

  // ----------- 7TV emote channel manager -----------
  type EmoteChannelCfg = string | { id: string; name: string };
  function normChannel(
    c: EmoteChannelCfg,
  ): { id: string; name: string } | null {
    if (typeof c === "string") {
      const v = c.trim();
      if (!v) return null;
      if (/^\d+$/.test(v)) return { id: v, name: v };
      return null;
    }
    if (c?.id && c?.name) return { id: String(c.id), name: String(c.name) };
    return null;
  }
  function renderEmoteChannels(): void {
    const box = $("cfg-emote-channels");
    if (!box) return;
    const list = (cfg.emoteChannels || []) as EmoteChannelCfg[];
    const norms = list.map(normChannel).filter(Boolean) as Array<{
      id: string;
      name: string;
    }>;
    // Always-loaded built-ins shown first as informational chips.
    const builtin = [
      `<div class="wp-channel-item builtin"><div class="grow">
         <span class="badge">global</span>
         <span class="nm">7TV global</span>
         <span class="tid">always loaded</span>
       </div></div>`,
    ];
    const items = norms.map((ch, i) => {
      const isFilianDefault =
        ch.name.toLowerCase() === "filian" && ch.id === "198633200";
      return `<div class="wp-channel-item" data-i="${i}">
        <div class="grow">
          ${isFilianDefault ? `<span class="badge">default</span>` : ""}
          <span class="nm">#${esc(ch.name)}</span>
          <span class="tid">id: ${esc(ch.id)}</span>
        </div>
        <span class="rm" data-rm-channel="${i}" title="Remove">×</span>
      </div>`;
    });
    box.innerHTML =
      [...builtin, ...items].join("") ||
      `<div style="padding:4px;color:var(--sub);font-style:italic">No extra channels yet.</div>`;

    box.querySelectorAll<HTMLElement>("[data-rm-channel]").forEach((el) => {
      el.addEventListener("click", async () => {
        const i = parseInt(el.dataset.rmChannel || "-1", 10);
        if (i < 0) return;
        const ch = norms[i];
        if (
          !(await confirmDlg(
            `Remove channel ${ch.name} from your emote list?`,
            "Remove channel",
          ))
        )
          return;
        cfg.emoteChannels = cfg.emoteChannels.filter((_x, idx) => idx !== i);
        saveCfg();
        renderEmoteChannels();
        reloadEmotes().catch(() => {});
        toast("7TV", "channel removed");
      });
    });
  }
  $("btn-emote-add")?.addEventListener("click", async () => {
    const nameInput = $("cfg-emote-name") as HTMLInputElement;
    const idInput = $("cfg-emote-tid") as HTMLInputElement;
    const name = (nameInput?.value || "").trim().replace(/^#/, "");
    const id = (idInput?.value || "").trim();
    if (!name || !id) {
      await errorDlg("Both display name and Twitch user ID are required.");
      return;
    }
    if (!/^\d+$/.test(id)) {
      await errorDlg("Twitch user ID must be numeric (e.g. 198633200).");
      return;
    }
    const existing = (cfg.emoteChannels || [])
      .map(normChannel)
      .filter(Boolean) as Array<{ id: string; name: string }>;
    if (existing.some((ch) => ch.id === id)) {
      await errorDlg("That channel is already in your list.");
      return;
    }
    cfg.emoteChannels = [...(cfg.emoteChannels || []), { id, name }];
    saveCfg();
    nameInput.value = "";
    idInput.value = "";
    renderEmoteChannels();
    toast("7TV", `loading ${name}…`);
    try {
      await reloadEmotes();
      toast("7TV", "loaded");
    } catch (e: any) {
      await errorDlg("Failed to load: " + errMsg(e));
    }
  });
  $("btn-emote-reload")?.addEventListener("click", async () => {
    toast("7TV", "reloading…");
    try {
      await reloadEmotes();
      toast("7TV", "reloaded");
    } catch (e: any) {
      await errorDlg("Reload failed: " + errMsg(e));
    }
  });
  renderEmoteChannels();
  $("cfg-backend-url")!.addEventListener("change", (e: Event) => {
    cfg.backendUrl = (e.target as HTMLInputElement).value.trim();
    saveCfg();
  });
  $("btn-backend-connect")!.addEventListener("click", backendConnect);
  $("cfg-intercept")!.addEventListener("change", (e: Event) => {
    cfg.interceptEvents = (e.target as HTMLInputElement).checked;
    saveCfg();
    if (cfg.interceptEvents) WallEvents.startDom();
  });
  $("cfg-wstap")!.addEventListener("change", (e: Event) => {
    cfg.wsTap = (e.target as HTMLInputElement).checked;
    saveCfg();
    toast("WS tap", "reload page to (de)activate");
  });
  $("cfg-charity-no-identity")?.addEventListener("change", (e: Event) => {
    cfg.charityNoIdentity = (e.target as HTMLInputElement).checked;
    saveCfg();
  });

  // update checker
  $("btn-check-update")!.addEventListener("click", async () => {
    const status = $("update-status");
    if (status) status.textContent = "checking…";
    const sig = await manualCheck();
    if (!sig) {
      if (status) status.textContent = "could not reach update server";
      return;
    }
    const diff = cmpVersion(sig.version, VERSION);
    if (diff === 0) {
      if (status) status.textContent = `up to date: v${VERSION}`;
      return;
    }
    if (diff < 0) {
      // Server reports an OLDER version than the one already installed —
      // common during local development or right after publishing. Show a
      // friendly note instead of "update available".
      if (status) {
        status.innerHTML = `you are ahead of release: <b>v${VERSION}</b> (server: v${sig.version})`;
      }
      return;
    }
    if (status) {
      const base = "https://the-wall.vai-rice.space";
      const d = sig.downloads as any;

      status.innerHTML =
        `update available: <b>v${sig.version}</b> (you have v${VERSION})<br>` +
        `<a href="${base}${d.userscript}" target="_blank" style="color:var(--link)">userscript</a> · ` +
        `<a href="${base}${d.chrome_zip}" target="_blank" style="color:var(--link)">chrome</a> · ` +
        `<a href="${base}${d.firefox_zip}" target="_blank" style="color:var(--link)">firefox</a> · ` +
        `<a href="${base}${d.safari_zip}" target="_blank" style="color:var(--link)">safari</a> · ` +
        `<a href="#" id="skip-ver" style="color:var(--sub)">skip</a>`;
      $("skip-ver")?.addEventListener("click", (e) => {
        e.preventDefault();
        skipVersion(sig.version);
        toast("Update", "version skipped");
      });
    }
  });

  wireAdmin(win);

  // ------- Paint helpers: refill toggle, current paint display, sell-all -------
  document.addEventListener("wd:paint-changed", updatePaintCurrent);
  setTimeout(updatePaintCurrent, 1500);

  $("cfg-notify-paint")?.addEventListener("change", (e) => {
    cfg.notifyOnPaintRefill = (e.target as HTMLInputElement).checked;
    saveCfg();
  });

  $("cfg-sound-paint")?.addEventListener("change", (e) => {
    cfg.paintRefillSound = (e.target as HTMLInputElement).checked;
    saveCfg();
  });

  $("cfg-sound-vol")?.addEventListener("input", (e) => {
    const pct = Number((e.target as HTMLInputElement).value);
    cfg.paintRefillVolume = Math.max(0, Math.min(1, pct / 100));
    saveCfg();
    const lbl = $("paint-vol-val");
    if (lbl) lbl.textContent = `${pct}%`;
  });

  $("btn-sound-test")?.addEventListener("click", () => {
    // Force-play regardless of the toggle so the user can preview the chime
    // before flipping it on.
    const prev = cfg.paintRefillSound;
    cfg.paintRefillSound = true;
    playPaintRefillSound();
    cfg.paintRefillSound = prev;
  });

  // ----- Settings: paint sell buttons -----
  const settingsRefresh = () => {
    updatePaintCurrent();
    updateProfileBalance().catch(() => {});
  };
  wireSellButton("btn-sell-all", "all", settingsRefresh);
  wireSellButton("btn-sell-some", "prompt", settingsRefresh);

  // backend meta
  const loadMeta = async () => {
    const el = $("server-meta");
    if (!el) return;
    el.textContent = "loading…";
    try {
      const r = await fetch(`${cfg.backendUrl}/meta`, { cache: "no-store" });
      const m = await r.json();
      el.textContent =
        `version:     v${m.version}\n` +
        `started:     ${m.started_at}\n` +
        `uptime:      ${Math.round(m.uptime_secs / 60)} min\n` +
        (m.deployed_at ? `deployed:    ${m.deployed_at}\n` : "") +
        (m.built_at ? `built:       ${m.built_at}\n` : "");
    } catch (e: any) {
      el.textContent = "could not reach backend: " + errMsg(e);
    }
  };
  $("btn-load-meta")?.addEventListener("click", loadMeta);
  setTimeout(loadMeta, 1500); // auto on open

  // account deletion
  $("btn-delete-account")?.addEventListener("click", async () => {
    if (!Backend.on) {
      await errorDlg("Connect to backend first");
      return;
    }
    const ok = await confirmDlg(
      "This permanently deletes your profile, avatars, messages and templates. Continue?",
      "DELETE ACCOUNT?",
    );
    if (!ok) return;
    const reason = await promptDlg("Reason (optional):", "", "Reason");
    try {
      await Backend.req("POST", "/me/delete", { confirm: true, reason });
      cfg.backendToken = "";
      cfg.refreshToken = "";
      saveCfg();
      await infoDlg("Account deleted. Reloading…", "Done");
      setTimeout(() => location.reload(), 1500);
    } catch (e: any) {
      await errorDlg("Delete failed: " + errMsg(e));
    }
  });
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
