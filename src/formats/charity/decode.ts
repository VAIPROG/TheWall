/**
 * Charity config → canonical WallTemplateSet. Parses ALL templates (the old
 * code silently dropped all but the first downstream). Normalises the upstream
 * field aliases, derives a sprite grid for animated entries, and recovers any
 * smuggled TheWallDev identity tag from the first tagged name.
 */
import type { CharityConfig, CharityEntry } from "./schema-types";
import type { WallTemplateSet, TemplateLayer, AnimationSpec, AuthorIdentity } from "../shared/template-model";
import { createSet } from "../shared/template-set";
import { NoTemplatesError } from "../shared/parse-errors";
import { parseInteropTag, stripInteropTag } from "./interop-tag";

function entryToLayer(t: CharityEntry): TemplateLayer | null {
  if (typeof t.x !== "number" || typeof t.y !== "number") return null;
  const sources = Array.isArray(t.sources) ? t.sources.filter((s) => typeof s === "string") : [];
  if (sources.length === 0) return null;

  const frameCount = typeof t.frameCount === "number" ? t.frameCount : 1;
  const rawName = String(t.name || "(unnamed)").trim() || "(unnamed)";
  const layer: TemplateLayer = {
    name: stripInteropTag(rawName).trim() || "(unnamed)",
    image: sources,
    x: Math.round(t.x),
    y: Math.round(t.y),
    scale: 1, // Charity templates are native-resolution
    width: typeof t.frameWidth === "number" ? t.frameWidth : 0,
    height: typeof t.frameHeight === "number" ? t.frameHeight : 0,
  };

  if (frameCount > 1) {
    const secondsPerFrame = t.secondsPerFrame ?? t.frameRate ?? t.frameSpeed ?? 1;
    const startSeconds = t.startTimestamp ?? t.startTime ?? 0;
    const anim: AnimationSpec = {
      sheet: {
        frameWidth: typeof t.frameWidth === "number" ? t.frameWidth : 0,
        frameHeight: typeof t.frameHeight === "number" ? t.frameHeight : 0,
        frameCount,
        layout: "grid",
        order: "row",
      },
      timing: {
        startTime: Math.round(startSeconds * 1000),
        defaultFrameMs: Math.max(1, Math.round(secondsPerFrame * 1000)),
        looping: typeof t.looping === "boolean" ? t.looping : true,
      },
      scaleMode: "native",
    };
    layer.animation = anim;
  }
  return layer;
}

export function decodeCharity(json: CharityConfig): WallTemplateSet {
  if (!Array.isArray(json?.templates)) throw new NoTemplatesError("missing templates[]");
  const layers: TemplateLayer[] = [];
  let author: AuthorIdentity | null = null;

  for (const t of json.templates) {
    const tag = parseInteropTag(String(t.name || ""));
    if (tag && !author) author = { id: tag.id, backendUrl: tag.backendUrl };
    const layer = entryToLayer(t);
    if (layer) layers.push(layer);
  }
  if (layers.length === 0) throw new NoTemplatesError("no usable templates (need x/y/sources)");

  return createSet({
    source: { standard: "charity", confidence: 1, reason: "charity config" },
    author,
    notes: json.faction ? [`faction: ${json.faction}`] : [],
    contacts: json.contact ? { other: [{ label: "contact", url: json.contact }] } : {},
    layers,
  });
}
