/**
 * Pure tile-grid math for reading a wall region from the tile server.
 *
 * The site no longer exposes a full-resolution wall canvas: the on-screen
 * `drawable-canvas` is only viewport-sized (screen-space), and in overview
 * mode the wall is a downscaled `snapshot.png`. The authoritative, full-res,
 * zoom/mode-independent source of painted pixels is the tile server's native
 * layer-0 tiles (`/tiles/0/<col>/<row>.png`, TILE_SIZE px each). To score a
 * template we only need the tiles it overlaps — this computes which ones and
 * where the template sits inside the composited grid.
 *
 * Dependency-free → unit-testable (spec/wall-tiles.test.ts).
 */

export const TILE_SIZE = 256;

export interface TileRegion {
  /** Inclusive tile-column/row range covering the wall rect. */
  tx0: number;
  ty0: number;
  tx1: number;
  ty1: number;
  /** Wall coordinate of the composite grid's top-left (tx0,ty0 tile origin). */
  gridX: number;
  gridY: number;
  /** Composite canvas size (whole tiles). */
  cw: number;
  ch: number;
  /** Offset of (ox,oy) inside the composite — where to read the template rect. */
  sx: number;
  sy: number;
}

export function tilesForRegion(
  ox: number,
  oy: number,
  w: number,
  h: number,
  tileSize: number = TILE_SIZE,
): TileRegion {
  const tx0 = Math.floor(ox / tileSize);
  const ty0 = Math.floor(oy / tileSize);
  const tx1 = Math.floor((ox + w - 1) / tileSize);
  const ty1 = Math.floor((oy + h - 1) / tileSize);
  const gridX = tx0 * tileSize;
  const gridY = ty0 * tileSize;
  return {
    tx0,
    ty0,
    tx1,
    ty1,
    gridX,
    gridY,
    cw: (tx1 - tx0 + 1) * tileSize,
    ch: (ty1 - ty0 + 1) * tileSize,
    sx: ox - gridX,
    sy: oy - gridY,
  };
}
