/**
 * Byte / base64 / data-URL primitives shared by every format. Consolidates the
 * sniffing logic that used to live inline in format-detect.ts. Pure functions,
 * no DOM, no fetch — safe to unit test under Bun.
 */

const BASE64_RE = /^[A-Za-z0-9+/=_-]+$/;
const MIN_BASE64_LEN = 64;

/** Magic numbers (leading bytes) → MIME. WEBP is handled separately (its
 *  marker isn't contiguous). */
const MAGIC: Array<[Uint8Array, string]> = [
  [new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png"],
  [new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg"],
  [new Uint8Array([0x47, 0x49, 0x46, 0x38]), "image/gif"],
];

export function bytesToBase64(buf: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    s += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

/** Decode a base64 string. Tolerates URL-safe alphabet and missing padding.
 *  Returns null when the string isn't valid base64. */
export function base64ToBytes(s: string): Uint8Array | null {
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

function startsWith(buf: Uint8Array, prefix: Uint8Array): boolean {
  if (buf.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (buf[i] !== prefix[i]) return false;
  return true;
}

function isWebp(buf: Uint8Array): boolean {
  return (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  );
}

export function sniffImageMime(buf: Uint8Array): string | null {
  for (const [magic, mime] of MAGIC) if (startsWith(buf, magic)) return mime;
  if (isWebp(buf)) return "image/webp";
  return null;
}

export function buildDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

export interface ParsedDataUrl {
  mime: string;
  bytes: Uint8Array;
}

/** Parse a `data:<mime>;base64,<payload>` URL. Returns null for anything else
 *  (including non-base64 data URLs, which we don't emit). */
export function parseDataUrl(url: string): ParsedDataUrl | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url.trim());
  if (!m) return null;
  const bytes = base64ToBytes(m[2]);
  if (!bytes) return null;
  return { mime: m[1], bytes };
}

/** Cheap gate before attempting a base64 decode: long enough and only
 *  base64-alphabet characters. */
export function looksLikeBase64(s: string): boolean {
  return s.length >= MIN_BASE64_LEN && BASE64_RE.test(s);
}
