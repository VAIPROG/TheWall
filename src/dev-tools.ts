/**
 * Development-only console API (`window.__wallDev`).
 *
 * Installed exclusively by dev builds: build.ts defines `__WALLDEV_DEV__`
 * per mode, index.ts calls installDevTools() behind that flag, and esbuild
 * dead-code-eliminates both the call and this whole module from release /
 * smallest bundles. Nothing here may be load-bearing for production paths.
 *
 * Devtools usage:
 *   __wallDev.loadConfig({...} | "json")   — auto-detects ours vs Charity
 *   __wallDev.exportCharityConfig({imageUrl: "https://…/sheet.png"})
 *   __wallDev.exportWallDevJson({templateName: "..."})
 *   __wallDev.autoSplitSheet(1050, 900, {frameCount: 41})
 *   __wallDev.protect.captureRegion(x, y, w, h, {tolerancePct: 1})
 *   __wallDev.protect.captureTemplate({tolerancePct: 0.5})
 *   __wallDev.protect.verifyAll() / .list() / .remove(id)
 *   __wallDev.protect.watch(60000) / .unwatch()
 *   __wallDev.cfg.get() / .set({overlayScale: 2}) / .reset()
 *   __wallDev.overlay()                    — current overlay state snapshot
 *   __wallDev.backend.req("GET", "/v2/me/links")
 *   __wallDev.backend.me()                 — cached backend user
 *   __wallDev.tiles.read(x, y, w, h)       — raw wall pixels for a region
 *   __wallDev.palette.quantize(buf)        — snap an RGBA buffer to the palette
 *   __wallDev.diff(template, live)         — per-pixel template/live diff
 *   __wallDev.version                      — build version string
 */
import { log } from "./log";
import { VERSION } from "./constants";
import { cfg, saveCfg, resetCfg } from "./config";
import {
  importCharityTemplate,
  exportToCharityConfig,
  parseCharityConfig,
} from "./charity-import";
import { exportToWallDevJson, applyWallDevExport } from "./walldev-config";
import { detectPayload } from "./format-detect";
import { autoSplitSheet, parseCharityTemplate } from "./animated-template";
import {
  overlayData,
  setOverlayAnimation,
  getOverlayAnimation,
  renderOverlay,
} from "./overlay";
import { getActiveClient, getMe } from "./backend/index";
import { PALETTE, quantizeBuffer } from "./palette";
import { diffTemplate } from "./template-diff";
import { readWallRegion } from "./overlay-region";
import {
  captureRegion,
  captureTemplateRegion,
  listProtectedRegions,
  removeProtectedRegion,
  verifyRegion,
  verifyAllRegions,
  startProtectionWatch,
  stopProtectionWatch,
} from "./protect";

export function installDevTools(): void {
  (window as any).__wallDev = {
    version: VERSION,

    /** One entry point for any config: detects the-wall-dev vs Charity
     *  (manifest or bare entry) via format-detect and applies it. */
    loadConfig: async (raw: unknown): Promise<boolean> => {
      const text = typeof raw === "string" ? raw : JSON.stringify(raw);
      const d = detectPayload(text);
      if (d.kind === "wall-dev-export") {
        await applyWallDevExport(d.json);
        return true;
      }
      if (d.kind === "charity-config") {
        const cfgC = parseCharityConfig(d.json);
        if (!cfgC.templates.length) return false;
        await importCharityTemplate(cfgC.templates[0]);
        return true;
      }
      log("WALLDEV", "WARN", `loadConfig: unrecognised payload (${d.kind})`);
      return false;
    },
    exportCharityConfig: (opts: any = {}) =>
      JSON.stringify(exportToCharityConfig(opts), null, 4),
    exportWallDevJson: (opts: any = {}) =>
      JSON.stringify(exportToWallDevJson(opts), null, 2),
    detectPayload,
    parseCharityTemplate,
    autoSplitSheet,
    setOverlayAnimation,
    getOverlayAnimation,

    /** Live config poke-around. `set` merges a patch and persists; `reset`
     *  wipes back to defaults. Handy for reproducing user setups. */
    cfg: {
      get: () => cfg,
      set: (patch: Record<string, unknown>) => {
        Object.assign(cfg, patch);
        saveCfg();
        return cfg;
      },
      reset: () => resetCfg(),
    },

    /** Snapshot of the overlay's placement/scale, plus a scale setter. */
    overlay: () => ({
      x: overlayData.x,
      y: overlayData.y,
      width: overlayData.origW,
      height: overlayData.origH,
      scale: cfg.overlayScale,
      hasImage: !!overlayData.src,
    }),
    setScale: (s: number) => {
      cfg.overlayScale = s;
      saveCfg();
      renderOverlay(true);
      return s;
    },

    /** Raw backend access — same client the UI uses. */
    backend: {
      req: (method: string, path: string, body?: unknown) =>
        getActiveClient()?.req({ method, path, body }),
      me: () => getMe(),
      get connected() {
        return getActiveClient()?.on ?? false;
      },
    },

    /** Read the true wall pixels for a region straight off the tile server
     *  (not the viewport canvas) — see the wall-tiles / overlay-region docs. */
    tiles: { read: readWallRegion },

    palette: { PALETTE, quantize: quantizeBuffer },
    diff: diffTemplate,

    protect: {
      captureRegion,
      captureTemplate: captureTemplateRegion,
      list: listProtectedRegions,
      remove: removeProtectedRegion,
      verify: verifyRegion,
      verifyAll: verifyAllRegions,
      watch: startProtectionWatch,
      unwatch: stopProtectionWatch,
    },
  };
  log("DEV", "OK", "__wallDev console API installed (dev build)");
}
