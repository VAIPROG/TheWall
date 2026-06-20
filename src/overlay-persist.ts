/**
 * Remember the last overlay across page reloads.
 *
 * The overlay's full state (image, position, scale, animation) is exactly
 * what `exportToWallDevJson()` already serialises, so persistence reuses that
 * envelope and restores it through `applyWallDevExport()` — the same path an
 * import/autoload takes, which keeps every component (image layer, dots,
 * coord inputs, scale controls, animation) in sync for free.
 *
 * Storage is IndexedDB, not localStorage: a template's `image_data_url` is a
 * data URL that routinely runs into several MB, well past the ~5 MB
 * localStorage ceiling.
 *
 * Saves are debounced and fire off the `wd:overlay-changed` event that the
 * overlay mutators emit; an empty overlay deletes the saved record so a
 * cleared canvas stays cleared after reload.
 */
import { exportToWallDevJson, applyWallDevExport } from "./walldev-config";
import { overlayData } from "./overlay";
import { errMsg } from "./helpers";
import { log } from "./log";

const DB_NAME = "walldev";
const STORE = "kv";
const KEY = "lastOverlay";
const SAVE_DEBOUNCE_MS = 800;

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const r = run(d.transaction(STORE, mode).objectStore(STORE));
        r.onsuccess = () => resolve(r.result as T);
        r.onerror = () => reject(r.error);
      }),
  );
}

const idbGet = <T>(key: string) => tx<T>("readonly", (s) => s.get(key));
const idbSet = (key: string, val: unknown) => tx<unknown>("readwrite", (s) => s.put(val, key));
const idbDel = (key: string) => tx<unknown>("readwrite", (s) => s.delete(key));

let saveTimer: number | null = null;
function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    saveTimer = null;
    try {
      if (!overlayData.src) {
        await idbDel(KEY);
        log.info("OVERLAY_PERSIST", "no overlay — cleared saved state");
        return;
      }
      await idbSet(KEY, exportToWallDevJson({}));
      log.ok("OVERLAY_PERSIST", "saved current overlay");
    } catch (e) {
      log.warn("OVERLAY_PERSIST", `save failed: ${errMsg(e)}`);
    }
  }, SAVE_DEBOUNCE_MS);
}

/** Start listening for overlay changes and persisting them. */
export function wireOverlayPersistence(): void {
  document.addEventListener("wd:overlay-changed", scheduleSave);
  log.ok("OVERLAY_PERSIST", "wired");
}

/** Persist immediately (skip the debounce). Used before a teleport reload so
 *  the current overlay is guaranteed on disk when the page comes back. */
export async function flushOverlaySave(): Promise<void> {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    if (!overlayData.src) await idbDel(KEY);
    else await idbSet(KEY, exportToWallDevJson({}));
  } catch (e) {
    log.warn("OVERLAY_PERSIST", `flush failed: ${errMsg(e)}`);
  }
}

/** Re-apply the last saved overlay, if any. Returns true when one was loaded. */
export async function restoreLastOverlay(): Promise<boolean> {
  try {
    const saved = await idbGet<any>(KEY);
    if (!saved?.template?.image_data_url) return false;
    await applyWallDevExport(saved);
    log.ok("OVERLAY_PERSIST", `restored overlay @ (${saved.template.x},${saved.template.y})`);
    return true;
  } catch (e) {
    log.warn("OVERLAY_PERSIST", `restore failed: ${errMsg(e)}`);
    return false;
  }
}

/** Forget the saved overlay (used by the Clear button). */
export async function clearPersistedOverlay(): Promise<void> {
  try {
    await idbDel(KEY);
  } catch (e) {
    log.warn("OVERLAY_PERSIST", `clear failed: ${errMsg(e)}`);
  }
}
