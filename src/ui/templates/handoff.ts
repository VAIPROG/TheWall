/**
 * Bridge from the DOM-heavy overlay/formats layer to the (DOM-free) Publish
 * screen. Both the Overlay "Share" button and the Templates "Publish" button
 * call {@link publishCurrentOverlay}; the overlay encoding stays behind dynamic
 * imports so publish.ts / browse.ts remain import-safe for the bare-Bun tests.
 */
import { openPublish } from "./shell";

/** Encode the current overlay to a the-wall-dev/2 document, or null when no
 *  overlay image is loaded. */
export async function currentOverlayDocument(): Promise<Record<string, unknown> | null> {
  try {
    const { overlayData } = await import("../../overlay");
    if (!overlayData?.src && !overlayData?.srcOrig) return null;
    const { exportCurrentOverlay } = await import("../../walldev-config");
    const { encode } = await import("../../formats");
    return encode(exportCurrentOverlay(), "wall-dev/2") as unknown as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Open the Publish screen pre-filled from the current overlay (or empty). */
export async function publishCurrentOverlay(): Promise<void> {
  const doc = await currentOverlayDocument();
  openPublish(doc ? { document: doc } : undefined);
}
