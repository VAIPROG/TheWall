/**
 * Canonical in-memory model for every template payload the extension reads or
 * writes. Each concrete standard (the-wall-dev v1/v2, Charity) decodes INTO
 * this shape and encodes OUT of it, so general code (overlay, diff, UI) only
 * ever sees one structure. The model is a faithful superset of the richest
 * standard (the-wall-dev/2) so a v2 round-trip is lossless; Charity and v1 are
 * lossy subsets, documented per field in the spec.
 *
 * Pure types only — no logic. Helpers live in template-set.ts.
 */

/** What standard a payload was recognised as (output of format-identify). */
export type Standard = "wall-dev" | "charity" | "image" | "unknown";

export interface FormatId {
  standard: Standard;
  /** Numeric format version when known (e.g. 1 or 2 for the-wall-dev). */
  version?: number;
  /** 0..1 — how sure the detector is. 1 = exact tag match. */
  confidence: number;
  /** Human-readable reason, for logs and the import dialog. */
  reason: string;
}

/** Sprite-sheet physical layout. */
export type SheetLayout = "line" | "grid";
export type GridOrder = "row" | "column" | "serpentine";
export type ScaleMode = "native" | "scaled";

export interface FrameOverride {
  index: number;
  durationMs?: number;
  skip?: boolean;
  /** Per-frame replacement image (ordered fallback chain). v2 feature. */
  imageSources?: string[];
  width?: number;
  height?: number;
  scale?: number;
}

export interface AnimationSpec {
  sheet: {
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    layout: SheetLayout;
    order: GridOrder;
  };
  timing: {
    /** Epoch ms when the timeline begins (absolute sync anchor). */
    startTime: number;
    defaultFrameMs: number;
    looping: boolean;
    frames?: FrameOverride[];
  };
  scaleMode?: ScaleMode;
}

/** One drawable layer. `image` is the ordered source chain AS AUTHORED — the
 *  raw strings round-trip on export. Resolution to pixels is a runtime step
 *  (image-source.ts), never stored here. */
export interface TemplateLayer {
  name: string;
  description?: string;
  image: string[];
  x: number;
  y: number;
  z?: number;
  scale: number;
  width: number;
  height: number;
  /** Presence marks the layer animated — the unified static/animated flag. */
  animation?: AnimationSpec;
}

/** All author fields optional (matches schema v2 after the author/id edit).
 *  No `clanRole`: v1's clan_role was naive and is dropped on read — identity is
 *  `clanId`, and the role is fetched from the backend (V3). */
export interface AuthorIdentity {
  id?: string;
  name?: string;
  backendUrl?: string;
  clanId?: string;
  clanName?: string;
}

export interface ContactEntry {
  /** Platform-specific subtype where the schema defines one (e.g. discord
   *  user/guild). Free-form for `other`. */
  type?: string;
  /** Display label (required for `other`). */
  label?: string;
  /** URL or platform id. */
  link?: string;
  url?: string;
  startParam?: string;
  notes?: string[];
}

export interface ContactBook {
  discord?: ContactEntry[];
  telegram?: ContactEntry[];
  x?: ContactEntry[];
  matrix?: ContactEntry[];
  sites?: ContactEntry[];
  other?: ContactEntry[];
}

/** Access control — PRESERVED through round-trip, NOT enforced client-side
 *  (the backend enforces; the extension is a client). */
export interface AccessControl {
  usersWhitelist?: string[];
  usersBlocklist?: string[];
  allowedToEdit?: { userIds?: string[]; clanIds?: string[] };
  domainsWhitelist?: string[];
}

export interface WallTemplateSet {
  /** Where this set was decoded from — drives UI + lossiness reporting. */
  source: FormatId;
  createdAt?: string;
  editedAt?: string;
  author: AuthorIdentity | null;
  notes: string[];
  contacts: ContactBook;
  access: AccessControl;
  /** Always at least one layer after a successful decode. */
  layers: TemplateLayer[];
}

/** Runtime result of resolving a layer's source chain — NOT part of the set. */
export interface ResolvedImage {
  dataUrl: string;
  width: number;
  height: number;
  /** Index into the layer's `image[]` that actually loaded. */
  usedSourceIndex: number;
}
