export const PALETTE = [
  "#ffffff", "#E8A8A0", "#F0C8A0", "#F0DC95", "#B8D898",
  "#90C8B8", "#9CC0D8", "#A0B0DC", "#B4A0CC", "#D0A8C4",
  "#E8B8C4", "#9FA9A9", "#C8362C", "#E8851F", "#E8C420",
  "#5BA833", "#1E8FA8", "#2A6FB8", "#1F4FA8", "#5B2D8C",
  "#A82D6E", "#E84A8F", "#465050", "#7A2218", "#9C5418",
  "#A88420", "#3D6E20", "#155D6E", "#1A4870", "#15326E",
  "#3A1C5C", "#6E1C48", "#9C2E5E", "#161A1A",
];

export const PALETTE_RGB: [number, number, number][] = PALETTE.map((h) => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
});

/* ---------------------------------------------------------------------------
 * LUT-accelerated quantization
 * ------------------------------------------------------------------------ */

/** 16×16×16 lookup table: quantized (r>>4, g>>4, b>>4) → palette index.
 *  Built once at module load. Error ≤ 8/255 per channel — imperceptible. */
const LUT_DIM = 16;
const LUT = new Uint8Array(LUT_DIM * LUT_DIM * LUT_DIM);
{
  const P = PALETTE_RGB;
  for (let ri = 0; ri < LUT_DIM; ri++) {
    for (let gi = 0; gi < LUT_DIM; gi++) {
      for (let bi = 0; bi < LUT_DIM; bi++) {
        const r = (ri << 4) | (ri > 0 ? 8 : 0);
        const g = (gi << 4) | (gi > 0 ? 8 : 0);
        const b = (bi << 4) | (bi > 0 ? 8 : 0);
        let best = 0, bd = Infinity;
        for (let j = 0; j < P.length; j++) {
          const p = P[j];
          const dr = r - p[0]; const dg = g - p[1]; const db = b - p[2];
          const dist = dr * dr + dg * dg + db * db;
          if (dist < bd) { bd = dist; best = j; }
        }
        LUT[(ri << 8) | (gi << 4) | bi] = best;
      }
    }
  }
}

/** In-place nearest-palette quantization for an ImageData buffer.
 *  O(1) per pixel via 16³ LUT — replaces the O(N×P) brute-force. */
export function quantizeImageData(d: ImageData): void {
  const a = d.data;
  const P = PALETTE_RGB;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 128) { a[i + 3] = 0; continue; }
    const idx = LUT[((a[i] >> 4) << 8) | ((a[i + 1] >> 4) << 4) | (a[i + 2] >> 4)];
    const p = P[idx];
    a[i] = p[0]; a[i + 1] = p[1]; a[i + 2] = p[2]; a[i + 3] = 255;
  }
}

/** In-place nearest-palette quantization for a raw Uint8ClampedArray. */
export function quantizeBuffer(a: Uint8ClampedArray): void {
  const P = PALETTE_RGB;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] < 128) { a[i + 3] = 0; continue; }
    const idx = LUT[((a[i] >> 4) << 8) | ((a[i + 1] >> 4) << 4) | (a[i + 2] >> 4)];
    const p = P[idx];
    a[i] = p[0]; a[i + 1] = p[1]; a[i + 2] = p[2]; a[i + 3] = 255;
  }
}

/* ---------------------------------------------------------------------------
 * HEX string cache (for SVG builder)
 * ------------------------------------------------------------------------ */

/** Pre-computed "00"–"ff" strings. Avoids per-pixel toString(16).padStart. */
export const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

export let activeColor = "#161A1A";

export function setActiveColor(hex: string): void {
  activeColor = hex;
}
