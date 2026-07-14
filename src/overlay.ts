import { cfg, saveCfg } from "./config";
import {
  SEL,
  WALL_W,
  WALL_H,
  COMPACT_MARKERS_REFRESH_MS_DEFAULT,
  COMPACT_MARKERS_REFRESH_MS_MIN,
  COMPACT_MARKERS_REFRESH_MS_MAX,
} from "./constants";
import { $ } from "./helpers";
import { log } from "./log";
import { screenToCanvas, canvasToScreen, mainCanvas, canvasContainer } from "./coords";
import { readWallRegion } from "./overlay-region";
import { colorClose } from "./template-diff";
import { visibleWallRect, cullTemplateRect, type Rect } from "./viewport-cull";
import { type AnimatedTemplate } from "./animated-template";
import {
  runtimeFromCharity,
  runtimeFromWallAnim,
  type AnimRuntime,
  type WallAnimConfig,
} from "./wall-anim";

/** What the overlay is animating, kept alongside the runtime so exporters can
 *  reach the original config. */
export type AnimSource =
  | { kind: "charity"; template: AnimatedTemplate }
  | { kind: "wall-anim"; config: WallAnimConfig };
import { toast } from "./notify";
import { t } from "./i18n";
import { ic } from "./icons";
import { quantizeImageData, PALETTE, PALETTE_RGB } from "./palette";

export interface OverlayData {
  x: number;
  y: number;
  w: number;
  h: number;
  src: string;
  srcOrig?: string;
  origW?: number;
  origH?: number;
  cleanSrc?: string;
}

export let overlayImg: HTMLImageElement | null = null;
export let guideCanvas: HTMLCanvasElement | null = null;
export let guideCtx: CanvasRenderingContext2D | null = null;
export let overlayData: OverlayData = { x: 0, y: 0, w: 0, h: 0, src: "" };
export let isLocked = true;
export let isPicking = false;

let _offCanvas: HTMLCanvasElement | null = null;
let _offCtx: CanvasRenderingContext2D | null = null;
let _offW = 0;
let _offH = 0;

let _renderGen = 0;
let _hashCanvas: HTMLCanvasElement | null = null;

let _cachedTemplateData: ImageData | null = null;
let _cachedTemplateW = 0;
let _cachedTemplateH = 0;

/** Animation state: when set, the overlay treats srcOrig as a sprite sheet
 *  and renders only the current frame (Charity or WallAnim — one runtime). */
let _animSrc: AnimSource | null = null;
let _animRt: AnimRuntime | null = null;
let _cachedAnimFrame = -1;
let _animTimer: number | null = null;

let _diffBuf: Uint8ClampedArray | null = null;

let _lastSvgUrl: string | null = null;
let _lastSvgData: string | null = null;

// Кэш DOM-элементов для предотвращения Layout Thrashing в hot path
let _elCoordX: HTMLInputElement | null = null;
let _elCoordY: HTMLInputElement | null = null;
let _elBtnPick: HTMLElement | null = null;
let _elBtnLock: HTMLElement | null = null;
let _elCanvasContainer: HTMLElement | null = null;

const getElCoordX = () =>
  _elCoordX || (_elCoordX = $("coord-x") as HTMLInputElement);
const getElCoordY = () =>
  _elCoordY || (_elCoordY = $("coord-y") as HTMLInputElement);
const getElBtnPick = () => _elBtnPick || (_elBtnPick = $("btn-pick"));
const getElBtnLock = () => _elBtnLock || (_elBtnLock = $("btn-lock"));
const getElCanvasContainer = () =>
  _elCanvasContainer ||
  (_elCanvasContainer = document.querySelector(
    SEL.canvasContainer,
  ) as HTMLElement);

export function setIsLocked(v: boolean): void {
  isLocked = v;
}
export function setIsPicking(v: boolean): void {
  isPicking = v;
}

export function initLayers(): void {
  const layers =
    document.querySelector(SEL.paintLayers) ||
    document.querySelector(".paint-layers") ||
    document.querySelector("[class*=paint-layer]") ||
    (mainCanvas()?.parentElement as Element | null);
  if (!layers) {
    log("LAYERS", "WARN", "paint-layers not found yet — retrying");
    setTimeout(initLayers, 1000);
    return;
  }
  if (!overlayImg) {
    overlayImg = document.createElement("img");
    overlayImg.id = "walldev-overlay";
    overlayImg.draggable = false;
    overlayImg.setAttribute("draggable", "false");
    overlayImg.style.userSelect = "none";
    overlayImg.addEventListener("dragstart", (e) => e.preventDefault());
    layers.appendChild(overlayImg);
  }
  if (!guideCanvas) {
    guideCanvas = document.createElement("canvas");
    guideCanvas.id = "walldev-guide";
    guideCanvas.width = WALL_W;
    guideCanvas.height = WALL_H;
    layers.appendChild(guideCanvas);
    // willReadFrequently: guide pixels are sampled via getImageData (guide.ts).
    guideCtx = guideCanvas.getContext("2d", { willReadFrequently: true });
  }
  bindOverlayDrag();
  bindCanvasPick();
  startCompactMarkersRefresh();
  startCameraCulling();
  log("LAYERS", "OK", "overlay + guide + pick attached");
}

export function setOverlayPos(x: number, y: number): void {
  overlayData.x = x;
  overlayData.y = y;
  if (overlayImg) {
    overlayImg.style.left = x + "px";
    overlayImg.style.top = y + "px";
  }
  const cx = getElCoordX();
  if (cx) cx.value = String(x);
  const cy = getElCoordY();
  if (cy) cy.value = String(y);
  emitOverlayChanged();
}

/**
 * The "template unit" to rasterise at the current scale:
 *   - static template → the whole image
 *   - animation       → the current frame's footprint of the sprite sheet
 * The source sub-rect needs the decoded image's natural size, so it is
 * resolved later in rasteriseFrame(); here we compute only what's known up
 * front — the output footprint and which animation frame is due.
 */
interface FrameTarget {
  outW: number;
  outH: number;
  animFrame: number;
}

function frameTarget(): FrameTarget | null {
  const anim = _animRt;
  const animFrame = anim ? anim.frameAt(Date.now()) : 0;
  const unitW = (anim && anim.frameWidth) || overlayData.origW || overlayData.w;
  const unitH = (anim && anim.frameHeight) || overlayData.origH || overlayData.h;
  if (!unitW || !unitH) return null;
  // Animation scaling policy: a "scaled" config carries its own factor and
  // native/Charity pins 100%; otherwise the user's overlay scale wins.
  const scale = Math.max(
    0.05,
    Math.min(10, anim?.scaleOverride ?? (cfg.overlayScale || 1)),
  );
  return {
    outW: Math.max(1, Math.round(unitW * scale)),
    outH: Math.max(1, Math.round(unitH * scale)),
    animFrame,
  };
}

/**
 * Decode the source image, draw the current unit (whole image, or one sprite
 * frame) into the offscreen canvas at outW×outH, quantise it to the wall
 * palette, cache it, and kick the diff/markers pass. Async on image decode;
 * `gen` drops the result if a newer render started meanwhile.
 */
function rasteriseFrame(outW: number, outH: number, animFrame: number): void {
  const gen = ++_renderGen;
  const img = new Image();
  img.onload = () => {
    if (gen !== _renderGen) return;
    if (!_offCanvas || _offW !== outW || _offH !== outH) {
      _offCanvas = document.createElement("canvas");
      _offCanvas.width = outW;
      _offCanvas.height = outH;
      _offCtx = _offCanvas.getContext("2d", { willReadFrequently: true });
      _offW = outW;
      _offH = outH;
    }
    const cx = _offCtx;
    if (!cx) return;
    cx.imageSmoothingEnabled = false;
    (cx as any).imageSmoothingQuality = "low";
    const fr = _animRt
      ? _animRt.rectOf(img.naturalWidth, img.naturalHeight, animFrame)
      : { sx: 0, sy: 0, sw: img.naturalWidth, sh: img.naturalHeight };
    cx.clearRect(0, 0, outW, outH);
    cx.drawImage(img, fr.sx, fr.sy, fr.sw, fr.sh, 0, 0, outW, outH);
    const data = cx.getImageData(0, 0, outW, outH);
    quantizeImageData(data);
    cx.putImageData(data, 0, 0);

    _cachedTemplateData = data;
    _cachedTemplateW = outW;
    _cachedTemplateH = outH;
    _cachedAnimFrame = animFrame;
    overlayData.w = outW;
    overlayData.h = outH;
    overlayData.cleanSrc = undefined; // template changed → drop clean-PNG cache

    renderDiffOnly(data, outW, outH, cx);
  };
  img.src = overlayData.srcOrig || overlayData.src;
}

/**
 * Re-render the overlay for the current source, scale and (if any) animation
 * frame. Rasterises a fresh frame only when the footprint or the frame index
 * changed; otherwise it re-runs the cheap diff/markers pass over the cached
 * template. This is the thin orchestrator that replaced the old overloaded
 * `applyOverlayScale` — the work now lives in frameTarget + rasteriseFrame +
 * renderDiffOnly.
 */
export function renderOverlay(forceTemplateRebuild = false): void {
  if (!overlayImg) return;
  if (!(overlayData.srcOrig || overlayData.src)) return;
  const tgt = frameTarget();
  if (!tgt) return;
  const { outW, outH, animFrame } = tgt;
  const changed =
    forceTemplateRebuild ||
    _cachedTemplateData === null ||
    _cachedTemplateW !== outW ||
    _cachedTemplateH !== outH ||
    (_animRt !== null && _cachedAnimFrame !== animFrame);
  if (changed) {
    rasteriseFrame(outW, outH, animFrame);
  } else {
    overlayData.w = outW;
    overlayData.h = outH;
    renderDiffOnly(_cachedTemplateData!, outW, outH, _offCtx);
  }
}

/* ===========================================================================
 * Animated templates (Charity-compatible sprite sheets)
 *
 * The frame index is wall-clock-derived (same formula as Charity), so all
 * painters see the same frame at the same moment. A light ticker watches for
 * the index to roll over and rebuilds the template (frame sub-rect) when it
 * does; between rollovers the cost is one getCurrentFrameIndex per tick.
 * ======================================================================== */

export function getOverlayAnimation(): AnimSource | null {
  return _animSrc;
}

export function getOverlayAnimRuntime(): AnimRuntime | null {
  return _animRt;
}

/** Enable (or disable with null) sprite-sheet animation for the currently
 *  loaded overlay source. Accepts either format; repositioning to the
 *  template's x/y is the caller's job — this only drives frame selection and
 *  rebuild cadence. */
export function setOverlayAnimation(src: AnimSource | null, render = true): void {
  _animSrc = src;
  _animRt =
    src === null
      ? null
      : src.kind === "charity"
        ? runtimeFromCharity(src.template)
        : runtimeFromWallAnim(src.config);
  _cachedAnimFrame = -1;
  _cachedTemplateData = null; // force a frame rebuild on next render
  if (_animTimer !== null) {
    clearInterval(_animTimer);
    _animTimer = null;
  }
  if (_animRt && _animRt.frameCount > 1) {
    _animTimer = window.setInterval(animationTick, _animRt.tickMs);
    log.ok(
      "OVERLAY_ANIM",
      `animation on (${_animRt.kind}): ${_animRt.frameCount} frames, tick ${_animRt.tickMs}ms`,
    );
  } else {
    _animSrc = null;
    _animRt = null;
    log.info("OVERLAY_ANIM", "animation off");
  }
  if (render && overlayData.srcOrig) renderOverlay(true);
  emitOverlayChanged();
}

function animationTick(): void {
  if (!_animRt || !overlayData.srcOrig) return;
  if (!overlayImg || overlayImg.style.display === "none") return;
  const idx = _animRt.frameAt(Date.now());
  if (idx === _cachedAnimFrame) return;
  log.trace("OVERLAY_ANIM", `frame ${_cachedAnimFrame} → ${idx}`);
  renderOverlay();
}

/**
 * Ленивая (Lazy) генерация PNG чистой подложки — вызывается только при реальной необходимости
 */
export function getCleanOverlaySrc(): string {
  if (overlayData.cleanSrc) return overlayData.cleanSrc;
  if (_offCanvas) {
    overlayData.cleanSrc = _offCanvas.toDataURL("image/png");
  }
  return overlayData.cleanSrc || "";
}

/**
 * The quantised template at the current scale, as raw RGBA bytes. Same data in
 * dots and classic mode (it's the render-independent cache that
 * applyOverlayScale fills), so progress/diff callers get identical results
 * regardless of overlay mode and without re-decoding the image. Returns null
 * only in the brief window before the first render completes.
 */
export function getCachedTemplate():
  | { data: Uint8ClampedArray; w: number; h: number }
  | null {
  if (!_cachedTemplateData) return null;
  return { data: _cachedTemplateData.data, w: _cachedTemplateW, h: _cachedTemplateH };
}

function renderDiffOnly(
  data: ImageData,
  newW: number,
  newH: number,
  cx: CanvasRenderingContext2D | null,
): void {
  const t0 = performance.now();
  const isCompact = !!cfg.compactMarkers;

  // Dots mode → vector SVG. Crisp sub-pixel dots need a vector, not a raster.
  // The previous path rasterised dots into an 8× canvas (newW*8 × newH*8),
  // which (a) re-composited slowly on every camera move because the bitmap
  // was 64× larger than the classic overlay, and (b) lost centring when the
  // browser downscaled that 8× texture back into the 1× overlay box. An SVG
  // stays tiny, centres each dot exactly, and the GPU scales it cheaply at
  // any zoom. Classic mode shows the full quantised template, which the
  // off-screen canvas (cx) already holds at 1:1 — read it back as a PNG.
  let url: string | null = null;
  if (isCompact) {
    url = renderCompactMarkersSvg(data, newW, newH);
  }
  if (!url) {
    // Full overlay, or dots hit the rect cap: fall back to the 1× template PNG.
    url = cx ? cx.canvas.toDataURL("image/png") : null;
  }
  if (!url) return;

  overlayData.src = url;
  if (overlayImg) {
    overlayImg.src = url;
    overlayImg.style.width = newW + "px";
    overlayImg.style.height = newH + "px";
    overlayImg.style.display = "block";
    overlayImg.style.imageRendering = "pixelated";
  }

  log.ok(
    "OVERLAY_RENDER",
    `mode=${isCompact ? "dots(svg)" : "full(png)"} ${newW}x${newH} ` +
      `in ${Math.round(performance.now() - t0)}ms`,
  );

  lastCanvasHash = hashLiveRegion();
}
interface SvgRenderOpts {
  dotSize: number;
  diffCanvas: boolean;
}

const colorToPaletteIdx = new Map<number, number>();
for (let j = 0; j < PALETTE_RGB.length; j++) {
  const p = PALETTE_RGB[j];
  const key = (p[0] << 16) | (p[1] << 8) | p[2];
  colorToPaletteIdx.set(key, j);
}

/** Extra wall px kept around the viewport so a small pan doesn't immediately
 *  reveal un-rendered template edges before the next re-cull lands. */
const CULL_MARGIN = 8;

/** Wall rect currently visible, derived purely from the container's on-screen
 *  rect + window size (stable DOM contract — no site internals). null when the
 *  container isn't mounted, which makes culling degrade to "render all". */
function computeVisibleWallRect(): Rect | null {
  const cont = canvasContainer();
  if (!cont) return null;
  const r = cont.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return visibleWallRect(
    r.left,
    r.top,
    r.width,
    window.innerWidth,
    window.innerHeight,
    WALL_W,
    WALL_H,
    CULL_MARGIN,
  );
}

function renderTemplateSvg(
  data: ImageData,
  w: number,
  h: number,
  opts: SvgRenderOpts,
): string | null {
  const t0 = performance.now();
  const src = data.data;
  const s = Math.max(0.01, Math.min(1, opts.dotSize));
  const inset = (1 - s) / 2;
  const fullPixel = s >= 0.999;

  const liveBuf = opts.diffCanvas
    ? readLiveRegion(overlayData.x, overlayData.y, w, h)
    : null;
  const MAX_RECTS = 80000;

  // Округляем константы один раз вне цикла
  const fmt = (n: number): string => {
    const r = Math.round(n * 1000) / 1000;
    return r.toString();
  };
  const sStr = fmt(s);
  const negS = "-" + sStr;
  const insetS = fmt(inset);

  // Оптимизация: вместо Map со строковыми ключами используем фиксированный массив под 34 цвета
  const pathsByColor = Array.from(
    { length: PALETTE.length },
    () => [] as string[],
  );
  let kept = 0,
    matched = 0;

  // Константный суффикс пути — выносим из цикла, чтобы не пересобирать строку
  const suffix = fullPixel ? "h1v1h-1z" : `h${sStr}v${sStr}h${negS}z`;

  // Viewport culling — only walk the slice of the template currently on screen.
  // No-op when it's all visible; the win is at deep zoom where most of the
  // template is off screen, so we skip building rects nobody can see.
  const cull = cullTemplateRect(
    overlayData.x,
    overlayData.y,
    w,
    h,
    computeVisibleWallRect(),
  );

  if (cull) {
    outer: for (let y = cull.y0; y < cull.y1; y++) {
      for (let x = cull.x0; x < cull.x1; x++) {
        const i = (y * w + x) * 4;
        if (src[i + 3] < 128) continue; // template hole
        if (
          liveBuf &&
          colorClose(src[i], src[i + 1], src[i + 2], liveBuf[i], liveBuf[i + 1], liveBuf[i + 2])
        ) {
          matched++;
          continue; // already painted correctly
        }
        if (kept >= MAX_RECTS) break outer;

        // Palette index via bit-key, integer M coords (the <g translate>
        // applies the dot inset once for the whole group).
        const key = (src[i] << 16) | (src[i + 1] << 8) | src[i + 2];
        const idx = colorToPaletteIdx.get(key) ?? 0;
        pathsByColor[idx].push(`M${x} ${y}${suffix}`);
        kept++;
      }
    }
  }

  if (kept >= MAX_RECTS) {
    log.warn(
      "OVERLAY_SVG",
      `rect cap (${MAX_RECTS}) hit — caller falls back to PNG`,
    );
    return null;
  }

  // Быстрая джойн-сборка тегов <path> по индексам палитры
  let paths = "";
  for (let j = 0; j < pathsByColor.length; j++) {
    if (pathsByColor[j].length > 0) {
      paths += `<path fill="${PALETTE[j]}" d="${pathsByColor[j].join("")}"/>`;
    }
  }

  // Если это режим точек, смещаем всю группу один раз через SVG-трансформ!
  if (!fullPixel) {
    paths = `<g transform="translate(${insetS}, ${insetS})">${paths}</g>`;
  }

  const shapeRendering = fullPixel ? "crispEdges" : "geometricPrecision";
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" ` +
    `width="${w}" height="${h}" shape-rendering="${shapeRendering}">${paths}</svg>`;

  log.ok(
    "OVERLAY_SVG",
    `mode=${fullPixel ? "full" : `dot ${Math.round(s * 100)}%`} ` +
      `kept=${kept}/${kept + matched} colours=${PALETTE.length} ` +
      `inset=${insetS}` +
      (liveBuf ? " (diffed)" : " (no canvas)") +
      ` in ${Math.round(performance.now() - t0)}ms`,
  );

  if (_lastSvgUrl) URL.revokeObjectURL(_lastSvgUrl);
  const blob = new Blob([svg], { type: "image/svg+xml" });
  _lastSvgUrl = URL.createObjectURL(blob);
  _lastSvgData = svg;
  return _lastSvgUrl;
}

let markerRefreshTimer: number | null = null;
let lastCanvasHash = 0;

function hashLiveRegion(): number {
  const c = mainCanvas();
  if (!c || !overlayData.w || !overlayData.h) return 0;
  try {
    const ctx = c.getContext("2d");
    if (!ctx) return 0;
    const rx = Math.max(0, Math.min(c.width - 1, overlayData.x));
    const ry = Math.max(0, Math.min(c.height - 1, overlayData.y));
    const rw = Math.max(1, Math.min(c.width - rx, overlayData.w));
    const rh = Math.max(1, Math.min(c.height - ry, overlayData.h));
    const sw = Math.max(1, Math.ceil(rw / 8));
    const sh = Math.max(1, Math.ceil(rh / 8));
    if (!_hashCanvas) _hashCanvas = document.createElement("canvas");
    _hashCanvas.width = sw;
    _hashCanvas.height = sh;
    // willReadFrequently: this scratch canvas exists purely to getImageData the
    // downsampled live region on every change-detection poll (hot path).
    const hctx = _hashCanvas.getContext("2d", { willReadFrequently: true });
    if (!hctx) return 0;
    hctx.drawImage(c, rx, ry, rw, rh, 0, 0, sw, sh);
    const data = hctx.getImageData(0, 0, sw, sh).data;
    let h = 2166136261;
    const step = 16;
    for (let i = 0; i < data.length; i += step) {
      h ^= data[i];
      h = Math.imul(h, 16777619);
    }
    return h | 0;
  } catch {
    return 0;
  }
}

function compactMarkersTick(): void {
  if (!cfg.compactMarkers) return;
  if (!overlayImg || overlayImg.style.display === "none") return;
  if (!overlayData.srcOrig) return;
  const h = hashLiveRegion();
  if (h === 0 || h === lastCanvasHash) return;
  log.trace(
    "OVERLAY_MARKERS",
    `live region changed (hash ${lastCanvasHash}→${h}) — redraw`,
  );
  lastCanvasHash = h;
  renderOverlay();
}

function effectiveDotsRefreshMs(): number {
  const raw = cfg.dotsRefreshMs;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return COMPACT_MARKERS_REFRESH_MS_DEFAULT;
  }
  return Math.max(
    COMPACT_MARKERS_REFRESH_MS_MIN,
    Math.min(COMPACT_MARKERS_REFRESH_MS_MAX, Math.round(raw)),
  );
}

export function startCompactMarkersRefresh(): void {
  if (markerRefreshTimer !== null) return;
  const ms = effectiveDotsRefreshMs();
  markerRefreshTimer = window.setInterval(compactMarkersTick, ms);
  log.ok("OVERLAY_MARKERS", `auto-refresh started (every ${ms}ms)`);
}

export function stopCompactMarkersRefresh(): void {
  if (markerRefreshTimer !== null) {
    clearInterval(markerRefreshTimer);
    markerRefreshTimer = null;
    log.info("OVERLAY_MARKERS", "auto-refresh stopped");
  }
}

export function restartCompactMarkersRefresh(): void {
  stopCompactMarkersRefresh();
  startCompactMarkersRefresh();
}

export function resetCompactMarkersBaseline(): void {
  lastCanvasHash = 0;
}

/* ===========================================================================
 * Camera-driven re-cull
 *
 * The 500ms tick redraws on *canvas* changes; it doesn't know the camera
 * moved. When the user pans/zooms, the visible slice of the template changes,
 * so the culled dots SVG must be rebuilt. We watch the container's transform
 * (the site sets `style.transform = matrix(...)` on every camera update — a
 * stable DOM contract) and, after the gesture settles, re-render only if the
 * visible slice actually changed — a fully-visible template keeps the same
 * cull key, so panning it costs nothing.
 * ======================================================================== */
let _cameraObserver: MutationObserver | null = null;
let _cameraSettleTimer: number | null = null;
let _lastCullKey = "";

function currentCullKey(): string {
  const cull = cullTemplateRect(
    overlayData.x,
    overlayData.y,
    overlayData.w,
    overlayData.h,
    computeVisibleWallRect(),
  );
  return cull ? `${cull.x0},${cull.y0},${cull.x1},${cull.y1}` : "none";
}

function onCameraSettled(): void {
  if (!cfg.compactMarkers) return;
  if (!overlayImg || overlayImg.style.display === "none") return;
  if (!overlayData.srcOrig) return;
  // Re-render only when the visible slice actually changed. This check alone
  // prevents churn (a fully-visible template keeps the same key while panning),
  // so no zoom threshold is needed — and large templates that don't fit the
  // viewport even at low zoom still re-cull correctly while panning.
  const key = currentCullKey();
  if (key === _lastCullKey) return;
  _lastCullKey = key;
  renderOverlay();
}

function startCameraCulling(): void {
  if (_cameraObserver) return;
  const cont = canvasContainer();
  if (!cont) return;
  _cameraObserver = new MutationObserver(() => {
    if (_cameraSettleTimer !== null) clearTimeout(_cameraSettleTimer);
    _cameraSettleTimer = window.setTimeout(onCameraSettled, 120);
  });
  _cameraObserver.observe(cont, { attributes: true, attributeFilter: ["style"] });
  log.ok("OVERLAY_CULL", "camera-driven re-cull attached");
}

function renderCompactMarkersSvg(
  data: ImageData,
  w: number,
  h: number,
): string | null {
  const sizePct = Math.max(10, Math.min(90, cfg.compactMarkerSize ?? 40));
  return renderTemplateSvg(data, w, h, {
    dotSize: sizePct / 100,
    diffCanvas: true,
  });
}

function readLiveRegion(
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray | null {
  const c = mainCanvas();
  if (!c) return null;
  try {
    const ctx = c.getContext("2d");
    if (!ctx) return null;

    // Оптимизация O3: Проверяем и лениво выделяем персистентный буфер нужного размера
    const needed = w * h * 4;
    if (!_diffBuf || _diffBuf.length < needed) {
      _diffBuf = new Uint8ClampedArray(needed);
    }

    return readWallRegion(
      (rx, ry, rw, rh) => ctx.getImageData(rx, ry, rw, rh).data,
      c.width,
      c.height,
      x,
      y,
      w,
      h,
      _diffBuf, // КРИТИЧЕСКИЙ ИСПРАВЛЕННЫЙ АРГУМЕНТ: передаем буфер для переиспользования
    );
  } catch (e: any) {
    log("OVERLAY_MARKERS", "WARN", "canvas read blocked: " + (e.name || e));
    return null;
  }
}

export function setOverlayImage(src: string, w: number, h: number, render = true): void {
  overlayData.srcOrig = src;
  overlayData.origW = w;
  overlayData.origH = h;
  overlayData.src = src;
  overlayData.w = w;
  overlayData.h = h;
  _cachedTemplateData = null;
  _cachedTemplateW = 0;
  _cachedTemplateH = 0;
  // A fresh upload is static until the caller explicitly re-enables animation
  // (setOverlayAnimation) — otherwise a stale sheet config would slice it. Never
  // render from this internal clear; the render below (or the caller) covers it.
  if (_animRt) setOverlayAnimation(null, false);
  // NB: do NOT point overlayImg at the raw `src` here — that decodes/paints the
  // full un-quantised image (the WHOLE sprite sheet for animations) just to be
  // replaced milliseconds later by the quantised render. renderDiffOnly sets
  // overlayImg.src to the finished result.
  if (overlayImg) overlayImg.style.display = "block";
  if (render) renderOverlay(true);
  emitOverlayChanged();
}

/**
 * Broadcast that the overlay's persistable state changed (image, position,
 * scale, animation, or cleared). The persistence layer debounces a save and
 * the UI re-syncs its controls — see overlay-persist.ts / ui-wire.ts. Not
 * emitted from the camera-cull re-render, which isn't a state change.
 */
export function emitOverlayChanged(): void {
  document.dispatchEvent(new CustomEvent("wd:overlay-changed"));
}

/**
 * Tear the current overlay down completely — image, animation, markers and
 * cached pixels — while leaving the layers mounted so a new template can be
 * loaded right away.
 */
export function clearOverlay(): void {
  setOverlayAnimation(null);
  overlayData = { x: 0, y: 0, w: 0, h: 0, src: "" };
  _cachedTemplateData = null;
  _cachedTemplateW = 0;
  _cachedTemplateH = 0;
  _lastCullKey = "";
  if (overlayImg) {
    overlayImg.removeAttribute("src");
    overlayImg.style.display = "none";
  }
  if (guideCtx) guideCtx.clearRect(0, 0, WALL_W, WALL_H);
  emitOverlayChanged();
}

function bindOverlayDrag(): void {
  if (!overlayImg) return;
  let dragging = false,
    sx = 0,
    sy = 0,
    ox = 0,
    oy = 0;
  overlayImg.addEventListener("mousedown", (e) => {
    if (isLocked) {
      log("OVERLAY_DRAG", "INFO", "ignored — locked");
      return;
    }
    if (isPicking) {
      log("OVERLAY_DRAG", "INFO", "ignored — picking mode");
      return;
    }
    if (e.button !== 0) return;
    dragging = true;
    const c = screenToCanvas(e.clientX, e.clientY);
    sx = c.x;
    sy = c.y;
    ox = overlayData.x;
    oy = overlayData.y;
    log(
      "OVERLAY_DRAG",
      "OK",
      `start @ canvas(${sx},${sy}) origin(${ox},${oy})`,
    );
    e.preventDefault();
    e.stopPropagation();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging || isLocked) return;
    const c = screenToCanvas(e.clientX, e.clientY);
    setOverlayPos(ox + (c.x - sx), oy + (c.y - sy));
  });
  document.addEventListener("mouseup", () => {
    if (dragging)
      log("OVERLAY_DRAG", "OK", `end @ (${overlayData.x},${overlayData.y})`);
    dragging = false;
  });
}

function bindCanvasPick(): void {
  if ((document as any).__wallPickBound) return;
  (document as any).__wallPickBound = true;
  document.addEventListener(
    "click",
    (e) => {
      if (!isPicking) return;
      const target = e.target as HTMLElement;
      const canvas = mainCanvas();
      if (!canvas) {
        log("PICK", "WARN", "no canvas");
        return;
      }
      const onCanvas =
        target === canvas ||
        target.closest?.(".paint-layers") ||
        target === overlayImg;
      if (!onCanvas) return;
      const c = screenToCanvas(e.clientX, e.clientY);
      log("PICK", "OK", `→ (${c.x}, ${c.y})`);
      setOverlayPos(c.x, c.y);
      togglePick(false);
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

export function togglePick(on: boolean): void {
  isPicking = on;
  log("PICK", "INFO", on ? "ENABLED — click canvas to set coords" : "disabled");
  const b = getElBtnPick();
  const cont = getElCanvasContainer();
  if (b) {
    b.classList.toggle("active-state", on);
    b.innerHTML = on
      ? "[ click on canvas… ]"
      : ic("pin") + " " + t("pickPoint");
  }
  if (cont) cont.classList.toggle("picking-mode", on);
}

export function updateLockBtn(): void {
  const b = getElBtnLock();
  if (!b || !overlayImg) {
    log("OVERLAY_LOCK", "WARN", `no btn=${!b} overlayImg=${!overlayImg}`);
    return;
  }
  overlayImg.classList.toggle("unlocked", !isLocked);
  b.textContent = isLocked ? t("unlock") : t("lock");
  b.classList.toggle("active-state", isLocked);
  log("OVERLAY_LOCK", "OK", isLocked ? "LOCKED" : "UNLOCKED (drag to move)");
}
