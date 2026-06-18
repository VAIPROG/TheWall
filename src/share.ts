import { cfg, saveCfg } from "./config";
import { $ } from "./helpers";
import { log } from "./log";
import { toast } from "./notify";
import { overlayData, setOverlaySrc, setOverlayPos, isLocked, setIsLocked, updateLockBtn, applyOverlayScale } from "./overlay";

export function importShare(str: string): void {
  try {
    const parsed = JSON.parse(
      atob(str.trim().replace("the-wall-dev://", "")),
    );
    if (parsed.x == null || parsed.y == null || !parsed.src)
      throw new Error("bad payload");
    const img = new Image();
    img.onload = () => {
      // Old share links may carry a scale field. Apply it first so the
      // resize that setOverlaySrc triggers picks it up.
      if (parsed.scale) {
        cfg.overlayScale = Math.max(0.05, Math.min(10, parsed.scale));
        saveCfg();
      }
      // setOverlaySrc treats its src as the *original*, and the scale config
      // determines the on-canvas pixel size.
      setOverlaySrc(parsed.src, img.naturalWidth, img.naturalHeight);
      setOverlayPos(parsed.x, parsed.y);
      location.hash = `#${parsed.x},${parsed.y}`;
      setIsLocked(true);
      updateLockBtn();
      log("IMPORT", "OK", `teleported #${parsed.x},${parsed.y}`);
    };
    img.src = parsed.src;
  } catch (e: any) {
    log("IMPORT", "ERR", e.toString());
    alert("Invalid the-wall-dev:// link");
  }
}

/**
 * Generate the current overlay's `the-wall-dev://` share link.
 *
 * Two call shapes:
 *
 *   - `genShare()`         — legacy behavior. Writes the link into the
 *                            `#sharelink-output` field on the Overlay tab
 *                            and copies to clipboard. When that field is
 *                            missing (Share tab refactor moved it), the
 *                            link is still copied via clipboard API.
 *   - `genShare(true)`     — returns the link as a string instead of
 *                            touching the DOM. Used by the Share tab's
 *                            "Copy share link" button.
 *
 * In both shapes the original source image is embedded, so recipients get
 * the cleanest possible quality independent of the sender's current scale.
 */
export function genShare(returnString?: false): void;
export function genShare(returnString: true): string | null;
export function genShare(returnString?: boolean): string | null | void {
  const origSrc = overlayData.srcOrig || overlayData.src;
  if (!origSrc) {
    if (!returnString) alert("Upload or import an image first");
    return returnString ? null : undefined;
  }
  const flexScaleEl = $("share-flex-scale") as HTMLInputElement | null;
  const flexScale = !!(flexScaleEl && flexScaleEl.checked);
  const payload: any = {
    x: overlayData.x,
    y: overlayData.y,
    src: origSrc,
  };
  if (!flexScale) payload.scale = cfg.overlayScale;

  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  const link = `the-wall-dev://${b64}`;

  if (returnString) return link;

  const out = $("sharelink-output") as HTMLInputElement | null;
  if (out) {
    out.value = link;
    out.select();
    try { document.execCommand("copy"); } catch {}
  }
  navigator.clipboard?.writeText(link).catch(() => {});
  toast("Share link", flexScale ? "copied (recipient picks scale)" : "copied (scale baked in)");
  return undefined;
}
