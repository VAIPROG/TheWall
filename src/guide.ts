/**
 * Guide layer — a LOCAL-ONLY annotation canvas laid over the wall.
 *
 * It is never uploaded, published or shared: it exists purely so you can mark
 * things up and orient yourself while tweaking a template locally. It persists
 * to IndexedDB (same `walldev`/`kv` store the overlay uses) so it survives
 * reloads, and offers pen / eraser tools plus a pixels-vs-dots pen style.
 *
 * The canvas itself lives in overlay.ts (`guideCanvas` / `guideCtx`, full wall
 * size). This module only adds interaction, persistence and styling.
 */
import { WALL_W, WALL_H } from "./constants";
import { cfg, saveCfg } from "./config";
import { guideCanvas, guideCtx } from "./overlay";
import { log } from "./log";

const DB_NAME = "walldev";
const STORE = "kv";
const KEY = "guideLayer";
const SAVE_DEBOUNCE_MS = 900;

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
function idbSet(key: string, val: unknown): Promise<void> {
  return db().then(
    (d) =>
      new Promise((res, rej) => {
        const r = d.transaction(STORE, "readwrite").objectStore(STORE).put(val, key);
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      }),
  );
}
function idbGet<T>(key: string): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise((res, rej) => {
        const r = d.transaction(STORE, "readonly").objectStore(STORE).get(key);
        r.onsuccess = () => res(r.result as T);
        r.onerror = () => rej(r.error);
      }),
  );
}

export type GuideTool =
  | "pen"
  | "eraser"
  | "line"
  | "rect"
  | "rectfill"
  | "eyedropper"
  | null;
/** Tools that commit a shape on release (drawn live on the preview canvas). */
const SHAPE_TOOLS = new Set(["line", "rect", "rectfill"]);
let activeTool: GuideTool = null;
let drawing = false;
let bound = false;
let startX = 0;
let startY = 0;
let lastX = 0;
let lastY = 0;

// Transient preview canvas (shape tools render here while dragging, then commit
// to the guide on release). Same size/position as the guide, non-interactive.
let preview: HTMLCanvasElement | null = null;
let previewCtx: CanvasRenderingContext2D | null = null;
function ensurePreview(): void {
  if (preview || !guideCanvas || !guideCanvas.parentElement) return;
  preview = document.createElement("canvas");
  preview.id = "walldev-guide-preview";
  preview.width = WALL_W;
  preview.height = WALL_H;
  preview.style.cssText =
    "position:absolute;left:0;top:0;pointer-events:none;image-rendering:pixelated;z-index:99998";
  guideCanvas.parentElement.appendChild(preview);
  previewCtx = preview.getContext("2d");
}
function clearPreview(): void {
  if (preview && previewCtx) previewCtx.clearRect(0, 0, preview.width, preview.height);
}
function penColor(): string {
  return cfg.guideColor || "#ff2bd6";
}
/** Draw the current shape tool from (x0,y0) to (x1,y1) onto a context. */
function drawShape(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const b = Math.max(1, cfg.guideBrush ?? 1);
  ctx.save();
  ctx.strokeStyle = penColor();
  ctx.fillStyle = penColor();
  ctx.lineWidth = b;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (activeTool === "line") {
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0 + 0.5);
    ctx.lineTo(x1 + 0.5, y1 + 0.5);
    ctx.stroke();
  } else if (activeTool === "rect") {
    ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  } else if (activeTool === "rectfill") {
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0) + 1, Math.abs(y1 - y0) + 1);
  }
  ctx.restore();
}
/** Eyedropper: read the guide pixel and adopt its colour as the pen colour. */
function pickColor(x: number, y: number): void {
  if (!guideCtx) return;
  const d = guideCtx.getImageData(x, y, 1, 1).data;
  if (d[3] < 10) return; // transparent — nothing to sample
  const hex =
    "#" + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, "0")).join("");
  cfg.guideColor = hex;
  saveCfg();
  document.dispatchEvent(new CustomEvent("wd:guide-color", { detail: hex }));
}

/** Apply opacity + visibility from cfg to the guide canvas element. */
export function applyGuideStyle(): void {
  if (!guideCanvas) return;
  guideCanvas.style.opacity = String(cfg.guideOpacity ?? 0.85);
  guideCanvas.style.display = cfg.guideVisible === false ? "none" : "";
}

/** Enable/disable a drawing tool. When a tool is active the guide canvas
 *  receives pointer events; otherwise it stays click-through (`none`). */
export function setGuideTool(tool: GuideTool): void {
  activeTool = tool;
  if (!guideCanvas) return;
  guideCanvas.style.pointerEvents = tool ? "auto" : "none";
  guideCanvas.style.cursor = tool
    ? tool === "eyedropper"
      ? "copy"
      : "crosshair"
    : "";
  ensurePreview();
  bindDrawing();
}
export function getGuideTool(): GuideTool {
  return activeTool;
}

/** Map a pointer event to a wall pixel via the canvas' *visual* rect, so it is
 *  correct at any site pan/zoom (getBoundingClientRect includes transforms). */
function eventToPixel(e: PointerEvent): { x: number; y: number } | null {
  if (!guideCanvas) return null;
  const rect = guideCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = Math.floor(((e.clientX - rect.left) / rect.width) * guideCanvas.width);
  const y = Math.floor(((e.clientY - rect.top) / rect.height) * guideCanvas.height);
  if (x < 0 || y < 0 || x >= WALL_W || y >= WALL_H) return null;
  return { x, y };
}

function stamp(x: number, y: number): void {
  if (!guideCtx) return;
  const b = Math.max(1, cfg.guideBrush ?? 1);
  const half = Math.floor(b / 2);
  const ox = x - half;
  const oy = y - half;
  if (activeTool === "eraser") {
    guideCtx.clearRect(ox, oy, b, b);
    return;
  }
  guideCtx.fillStyle = cfg.guideColor || "#ff2bd6";
  if ((cfg.guideMode || "pixels") === "dots" && b >= 2) {
    // Dots style: a centred round dot instead of a filled square (leaves the
    // wall visible around it). Meaningful for brush ≥ 2; a 1-px brush is a dot
    // either way.
    guideCtx.beginPath();
    guideCtx.arc(x + 0.5, y + 0.5, b / 2, 0, Math.PI * 2);
    guideCtx.fill();
  } else {
    guideCtx.fillRect(ox, oy, b, b);
  }
}

let saveTimer: number | null = null;
function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveGuide();
  }, SAVE_DEBOUNCE_MS);
}

function bindDrawing(): void {
  if (bound || !guideCanvas) return;
  bound = true;
  const canvas = guideCanvas;
  canvas.addEventListener("pointerdown", (e) => {
    if (!activeTool) return;
    const p = eventToPixel(e);
    if (!p) return;
    if (activeTool === "eyedropper") {
      pickColor(p.x, p.y);
      e.preventDefault();
      return;
    }
    drawing = true;
    startX = lastX = p.x;
    startY = lastY = p.y;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    // Freehand tools stamp immediately; shape tools wait for release.
    if (activeTool === "pen" || activeTool === "eraser") stamp(p.x, p.y);
    e.preventDefault();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drawing || !activeTool) return;
    const p = eventToPixel(e);
    if (!p) return;
    lastX = p.x;
    lastY = p.y;
    if (activeTool === "pen" || activeTool === "eraser") {
      stamp(p.x, p.y);
    } else if (SHAPE_TOOLS.has(activeTool) && previewCtx && preview) {
      previewCtx.clearRect(0, 0, preview.width, preview.height);
      drawShape(previewCtx, startX, startY, p.x, p.y);
    }
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    // Commit a shape from its stored start to where the pointer was released.
    if (activeTool && SHAPE_TOOLS.has(activeTool) && guideCtx) {
      drawShape(guideCtx, startX, startY, lastX, lastY);
      clearPreview();
    }
    scheduleSave();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

/** Wipe the entire guide layer. */
export function clearGuide(): void {
  if (guideCtx) guideCtx.clearRect(0, 0, WALL_W, WALL_H);
  scheduleSave();
  log("GUIDE", "INFO", "guide cleared");
}

/** Persist the guide canvas to IndexedDB as a PNG blob (debounced caller). */
export async function saveGuide(): Promise<void> {
  if (!guideCanvas) return;
  try {
    const blob: Blob | null = await new Promise((res) =>
      guideCanvas!.toBlob((b) => res(b), "image/png"),
    );
    if (blob) await idbSet(KEY, blob);
  } catch {
    log("GUIDE", "WARN", "guide save failed");
  }
}

/** Restore the saved guide onto the canvas, if any. */
export async function restoreGuide(): Promise<void> {
  if (!guideCtx || !guideCanvas) return;
  try {
    const blob = await idbGet<Blob>(KEY);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error("guide image decode failed"));
      img.src = url;
    });
    guideCtx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    log("GUIDE", "INFO", "guide restored from storage");
  } catch {
    /* no saved guide, or decode failed — start blank */
  }
}

/** Run once after the wall layers exist: restore the saved guide + apply
 *  opacity/visibility. */
export function initGuide(): void {
  applyGuideStyle();
  void restoreGuide();
}
