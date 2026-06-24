/**
 * Resolve a layer's ordered imageSources[] fallback chain to a concrete loaded
 * image. Tries each source in order; the first that loads wins. The browser
 * loader (default) handles `data:` directly and fetches http(s) → data URL,
 * then decodes for dimensions. `resolveImageWith` takes an injected loader so
 * the ordering logic is unit-testable without a DOM.
 */
import type { ResolvedImage } from "./template-model";
import { ImageLoadFailedError } from "./parse-errors";

export interface LoadedImage { dataUrl: string; width: number; height: number; }
export type ImageLoader = (src: string) => Promise<LoadedImage>;

export async function resolveImageWith(
  sources: string[], loader: ImageLoader,
): Promise<ResolvedImage> {
  for (let i = 0; i < sources.length; i++) {
    try {
      const loaded = await loader(sources[i]);
      return { ...loaded, usedSourceIndex: i };
    } catch { /* try next */ }
  }
  throw new ImageLoadFailedError(`none of ${sources.length} source(s) loaded`);
}

/** Production loader: data: URL passthrough, otherwise fetch → data URL, then
 *  decode via an <img> to read natural dimensions. */
export const browserLoader: ImageLoader = async (src) => {
  let dataUrl = src;
  if (!src.startsWith("data:")) {
    const r = await fetch(src, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const blob = await r.blob();
    dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(new Error("read failed"));
      fr.readAsDataURL(blob);
    });
  }
  const { width, height } = await new Promise<{ width: number; height: number }>((res, rej) => {
    const img = new Image();
    img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => rej(new Error("decode failed"));
    img.src = dataUrl;
  });
  return { dataUrl, width, height };
};

export function resolveImage(sources: string[]): Promise<ResolvedImage> {
  return resolveImageWith(sources, browserLoader);
}
