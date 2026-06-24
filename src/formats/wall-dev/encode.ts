/**
 * Canonical WallTemplateSet → the-wall-dev/2 envelope. v2 is a lossless
 * superset of the canonical model, so this encode is lossless (no report
 * needed). Omits undefined / empty-array fields to satisfy the schema's
 * additionalProperties:false constraint.
 *
 * opts.now (optional) pins createdAt/editedAt defaults for deterministic tests.
 */
import type { WallTemplateSet, AnimationSpec, FrameOverride, ContactBook } from "../shared/template-model";
import type {
  WallDevV2, V2Author, V2AuthorObject,
  V2TemplateEntry, V2AnimationBlock, V2FrameOverride,
  V2Contacts,
} from "./schema-types";

export interface EncodeWallDevV2Options {
  /** Fallback timestamp when the set carries no createdAt/editedAt. */
  now?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mapAnimationToV2(anim: AnimationSpec): V2AnimationBlock {
  const frames: V2FrameOverride[] | undefined = anim.timing.frames?.length
    ? anim.timing.frames.map((f: FrameOverride) => {
        const o: V2FrameOverride = { index: f.index };
        if (f.durationMs !== undefined) o.durationMs = f.durationMs;
        if (f.skip !== undefined) o.skip = f.skip;
        if (f.imageSources !== undefined) o.imageSources = f.imageSources;
        if (f.width !== undefined) o.width = f.width;
        if (f.height !== undefined) o.height = f.height;
        if (f.scale !== undefined) o.scale = f.scale;
        return o;
      })
    : undefined;

  const block: V2AnimationBlock = {
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
  };
  if (anim.scaleMode !== undefined) block.scaleMode = anim.scaleMode;
  return block;
}

function mapContactsToV2(contacts: ContactBook): V2Contacts | undefined {
  const out: V2Contacts = {};
  if (contacts.discord?.length) out.discord = contacts.discord as any;
  if (contacts.telegram?.length) out.telegram = contacts.telegram as any;
  if (contacts.x?.length) out.x = contacts.x as any;
  if (contacts.matrix?.length) out.matrix = contacts.matrix as any;
  if (contacts.sites?.length) out.sites = contacts.sites as any;
  if (contacts.other?.length) out.other = contacts.other as any;
  return Object.keys(out).length ? out : undefined;
}

// ---------------------------------------------------------------------------
// Public encoder
// ---------------------------------------------------------------------------

export function encodeWallDevV2(set: WallTemplateSet, opts: EncodeWallDevV2Options): WallDevV2 {
  const fallback = opts.now ?? new Date().toISOString();
  const createdAt = set.createdAt ?? fallback;
  const editedAt = set.editedAt ?? fallback;

  // Author: any populated field → emit object; null/no fields → "anon"
  let author: V2Author;
  if (
    set.author !== null &&
    set.author !== undefined &&
    (set.author.id !== undefined ||
      set.author.name !== undefined ||
      set.author.backendUrl !== undefined ||
      set.author.clanId !== undefined ||
      set.author.clanName !== undefined)
  ) {
    const a: V2AuthorObject = {};
    if (set.author.id !== undefined) a.id = set.author.id;
    if (set.author.name !== undefined) a.name = set.author.name;
    if (set.author.backendUrl !== undefined) a.backendUrl = set.author.backendUrl;
    if (set.author.clanId !== undefined) a.clanId = set.author.clanId;
    if (set.author.clanName !== undefined) a.clanName = set.author.clanName;
    author = a;
  } else {
    author = "anon";
  }

  // Templates
  const templates: V2TemplateEntry[] = set.layers.map((layer) => {
    const entry: V2TemplateEntry = {
      name: layer.name,
      imageSources: layer.image,
      x: layer.x,
      y: layer.y,
      scale: layer.scale,
      width: layer.width,
      height: layer.height,
    };
    if (layer.description !== undefined) entry.description = layer.description;
    if (layer.z !== undefined) entry.z = layer.z;
    if (layer.animation) entry.animation = mapAnimationToV2(layer.animation);
    return entry;
  });

  // Build envelope — only include optional top-level fields when non-empty
  const out: WallDevV2 = {
    format: "the-wall-dev/2",
    createdAt,
    editedAt,
    author,
    templates,
  };

  if (set.notes.length) out.notes = [...set.notes];

  const contacts = mapContactsToV2(set.contacts);
  if (contacts) out.contacts = contacts;

  if (set.access.usersWhitelist?.length) out.usersWhitelist = set.access.usersWhitelist;
  if (set.access.usersBlocklist?.length) out.usersBlocklist = set.access.usersBlocklist;
  if (
    set.access.allowedToEdit &&
    (set.access.allowedToEdit.userIds?.length || set.access.allowedToEdit.clanIds?.length)
  ) {
    out.allowedToEdit = set.access.allowedToEdit;
  }
  if (set.access.domainsWhitelist?.length) out.domainsWhitelist = set.access.domainsWhitelist;

  return out;
}
