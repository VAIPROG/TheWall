/**
 * Template/region protection (test mode).
 *
 * "Fix the current state as stable, alarm when it breaks." The reference is
 * captured from the tile server's native layer-0 tiles — the same clean,
 * watermark-free, full-resolution source the snapshot stitcher uses — so it
 * works for ANY rect: under a loaded template (captureTemplateRegion) or a
 * hand-picked zone with no template at all (captureRegion). The capture is
 * what's on the wall RIGHT NOW, not the template image, so an evolved artwork
 * can be fixed exactly as built.
 *
 * Verification re-reads the rect and scores it through the pure
 * protect-core (tolerance in % of broken painted cells). Violations emit a
 * `wd:protection-violated` CustomEvent + toast; the optional watch loop
 * re-verifies on an interval.
 *
 * Persistence: localStorage, reference stored as a PNG data URL (compact,
 * survives reloads). One shared offscreen canvas for encode/decode.
 */
import { log } from "./log";
import { toast } from "./notify";
import { errMsg } from "./helpers";
import { readWallRegionFromTiles } from "./snapshot";
import { overlayData } from "./overlay";
import { evaluateProtection, type ProtectionVerdict } from "./protect-core";

export interface ProtectedRegion {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Allowed % of broken painted cells before alarm. */
  tolerancePct: number;
  capturedAt: number;
  /** Reference pixels as a PNG data URL. */
  refPng: string;
}

export interface ProtectionReport {
  region: ProtectedRegion;
  verdict: ProtectionVerdict;
}

const STORE_KEY = "wd_protected_regions_v1";
const MAX_REGION_PIXELS = 1024 * 1024; // 1M cells ≈ whole 1024² art — plenty

let _codecCanvas: HTMLCanvasElement | null = null;

function codecCtx(w: number, h: number): CanvasRenderingContext2D | null {
  if (!_codecCanvas) _codecCanvas = document.createElement("canvas");
  if (_codecCanvas.width !== w || _codecCanvas.height !== h) {
    _codecCanvas.width = w;
    _codecCanvas.height = h;
  }
  return _codecCanvas.getContext("2d", { willReadFrequently: true });
}

function encodePng(buf: Uint8ClampedArray, w: number, h: number): string | null {
  const ctx = codecCtx(w, h);
  if (!ctx) return null;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(buf), w, h), 0, 0);
  return _codecCanvas!.toDataURL("image/png");
}

function decodePng(dataUrl: string, w: number, h: number): Promise<Uint8ClampedArray> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const ctx = codecCtx(w, h);
      if (!ctx) return reject(new Error("no 2d context"));
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, w, h).data);
    };
    img.onerror = () => reject(new Error("reference decode failed"));
    img.src = dataUrl;
  });
}

export function listProtectedRegions(): ProtectedRegion[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveRegions(regions: ProtectedRegion[]): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(regions));
  } catch (e: any) {
    log("PROTECT", "WARN", "persist failed (quota?): " + (e?.name || e));
    toast("Protect", "could not persist region (storage full?)");
  }
}

/**
 * Fix the current wall state of a rect as the protected reference.
 * Works with or without a template — this IS the "select a zone and go" path.
 */
export async function captureRegion(
  x: number,
  y: number,
  w: number,
  h: number,
  opts: { name?: string; tolerancePct?: number } = {},
): Promise<ProtectedRegion | null> {
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  if (w <= 0 || h <= 0) {
    toast("Protect", "empty region");
    return null;
  }
  if (w * h > MAX_REGION_PIXELS) {
    toast("Protect", `region too large (${w}×${h})`);
    return null;
  }
  const buf = await readWallRegionFromTiles(x, y, w, h);
  if (!buf) {
    toast("Protect", "could not read wall tiles");
    return null;
  }
  const refPng = encodePng(buf, w, h);
  if (!refPng) {
    toast("Protect", "encode failed");
    return null;
  }
  const region: ProtectedRegion = {
    id: `pr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name: opts.name || `region ${x},${y} ${w}×${h}`,
    x, y, w, h,
    tolerancePct: Math.max(0, Math.min(100, opts.tolerancePct ?? 0)),
    capturedAt: Date.now(),
    refPng,
  };
  const all = listProtectedRegions();
  all.push(region);
  saveRegions(all);
  log("PROTECT", "OK", `captured "${region.name}" (${w}×${h}, tol ${region.tolerancePct}%)`);
  toast("Protect", `fixed "${region.name}" as stable`);
  return region;
}

/** Capture the rect currently under the loaded template. */
export async function captureTemplateRegion(
  opts: { name?: string; tolerancePct?: number } = {},
): Promise<ProtectedRegion | null> {
  if (!overlayData.w || !overlayData.h) {
    toast("Protect", "load a template first (or use captureRegion)");
    return null;
  }
  return captureRegion(overlayData.x, overlayData.y, overlayData.w, overlayData.h, opts);
}

export function removeProtectedRegion(id: string): boolean {
  const all = listProtectedRegions();
  const next = all.filter((r) => r.id !== id);
  if (next.length === all.length) return false;
  saveRegions(next);
  return true;
}

/** Re-read the wall and score one region against its reference. */
export async function verifyRegion(region: ProtectedRegion): Promise<ProtectionReport> {
  const ref = await decodePng(region.refPng, region.w, region.h);
  const cur = await readWallRegionFromTiles(region.x, region.y, region.w, region.h);
  const verdict = evaluateProtection(ref, region.w, region.h, cur, region.tolerancePct);
  if (!verdict.ok) {
    log(
      "PROTECT",
      "WARN",
      `"${region.name}" VIOLATED: ${verdict.broken}/${verdict.total} cells (${verdict.brokenPct.toFixed(2)}% > ${verdict.tolerancePct}%)`,
    );
    document.dispatchEvent(
      new CustomEvent("wd:protection-violated", { detail: { region, verdict } }),
    );
    toast(
      "Protect ⚠",
      `"${region.name}" broken: ${verdict.broken} px (${verdict.brokenPct.toFixed(1)}%)`,
    );
  } else {
    log(
      "PROTECT",
      "OK",
      `"${region.name}" intact: ${verdict.intact}/${verdict.total} (${verdict.brokenPct.toFixed(2)}% broken ≤ ${verdict.tolerancePct}%)`,
    );
  }
  return { region, verdict };
}

export async function verifyAllRegions(): Promise<ProtectionReport[]> {
  const out: ProtectionReport[] = [];
  for (const r of listProtectedRegions()) {
    try {
      out.push(await verifyRegion(r));
    } catch (e: any) {
      log("PROTECT", "ERR", `verify "${r.name}" failed: ${errMsg(e)}`);
    }
  }
  return out;
}

/* --------------------------- watch loop --------------------------------- */

let _watchTimer: number | null = null;

export function startProtectionWatch(intervalMs = 60_000): void {
  if (_watchTimer !== null) return;
  const ms = Math.max(10_000, intervalMs);
  _watchTimer = window.setInterval(() => {
    verifyAllRegions().catch(() => {});
  }, ms);
  log("PROTECT", "OK", `watch started (every ${ms / 1000}s)`);
  toast("Protect", `watching ${listProtectedRegions().length} region(s)`);
}

export function stopProtectionWatch(): void {
  if (_watchTimer !== null) {
    clearInterval(_watchTimer);
    _watchTimer = null;
    log("PROTECT", "INFO", "watch stopped");
  }
}
