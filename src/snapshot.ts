/**
 * High-quality full-wall snapshot via the tile server.
 *
 * Tile URL: `${WS_HOST}/tiles/<layer>/<x>/<y>.png`
 *   - Tile is always 256 × 256 px (matches the site's `R$ = 256` constant).
 *   - Layer N represents the whole wall downscaled by 2^N.
 *     Layer 0 = native 6000 × 4200 (~408 tiles).
 *     Layer 1 = 3000 × 2100         (~108 tiles).
 *     Layer 2 = 1500 × 1050         (~30  tiles).
 *
 * We use the site's *own* downscale (= its layer ladder) instead of fetching
 * layer 0 and resampling in the browser — that gives the cleanest possible
 * output at every quality (no JS-side smoothing artefacts) and is much faster
 * on low/medium because we download fewer + smaller tiles.
 *
 * Pipeline:
 *   1. Brick-background fill on the stage canvas (matches the site's wall).
 *   2. Fetch every tile of the chosen layer in parallel; paint at native
 *      pixel offset.
 *   3. Crop the tile-grid overshoot to the actual wall rectangle.
 *   4. Compose a small "Made with The Wall Dev" header strip above the wall.
 *   5. Export PNG.
 */

import { SITE, WS_HOST, WALL_W, WALL_H } from "./constants";
import { log } from "./log";
import { toast } from "./notify";
import { errMsg } from "./helpers";
import { tilesForRegion, TILE_SIZE } from "./wall-tiles";

export type SnapshotQuality = "low" | "medium" | "high";

const PARALLEL = 6;

const QUALITY_LAYER: Record<SnapshotQuality, number> = {
  low: 2,    // 1500 × 1050,   30 tiles
  medium: 1, // 3000 × 2100,   108 tiles
  high: 0,   // 6000 × 4200,   408 tiles
};

const BG_HI = `${SITE}/static/brick-background-hi.webp`;
const BG_LO = `${SITE}/static/brick-background.jpg`;

const HEADER_TEXT = "Made with The Wall Dev · the-wall.vai-rice.space";

const wallWAtLayer = (n: number) => Math.ceil(WALL_W / 2 ** n);
const wallHAtLayer = (n: number) => Math.ceil(WALL_H / 2 ** n);
const colsAtLayer = (n: number) => Math.ceil(wallWAtLayer(n) / TILE_SIZE);
const rowsAtLayer = (n: number) => Math.ceil(wallHAtLayer(n) / TILE_SIZE);

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("load failed: " + url));
    img.src = url;
  });
}

async function paintBrickBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  hires: boolean,
): Promise<void> {
  const urls = hires ? [BG_HI, BG_LO] : [BG_LO, BG_HI];
  for (const url of urls) {
    try {
      const img = await loadImage(url);
      const pat = ctx.createPattern(img, "repeat");
      if (!pat) continue;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
      return;
    } catch {
      /* try next */
    }
  }
  ctx.fillStyle = "#3a2820";
  ctx.fillRect(0, 0, w, h);
}

async function paintTile(
  ctx: CanvasRenderingContext2D,
  layer: number,
  x: number,
  y: number,
  bust: string,
): Promise<boolean> {
  const url = `${WS_HOST}/tiles/${layer}/${x}/${y}.png?v=${bust}`;
  try {
    const img = await loadImage(url);
    ctx.drawImage(img, x * TILE_SIZE, y * TILE_SIZE);
    return true;
  } catch {
    return false;
  }
}

function paintHeader(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Dark gradient strip, white centered label.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "#1a1a1a");
  grad.addColorStop(1, "#0d0d0d");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  // Subtle bottom hairline so the header doesn't melt into the wall.
  ctx.fillStyle = "#3a2820";
  ctx.fillRect(0, h - 2, w, 2);

  const fontSize = Math.max(12, Math.round(h * 0.55));
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${fontSize}px "Inter","Segoe UI",Tahoma,sans-serif`;
  ctx.fillText(HEADER_TEXT, w / 2, h / 2);
}

interface SnapshotOptions {
  onProgress?: (done: number, total: number) => void;
  quality?: SnapshotQuality;
}

export async function captureWallSnapshot(opts: SnapshotOptions = {}): Promise<Blob> {
  const quality = opts.quality || "high";
  const layer = QUALITY_LAYER[quality];
  const bust = String(Date.now());

  const cols = colsAtLayer(layer);
  const rows = rowsAtLayer(layer);
  const wallW = wallWAtLayer(layer);
  const wallH = wallHAtLayer(layer);
  const total = cols * rows;
  log("SNAPSHOT", "OK", `layer=${layer} grid=${cols}×${rows} (${total} tiles) → ${wallW}×${wallH}`);

  // 1. Staging canvas: a bit bigger than the wall so the grid lines up.
  const stage = document.createElement("canvas");
  stage.width = cols * TILE_SIZE;
  stage.height = rows * TILE_SIZE;
  const sctx = stage.getContext("2d");
  if (!sctx) throw new Error("could not create staging context");

  // 2. Brick background — same texture the site uses.
  await paintBrickBackground(sctx, stage.width, stage.height, quality === "high");

  // 3. Fan out tile fetches.
  const jobs: { x: number; y: number }[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) jobs.push({ x, y });
  }
  let done = 0;
  async function worker(): Promise<void> {
    while (jobs.length) {
      const job = jobs.shift();
      if (!job) return;
      await paintTile(sctx!, layer, job.x, job.y, bust);
      done++;
      opts.onProgress?.(done, total);
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(PARALLEL, total); i++) workers.push(worker());
  await Promise.all(workers);

  // 4. Crop the tile-grid overshoot to the actual wall.
  const wallCrop = document.createElement("canvas");
  wallCrop.width = wallW;
  wallCrop.height = wallH;
  wallCrop.getContext("2d")!.drawImage(stage, 0, 0);

  // 5. Compose final image: header on top, wall below.
  const headerH = Math.max(18, Math.round(wallH * 0.022));
  const out = document.createElement("canvas");
  out.width = wallW;
  out.height = wallH + headerH;
  const octx = out.getContext("2d")!;
  paintHeader(octx, wallW, headerH);
  octx.drawImage(wallCrop, 0, headerH);

  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob returned null"))),
      "image/png",
    );
  });
}

/* ---------------------------------------------------------------------------
 * Template-region read (for progress / diff)
 * ------------------------------------------------------------------------ */

let _regionCanvas: HTMLCanvasElement | null = null;
let _regionCtx: CanvasRenderingContext2D | null = null;

/**
 * Read a w×h wall region under (ox, oy) straight from native (layer-0) tiles.
 *
 * Full-resolution and independent of camera zoom / overview-vs-live mode, so a
 * template scores correctly even where it's currently off screen — the site's
 * on-screen drawable-canvas is only viewport-sized and can't provide that.
 * Only the tiles overlapping the template are fetched. Missing or unpainted
 * pixels come back transparent (counted as "not painted" by the diff). Returns
 * null when no covering tile could be fetched.
 *
 * Reuses one offscreen canvas across calls (resized as needed) instead of
 * allocating per call.
 */
export async function readWallRegionFromTiles(
  ox: number,
  oy: number,
  w: number,
  h: number,
): Promise<Uint8ClampedArray | null> {
  const reg = tilesForRegion(ox, oy, w, h, TILE_SIZE);
  if (!_regionCanvas) _regionCanvas = document.createElement("canvas");
  if (_regionCanvas.width !== reg.cw || _regionCanvas.height !== reg.ch) {
    _regionCanvas.width = reg.cw;
    _regionCanvas.height = reg.ch;
    _regionCtx = _regionCanvas.getContext("2d", { willReadFrequently: true });
  }
  const ctx = _regionCtx;
  if (!ctx) return null;
  ctx.clearRect(0, 0, reg.cw, reg.ch);

  const bust = String(Date.now());
  let any = false;
  const jobs: Promise<void>[] = [];
  for (let ty = reg.ty0; ty <= reg.ty1; ty++) {
    for (let tx = reg.tx0; tx <= reg.tx1; tx++) {
      if (tx < 0 || ty < 0) continue; // off-wall tile — leave transparent
      jobs.push(
        (async () => {
          try {
            const img = await loadImage(`${WS_HOST}/tiles/0/${tx}/${ty}.png?v=${bust}`);
            ctx.drawImage(img, (tx - reg.tx0) * TILE_SIZE, (ty - reg.ty0) * TILE_SIZE);
            any = true;
          } catch {
            /* missing tile = unpainted region */
          }
        })(),
      );
    }
  }
  await Promise.all(jobs);
  if (!any) return null;
  return ctx.getImageData(reg.sx, reg.sy, w, h).data;
}

export async function downloadWallSnapshot(quality: SnapshotQuality = "high"): Promise<void> {
  toast("Snapshot", `stitching tiles (${quality})…`);
  try {
    const blob = await captureWallSnapshot({
      quality,
      onProgress: (done, total) => {
        if (done === total || done % Math.max(1, Math.floor(total / 8)) === 0) {
          toast("Snapshot", `${done}/${total} tiles`);
        }
      },
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TheWall_${quality}_${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast("Snapshot", `downloaded ✓ (${(blob.size / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e: any) {
    log("SNAPSHOT", "ERR", String(e));
    toast("Snapshot", "failed: " + errMsg(e));
  }
}
