/**
 * Regression test for the "Clear overlay comes back after reload" bug.
 *
 * Bug: `clearOverlay()` reset `overlayData` to an empty object, but it FIRST
 * kicked a render of the still-present old source (via `setOverlayAnimation`
 * with its default `render = true`). `rasteriseFrame` is ASYNC — the work runs
 * inside `img.onload` — so that render landed AFTER the reset and re-wrote
 * `overlayData.src` (overlay.ts: `renderDiffOnly` → `overlayData.src = url`).
 * The pending debounced persist save (overlay-persist.ts) then saw a non-empty
 * `overlayData.src` and re-persisted the "cleared" template, so it returned on
 * the next page load.
 *
 * Fix: `clearOverlay()` stops the animation with `render = false` (no new
 * render of the doomed source) AND bumps the render generation so any render
 * already in flight drops in its onload guard (`gen !== _renderGen`) instead of
 * repopulating `overlayData.src`.
 *
 * This test models that exact ordering with the real semantics (async render
 * onload + a live-binding `overlayData.src` read inside the debounced save +
 * a render-generation guard). It does NOT import overlay.ts (that module reads
 * `document`/`window` at import time); instead it reproduces the invariant that
 * a stale render MUST NOT un-clear the overlay.
 *
 * Run: bun tests/extension/overlay-clear-persist.test.ts
 */
import assert from "node:assert";

// --- Minimal model of the overlay render + persistence interaction. --------

interface Overlay {
  src: string;
  srcOrig?: string;
}

function makeWorld() {
  let overlay: Overlay = { src: "", srcOrig: undefined };
  let renderGen = 0;
  const store: Record<string, unknown> = {};
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  const pending: Array<() => void> = []; // queued async render onloads

  // rasteriseFrame(): async. Captures a generation, schedules an onload that
  // (if still current) writes overlay.src — exactly like renderDiffOnly.
  function rasteriseFrame(): void {
    const gen = ++renderGen;
    pending.push(() => {
      if (gen !== renderGen) return; // stale — drop (the real onload guard)
      overlay.src = "RENDERED:" + (overlay.srcOrig || overlay.src);
    });
  }

  // The debounced persist save: gate on the LIVE overlay.src (live binding).
  function scheduleSave(): void {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!overlay.src) {
        delete store.lastOverlay;
        return;
      }
      store.lastOverlay = { template: { image_data_url: overlay.srcOrig || overlay.src } };
    }, 0);
  }

  return {
    get overlay() {
      return overlay;
    },
    setOverlay(o: Overlay) {
      overlay = o;
    },
    get store() {
      return store;
    },
    rasteriseFrame,
    scheduleSave,
    bumpGen() {
      renderGen++;
    },
    flushRenders() {
      const q = pending.splice(0);
      for (const fn of q) fn();
    },
    async flushSave() {
      await new Promise((r) => setTimeout(r, 5));
    },
  };
}

// --- 1. BUGGY ordering (no gen bump on clear) re-persists. Guards that our ---
//        model actually reproduces the failure it is protecting against. -----
{
  const w = makeWorld();
  // load
  w.setOverlay({ src: "PNG", srcOrig: "PNG" });
  w.scheduleSave();
  await w.flushSave();
  w.flushRenders();
  assert.equal((w.store.lastOverlay as any)?.template?.image_data_url, "PNG", "loaded template persisted");

  // BUGGY clear: kick a render, THEN reset (no gen bump)
  w.rasteriseFrame(); // render of the still-present old source, async
  w.setOverlay({ src: "", srcOrig: undefined }); // reset
  w.scheduleSave(); // debounced save pending (src currently "")
  delete w.store.lastOverlay; // clearPersistedOverlay()

  w.flushRenders(); // stale render lands → repopulates overlay.src
  await w.flushSave(); // debounced save now sees non-empty src → re-persists
  assert.ok(w.store.lastOverlay, "buggy path DOES re-persist (reproduction sanity check)");
}

// --- 2. FIXED ordering: render=false (no new render) + gen bump drops any ----
//        in-flight render, so nothing re-writes overlay.src. Stays cleared. ---
{
  const w = makeWorld();
  w.setOverlay({ src: "PNG", srcOrig: "PNG" });
  w.scheduleSave();
  await w.flushSave();
  w.flushRenders();
  assert.ok(w.store.lastOverlay, "precondition: template persisted");

  // Simulate a render already in flight from a move right before Clear.
  w.rasteriseFrame();

  // FIXED clear: no new render kicked; bump gen to invalidate in-flight render.
  w.bumpGen();
  w.setOverlay({ src: "", srcOrig: undefined });
  w.scheduleSave();
  delete w.store.lastOverlay; // clearPersistedOverlay()

  w.flushRenders(); // in-flight render is stale (gen bumped) → dropped
  await w.flushSave();
  assert.equal(w.overlay.src, "", "overlay.src stays empty after clear");
  assert.ok(!w.store.lastOverlay, "cleared overlay is NOT re-persisted");
}

// --- 3. Normal load still persists (fix must not break persistence). --------
{
  const w = makeWorld();
  w.setOverlay({ src: "PNG2", srcOrig: "PNG2" });
  w.rasteriseFrame(); // normal render, current generation
  w.flushRenders(); // lands, sets overlay.src to the rendered PNG
  w.scheduleSave();
  await w.flushSave();
  assert.ok(w.store.lastOverlay, "normal load persists");
  // export prefers srcOrig (the original source) over the rendered src.
  assert.equal((w.store.lastOverlay as any).template.image_data_url, "PNG2", "original src persisted");
}

console.log("overlay-clear-persist: 3 checks passed");
