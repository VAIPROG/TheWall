/**
 * Canonical set → Charity config. Charity is a lossy target: it has no place
 * for contacts, access control, notes, structured author, descriptions, z, or
 * per-frame overrides. We emit what fits, optionally smuggle the author
 * identity into the (first) template name via the interop tag, and return a
 * report of everything dropped so the UI can warn the user.
 */
import type { CharityConfig, CharityEntry } from "./schema-types";
import type { WallTemplateSet, TemplateLayer } from "../shared/template-model";
import { encodeInteropTag } from "./interop-tag";

export interface CharityEncodeOptions {
  faction?: string;
  contact?: string;
  /** Embed (TheWallDev: ID:…;BACKEND:…) into the first template name. Default true. */
  embedIdentity?: boolean;
}
export interface CharityLossReport { lostFields: string[]; }

function layerToEntry(l: TemplateLayer): CharityEntry {
  const e: CharityEntry = { name: l.name, sources: l.image, x: l.x, y: l.y };
  if (l.animation && l.animation.sheet.frameCount > 1) {
    e.frameWidth = l.animation.sheet.frameWidth || null;
    e.frameHeight = l.animation.sheet.frameHeight || null;
    e.frameCount = l.animation.sheet.frameCount;
    e.secondsPerFrame = l.animation.timing.defaultFrameMs / 1000;
    e.startTimestamp = Math.round(l.animation.timing.startTime / 1000);
    e.looping = l.animation.timing.looping;
  }
  return e;
}

export function encodeCharity(
  set: WallTemplateSet, opts: CharityEncodeOptions,
): { config: CharityConfig; report: CharityLossReport } {
  const embed = opts.embedIdentity !== false;
  const templates = set.layers.map(layerToEntry);

  if (embed && set.author && (set.author.id || set.author.backendUrl) && templates[0]) {
    templates[0].name = `${templates[0].name || "Untitled"} ${encodeInteropTag({
      id: set.author.id, backendUrl: set.author.backendUrl,
    })}`.trim();
  }

  const lostFields: string[] = [];
  if (Object.values(set.contacts).some((a) => a?.length)) lostFields.push("contacts");
  if (Object.values(set.access).some((v) => v && (Array.isArray(v) ? v.length : Object.keys(v).length))) lostFields.push("access");
  if (set.notes.length) lostFields.push("notes");
  if (set.layers.some((l) => l.description)) lostFields.push("descriptions");
  if (set.layers.some((l) => l.animation?.timing.frames?.length)) lostFields.push("perFrameOverrides");

  const config: CharityConfig = {
    faction: opts.faction || "the-wall-dev export",
    contact: opts.contact || "anonymous",
    templates,
    whitelist: [],
  };
  return { config, report: { lostFields } };
}
