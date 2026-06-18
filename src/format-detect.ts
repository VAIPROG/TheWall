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

/** Lightweight base64 sniff. We don't try to decode every base64-looking
 *  string — that would be expensive — only ones that pass a cheap length +
 *  alphabet check. The minimum length keeps short tokens (e.g. "abc")
 *  from triggering the heavier image-decode path. */
const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;
const MIN_BASE64_LEN = 64;

/** Map of file magic numbers (first bytes) → MIME type. Used after a
 *  base64 decode succeeds so we can build a proper data URL. */
const MAGIC: Array<[Uint8Array, string]> = [
  [new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"],
  [new Uint8Array([0xff, 0xd8, 0xff]),       "image/jpeg"],
  [new Uint8Array([0x47, 0x49, 0x46, 0x38]), "image/gif"],
  // WebP: "RIFF????WEBP" — check the first 4 bytes (RIFF) and bytes 8-11
  // ("WEBP") via a separate helper because the magic isn't contiguous.
];

function bytesStartWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[i] !== prefix[i]) return false;
  }
  return true;
}

function isWebp(buf: Uint8Array): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  );
}

function detectImageMime(buf: Uint8Array): string | null {
  for (const [magic, mime] of MAGIC) {
    if (bytesStartWith(buf, magic)) return mime;
  }
  if (isWebp(buf)) return "image/webp";
  return null;
}

function bytesToBase64(buf: Uint8Array): string {
  // btoa expects a binary string. Build one in chunks to avoid the
  // "Maximum call stack" trap on large buffers.
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function tryAtob(s: string): Uint8Array | null {
  // Tolerate URL-safe alphabet + missing padding.
  let b = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b.length % 4;
  if (pad) b += "=".repeat(4 - pad);
  try {
    const binary = atob(b);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Try interpreting a JSON value (already parsed) as one of our schemas. */
function classifyJson(j: any, raw: string): Detected | null {
  if (j && typeof j === "object") {
    if (j.format === "the-wall-dev/1" && j.template) {
      return { kind: "wall-dev-export", raw, json: j };
    }
    if (Array.isArray(j.templates)) {
      return { kind: "charity-config", raw, json: j };
    }
    // Bare Charity entry (the commonly-shared shape — one template object
    // with x/y/sources at top level, like the CFRB animation sample).
    // Normalise to a single-entry manifest so downstream code has ONE shape.
    if (
      typeof j.x === "number" &&
      typeof j.y === "number" &&
      Array.isArray(j.sources) &&
      !j.format
    ) {
      return { kind: "charity-config", raw, json: { templates: [j] } };
    }
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
  if (trimmed.length >= MIN_BASE64_LEN && BASE64_RE.test(trimmed)) {
    const bytes = tryAtob(trimmed);
    if (bytes) {
      // Try JSON inside the decoded bytes.
      try {
        const utf8 = new TextDecoder().decode(bytes);
        const j = JSON.parse(utf8);
        const hit = classifyJson(j, trimmed);
        if (hit) return hit;
      } catch { /* not JSON */ }
      // Try image.
      const mime = detectImageMime(bytes);
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
