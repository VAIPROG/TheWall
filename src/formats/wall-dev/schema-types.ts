/**
 * TypeScript interfaces mirroring schema/theWallDev/1.json and 2.json exactly.
 * Both schemas use additionalProperties:false — these interfaces are closed
 * shapes. Field names match the JSON property names verbatim.
 */

// ---------------------------------------------------------------------------
// Shared primitives (used in both v1 and v2)
// ---------------------------------------------------------------------------

export type V1SheetLayout = "line" | "grid";
export type V1GridOrder = "row" | "column" | "serpentine";
export type V1ScalingMode = "native" | "scaled";

// ---------------------------------------------------------------------------
// v1 types
// ---------------------------------------------------------------------------

/** Per-frame override inside v1 AnimationBlock.timing.frames */
export interface V1FrameOverride {
  index: number;
  durationMs?: number;
  skip?: boolean;
}

/** Animation block for v1. Absent for static templates. */
export interface V1AnimationBlock {
  sheet: {
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    layout: V1SheetLayout;
    order: V1GridOrder;
  };
  timing: {
    startTime: number;
    defaultFrameMs: number;
    looping: boolean;
    frames?: V1FrameOverride[];
  };
  scaling?: {
    mode: V1ScalingMode;
  };
}

/** The single template payload inside a v1 envelope. */
export interface V1Template {
  name?: string;
  image_data_url: string;
  x: number;
  y: number;
  scale: number;
  width: number;
  height: number;
  animation?: V1AnimationBlock;
}

/** Optional author block in v1. Absent for anonymous exports. */
export interface V1Author {
  username: string;
  clan_name?: string;
  clan_role?: string;
}

/** Top-level v1 envelope. */
export interface WallDevV1 {
  format: "the-wall-dev/1";
  version: string;
  exported_at: string;
  author?: V1Author;
  note?: string;
  template: V1Template;
}

// ---------------------------------------------------------------------------
// v2 types
// ---------------------------------------------------------------------------

export type V2SheetLayout = "line" | "grid";
export type V2GridOrder = "row" | "column" | "serpentine";
export type V2ScalingMode = "native" | "scaled";

/** Per-frame override inside v2 AnimationBlock.timing.frames */
export interface V2FrameOverride {
  index: number;
  durationMs?: number;
  skip?: boolean;
  imageSources?: string[];
  width?: number;
  height?: number;
  scale?: number;
}

/** Animation block for v2. Absent for static templates. */
export interface V2AnimationBlock {
  sheet: {
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    layout: V2SheetLayout;
    order: V2GridOrder;
  };
  timing: {
    startTime: number;
    defaultFrameMs: number;
    looping: boolean;
    frames?: V2FrameOverride[];
  };
  scaleMode?: V2ScalingMode;
}

/** Structured author object (one of three author modes in v2). */
export interface V2AuthorObject {
  id?: string;
  backendUrl?: string;
  name?: string;
  clanId?: string;
  clanName?: string;
}

/** v2 author field: structured object, "anon" string, or null. */
export type V2Author = V2AuthorObject | "anon" | null;

/** Discord contact entry. */
export interface V2DiscordContact {
  type: "user" | "guild";
  link: string;
  notes?: string[];
}

/** Telegram contact entry. */
export interface V2TelegramContact {
  type: "user" | "group" | "channel" | "bot";
  link: string;
  startParam?: string;
  notes?: string[];
}

/** X (Twitter) contact entry. */
export interface V2XContact {
  link: string;
  notes?: string[];
}

/** Matrix contact entry. */
export interface V2MatrixContact {
  type: "user" | "group" | "bot";
  link: string;
  notes?: string[];
}

/** Site contact entry. */
export interface V2SiteContact {
  url: string;
  notes?: string[];
}

/** Other/misc contact entry. */
export interface V2OtherContact {
  label: string;
  type?: string;
  url: string;
  notes?: string[];
}

/** Contact book for v2. */
export interface V2Contacts {
  discord?: V2DiscordContact[];
  telegram?: V2TelegramContact[];
  x?: V2XContact[];
  matrix?: V2MatrixContact[];
  sites?: V2SiteContact[];
  other?: V2OtherContact[];
}

/** One template/layer entry inside a v2 envelope. */
export interface V2TemplateEntry {
  name: string;
  description?: string;
  imageSources: string[];
  x: number;
  y: number;
  z?: number;
  scale: number;
  width: number;
  height: number;
  animation?: V2AnimationBlock;
}

/** Top-level v2 envelope. */
export interface WallDevV2 {
  format: "the-wall-dev/2";
  createdAt: string;
  editedAt: string;
  author?: V2Author;
  notes?: string[];
  contacts?: V2Contacts;
  domainsWhitelist?: string[];
  usersWhitelist?: string[];
  usersBlocklist?: string[];
  allowedToEdit?: {
    userIds?: string[];
    clanIds?: string[];
  };
  templates: V2TemplateEntry[];
}
