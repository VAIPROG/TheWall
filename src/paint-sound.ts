/**
 * Audio cue for the "paint refilled" event.
 *
 * A tiny WebAudio chime — two short tones (low → high) generated with an
 * OscillatorNode. We deliberately don't ship an audio file because:
 *   - WebAudio is universally available in every browser the extension
 *     targets (Chrome 111+, Firefox 128+, Safari 16+);
 *   - generating the tone live keeps the bundle small (no .mp3/.ogg ship);
 *   - the user can adjust volume / disable entirely from Settings without us
 *     decoding a payload each time.
 *
 * Public API:
 *   playPaintRefillSound()  fire-and-forget; respects cfg.paintRefillSound
 *                            and cfg.paintRefillVolume.
 *
 * Browser quirk: Chrome's autoplay policy requires a user gesture before a
 * brand-new AudioContext can produce sound. The first refill after page load
 * may therefore be silent on a tab that hasn't been clicked yet — that's
 * intentional browser behavior, not a bug. Once the user has interacted with
 * the page even once (clicked anywhere), every subsequent refill chimes
 * normally.
 */
import { cfg } from "./config";
import { log } from "./log";
import { errMsg } from "./helpers";
import {
  PAINT_REFILL_TONE_LOW_HZ,
  PAINT_REFILL_TONE_HIGH_HZ,
  PAINT_REFILL_TONE_LEN_MS,
  PAINT_REFILL_TONE_GAP_MS,
} from "./constants";

let ctx: AudioContext | null = null;

/** Lazily create the AudioContext. Constructing it on import would break in
 *  Chromium where the policy demands a user gesture before any context can
 *  be created — even one that never plays. */
function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  try {
    const Ctor: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) {
      log.warn("PAINT_SND", "AudioContext not available");
      return null;
    }
    ctx = new Ctor();
    return ctx;
  } catch (e: any) {
    log.warn("PAINT_SND", `ctx create failed: ${errMsg(e)}`);
    return null;
  }
}

/** Schedule one tone at the given offset. The envelope is a quick attack +
 *  exponential decay so the chime has a "soft mallet" feel rather than a
 *  raw beep. */
function scheduleTone(
  c: AudioContext,
  freqHz: number,
  startAt: number,
  durMs: number,
  volume: number,
): void {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freqHz;
  // Envelope: 5ms attack to peak, exponential decay over `durMs`.
  const peak = Math.max(0, Math.min(1, volume));
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + durMs / 1000);
  osc.connect(gain).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + durMs / 1000 + 0.02);
}

/**
 * Play the paint-refilled chime. Honors:
 *   - cfg.paintRefillSound   (false → no-op)
 *   - cfg.paintRefillVolume  (0..1, clamped)
 */
export function playPaintRefillSound(): void {
  if (!cfg.paintRefillSound) {
    log.trace("PAINT_SND", "muted by config");
    return;
  }
  const c = ensureCtx();
  if (!c) return;

  // Resume in case the context was suspended by the browser policy. This is
  // a no-op when the context is already running.
  if (c.state === "suspended") {
    c.resume().catch(() => { /* user hasn't interacted yet; will retry */ });
  }

  const vol = typeof cfg.paintRefillVolume === "number" ? cfg.paintRefillVolume : 0.35;
  const now = c.currentTime;
  const toneSec = PAINT_REFILL_TONE_LEN_MS / 1000;
  const gapSec = PAINT_REFILL_TONE_GAP_MS / 1000;

  scheduleTone(c, PAINT_REFILL_TONE_LOW_HZ, now, PAINT_REFILL_TONE_LEN_MS, vol);
  scheduleTone(c, PAINT_REFILL_TONE_HIGH_HZ, now + toneSec + gapSec, PAINT_REFILL_TONE_LEN_MS, vol);
  log.ok("PAINT_SND", `chime played (vol=${vol.toFixed(2)})`);
}
