import { cfg, saveCfg } from "../config";
import { WALL_W, WALL_H } from "../constants";
import { teleport } from "../coords";
import { $, esc, errMsg } from "../helpers";
import { ic } from "../icons";
import { t } from "../i18n";
import { toast } from "../notify";
import {
  overlayImg,
  overlayData,
  isLocked,
  setIsLocked,
  isPicking,
  setOverlayPos,
  renderOverlay,
  togglePick,
  updateLockBtn,
  clearOverlay,
  restartCompactMarkersRefresh,
} from "../overlay";
import { insertTemplate } from "../template-insert";
import {
  wireOverlayPersistence,
  clearPersistedOverlay,
  flushOverlaySave,
} from "../overlay-persist";
import { templateProgress } from "../template-progress";
import { applyParsedJson } from "../url-autoload";
import { confirmDlg, errorDlg } from "../dialog";
import { log } from "../log";
import { triggerEvent } from "../achievements";
import { segmented } from "./kit/primitives";
import { buildProtectPane } from "./build-protect";
import {
  setGuideTool,
  getGuideTool,
  clearGuide,
  applyGuideStyle,
} from "../guide";
import { PALETTE } from "../palette";

// Module-level state for debouncing scale changes.
let scaleTimer: number | null = null;
// Last template src we reset the Progress readouts for — so loading a NEW
// template blanks the stale numbers until the user re-opens the Progress drill.
let _lastProgressSrc = "";

export function applyScalePct(pct: number, immediate: boolean): void {
  const clamped = Math.max(5, Math.min(1000, Math.round(pct)));
  cfg.overlayScale = clamped / 100;
  saveCfg();
  const valEl = $("scale-val");
  if (valEl) valEl.textContent = clamped + "%";
  const rangeEl = $("scale-range") as HTMLInputElement | null;
  const inputEl = $("scale-input") as HTMLInputElement | null;
  if (rangeEl && parseInt(rangeEl.value) !== clamped)
    rangeEl.value = String(clamped);
  if (inputEl && parseInt(inputEl.value) !== clamped)
    inputEl.value = String(clamped);
  if (scaleTimer != null) clearTimeout(scaleTimer);
  if (immediate) renderOverlay();
  else
    scaleTimer = window.setTimeout(() => {
      scaleTimer = null;
      renderOverlay();
    }, 220);
}

export function wireOverlay(win: HTMLElement): void {
  // Overlay's "Share/Publish" button → jump to the Templates super-tab and open
  // Publish, pre-filled with the current overlay (built via the handoff bridge).
  $("btn-jump-share")?.addEventListener("click", async () => {
    win.querySelector<HTMLElement>('.wp-tab[data-p="tp"]')?.click();
    const { publishCurrentOverlay } = await import("./templates/handoff");
    await publishCurrentOverlay();
  });

  $("file-upload")!.addEventListener("change", (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = async (ev) => {
      // A raw upload is palette-quantised on the way in; it keeps the
      // overlay's current position (uploading doesn't move it).
      const { w, h } = await insertTemplate({
        imageDataUrl: (ev.target as FileReader).result as string,
        x: overlayData.x,
        y: overlayData.y,
        quantize: true,
      });
      setIsLocked(false);
      updateLockBtn();
      toast("Template", `${w}×${h} quantized`);
    };
    rd.readAsDataURL(f);
  });

  // New top buttons: Load Image triggers the (hidden) image input; Load JSON
  // opens a JSON file and applies it through the shared decoder.
  $("btn-load-image")?.addEventListener("click", () => $("file-upload")?.click());
  $("btn-load-json")?.addEventListener("click", () => $("json-upload")?.click());
  $("json-upload")?.addEventListener("change", (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = async (ev) => {
      try {
        const obj = JSON.parse((ev.target as FileReader).result as string);
        const ok = await applyParsedJson(obj, f.name);
        if (!ok) await errorDlg("Could not load this JSON (unrecognised format).");
      } catch (err: any) {
        await errorDlg("Invalid JSON: " + (err?.message || err));
      }
      (e.target as HTMLInputElement).value = "";
    };
    rd.readAsText(f);
  });

  const onCoords = () =>
    setOverlayPos(
      parseInt(($("coord-x") as HTMLInputElement).value) || 0,
      parseInt(($("coord-y") as HTMLInputElement).value) || 0,
    );
  $("coord-x")!.addEventListener("input", onCoords);
  $("coord-y")!.addEventListener("input", onCoords);
  $("btn-pick")!.addEventListener("click", () => togglePick(!isPicking));
  $("btn-teleport")?.addEventListener("click", async () => {
    const x = parseInt(($("coord-x") as HTMLInputElement).value) || 0;
    const y = parseInt(($("coord-y") as HTMLInputElement).value) || 0;
    if (x < 0 || x >= WALL_W || y < 0 || y >= WALL_H) {
      await errorDlg(t("teleportRange", { w: WALL_W - 1, h: WALL_H - 1 }));
      return;
    }
    // Teleport rides the site's URL deep-link, which only takes effect on a
    // reload. The overlay is persisted and auto-restored after the reload, so
    // there's nothing to lose — just flush the latest state first.
    await flushOverlaySave();
    teleport(x, y);
  });
  $("btn-clear-overlay")?.addEventListener("click", async () => {
    if (overlayData.src && !(await confirmDlg(t("clearOverlayConfirm")))) return;
    clearOverlay();
    await clearPersistedOverlay();
    toast(t("file"), t("clearOverlayDone"));
  });

  // Keep the scale controls + clear button in step with the live overlay
  // state (coords are already synced by setOverlayPos). Fires on load, move,
  // scale, animation, clear and restore.
  const syncOverlayControls = () => {
    const loaded = !!overlayData.src;
    const clearBtn = $("btn-clear-overlay") as HTMLButtonElement | null;
    if (clearBtn) clearBtn.disabled = !loaded;
    const pct = Math.round((cfg.overlayScale || 1) * 100);
    // Template card: show a live preview + readout when loaded, else the empty
    // state. Static children keep their IDs so listeners survive.
    const cardLoaded = $("ov-card-loaded");
    const cardEmpty = $("ov-card-empty");
    if (cardLoaded) cardLoaded.style.display = loaded ? "" : "none";
    if (cardEmpty) cardEmpty.style.display = loaded ? "none" : "";
    if (loaded) {
      const thumb = $("ov-card-thumb") as HTMLImageElement | null;
      if (thumb && thumb.src !== overlayData.src) thumb.src = overlayData.src;
      const ro = $("ov-card-readout");
      if (ro) {
        const w = overlayData.origW || overlayData.w;
        const h = overlayData.origH || overlayData.h;
        ro.textContent = `${w}×${h} @${overlayData.x},${overlayData.y} · ${pct}%`;
      }
    }
    const sval = $("scale-val");
    if (sval) sval.textContent = `${pct}%`;
    for (const id of ["scale-range", "scale-input"]) {
      const el = $(id) as HTMLInputElement | null;
      if (el && document.activeElement !== el) el.value = String(pct);
    }
    // A NEW template invalidates the last progress count — blank the readouts
    // (they recompute when the user opens the Progress drill). Moving/scaling
    // the same template keeps the numbers.
    if (overlayData.src && overlayData.src !== _lastProgressSrc) {
      _lastProgressSrc = overlayData.src;
      for (const id of [
        "ov-prog-pct",
        "ov-prog-total",
        "ov-prog-done",
        "ov-prog-left",
        "wp-progress",
        "ov-row-progress-hl",
      ]) {
        const n = $(id);
        if (n) n.textContent = "—";
      }
      const fill = $("ov-prog-fill");
      if (fill) fill.style.width = "0%";
    } else if (!overlayData.src) {
      _lastProgressSrc = "";
    }
  };
  document.addEventListener("wd:overlay-changed", syncOverlayControls);
  wireOverlayPersistence();

  // Overlay scale (5% – 1000%). Apply is heavy (resize + quantize a possibly
  // huge image), so debounce slider drags. Direct number-input and presets
  // apply immediately because they're discrete clicks.
  $("scale-range")!.addEventListener("input", (e: Event) => {
    applyScalePct(parseInt((e.target as HTMLInputElement).value) || 100, false);
  });
  $("scale-input")?.addEventListener("change", (e: Event) => {
    applyScalePct(parseInt((e.target as HTMLInputElement).value) || 100, true);
  });
  document
    .querySelectorAll<HTMLButtonElement>("[data-scale-preset]")
    .forEach((b) => {
      b.addEventListener("click", () =>
        applyScalePct(parseInt(b.dataset.scalePreset || "100"), true),
      );
    });
  $("opacity-range")!.addEventListener("input", (e: Event) => {
    // Dots mode forces full opacity for max readability — the slider is
    // hidden in that case, but if anything sneaks an input event through
    // (keyboard, focus race, …) we honour the lock-in by ignoring it.
    if (cfg.compactMarkers) {
      if (overlayImg) overlayImg.style.opacity = "1";
      return;
    }
    cfg.defaultOpacity = parseFloat((e.target as HTMLInputElement).value);
    saveCfg();
    if (overlayImg)
      overlayImg.style.opacity = (e.target as HTMLInputElement).value;
  });

  // Display mode: segmented Overlay ↔ Dots. Selecting "Dots" turns on the
  // compact-marker renderer; opacity applies only in Overlay mode and its
  // sub-block is hidden under Dots (the slider is a no-op there), while the dot
  // sizing / refresh sub-block is shown only under Dots.
  const seg = $("ov-display-seg");
  seg?.querySelectorAll<HTMLElement>("[data-seg]").forEach((b) =>
    b.addEventListener("click", () => {
      const dots = b.dataset.seg === "dots";
      if (cfg.compactMarkers === dots) return; // already in this mode
      seg
        .querySelectorAll<HTMLElement>("[data-seg]")
        .forEach((x) => x.classList.toggle("is-on", x === b));
      cfg.compactMarkers = dots;
      saveCfg();
      const wrap = $("compact-size-wrap");
      if (wrap) wrap.style.display = dots ? "" : "none";
      const opacityGroup = $("opacity-group");
      if (opacityGroup) opacityGroup.style.display = dots ? "none" : "";
      if (overlayImg)
        overlayImg.style.opacity = dots ? "1" : String(cfg.defaultOpacity);
      renderOverlay();
      log("OVERLAY", "INFO", "display mode: " + (dots ? "dots" : "overlay"));
      if (dots) triggerEvent("compact_mode_enabled").catch(() => {});
    }),
  );

  // Dots refresh interval
  $("cfg-dots-refresh")?.addEventListener("input", (e: Event) => {
    const v = parseInt((e.target as HTMLInputElement).value, 10);
    cfg.dotsRefreshMs = Number.isFinite(v) ? v : 500;
    saveCfg();
    const lbl = $("dots-refresh-val");
    if (lbl) lbl.textContent = cfg.dotsRefreshMs + "ms";
    restartCompactMarkersRefresh();
  });
  $("cfg-compact-size")?.addEventListener("input", (e: Event) => {
    cfg.compactMarkerSize = parseInt((e.target as HTMLInputElement).value, 10);
    const lbl = $("compact-size-val");
    if (lbl) lbl.textContent = cfg.compactMarkerSize + "%";
    saveCfg();
  });
  $("cfg-compact-size")?.addEventListener("change", () => {
    if (cfg.compactMarkers) renderOverlay();
  });
  $("cfg-progress-tol")?.addEventListener("input", (e: Event) => {
    cfg.progressTolerancePct = parseInt((e.target as HTMLInputElement).value, 10) || 0;
    saveCfg();
    const lbl = $("prog-tol-val");
    if (lbl) lbl.textContent = cfg.progressTolerancePct + "%";
  });
  $("btn-progress")!.addEventListener("click", () => templateProgress(false));
  $("btn-progress-guide")!.addEventListener("click", () =>
    templateProgress(true),
  );
  $("btn-lock")!.addEventListener("click", () => {
    setIsLocked(!isLocked);
    updateLockBtn();
  });
  $("btn-toggle")!.addEventListener("click", () => {
    if (overlayImg)
      overlayImg.style.display =
        overlayImg.style.display === "none" ? "block" : "none";
  });

  // ----- Drill-in navigation (Animation / Protect / Progress) --------------
  // A lightweight show/hide stack over always-present DOM: opening a drill
  // hides #ov-root and shows one ov-drill-* container; "‹ Back" returns. The
  // drill content keeps its IDs, so the listeners wired above / by
  // wireAnimAndProtect stay attached across navigation.
  const DRILLS = ["anim", "protect", "progress", "guide"] as const;
  const showDrill = (name: (typeof DRILLS)[number] | null) => {
    const root = $("ov-root");
    if (root) {
      root.style.display = name ? "none" : "";
      // Returning to the root gets the same slide feel as opening a drill
      // (retrigger the animation by removing + re-adding the class).
      if (!name) {
        root.classList.remove("ov-root-back");
        void root.offsetWidth;
        root.classList.add("ov-root-back");
      }
    }
    for (const d of DRILLS) {
      const el = $("ov-drill-" + d);
      if (el) el.style.display = d === name ? "" : "none";
    }
    // Leaving the Guide drill disarms any active pen/eraser so the guide canvas
    // goes click-through again (otherwise it would swallow wall clicks).
    if (name !== "guide" && getGuideTool()) {
      setGuideTool(null);
      win
        .querySelectorAll("#ov-guide-tool [data-tool]")
        .forEach((x) => x.classList.remove("is-on"));
    }
    // Scroll the panel body back to the top so the pushed screen starts at the
    // header rather than wherever the root was scrolled.
    const content = win.querySelector(".wp-content") as HTMLElement | null;
    if (content) content.scrollTop = 0;
    // Refresh live data on entry.
    if (name === "progress") templateProgress(false).catch(() => {});
  };
  win.querySelectorAll<HTMLElement>("#ov-root [data-drill]").forEach((b) =>
    b.addEventListener("click", () =>
      showDrill(b.dataset.drill as (typeof DRILLS)[number]),
    ),
  );
  win.querySelectorAll<HTMLElement>("[data-drill-back]").forEach((b) => {
    b.addEventListener("click", () => showDrill(null));
    b.addEventListener("keydown", (e) => {
      const k = (e as KeyboardEvent).key;
      if (k === "Enter" || k === " ") {
        e.preventDefault();
        showDrill(null);
      }
    });
  });

  // ----- Guide layer controls ----------------------------------------------
  const guideSeg = $("ov-guide-seg");
  guideSeg?.querySelectorAll<HTMLElement>("[data-seg]").forEach((b) =>
    b.addEventListener("click", () => {
      cfg.guideMode = (b.dataset.seg as "pixels" | "dots") || "pixels";
      saveCfg();
      guideSeg
        .querySelectorAll<HTMLElement>("[data-seg]")
        .forEach((x) => x.classList.toggle("is-on", x === b));
    }),
  );
  $("guide-opacity")?.addEventListener("input", (e: Event) => {
    cfg.guideOpacity = parseFloat((e.target as HTMLInputElement).value);
    saveCfg();
    applyGuideStyle();
  });
  $("guide-visible")?.addEventListener("change", (e: Event) => {
    cfg.guideVisible = (e.target as HTMLInputElement).checked;
    saveCfg();
    applyGuideStyle();
  });
  // Colour comes from the site palette (same swatches used for templates), so
  // guide marks stay on-palette. Selecting a swatch (or the eyedropper picking
  // one) updates cfg.guideColor and the highlighted swatch.
  const markGuideSwatch = () => {
    const cur = (cfg.guideColor || "").toLowerCase();
    win
      .querySelectorAll<HTMLElement>("#ov-guide-sw [data-ghex]")
      .forEach((b) =>
        b.classList.toggle("sel", (b.dataset.ghex || "").toLowerCase() === cur),
      );
  };
  win.querySelectorAll<HTMLElement>("#ov-guide-sw [data-ghex]").forEach((b) =>
    b.addEventListener("click", () => {
      cfg.guideColor = b.dataset.ghex || cfg.guideColor;
      saveCfg();
      markGuideSwatch();
    }),
  );
  document.addEventListener("wd:guide-color", markGuideSwatch);
  $("guide-brush")?.addEventListener("input", (e: Event) => {
    cfg.guideBrush = parseInt((e.target as HTMLInputElement).value, 10) || 1;
    const l = $("guide-brush-val");
    if (l) l.textContent = String(cfg.guideBrush);
    saveCfg();
  });
  const toolSeg = $("ov-guide-tool");
  toolSeg?.querySelectorAll<HTMLElement>("[data-tool]").forEach((b) =>
    b.addEventListener("click", () => {
      const tool = b.dataset.tool as "pen" | "eraser";
      const next = getGuideTool() === tool ? null : tool;
      setGuideTool(next);
      toolSeg
        .querySelectorAll<HTMLElement>("[data-tool]")
        .forEach((x) => x.classList.toggle("is-on", next !== null && x === b));
    }),
  );
  $("btn-guide-remaining")?.addEventListener("click", () =>
    templateProgress(true).catch(() => {}),
  );
  $("btn-guide-clear")?.addEventListener("click", async () => {
    if (!(await confirmDlg(t("guideClearConfirm")))) return;
    clearGuide();
    toast(t("guideLegend"), t("guideCleared"));
  });
}

export function buildOverlayPane(): string {
  return `<div class="wp-pane active" data-p="ov">
              <div id="ov-root">
                  <!-- template card (loaded) / empty state — filled by syncOverlayControls -->
                  <div class="wd-card" id="ov-card" style="margin-bottom:6px">
                      <div id="ov-card-loaded" style="display:none">
                          <div style="display:flex;gap:8px;align-items:center">
                              <img id="ov-card-thumb" alt="" style="width:44px;height:44px;flex:none;border:1px solid var(--shadow);image-rendering:pixelated;background:var(--group);object-fit:contain">
                              <div style="flex:1;min-width:0">
                                  <b id="ov-card-name">${t("file")}</b>
                                  <div><span class="wd-readout" id="ov-card-readout"></span></div>
                              </div>
                          </div>
                          <button class="wd-btn" id="btn-clear-overlay" style="width:100%;margin-top:6px;color:var(--err)" title="${esc(t("ovRemoveLocalHint"))}">✕ ${t("ovRemoveLocal")}</button>
                      </div>
                      <div id="ov-card-empty" class="wd-empty"><span class="wd-empty-ico">🖼</span>${t("ovEmpty")}</div>
                  </div>
                  <input type="file" id="file-upload" accept="image/*" style="display:none">
                  <input type="file" id="json-upload" accept=".json,application/json" style="display:none">
                  <div style="display:flex;gap:6px;margin-bottom:5px">
                      <button class="wd-btn" id="btn-load-image" style="flex:1">🖼 ${t("ovLoadImage")}</button>
                      <button class="wd-btn" id="btn-load-json" style="flex:1">📄 ${t("ovLoadJson")}</button>
                  </div>
                  <button class="wd-btn wd-btn--primary wd-btn--full" id="btn-jump-share" style="margin-bottom:8px">${ic("send")}${t("ovShareGo")} →</button>
                  <div class="wp-group"><div class="wp-legend">${ic("pin")}${t("coords")}</div>
                      <div class="wp-row"><div>X<input type="number" id="coord-x" name="coord_x" autocomplete="off" class="wp-input" value="0"></div>
                      <div>Y<input type="number" id="coord-y" name="coord_y" autocomplete="off" class="wp-input" value="0"></div></div>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-pick" style="flex:1;margin:0">${ic("pin")}${t("pickPoint")}</button>
                          <button class="wp-btn" id="btn-teleport" style="flex:1;margin:0" title="${esc(t("teleportHint"))}">${ic("send")}${t("teleport")}</button>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${t("scale")}: <span id="scale-val">${Math.round((cfg.overlayScale || 1) * 100)}%</span></div>
                      <input type="range" id="scale-range" min="5" max="1000" step="5" value="${Math.round((cfg.overlayScale || 1) * 100)}" style="width:100%">
                      <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">
                          <button class="wp-btn" data-scale-preset="10" style="flex:1;min-width:46px;padding:2px 4px;margin:0">10%</button>
                          <button class="wp-btn" data-scale-preset="25" style="flex:1;min-width:46px;padding:2px 4px;margin:0">25%</button>
                          <button class="wp-btn" data-scale-preset="50" style="flex:1;min-width:46px;padding:2px 4px;margin:0">50%</button>
                          <button class="wp-btn" data-scale-preset="100" style="flex:1;min-width:46px;padding:2px 4px;margin:0">100%</button>
                          <button class="wp-btn" data-scale-preset="200" style="flex:1;min-width:46px;padding:2px 4px;margin:0">200%</button>
                          <button class="wp-btn" data-scale-preset="500" style="flex:1;min-width:46px;padding:2px 4px;margin:0">500%</button>
                      </div>
                      <input type="number" id="scale-input" min="5" max="1000" step="1" value="${Math.round((cfg.overlayScale || 1) * 100)}" class="wp-input" style="margin-top:4px;font:11px monospace" title="exact %">
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("grid")}${t("dispLegend")}</div>
                      <div id="ov-display-seg">${segmented([{ value: "overlay", label: "▦ " + t("dispOverlay") }, { value: "dots", label: "• " + t("dispDots") }], cfg.compactMarkers ? "dots" : "overlay")}</div>
                      <!-- OVERLAY mode: opacity -->
                      <div id="opacity-group" style="margin-top:6px;${cfg.compactMarkers ? "display:none" : ""}">
                          <div style="font-size:11px;margin-bottom:2px">${t("opacity")}</div>
                          <input type="range" id="opacity-range" min="0" max="1" step="0.05" value="${cfg.defaultOpacity}" style="width:100%">
                      </div>
                      <!-- DOTS mode: marker sizing + live-refresh -->
                      <div id="compact-size-wrap" style="margin-top:6px;${cfg.compactMarkers ? "" : "display:none"}">
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-bottom:4px">${t("dispDotsNote")}</div>
                          Dot size: <span id="compact-size-val">${cfg.compactMarkerSize}%</span> of pixel
                          <input type="range" id="cfg-compact-size" min="10" max="90" step="5" value="${cfg.compactMarkerSize}" style="width:100%">
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">Marker is centred inside each canvas pixel. Pixels already matching the canvas are skipped.</div>
                          <div style="margin-top:8px">Live refresh: <span id="dots-refresh-val">${cfg.dotsRefreshMs}ms</span>
                              <input type="range" id="cfg-dots-refresh" min="200" max="10000" step="100" value="${cfg.dotsRefreshMs}" style="width:100%">
                              <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">How often the overlay re-checks the canvas. 500 ms = snappy, 2000 ms = quieter.</div>
                          </div>
                      </div>
                  </div>
                  <!-- Drill-in rows: each opens a full-pane detail screen with a
                       compact live headline. Content lives in the ov-drill-*
                       containers below (kept in the DOM so their listeners,
                       wired once, survive navigation). -->
                  <button class="wd-drillrow" data-drill="anim">
                      <span class="wd-drillrow-t">${ic("bolt")}${t("animLegend")}</span>
                      <span class="wd-drillrow-hl" id="ov-row-anim-hl">${t("animStatusOff")}</span><span class="wd-drillrow-arr">▸</span>
                  </button>
                  <button class="wd-drillrow" data-drill="protect">
                      <span class="wd-drillrow-t">${ic("shield")}${t("protectLegend")}</span>
                      <span class="wd-drillrow-hl" id="ov-row-protect-hl"></span><span class="wd-drillrow-arr">▸</span>
                  </button>
                  <button class="wd-drillrow" data-drill="progress">
                      <span class="wd-drillrow-t">${ic("scan")}${t("progress")}</span>
                      <span class="wd-drillrow-hl" id="ov-row-progress-hl">—</span><span class="wd-drillrow-arr">▸</span>
                  </button>
                  <button class="wd-drillrow" data-drill="guide">
                      <span class="wd-drillrow-t">🧭 ${t("guideLegend")}</span>
                      <span class="wd-drillrow-hl" id="ov-row-guide-hl"></span><span class="wd-drillrow-arr">▸</span>
                  </button>
                  <button class="wp-btn active-state" id="btn-lock">${t("unlock")}</button>
                  <button class="wp-btn" id="btn-toggle">${t("visibility")}</button>
                  <!-- Wall snapshot (relocated here after the Social tab was retired). -->
                  <div class="wp-group"><div class="wp-legend">${ic("dl")}${t("snapshot")}</div>
                      <select id="snapshot-quality" class="wp-input" style="font:11px sans-serif">
                          <option value="low">Low — 1500×1050 · ~30 tiles · fastest</option>
                          <option value="medium">Medium — 3000×2100 · ~108 tiles</option>
                          <option value="high" selected>High — 6000×4200 · ~408 tiles · best</option>
                      </select>
                      <button class="wp-btn" id="btn-snapshot">${ic("dl")}${t("snapshot")}</button>
                  </div>
              </div><!-- /ov-root -->

              <!-- DRILL: Animation -->
              <div id="ov-drill-anim" class="ov-drill" style="display:none">
                  <div class="wd-stack-back" data-drill-back role="button" tabindex="0"><span aria-hidden="true">‹</span> ${t("animLegend")}</div>
                  <div class="wp-group">
                      <div class="wp-hud" id="anim-status">${t("animStatusOff")}</div>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-anim-stop" style="flex:1;margin:0">${t("animStop")}</button>
                          <button class="wp-btn" id="btn-anim-advanced" style="flex:1;margin:0">${t("animAdvanced")} ▸</button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("animHint")}</div>
                      <div id="anim-advanced-wrap" style="display:none;margin-top:6px">
                          <div class="wp-row">
                              <div>W<input type="number" id="anim-frame-w" class="wp-input" min="1"></div>
                              <div>H<input type="number" id="anim-frame-h" class="wp-input" min="1"></div>
                              <div>#<input type="number" id="anim-frame-count" class="wp-input" min="1"></div>
                          </div>
                          <button class="wp-btn" id="btn-anim-autosplit" style="margin-top:4px;width:100%">${t("animAutosplit")}</button>
                          <div class="wp-row" style="margin-top:4px">
                              <select id="anim-layout" class="wp-input" style="font:11px sans-serif">
                                  <option value="grid">${t("animLayoutGrid")}</option>
                                  <option value="line">${t("animLayoutLine")}</option>
                              </select>
                              <select id="anim-order" class="wp-input" style="font:11px sans-serif">
                                  <option value="row">${t("animOrderRow")}</option>
                                  <option value="column">${t("animOrderColumn")}</option>
                                  <option value="serpentine">${t("animOrderSerp")}</option>
                              </select>
                          </div>
                          <div style="margin-top:4px">${t("animFrameMs")}
                              <input type="number" id="anim-frame-ms" class="wp-input" min="50" step="50" value="1000">
                          </div>
                          <label class="wp-check"><input type="checkbox" id="anim-looping" checked> ${t("animLooping")}</label>
                          <div style="margin-top:4px">${t("animScaling")}
                              <select id="anim-scaling" class="wp-input" style="font:11px sans-serif">
                                  <option value="native">${t("animScalingNative")}</option>
                                  <option value="scaled">${t("animScalingScaled")}</option>
                              </select>
                          </div>
                          <div style="display:flex;gap:4px;margin-top:6px">
                              <button class="wp-btn primary" id="btn-anim-apply" style="flex:1;margin:0">${t("animApply")}</button>
                              <button class="wp-btn" id="btn-anim-start-now" style="flex:1;margin:0">${t("animStartNow")}</button>
                          </div>
                          <div style="display:flex;gap:4px;margin-top:4px">
                              <button class="wp-btn" id="btn-anim-export-walldev" style="flex:1;margin:0">${t("animExportOur")}</button>
                              <button class="wp-btn" id="btn-anim-export-charity" style="flex:1;margin:0">${t("animExportCharity")}</button>
                          </div>
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:6px">${t("animPublishMoved")}</div>
                      </div>
                  </div>
              </div>

              <!-- DRILL: Protect regions -->
              <div id="ov-drill-protect" class="ov-drill" style="display:none">
                  <div class="wd-stack-back" data-drill-back role="button" tabindex="0"><span aria-hidden="true">‹</span> ${t("protectLegend")}</div>
                  ${buildProtectPane()}
              </div>

              <!-- DRILL: Progress -->
              <div id="ov-drill-progress" class="ov-drill" style="display:none">
                  <div class="wd-stack-back" data-drill-back role="button" tabindex="0"><span aria-hidden="true">‹</span> ${t("progress")}</div>
                  <div class="ov-prog-hero">
                      <div class="ov-prog-pct" id="ov-prog-pct">—</div>
                      <div class="ov-prog-bar"><div class="ov-prog-fill" id="ov-prog-fill" style="width:0%"></div></div>
                  </div>
                  <div class="ov-prog-counts">
                      <div class="ov-prog-cell"><div class="k">${t("progTotal")}</div><div class="wd-readout" id="ov-prog-total">—</div></div>
                      <div class="ov-prog-cell"><div class="k">${t("progDone")}</div><div class="wd-readout" id="ov-prog-done">—</div></div>
                      <div class="ov-prog-cell"><div class="k">${t("progLeft")}</div><div class="wd-readout" id="ov-prog-left">—</div></div>
                  </div>
                  <div class="wp-hud" id="wp-progress" style="margin-top:6px;font-size:10px">—</div>
                  <div style="margin:6px 0;font-size:11px">${t("progressTolerance")}: <span id="prog-tol-val">${cfg.progressTolerancePct}%</span>
                      <input type="range" id="cfg-progress-tol" min="0" max="25" step="1" value="${cfg.progressTolerancePct}" style="width:100%">
                      <div class="wp-note" style="color:var(--sub);font-size:10px">${t("progressToleranceNote")}</div>
                  </div>
                  <button class="wp-btn" id="btn-progress">${ic("scan")}${t("progRecount")}</button>
                  <button class="wp-btn" id="btn-progress-guide">${t("showRemaining")}</button>
              </div>

              <!-- DRILL: Guide layer (local-only annotation) -->
              <div id="ov-drill-guide" class="ov-drill" style="display:none">
                  <div class="wd-stack-back" data-drill-back role="button" tabindex="0"><span aria-hidden="true">‹</span> ${t("guideLegend")}</div>
                  <div class="wp-note" style="color:var(--sub);font-size:10px;margin-bottom:6px">${t("guideAbout")}</div>
                  <div class="wp-group"><div class="wp-legend">${ic("grid")}${t("dispLegend")}</div>
                      <div id="ov-guide-seg">${segmented([{ value: "pixels", label: "▦ " + t("guidePixels") }, { value: "dots", label: "• " + t("guideDots") }], cfg.guideMode || "pixels")}</div>
                      <div style="margin-top:6px;font-size:11px">${t("opacity")}</div>
                      <input type="range" id="guide-opacity" min="0" max="1" step="0.05" value="${cfg.guideOpacity}" style="width:100%">
                      <label class="wp-check" style="margin-top:4px"><input type="checkbox" id="guide-visible" ${cfg.guideVisible !== false ? "checked" : ""}> ${t("guideVisible")}</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">🖌 ${t("guideTools")}</div>
                      <span class="wd-seg wd-seg--tools" id="ov-guide-tool">
                          <button data-tool="pen" title="${esc(t("guidePen"))}">✏</button>
                          <button data-tool="eraser" title="${esc(t("guideEraser"))}">▱</button>
                          <button data-tool="line" title="${esc(t("guideLine"))}">╲</button>
                          <button data-tool="rect" title="${esc(t("guideRect"))}">▭</button>
                          <button data-tool="rectfill" title="${esc(t("guideRectFill"))}">▬</button>
                          <button data-tool="eyedropper" title="${esc(t("guidePick"))}">💧</button>
                      </span>
                      <div style="margin-top:6px;font-size:11px">${t("guideBrush")}: <span id="guide-brush-val">${cfg.guideBrush}</span>
                          <input type="range" id="guide-brush" min="1" max="16" step="1" value="${cfg.guideBrush}" style="width:100%">
                      </div>
                      <div style="margin-top:6px;font-size:11px">${t("guideColor")}</div>
                      <div class="wp-sw" id="ov-guide-sw">${PALETTE.map((h) => `<button data-ghex="${h}" style="background:${h}" title="${h}" class="${h.toLowerCase() === (cfg.guideColor || "").toLowerCase() ? "sel" : ""}"></button>`).join("")}</div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("guideDrawNote")}</div>
                  </div>
                  <button class="wp-btn" id="btn-guide-remaining">${ic("scan")}${t("showRemaining")}</button>
                  <button class="wp-btn" id="btn-guide-clear" style="color:var(--err)">🗑 ${t("guideClear")}</button>
              </div>
          </div>`;
}
