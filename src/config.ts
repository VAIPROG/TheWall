export interface WallConfig {
  _v: number;
  backendUrl: string;
  backendToken: string;
  refreshToken: string;
  remoteI18n: boolean;
  interceptEvents: boolean;
  wsTap: boolean;
  defaultOpacity: number;
  overlayScale: number;
  theme: "auto" | "light" | "dark";
  uiScale: number;
  cozy: boolean;
  cursorMode: "off" | "clan";
  cursorSelector: string;
  showUnverified: boolean;
  showUnverifiedClan: boolean;
  /** Extra 7TV emote sets to load.
   *  Each entry is `{ id, name }` (Twitch user ID + display name) or a bare
   *  string (numeric Twitch ID or a known login). Empty = use default. */
  emoteChannels: Array<string | { id: string; name: string }>;
  /** Inject 7TV emote rendering into filianislost's chat (global + clan). */
  injectSiteEmotes: boolean;
  /** Render template overlay as small opaque markers instead of a flat image
   *  so the underlying canvas stays readable. */
  compactMarkers: boolean;
  /** File a backend paint-refill reminder whenever the can runs dry; the
   *  server DMs the linked Telegram/Discord at refill time. */
  paintReminderRemote: boolean;
  /** Legacy global toggle, superseded by the per-scope flags below. Kept so
   *  old configs deserialize; its value seeds the per-scope defaults. */
  hideAnimatedTpl: boolean;
  /** Per-block "hide animated" filters in the Templates tab. */
  hideAnimatedPub: boolean;
  hideAnimatedClan: boolean;
  hideAnimatedMine: boolean;
  /** Marker size 10..90% of a pixel. Only used when compactMarkers is on. */
  compactMarkerSize: number;
  /** Show a toast / OS notification when paint refills from 0. */
  notifyOnPaintRefill: boolean;
  /** Play a short WebAudio chime when paint refills from 0. */
  paintRefillSound: boolean;
  /** Chime volume (0..1). */
  paintRefillVolume: number;
  /** Persisted extension-window dimensions. 0 = use CSS default. */
  windowWidth: number;
  windowHeight: number;
  /** How often the dots overlay re-checks the canvas in ms (default 500). */
  dotsRefreshMs: number;
  /** When true, Charity exports omit the (TheWallDev: ID:…;BACKEND:…) identity
   *  tag from the template name. Default false (identity is embedded). */
  charityNoIdentity: boolean;
}

const CFG_KEY = "walldev_cfg";
const CFG_VERSION = 4;

const DEFAULT_CFG: WallConfig = {
  _v: CFG_VERSION,
  backendUrl: "https://the-wall.vai-rice.space/api",
  backendToken: "",
  refreshToken: "",
  remoteI18n: false,
  interceptEvents: true,
  wsTap: false,
  defaultOpacity: 0.6,
  overlayScale: 1,
  theme: "auto",
  uiScale: 1,
  cozy: true,
  cursorMode: "off",
  cursorSelector: '[class*="cursor"]',
  showUnverified: false,
  showUnverifiedClan: false,
  emoteChannels: [{ id: "198633200", name: "filian" }],
  injectSiteEmotes: true,
  compactMarkers: false,
  paintReminderRemote: false,
  hideAnimatedTpl: false,
  hideAnimatedPub: false,
  hideAnimatedClan: false,
  hideAnimatedMine: false,
  compactMarkerSize: 40,
  notifyOnPaintRefill: true,
  paintRefillSound: true,
  paintRefillVolume: 0.35,
  windowWidth: 0,
  windowHeight: 0,
  dotsRefreshMs: 500,
  charityNoIdentity: false,
};

export function loadCfg(): WallConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(CFG_KEY) || "{}");
    const merged = Object.assign({}, DEFAULT_CFG, stored);
    const prevV = stored._v || 0;
    if (prevV < CFG_VERSION) {
      // v2 → v3: overlayScale was an integer 1..8 (pixel-blow-up factor).
      // v3 treats it as a fractional scale 0.05..10 (5%..1000%). Anything
      // > 10 from a pre-v3 config is almost certainly a stale integer — keep
      // it as the same number but bring it inside the new range.
      if (prevV < 3) {
        const s = typeof stored.overlayScale === "number" ? stored.overlayScale : 1;
        merged.overlayScale = Math.max(0.05, Math.min(10, s));
      }
      merged._v = CFG_VERSION;
      localStorage.setItem(CFG_KEY, JSON.stringify(merged));
    }
    // The legacy global "hide animated" seeds the per-scope filters once —
    // a user who had everything hidden keeps that state per block.
    if (stored.hideAnimatedTpl === true && stored.hideAnimatedPub === undefined) {
      merged.hideAnimatedPub = true;
      merged.hideAnimatedClan = true;
      merged.hideAnimatedMine = true;
      localStorage.setItem(CFG_KEY, JSON.stringify(merged));
    }
    return merged;
  } catch {
    return { ...DEFAULT_CFG };
  }
}

export let cfg = loadCfg();

export function saveCfg(): void {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}

export function resetCfg(): void {
  localStorage.removeItem(CFG_KEY);
  cfg = loadCfg();
}
