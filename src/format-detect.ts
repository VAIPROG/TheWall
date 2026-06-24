/**
 * Auto-detect the format of an incoming payload (file content, URL response
 * body, pasted clipboard text, …) and return a normalised classification
 * the importer can dispatch on.
 *
 * Why one place: each callsite that wants to "just figure out what this
 * is" used to do its own ad-hoc sniffing (`startsWith("the-wall-dev://")`
 * here, `Array.isArray(j.templates)` there, …). When we added base64-image
 * support we'd have had to teach every call site about it. Centralising the
 * logic means new formats become a single switch arm.
 *
 * Detection order (first match wins):
 *
 *   1. `data:image/…` data URL → DataUrlImage
 *   2. `the-wall-dev://…`     → ShareLink
 *   3. JSON object with `format: "the-wall-dev/1"` → WallDevExport
 *   4. JSON object with `templates: []`            → Charity
 *   5. Base64 string whose decoded bytes parse as JSON → recurse
 *   6. Base64 string whose decoded bytes start with image magic numbers
 *      (PNG / JPEG / GIF / WEBP) → DataUrlImage with synthesised mime
 *   7. Otherwise → Unknown
 *
 * The detector NEVER mutates state — it returns a description, the caller
 * decides what to do with it. That lets us reuse the same function from
 * the URL autoloader, the Share tab's file picker, and a future "paste a
 * URL here" affordance without coupling them to specific side-effects.
 *
 * Public API:
 *   detectPayload(textOrJson)
 *
 * @deprecated Shim — delegates to src/formats/shared/format-identify.ts.
 *   Call sites will be rewired to the formats barrel in Task 17.
 */

export type DetectedKind =
  | "wall-dev-export"
  | "charity-config"
  | "share-link"
  | "data-url-image"
  | "unknown";

export interface Detected {
  kind: DetectedKind;
  /** The original input that was sniffed — handy for caller logging. */
  raw: string;
  /** Already-parsed JSON when `kind` is `wall-dev-export` or `charity-config`. */
  json?: any;
  /** A complete `data:image/…;base64,…` URL when `kind` is `data-url-image`. */
  dataUrl?: string;
}

import {
  looksLikeBase64,
  base64ToBytes,
  sniffImageMime,
  bytesToBase64,
} from "./formats/shared/binary-codec";
import { identifyJson } from "./formats/shared/format-identify";

/** Map an already-parsed JSON object to a Detected result, preserving the
 *  legacy bare-entry normalisation (single charity entry → {templates:[j]}). */
function classifyJson(j: any, raw: string): Detected | null {
  if (!j || typeof j !== "object") return null;
  const id = identifyJson(j);
  if (!id) return null;

  if (id.standard === "wall-dev") {
    return { kind: "wall-dev-export", raw, json: j };
  }
  if (id.standard === "charity") {
    // Preserve legacy normalisation: bare entry → {templates:[j]}
    const json = Array.isArray(j.templates) ? j : { templates: [j] };
    return { kind: "charity-config", raw, json };
  }
  return null;
}

/**
 * Classify a string. Pass either parsed JSON (then we skip the parse step)
 * or the raw text — the function tries each rule in turn.
 */
export function detectPayload(input: string): Detected {
  const trimmed = input.trim();

  // 1. Data URL image (caller can apply directly via setOverlaySrc).
  if (trimmed.startsWith("data:image/")) {
    return { kind: "data-url-image", raw: trimmed, dataUrl: trimmed };
  }

  // 2. Share link.
  if (trimmed.startsWith("the-wall-dev://")) {
    return { kind: "share-link", raw: trimmed };
  }

  // 3 + 4. JSON.
  try {
    const j = JSON.parse(trimmed);
    const hit = classifyJson(j, trimmed);
    if (hit) return hit;
  } catch { /* not JSON — fall through */ }

  // 5 + 6. Base64.
  if (looksLikeBase64(trimmed)) {
    const bytes = base64ToBytes(trimmed);
    if (bytes) {
      // Try JSON inside the decoded bytes.
      try {
        const utf8 = new TextDecoder().decode(bytes);
        const j = JSON.parse(utf8);
        const hit = classifyJson(j, trimmed);
        if (hit) return hit;
      } catch { /* not JSON */ }
      // Try image.
      const mime = sniffImageMime(bytes);
      if (mime) {
        // Re-encode to canonical base64 so the data URL is portable even
        // when the source used URL-safe alphabet.
        const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
        return { kind: "data-url-image", raw: trimmed, dataUrl };
      }
    }
  }

  return { kind: "unknown", raw: trimmed };
}

/**
 * Convenience helper: detect the payload contained in a File. Reads as text
 * for JSON / share / base64-text content, and as data URL for actual image
 * binaries (PNG / JPEG / …).
 */
export async function detectFile(file: File): Promise<Detected> {
  // If the browser tagged the file as an image, take the fast path: convert
  // straight to a data URL and skip the JSON sniffing entirely.
  if (file.type.startsWith("image/")) {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(new Error("read failed"));
      r.readAsDataURL(file);
    });
    return { kind: "data-url-image", raw: file.name, dataUrl };
  }
  const text = await file.text();
  return detectPayload(text);
}
