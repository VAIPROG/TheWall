import { cfg } from "./config";
import { $ } from "./helpers";
import { log } from "./log";
import { toast } from "./notify";
import { overlayData, setIsLocked, updateLockBtn } from "./overlay";
import { insertTemplate } from "./template-insert";

/** Apply a `the-wall-dev://` share link: insert its (static) image and jump
 *  the view to its coordinates. `scale` is optional — when absent we keep the
 *  current overlay scale (newer "recipient picks scale" links). */
export function importShare(str: string): void {
  let parsed: any;
  try {
    parsed = JSON.parse(atob(str.trim().replace("the-wall-dev://", "")));
  } catch (e: any) {
    log("IMPORT", "ERR", e.toString());
    alert("Invalid the-wall-dev:// link");
    return;
  }
  if (parsed.x == null || parsed.y == null || !parsed.src) {
    alert("Invalid the-wall-dev:// link");
    return;
  }
  const scale =
    parsed.scale != null ? Math.max(0.05, Math.min(10, parsed.scale)) : undefined;
  insertTemplate({ imageDataUrl: parsed.src, x: parsed.x, y: parsed.y, scale })
    .then(() => {
      location.hash = `#${parsed.x},${parsed.y}`;
      setIsLocked(true);
      updateLockBtn();
      log("IMPORT", "OK", `teleported #${parsed.x},${parsed.y}`);
    })
    .catch((e: any) => {
      log("IMPORT", "ERR", e.toString());
      alert("Invalid the-wall-dev:// link");
    });
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
