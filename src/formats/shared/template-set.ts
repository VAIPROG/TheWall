/**
 * Ergonomic helpers for building and inspecting a WallTemplateSet quickly and
 * readably. Keep behaviour pure where practical (mutating helpers like addLayer
 * return the same set for chaining convenience).
 */
import type {
  WallTemplateSet, TemplateLayer, AuthorIdentity, FormatId,
} from "./template-model";

const UNKNOWN: FormatId = { standard: "unknown", confidence: 0, reason: "synthetic" };

export function createSet(over: Partial<WallTemplateSet> = {}): WallTemplateSet {
  return {
    source: over.source ?? UNKNOWN,
    createdAt: over.createdAt,
    editedAt: over.editedAt,
    author: over.author ?? null,
    notes: over.notes ?? [],
    contacts: over.contacts ?? {},
    access: over.access ?? {},
    layers: over.layers ?? [],
  };
}

export function addLayer(set: WallTemplateSet, layer: TemplateLayer): WallTemplateSet {
  set.layers.push(layer);
  return set;
}

export function layerCount(set: WallTemplateSet): number {
  return set.layers.length;
}

export function isMultiLayer(set: WallTemplateSet): boolean {
  return set.layers.length > 1;
}

export function primaryLayer(set: WallTemplateSet): TemplateLayer | null {
  return set.layers[0] ?? null;
}

export function isAnimated(layer: TemplateLayer): boolean {
  return !!layer.animation && layer.animation.sheet.frameCount > 1;
}

export function hasAnimatedLayers(set: WallTemplateSet): boolean {
  return set.layers.some(isAnimated);
}

export function mapLayers<T>(set: WallTemplateSet, fn: (l: TemplateLayer, i: number) => T): T[] {
  return set.layers.map(fn);
}

export function findLayer(
  set: WallTemplateSet,
  pred: (l: TemplateLayer, i: number) => boolean,
): TemplateLayer | null {
  return set.layers.find(pred) ?? null;
}

export function withAuthor(set: WallTemplateSet, author: AuthorIdentity | null): WallTemplateSet {
  set.author = author;
  return set;
}

export function fromSingleImage(
  dataUrl: string, x: number, y: number, width: number, height: number,
  name = "Imported",
): WallTemplateSet {
  return createSet({
    source: { standard: "image", confidence: 1, reason: "raw image" },
    layers: [{ name, image: [dataUrl], x, y, scale: 1, width, height }],
  });
}

export interface SetSummary {
  layerCount: number;
  animatedCount: number;
  author: AuthorIdentity | null;
  notes: string[];
  contactPlatforms: string[];
  /** True when the source standard cannot represent some model fields. */
  lossy: boolean;
}

export function summarize(set: WallTemplateSet): SetSummary {
  return {
    layerCount: set.layers.length,
    animatedCount: set.layers.filter(isAnimated).length,
    author: set.author,
    notes: set.notes,
    contactPlatforms: Object.keys(set.contacts).filter(
      (k) => (set.contacts as any)[k]?.length,
    ),
    lossy: set.source.standard === "charity",
  };
}
