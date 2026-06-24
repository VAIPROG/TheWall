/**
 * Dispatch layer: identify a payload, route it to the owning format's decoder,
 * and route encode requests to the owning format's encoder. This is the ONLY
 * entry general app code should call for format work.
 */
import type { WallTemplateSet, FormatId } from "./template-model";
import { identify, identifyJson } from "./format-identify";
import { UnknownFormatError } from "./parse-errors";
import { base64ToBytes, looksLikeBase64 } from "./binary-codec";
import { decodeWallDev } from "../wall-dev/decode";
import { encodeWallDevV2 } from "../wall-dev/encode";
import { decodeCharity } from "../charity/decode";
import { encodeCharity, type CharityEncodeOptions } from "../charity/encode";

/** Coerce a string|object payload into the parsed JSON we decode from. */
function toJson(input: string | object): any | null {
  if (typeof input === "object") return input;
  const t = input.trim();
  try { return JSON.parse(t); } catch { /* not direct JSON */ }
  if (looksLikeBase64(t)) {
    const bytes = base64ToBytes(t);
    if (bytes) { try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { /* */ } }
  }
  return null;
}

export function decodeAny(input: string | object): { set: WallTemplateSet; id: FormatId } {
  const id = typeof input === "string" ? identify(input) : (identifyJson(input) ?? { standard: "unknown" as const, confidence: 1, reason: "unrecognised object" });
  const json = toJson(input);
  if (id.standard === "wall-dev" && json) return { set: decodeWallDev(json), id };
  if (id.standard === "charity" && json) return { set: decodeCharity(json), id };
  throw new UnknownFormatError(id.reason);
}

export type EncodeTarget = "wall-dev/2" | "charity";

export function encode(set: WallTemplateSet, target: EncodeTarget, opts: CharityEncodeOptions & { now?: string } = {}) {
  if (target === "wall-dev/2") return encodeWallDevV2(set, opts);
  return encodeCharity(set, opts);
}
