declare const __INJECT_VERSION__: string;
declare const __INJECT_DEV__: boolean;

/**
 * Compile-time version flag injected by build.ts.
 */
export const VERSION: string = __INJECT_VERSION__;

/**
 * Compile-time build-mode flag injected by build.ts.
 * `false` in release/smallest → the whole dev-tools module tree-shakes out.
 */
export const __WALLDEV_DEV__: boolean = __INJECT_DEV__;

export const WALL_W = 6000;
export const WALL_H = 4200;
export const SITE = "https://filianislost.com";
export const WS_HOST = "https://ws.filianislost.com";
export const DISCORD_CDN = "https://cdn.discordapp.com";

/* ---------------------------------------------------------------------------
 * Site-archive
 * ------------------------------------------------------------------------ */

/** Base URL of the filianislost.com signal archive (signal.filianislost.com).
 *  Used by signals-cache.ts to fetch and re-render the official archive list
 *  in the site's own DOM shape. */
export const SIGNAL_ARCHIVE_BASE = "https://signal.filianislost.com";

/** First-batch limit used by the site's own LOAD MORE flow. The site fetches
 *  4 signals on the first call and 10 on every subsequent LOAD MORE. We mirror
 *  the 4-shot for our Reload button so it feels native. */
export const SIGNAL_FIRST_BATCH = 4;

/* ---------------------------------------------------------------------------
 * Paint mechanics (mirrors the site's `F0` constant — paint-per-spray-can)
 * ------------------------------------------------------------------------ */

/** Pixels in one full spray can.
 *
 *  Source of truth: the site's `F0 = 1000` constant (The-Wall-Source-Code.js
 *  line 315). Mis-setting this by an order of magnitude is exactly what
 *  caused the "1 can shows as 10" bug — DO NOT change without verifying
 *  against the site bundle. */
export const PAINT_PER_CAN = 1000;

/** Pixels per coin (site's `b5 = Math.floor(100)` — line 316). Used by
 *  sell-all.ts only to *display* an estimated coin payout in the confirm
 *  dialog — the server is authoritative on the actual coin grant. */
export const PAINT_PER_COIN = 100;

/** How often the paint-state poller re-reads the DOM. The site updates the
 *  `.paint-bar` tooltip / `--paint-remaining` style on every paint event, so
 *  the MutationObserver covers most transitions; the timer is a backstop for
 *  the case where the bar gets re-created (e.g. theme change). */
export const PAINT_POLL_INTERVAL_MS = 4000;

/* ---------------------------------------------------------------------------
 * sell-all spacing
 * ------------------------------------------------------------------------ */

/** Polite delay between consecutive POSTs to /cursor/buyCoins. Keeps us well
 *  under the site's rate limit even when the user has 30+ cans to sell. */
export const SELL_CAN_SPACING_MS = 300;

/** POST endpoint the site uses for converting one spray can into coins. The
 *  RPC client maps `N.cursor.buyCoins.$post()` to this URL. */
export const SELL_CAN_URL = `${SITE}/cursor/buyCoins`;

/** GET endpoint the site uses to fetch the user's cursor inventory + coin
 *  balance. The site's `Z5()` is essentially `v8 = await this.$get().json()`. */
export const CURSOR_INVENTORY_URL = `${SITE}/cursor/inventory`;

/* ---------------------------------------------------------------------------
 * Local caches
 * ------------------------------------------------------------------------ */

/** Profile / "my achievements" cache TTL. */
export const CACHE_TTL_PROFILE_MS = 60 * 60 * 1000; // 1 hour

/** Template list cache TTL (clan + public). Short, so a fresh share lands
 *  inside one refill cycle for the rest of the clan. */
export const CACHE_TTL_TEMPLATES_MS = 5 * 60 * 1000; // 5 minutes

/** Signal-archive cache TTL. */
export const CACHE_TTL_SIGNALS_MS = 5 * 60 * 1000; // 5 minutes

/** How often the background poller refreshes the signal archive. The site
 *  doesn't get many new signals per day, so we keep this low-frequency
 *  (~once a day). The poll also runs once on tab open if the cached
 *  payload is older than the threshold. */
export const SIGNAL_BACKGROUND_POLL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** How often the announcement poller checks the backend for new mailbox
 *  items. New broadcast announcements are rare but we still want to
 *  surface them promptly. */
export const ANNOUNCEMENT_POLL_MS = 5 * 60 * 1000; // 5 minutes

/* ---------------------------------------------------------------------------
 * Window resize limits
 * ------------------------------------------------------------------------ */

/** Lower bound: anything smaller and the Win95 chrome stops making sense. */
export const WINDOW_MIN_WIDTH_PX = 280;
export const WINDOW_MIN_HEIGHT_PX = 320;
/** Upper bound: keep the panel from covering the whole canvas on a 4K
 *  display. We still want the user to be able to see what they're painting. */
export const WINDOW_MAX_WIDTH_PX = 640;
export const WINDOW_MAX_HEIGHT_PX = 900;

/** Admin achievement catalogue TTL — only changes when an admin edits it. */
export const CACHE_TTL_ACH_CATALOGUE_MS = 24 * 60 * 60 * 1000; // 24 hours

/** 7TV emote sets TTL. The global set has 800+ entries and changes maybe
 *  once a week on the 7TV side, so refetching every hour was wasteful. A
 *  week-long cache covers normal use; the reload button next to the 7TV
 *  block in Settings still busts it on demand. */
export const CACHE_TTL_EMOTES_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/* ---------------------------------------------------------------------------
 * Paint-refill sound
 * ------------------------------------------------------------------------ */

/** Frequency (Hz) of the two-tone refill chime. Picked to be audibly distinct
 *  from any site sound (the site never plays audio for paint events). */
export const PAINT_REFILL_TONE_LOW_HZ = 660;
export const PAINT_REFILL_TONE_HIGH_HZ = 880;

/** Total chime length. Two tones, each PAINT_REFILL_TONE_LEN_MS long, with a
 *  small gap so the second note "answers" the first. */
export const PAINT_REFILL_TONE_LEN_MS = 140;
export const PAINT_REFILL_TONE_GAP_MS = 40;

/** Default playback volume (0..1) for the chime. The user can tweak via
 *  cfg.paintRefillVolume. */
export const PAINT_REFILL_DEFAULT_VOLUME = 0.35;

/** "Away long enough to deserve a special message" — used by the queue to
 *  pick between the normal refilled body and the "while you were away"
 *  variant. Anything over an hour spent in the empty state counts. */
export const PAINT_REFILL_AWAY_THRESHOLD_MS = 60 * 60 * 1000;

/** Default poll interval for the dots-overlay live diff (ms). Tuned for a
 *  responsive "watch pixels disappear as your clan paints" feel while still
 *  staying cheap (one sampled hash of the under-template region per tick).
 *  The user can override via cfg.dotsRefreshMs through Settings → Overlay. */
export const COMPACT_MARKERS_REFRESH_MS_DEFAULT = 500;
/** Lower bound — anything faster wastes CPU without visible benefit. */
export const COMPACT_MARKERS_REFRESH_MS_MIN = 200;
/** Upper bound — anything slower defeats the point of "live" tracking. */
export const COMPACT_MARKERS_REFRESH_MS_MAX = 10_000;

/** Legacy export retained for compatibility with code paths that still
 *  expect a single constant. New callers should read `cfg.dotsRefreshMs`
 *  through getDotsRefreshMs() below. */
export const COMPACT_MARKERS_REFRESH_MS = COMPACT_MARKERS_REFRESH_MS_DEFAULT;

/* ---------------------------------------------------------------------------
 * Site DOM selectors
 * ------------------------------------------------------------------------ */

export const SEL = {
  canvasContainer: "div.canvas-container",
  paintLayers: "div.paint-layers",
  mainCanvas: ".paint-layers > canvas:not(.preview-canvas)",
  chatList: ".chat-log .list",
  chatInput: "#chat-input-field",
  chatSend: "#tool-send-btn",
  toolSpray: "#tool-spray",
  notifBadge: ".notif-badge",
  /* New in v4.x — paint-state + signal archive */
  paintBar: ".paint-bar",
  sprayCanCount: ".spray-can-count",
  paintTimer: ".timer > b",
  chatBubble: ".chat-bubble",
  sightingsPosts: ".sightings .posts",
  sightingsMore: ".sightings .more",
} as const;
