/**
 * Cache + "Reload" affordance for the official Signal Archive.
 *
 * The site's Signal Archive at signal.filianislost.com is a separate service
 * the main page renders inside `.sightings`. The site fetches signals via:
 *
 *   GET https://signal.filianislost.com/fetch?tag=&after={offset}&limit={N}&at={now}
 *
 * with N=4 on the first batch and N=10 on every subsequent LOAD MORE click.
 * Each response is a JSON array of `{ num_id, name, location, submitted_at,
 * image_file }` records, which the site then renders as `div.window.wpost`
 * cards inside `.sightings .posts`.
 *
 * What this module adds:
 *   1. A localStorage cache of the first-batch response (5-minute TTL). On
 *      page reload, if `.sightings .posts` is empty but the cache is fresh,
 *      we paint the cached cards immediately so the panel doesn't sit on
 *      "Loading..." while the network rolls over.
 *   2. A small "↻ RELOAD" button injected next to the site's own
 *      "LOAD MORE" button inside `.sightings .more`. On click it:
 *        - clears the cache entry
 *        - drops only the cards *we* injected (`.wd-signals-our` marker class)
 *        - re-fetches the first batch and prepends fresh cards
 *      The site's own cards are left alone so the user's scroll history is
 *      preserved.
 *
 * Why we re-render in our own code rather than calling the site's `tK()`:
 *   `tK()` is closure-scoped inside the bundle. We can't reach it from a
 *   content script. Mirroring its DOM shape exactly (same class names, same
 *   image / video branch, same info row layout) gives us identical visuals
 *   without needing the site's API.
 *
 * Fair-play note: this module only reads the *public* signal-archive API and
 * paints DOM. It does not write back, does not submit signals, and does not
 * intercept the site's own fetches. The site can fetch the archive in
 * parallel without us interfering.
 *
 * Public API:
 *   startSignalsCache()  start watching for `.sightings .more` to appear
 *   stopSignalsCache()   teardown for tests
 */
import { log } from "./log";
import { errMsg } from "./helpers";
import { getCached, setCached, clearCached } from "./cache";
import { notify } from "./notify";
import { t } from "./i18n";
import {
  SIGNAL_ARCHIVE_BASE,
  SIGNAL_FIRST_BATCH,
  CACHE_TTL_SIGNALS_MS,
  SIGNAL_BACKGROUND_POLL_MS,
  SEL,
} from "./constants";

/** Shape of a single signal as returned by `/fetch`. */
type SignalRow = {
  num_id: number;
  name: string;
  location: string;
  submitted_at: number | string;
  image_file: string;
};

const OUR_CARD_MARKER = "wd-signals-our";

function cacheKey(after: number, limit: number): string {
  return `signals:${after}:${limit}`;
}

async function fetchSignals(after: number, limit: number): Promise<SignalRow[]> {
  const url = `${SIGNAL_ARCHIVE_BASE}/fetch?tag=&after=${after}&limit=${limit}&at=${Date.now()}`;
  log.trace("SIGNALS", `fetch ${url}`);
  const r = await fetch(url, { credentials: "omit" });
  if (!r.ok) throw new Error(`signal-archive ${r.status}`);
  const data = (await r.json()) as SignalRow[];
  log.info("SIGNALS", `fetched ${data.length} rows from after=${after}`);
  return data;
}

async function loadSignals(after: number, limit: number, force = false): Promise<SignalRow[]> {
  const key = cacheKey(after, limit);
  if (!force) {
    const cached = getCached<SignalRow[]>(key, CACHE_TTL_SIGNALS_MS);
    if (cached) {
      log.info("SIGNALS", `cache hit after=${after} (${cached.length} rows)`);
      return cached;
    }
  }
  const fresh = await fetchSignals(after, limit);
  setCached(key, fresh);
  return fresh;
}

function fmtDate(ts: number | string): string {
  try {
    const d = new Date(ts);
    return new Intl.DateTimeFormat([], {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);
  } catch {
    return String(ts);
  }
}

const VIDEO_EXT_RE = /\.(mp4|webm|ogg|mov)$/i;

/**
 * Build one signal card matching the site's `tK($)` exactly:
 *
 *   div.window.wpost
 *     ├ div.title  (SIGNAL #N + close button)
 *     └ div.content
 *         ├ div.image       (background-image OR <video>)
 *         └ div.info  (SIGNAL NAME / LOCATION / TRANSMITTED rows)
 */
function renderCard(s: SignalRow): HTMLElement {
  const card = document.createElement("div");
  card.className = "window wpost";

  const title = document.createElement("div");
  title.className = "title";
  const p = document.createElement("p");
  p.textContent = `SIGNAL #${s.num_id}`;
  title.appendChild(p);
  const btns = document.createElement("div");
  btns.className = "buttons";
  const closeBtn = document.createElement("button");
  const img = document.createElement("img");
  img.src = "/static/icon/archive/close.png";
  img.alt = "x";
  closeBtn.appendChild(img);
  closeBtn.addEventListener("click", () => card.remove());
  btns.appendChild(closeBtn);
  title.appendChild(btns);
  card.appendChild(title);

  const content = document.createElement("div");
  content.className = "content";
  const image = document.createElement("div");
  image.className = "image";
  if (VIDEO_EXT_RE.test(s.image_file)) {
    const vid = document.createElement("video");
    vid.style.width = "100%";
    vid.style.height = "100%";
    vid.controls = true;
    vid.src = `${SIGNAL_ARCHIVE_BASE}/static/uploads/${s.image_file}`;
    vid.autoplay = false;
    vid.preload = "none";
    vid.loop = false;
    vid.muted = false;
    image.appendChild(vid);
  } else {
    image.style.backgroundImage = `url(${SIGNAL_ARCHIVE_BASE}/static/uploads/${s.image_file})`;
    image.style.imageRendering = "auto";
  }
  content.appendChild(image);

  const info = document.createElement("div");
  info.className = "info";
  for (const [label, value] of [
    ["SIGNAL NAME", s.name],
    ["LOCATION", s.location],
    ["TRANSMITTED", fmtDate(s.submitted_at)],
  ] as const) {
    const row = document.createElement("p");
    const lbl = document.createElement("span");
    lbl.className = "label";
    lbl.textContent = label;
    row.appendChild(lbl);
    const b = document.createElement("b");
    b.textContent = value;
    row.appendChild(b);
    info.appendChild(row);
  }
  content.appendChild(info);
  card.appendChild(content);
  return card;
}

/** Idempotent injection of the "↻ RELOAD" button next to the site's
 *  LOAD MORE inside `.sightings .more`. */
async function ensureReloadButton(): Promise<void> {
  const more = document.querySelector<HTMLElement>(SEL.sightingsMore);
  if (!more) return;
  if (more.querySelector(".wd-signals-reload")) return;

  const btn = document.createElement("button");
  btn.className = "wd-signals-reload";
  btn.type = "button";
  btn.textContent = "↻ RELOAD";
  btn.title = "Clear cache and re-fetch the first batch of signals";
  btn.style.marginLeft = "8px";
  btn.addEventListener("click", () => doReload(btn));
  more.appendChild(btn);
  log.ok("SIGNALS", "reload button injected");

  // First-paint hint: if `.posts` is empty but we have cached signals from a
  // previous session, paint them now so the archive doesn't flash blank.
  const posts = document.querySelector<HTMLElement>(SEL.sightingsPosts);
  if (posts && posts.children.length === 0) {
    const cached = getCached<SignalRow[]>(
      cacheKey(0, SIGNAL_FIRST_BATCH),
      CACHE_TTL_SIGNALS_MS,
    );
    if (cached?.length) {
      log.info("SIGNALS", `first-paint from cache: ${cached.length} cards`);
      for (const s of cached) {
        const card = renderCard(s);
        card.classList.add(OUR_CARD_MARKER);
        posts.appendChild(card);
      }
    }
  }
}

async function doReload(btn: HTMLButtonElement): Promise<void> {
  const posts = document.querySelector<HTMLElement>(SEL.sightingsPosts);
  if (!posts) return;
  log.info("SIGNALS", "reload click — busting cache");
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = "↻ …";

  // Wipe any "Nothing here yet" / "End of list" filler the site may have left
  // and any cards we ourselves injected. We deliberately leave the site's
  // own cards alone so the user's scroll history is preserved.
  posts.querySelectorAll("div.f").forEach((n) => n.remove());
  posts.querySelectorAll(`.wpost.${OUR_CARD_MARKER}`).forEach((n) => n.remove());
  clearCached(cacheKey(0, SIGNAL_FIRST_BATCH));

  try {
    const fresh = await loadSignals(0, SIGNAL_FIRST_BATCH, true);
    const frag = document.createDocumentFragment();
    for (const s of fresh) {
      const c = renderCard(s);
      c.classList.add(OUR_CARD_MARKER);
      frag.appendChild(c);
    }
    posts.prepend(frag);
    log.ok("SIGNALS", `reload done: ${fresh.length} cards prepended`);
  } catch (e: any) {
    log.warn("SIGNALS", `reload failed: ${errMsg(e)}`);
  } finally {
    btn.textContent = oldText;
    btn.disabled = false;
  }
}

/**
 * Background poll: once every SIGNAL_BACKGROUND_POLL_MS we re-fetch the first
 * batch and compare the highest `num_id` to what's in cache. If any new
 * signal appeared, we update the cache and fire an OS notification so the
 * user is aware even with the archive tab closed.
 *
 * State for "last seen num_id" lives in its own localStorage key so the
 * cache TTL doesn't reset it.
 */
const LAST_SEEN_KEY = "wd_signals_last_seen_v1";

function loadLastSeenNumId(): number {
  try {
    const raw = localStorage.getItem(LAST_SEEN_KEY);
    if (!raw) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function saveLastSeenNumId(n: number): void {
  try { localStorage.setItem(LAST_SEEN_KEY, String(n)); } catch {}
}

async function backgroundPoll(): Promise<void> {
  try {
    log.info("SIGNALS", "background poll start");
    const fresh = await fetchSignals(0, SIGNAL_FIRST_BATCH);
    if (!fresh.length) return;
    const lastSeen = loadLastSeenNumId();
    const newest = fresh.reduce((max, s) => Math.max(max, s.num_id), 0);
    if (newest <= lastSeen) {
      log.info("SIGNALS", `background poll — no new signals (newest=${newest}, lastSeen=${lastSeen})`);
      return;
    }
    setCached(cacheKey(0, SIGNAL_FIRST_BATCH), fresh);
    saveLastSeenNumId(newest);
    // First-ever poll on a fresh install: don't toast. We just want a
    // baseline so future polls have something to compare against.
    if (lastSeen === 0) {
      log.info("SIGNALS", `background poll — established baseline at num_id=${newest}`);
      return;
    }
    const added = fresh.filter((s) => s.num_id > lastSeen);
    log.ok("SIGNALS", `background poll — ${added.length} new signal(s); newest #${newest}`);
    notify(
      t("signalNewTitle"),
      t("signalNewBody", { count: added.length, newest }),
    );
  } catch (e: any) {
    log.warn("SIGNALS", `background poll failed: ${errMsg(e)}`);
  }
}

let watcher: MutationObserver | null = null;
let pollTimer: number | null = null;

/** Begin watching the document for the archive container. The archive may not
 *  exist on every page (it's lazy-rendered when the user opens the panel), so
 *  we install a body-level observer that re-checks on every childList change.
 *  Also kicks off the 24h background poll. */
export function startSignalsCache(): void {
  if (watcher) return;
  log.info("SIGNALS", "startSignalsCache()");
  watcher = new MutationObserver(() => ensureReloadButton());
  watcher.observe(document.body, { childList: true, subtree: true });
  ensureReloadButton();

  // Kick off one poll soon after boot so the user sees fresh data within
  // a minute of opening the tab (without competing with paint hotpath).
  setTimeout(() => backgroundPoll(), 30 * 1000);
  pollTimer = window.setInterval(() => backgroundPoll(), SIGNAL_BACKGROUND_POLL_MS);
}

/** Teardown for tests / hot-reload. */
export function stopSignalsCache(): void {
  watcher?.disconnect();
  watcher = null;
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  log.info("SIGNALS", "stopSignalsCache()");
}
