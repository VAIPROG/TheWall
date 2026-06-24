/**
 * Decode a the-wall-dev v1 or v2 payload into the canonical WallTemplateSet.
 * Branches on json.format — throws UnknownFormatError for anything else.
 *
 * v1 → v2 mapping notes:
 *   - image_data_url → image:[image_data_url]
 *   - animation.scaling.mode → scaleMode
 *   - author.username → name, author.clan_name → clanName; clan_role DROPPED
 *   - note (string) → notes:[note]
 *   - exported_at → createdAt
 *
 * v2 mapping notes:
 *   - imageSources → image (copy array)
 *   - author: object → AuthorIdentity copy; "anon"/null → null
 *   - notes, contacts: copy as-is
 *   - access: usersWhitelist/usersBlocklist/allowedToEdit/domainsWhitelist
 *   - per-layer animation: timing.frames FrameOverride[] and scaleMode carried
 */
import type {
  WallTemplateSet, TemplateLayer, AnimationSpec, AuthorIdentity,
  FrameOverride, ContactBook,
} from "../shared/template-model";
import { createSet } from "../shared/template-set";
import { UnknownFormatError } from "../shared/parse-errors";
import type {
  WallDevV1, WallDevV2,
  V1AnimationBlock,
  V2AnimationBlock, V2Author, V2Contacts,
} from "./schema-types";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapV1Animation(anim: V1AnimationBlock): AnimationSpec {
  const frames: FrameOverride[] | undefined = anim.timing.frames
    ? anim.timing.frames.map((f) => {
        const o: FrameOverride = { index: f.index };
        if (f.durationMs !== undefined) o.durationMs = f.durationMs;
        if (f.skip !== undefined) o.skip = f.skip;
        return o;
      })
    : undefined;

  return {
    sheet: {
      frameWidth: anim.sheet.frameWidth,
      frameHeight: anim.sheet.frameHeight,
      frameCount: anim.sheet.frameCount,
      layout: anim.sheet.layout,
      order: anim.sheet.order,
    },
    timing: {
      startTime: anim.timing.startTime,
      defaultFrameMs: anim.timing.defaultFrameMs,
      looping: anim.timing.looping,
      ...(frames ? { frames } : {}),
    },
    ...(anim.scaling ? { scaleMode: anim.scaling.mode } : {}),
  };
}

function mapV2Animation(anim: V2AnimationBlock): AnimationSpec {
  const frames: FrameOverride[] | undefined = anim.timing.frames
    ? anim.timing.frames.map((f) => {
        const o: FrameOverride = { index: f.index };
        if (f.durationMs !== undefined) o.durationMs = f.durationMs;
        if (f.skip !== undefined) o.skip = f.skip;
        if (f.imageSources !== undefined) o.imageSources = f.imageSources;
        if (f.width !== undefined) o.width = f.width;
        if (f.height !== undefined) o.height = f.height;
        if (f.scale !== undefined) o.scale = f.scale;
        return o;
      })
    : undefined;

  return {
    sheet: {
      frameWidth: anim.sheet.frameWidth,
      frameHeight: anim.sheet.frameHeight,
      frameCount: anim.sheet.frameCount,
      layout: anim.sheet.layout,
      order: anim.sheet.order,
    },
    timing: {
      startTime: anim.timing.startTime,
      defaultFrameMs: anim.timing.defaultFrameMs,
      looping: anim.timing.looping,
      ...(frames ? { frames } : {}),
    },
    ...(anim.scaleMode !== undefined ? { scaleMode: anim.scaleMode } : {}),
  };
}

function mapV2Author(author: V2Author | undefined): AuthorIdentity | null {
  if (author === "anon" || author === null || author === undefined) return null;
  // It's an AuthorObject
  const a: AuthorIdentity = {};
  if (author.id !== undefined) a.id = author.id;
  if (author.name !== undefined) a.name = author.name;
  if (author.backendUrl !== undefined) a.backendUrl = author.backendUrl;
  if (author.clanId !== undefined) a.clanId = author.clanId;
  if (author.clanName !== undefined) a.clanName = author.clanName;
  return a;
}

function mapV2Contacts(contacts: V2Contacts | undefined): ContactBook {
  if (!contacts) return {};
  const book: ContactBook = {};
  if (contacts.discord?.length) book.discord = contacts.discord as any;
  if (contacts.telegram?.length) book.telegram = contacts.telegram as any;
  if (contacts.x?.length) book.x = contacts.x as any;
  if (contacts.matrix?.length) book.matrix = contacts.matrix as any;
  if (contacts.sites?.length) book.sites = contacts.sites as any;
  if (contacts.other?.length) book.other = contacts.other as any;
  return book;
}

// ---------------------------------------------------------------------------
// v1 decoder
// ---------------------------------------------------------------------------

function readV1(json: WallDevV1): WallTemplateSet {
  const t = json.template;
  const layer: TemplateLayer = {
    name: t.name ?? "(unnamed)",
    image: [t.image_data_url],
    x: t.x,
    y: t.y,
    scale: t.scale,
    width: t.width,
    height: t.height,
  };
  if (t.animation) layer.animation = mapV1Animation(t.animation);

  let author: AuthorIdentity | null = null;
  if (json.author) {
    author = {};
    if (json.author.username !== undefined) author.name = json.author.username;
    if (json.author.clan_name !== undefined) author.clanName = json.author.clan_name;
    // clan_role intentionally dropped — obsolete, role comes from backend
  }

  return createSet({
    source: { standard: "wall-dev", version: 1, confidence: 1, reason: `format tag ${json.format}` },
    createdAt: json.exported_at,
    author,
    notes: json.note ? [json.note] : [],
    layers: [layer],
  });
}

// ---------------------------------------------------------------------------
// v2 decoder
// ---------------------------------------------------------------------------

function readV2(json: WallDevV2): WallTemplateSet {
  const layers: TemplateLayer[] = json.templates.map((t) => {
    const layer: TemplateLayer = {
      name: t.name,
      image: t.imageSources,
      x: t.x,
      y: t.y,
      scale: t.scale,
      width: t.width,
      height: t.height,
    };
    if (t.description !== undefined) layer.description = t.description;
    if (t.z !== undefined) layer.z = t.z;
    if (t.animation) layer.animation = mapV2Animation(t.animation);
    return layer;
  });

  return createSet({
    source: { standard: "wall-dev", version: 2, confidence: 1, reason: `format tag ${json.format}` },
    createdAt: json.createdAt,
    editedAt: json.editedAt,
    author: mapV2Author(json.author),
    notes: json.notes ? [...json.notes] : [],
    contacts: mapV2Contacts(json.contacts),
    access: {
      ...(json.usersWhitelist ? { usersWhitelist: json.usersWhitelist } : {}),
      ...(json.usersBlocklist ? { usersBlocklist: json.usersBlocklist } : {}),
      ...(json.allowedToEdit ? { allowedToEdit: json.allowedToEdit } : {}),
      ...(json.domainsWhitelist ? { domainsWhitelist: json.domainsWhitelist } : {}),
    },
    layers,
  });
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Decode any the-wall-dev payload (v1 or v2) into a canonical WallTemplateSet.
 *  Throws UnknownFormatError when json.format is not recognised. */
export function decodeWallDev(json: any): WallTemplateSet {
  const fmt: string | undefined = json?.format;
  if (fmt === "the-wall-dev/1") return readV1(json as WallDevV1);
  if (fmt === "the-wall-dev/2") return readV2(json as WallDevV2);
  throw new UnknownFormatError(`unrecognised format tag: ${fmt ?? "(none)"}`);
}
