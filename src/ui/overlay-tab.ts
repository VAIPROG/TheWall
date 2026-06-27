import { cfg, saveCfg } from "../config";
import { WALL_W, WALL_H } from "../constants";
import { teleport } from "../coords";
import { $, errMsg } from "../helpers";
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
