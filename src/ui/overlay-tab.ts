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
import { confirmDlg, errorDlg } from "../dialog";
import { log } from "../log";
import { triggerEvent } from "../achievements";

// Module-level state for debouncing scale changes.
let scaleTimer: number | null = null;

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

export function wireOverlay(_win: HTMLElement): void {
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
    const sval = $("scale-val");
    if (sval) sval.textContent = `${pct}%`;
    for (const id of ["scale-range", "scale-input"]) {
      const el = $(id) as HTMLInputElement | null;
      if (el && document.activeElement !== el) el.value = String(pct);
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

  // Compact-marker mode
  $("cfg-compact-markers")?.addEventListener("change", (e: Event) => {
    cfg.compactMarkers = (e.target as HTMLInputElement).checked;
    saveCfg();
    const wrap = $("compact-size-wrap");
    if (wrap) wrap.style.display = cfg.compactMarkers ? "" : "none";
    // Hide the opacity control entirely when dots are on — its slider is
    // a no-op in that mode and showing it confuses people who think it
    // should still work.
    const opacityGroup = $("opacity-group");
    if (opacityGroup)
      opacityGroup.style.display = cfg.compactMarkers ? "none" : "";
    if (overlayImg)
      overlayImg.style.opacity = cfg.compactMarkers
        ? "1"
        : String(cfg.defaultOpacity);
    renderOverlay();
    log(
      "OVERLAY",
      "INFO",
      "compact markers: " + (cfg.compactMarkers ? "ON" : "off"),
    );
    if (cfg.compactMarkers)
      triggerEvent("compact_mode_enabled").catch(() => {});
  });

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
}

export function buildOverlayPane(): string {
  return `<div class="wp-pane active" data-p="ov">
                  <div class="wp-group"><div class="wp-legend">${ic("disk")}${t("file")}</div>
                      <input type="file" id="file-upload" accept="image/*" class="wp-input" style="font:11px sans-serif">
                      <button class="wp-btn" id="btn-clear-overlay" style="margin-top:4px" title="${esc(t("clearOverlay"))}">${ic("trash")}${t("clearOverlay")}</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("send")}${t("ovShareLegend")}</div>
                      <button class="wp-btn primary" id="btn-jump-share" style="width:100%">${ic("send")}${t("ovShareGo")} →</button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("ovShareHint")}</div>
                  </div>
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
                  <div class="wp-group" id="opacity-group" style="${cfg.compactMarkers ? "display:none" : ""}"><div class="wp-legend">${t("opacity")}</div>
                      <input type="range" id="opacity-range" min="0" max="1" step="0.05" value="${cfg.defaultOpacity}" style="width:100%">
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">Opacity has no effect in dots mode — dots are always fully opaque for max readability.</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("grid")}Compact markers</div>
                      <label class="wp-check"><input type="checkbox" id="cfg-compact-markers" ${cfg.compactMarkers ? "checked" : ""}> Render every missing pixel as a small opaque dot (canvas stays visible)</label>
                      <div id="compact-size-wrap" style="margin-top:4px;${cfg.compactMarkers ? "" : "display:none"}">
                          Dot size: <span id="compact-size-val">${cfg.compactMarkerSize}%</span> of pixel
                          <input type="range" id="cfg-compact-size" min="10" max="90" step="5" value="${cfg.compactMarkerSize}" style="width:100%">
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">Marker is centred inside each canvas pixel. Pixels already matching the canvas are skipped.</div>
                          <div style="margin-top:8px">Live refresh: <span id="dots-refresh-val">${cfg.dotsRefreshMs}ms</span>
                              <input type="range" id="cfg-dots-refresh" min="200" max="10000" step="100" value="${cfg.dotsRefreshMs}" style="width:100%">
                              <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">How often the overlay re-checks the canvas. 500 ms = snappy, 2000 ms = quieter.</div>
                          </div>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("bolt")}${t("animLegend")}</div>
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
                  <div class="wp-group"><div class="wp-legend">${ic("scan")}${t("progress")}</div>
                      <div class="wp-hud" id="wp-progress">—</div>
                      <button class="wp-btn" id="btn-progress">${ic("scan")}${t("progress")}</button>
                      <button class="wp-btn" id="btn-progress-guide">${t("showRemaining")}</button>
                  </div>
                  <button class="wp-btn active-state" id="btn-lock">${t("unlock")}</button>
                  <button class="wp-btn" id="btn-toggle">${t("visibility")}</button>
              </div>`;
}
