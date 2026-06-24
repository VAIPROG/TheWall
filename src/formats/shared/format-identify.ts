/**
 * Format identification — the single, side-effect-free authority for "what is
 * this payload?". Returns a FormatId with a confidence and a human reason
 * (logged + shown in the import dialog). Never fetches, never mutates, never
 * decodes images beyond a magic-number sniff. The registry consumes this to
 * route to the right decoder.
 */
import type { FormatId } from "./template-model";
import { looksLikeBase64, base64ToBytes, sniffImageMime } from "./binary-codec";

const WALL_DEV_TAG = /^the-wall-dev\/(\d+)$/;

/** Identify already-parsed JSON. Exported so the registry can skip re-parsing. */
export function identifyJson(j: any): FormatId | null {
  if (!j || typeof j !== "object") return null;
  if (typeof j.format === "string") {
    const m = WALL_DEV_TAG.exec(j.format);
    if (m) {
      return { standard: "wall-dev", version: Number(m[1]), confidence: 1, reason: `format tag ${j.format}` };
    }
  }
  if (Array.isArray(j.templates)) {
    return { standard: "charity", confidence: 0.9, reason: "templates[] array" };
  }
  if (typeof j.x === "number" && typeof j.y === "number" && Array.isArray(j.sources) && !j.format) {
    return { standard: "charity", confidence: 0.8, reason: "bare charity entry (x/y/sources)" };
  }
  return null;
}

export function identify(input: string): FormatId {
  const t = input.trim();
  if (!t) return { standard: "unknown", confidence: 1, reason: "empty input" };

  if (t.startsWith("data:image/")) {
    return { standard: "image", confidence: 1, reason: "data:image URL" };
  }
  if (t.startsWith("the-wall-dev://")) {
    return { standard: "wall-dev", confidence: 1, reason: "the-wall-dev:// share link" };
  }

  try {
    const hit = identifyJson(JSON.parse(t));
    if (hit) return hit;
  } catch { /* not JSON */ }

  if (looksLikeBase64(t)) {
    const bytes = base64ToBytes(t);
    if (bytes) {
      try {
        const hit = identifyJson(JSON.parse(new TextDecoder().decode(bytes)));
        if (hit) return { ...hit, reason: `base64 → ${hit.reason}` };
      } catch { /* not JSON inside */ }
      const mime = sniffImageMime(bytes);
      if (mime) return { standard: "image", confidence: 0.9, reason: `base64 image (${mime})` };
    }
  }

  return { standard: "unknown", confidence: 1, reason: "no rule matched" };
}
