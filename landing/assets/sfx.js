/*
 * WallSFX — the shared WebAudio sound bank for the Phase 1 timelapse page
 * Epic Cinematic Ambient Synthwave. Smooth, warm, and evolving score.
 */
(function () {
  let ctx = null;
  let master = null;
  let musicGain = null; // only the generative score routes through this
  let muted = false;
  let musicMuted = false;

  function init() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      // A dedicated bus for the music score so it can be silenced on its own,
      // independently of the SFX (which connect straight to master).
      musicGain = ctx.createGain();
      musicGain.gain.value = musicMuted ? 0 : 1;
      musicGain.connect(master);
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  function setMuted(on) {
    muted = !!on;
    if (master) master.gain.value = muted ? 0 : 1;
  }

  // Mute ONLY the music (the generative score), leaving SFX untouched.
  function setMusicMuted(on) {
    musicMuted = !!on;
    if (musicGain) musicGain.gain.value = musicMuted ? 0 : 1;
  }

  function tone(opts) {
    if (!ctx) return;
    const {
      type = "square",
      from = 440,
      to = from,
      time = 0.05,
      gain = 0.05,
      delay = 0,
    } = opts;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from)
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + time);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + time);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + time + 0.02);
  }

  function noise(durationMs, gain) {
    if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * (durationMs / 1000));
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain ?? 0.15, ctx.currentTime);
    src.connect(g);
    g.connect(master);
    src.start();
  }

  /* ---- DISCRETE SOUNDS ---------------------------------------------------- */
  function typing() {
    tone({
      type: "square",
      from: 600 + Math.random() * 400,
      time: 0.02,
      gain: 0.015,
    });
  }
  function glitch(ms) {
    noise(ms || 120, 0.15);
  }
  function error() {
    tone({ type: "sawtooth", from: 100, to: 40, time: 0.5, gain: 0.15 });
  }
  function impact() {
    tone({ type: "square", from: 150, to: 20, time: 2, gain: 0.4 });
    noise(300, 0.15);
  }
  function beep() {
    tone({ type: "square", from: 880, time: 0.08, gain: 0.05 });
  }
  function select() {
    tone({ type: "triangle", from: 1200, to: 1500, time: 0.04, gain: 0.04 });
  }
  function powerUp() {
    tone({ type: "square", from: 330, to: 660, time: 0.12, gain: 0.06 });
    tone({
      type: "square",
      from: 660,
      to: 990,
      time: 0.16,
      gain: 0.05,
      delay: 0.1,
    });
  }
  function denied() {
    tone({ type: "square", from: 440, to: 330, time: 0.1, gain: 0.06 });
    tone({
      type: "square",
      from: 330,
      to: 180,
      time: 0.18,
      gain: 0.06,
      delay: 0.09,
    });
  }
  function chime() {
    tone({ type: "square", from: 660, time: 0.18, gain: 0.06 });
    tone({ type: "square", from: 880, time: 0.18, gain: 0.06, delay: 0.09 });
    tone({ type: "square", from: 1320, time: 0.3, gain: 0.06, delay: 0.18 });
  }
  function whoosh() {
    if (!ctx) return;
    const n = Math.floor(ctx.sampleRate * 0.5);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filt = ctx.createBiquadFilter();
    filt.type = "bandpass";
    filt.frequency.setValueAtTime(300, ctx.currentTime);
    filt.frequency.exponentialRampToValueAtTime(4000, ctx.currentTime + 0.45);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0008, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.2);
    g.gain.exponentialRampToValueAtTime(0.0008, ctx.currentTime + 0.5);
    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    src.start();
  }
  function scan() {
    tone({ type: "square", from: 1400, to: 200, time: 0.4, gain: 0.04 });
  }

  /* ---- GENERATIVE CINEMATIC SCORE (AMBIENT / SMOOTH SYNTHWAVE) ----------- *
   * Warm, lush, ear-pleasing generative composition. Focus on slow attacks,
   * deep low-pass filtering, and massive spatial reverb.
   * ----------------------------------------------------------------------- */
  let score = null;

  const mfreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // Wide, open cinematic chords (spaced out to prevent muddiness)
  const PROGS = {
    // 0: Ethereal & Melancholic
    dark: [
      { bass: 33, pad: [57, 64, 69, 74], arp: [57, 60, 64, 69] }, // Am11
      { bass: 29, pad: [53, 60, 65, 72], arp: [53, 57, 60, 65] }, // Fmaj9
      { bass: 31, pad: [55, 62, 67, 71], arp: [55, 59, 62, 67] }, // G6
      { bass: 33, pad: [57, 60, 69, 72], arp: [57, 60, 64, 69] }, // Am7
    ],
    // 1: Uplifting Space
    epic: [
      { bass: 29, pad: [53, 60, 65, 72], arp: [53, 57, 60, 65] }, // Fmaj9
      { bass: 36, pad: [60, 67, 72, 76], arp: [60, 64, 67, 72] }, // Cmaj7
      { bass: 31, pad: [55, 62, 67, 74], arp: [55, 59, 62, 67] }, // Gsus4 -> G
      { bass: 33, pad: [57, 64, 69, 76], arp: [57, 60, 64, 69] }, // Am9
    ],
  };

  // Slower, more deliberate lead generation
  function getLeadNote(bar, step, chord) {
    const scale = [0, 2, 4, 7, 9]; // Pentatonic for safety and smoothness
    const seed = (bar * 31 + step * 47) % 100;
    const root = chord.bass + 36; // 3 octaves up
    if (seed < 40) return root + scale[0];
    if (seed < 70) return root + scale[3];
    if (seed < 90) return root + scale[2];
    return root + scale[4];
  }

  function makeWarmIR(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let lastVal = 0;
      for (let i = 0; i < len; i++) {
        // Generate noise but heavily low-pass it via simple math for a warm reverb tail
        const raw = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
        lastVal = lastVal * 0.8 + raw * 0.2;
        d[i] = lastVal;
      }
    }
    return buf;
  }

  function startScore() {
    if (!ctx || score) return;
    const now = ctx.currentTime;

    // --- Master Bus & Soft Mastering ---
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.gain.linearRampToValueAtTime(0.8, now + 12); // Very slow 12s fade in

    // Smooth Limiter (prevents clipping without squashing)
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 12;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.05;
    limiter.release.value = 0.5;

    bus.connect(limiter);
    // Route the whole score through the music bus so it can be muted on its
    // own (musicGain falls back to master if the score starts pre-init).
    limiter.connect(musicGain || master);

    // Lush, Endless Reverb
    const reverb = ctx.createConvolver();
    reverb.buffer = makeWarmIR(4.0, 3.0); // 4 seconds of warm space
    const revSend = ctx.createGain();
    revSend.gain.value = 0.4;
    revSend.connect(reverb);
    reverb.connect(limiter);

    // Warm Tape Delay
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.5; // Slower delay
    const delayFilter = ctx.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 1200; // Muffled echoes
    const fb = ctx.createGain();
    fb.gain.value = 0.6; // High feedback for ambient wash
    delay.connect(delayFilter);
    delayFilter.connect(fb);
    fb.connect(delay);
    const delSend = ctx.createGain();
    delSend.gain.value = 0.35;
    delSend.connect(delay);
    delay.connect(limiter);

    bus.connect(revSend);
    bus.connect(delSend);

    const duckBus = ctx.createGain();
    duckBus.gain.value = 1;
    duckBus.connect(bus);
    duckBus.connect(revSend);

    // --- The Atmospheric Pads ---
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = "lowpass";
    padFilter.frequency.value = 300; // Starts very dark
    padFilter.Q.value = 0.5; // No resonance piercing

    const padGain = ctx.createGain();
    padGain.gain.value = 0;
    padFilter.connect(padGain);
    padGain.connect(duckBus);

    // Ultra-slow LFO for pad movement
    const padLFO = ctx.createOscillator();
    padLFO.type = "sine";
    padLFO.frequency.value = 0.02; // 50 seconds per cycle
    const padLFOGain = ctx.createGain();
    padLFOGain.gain.value = 250;
    padLFO.connect(padLFOGain);
    padLFOGain.connect(padFilter.frequency);
    padLFO.start(now);

    const padVoices = PROGS.dark[0].pad.map((m, i) => {
      // Mixing Triangle for warmth and slightly filtered Saw for texture
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.type = "triangle";
      b.type = "sawtooth";

      a.detune.value = -6;
      b.detune.value = 6;

      const g = ctx.createGain();
      g.gain.value = 0.06; // Quiet and smooth

      // Local filter just to tame the sawtooth before the main pad filter
      const tamer = ctx.createBiquadFilter();
      tamer.type = "lowpass";
      tamer.frequency.value = 1500;

      a.frequency.value = b.frequency.value = mfreq(m);
      a.connect(g);
      b.connect(g);
      g.connect(tamer);
      tamer.connect(padFilter);
      a.start();
      b.start();
      return { a, b };
    });

    // --- Deep Sub Bass ---
    const subOsc = ctx.createOscillator();
    subOsc.type = "sine"; // Pure sine wave, no harmonics = no harshness
    subOsc.frequency.value = mfreq(PROGS.dark[0].bass);
    const subGain = ctx.createGain();
    subGain.gain.value = 0;
    subOsc.connect(subGain);
    subGain.connect(duckBus);
    subOsc.start();

    // --- Soft Synthesizer Engine (ADSR Envelopes) ---
    const playSynth = (
      t,
      m,
      gain,
      type = "triangle",
      doDelay = false,
      env = {},
    ) => {
      const {
        atk = 0.05,
        dec = 0.1,
        sus = 0.5,
        rel = 0.5,
        filtStart = 2000,
        filtEnd = 400,
      } = env;

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const f = ctx.createBiquadFilter();

      o.type = type;
      o.frequency.value = mfreq(m);

      f.type = "lowpass";
      f.frequency.setValueAtTime(filtStart, t);
      f.frequency.exponentialRampToValueAtTime(filtEnd, t + atk + dec);

      // Smooth ADSR Envelope to prevent ALL clicks
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + atk); // Attack
      g.gain.exponentialRampToValueAtTime(gain * sus, t + atk + dec); // Decay to Sustain

      const endTime = t + atk + dec + rel;
      g.gain.setValueAtTime(gain * sus, endTime - rel);
      g.gain.exponentialRampToValueAtTime(0.0001, endTime); // Release

      o.connect(f);
      f.connect(g);
      g.connect(bus);
      if (doDelay) g.connect(delSend);

      o.start(t);
      o.stop(endTime + 0.1);
    };

    // --- Atmospheric Rhythm Section ---
    const kick = (t, gain) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine"; // Soft thud
      o.frequency.setValueAtTime(100, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.2);

      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.02); // Soft attack
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4); // Long, deep tail

      o.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + 0.5);

      // Gentle Sidechain ducking
      duckBus.gain.cancelScheduledValues(t);
      duckBus.gain.setValueAtTime(0.4, t);
      duckBus.gain.setTargetAtTime(1.0, t + 0.1, 0.2); // Smooth recovery
    };

    const softSnare = (t, gain) => {
      // Creates a sound like a distant, heavily reverberated clap
      const n = Math.floor(ctx.sampleRate * 0.3);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++)
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
      const src = ctx.createBufferSource();
      src.buffer = buf;

      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1200; // Low frequency for less harshness
      bp.Q.value = 0.8;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

      src.connect(bp);
      bp.connect(g);
      g.connect(revSend); // 100% wet reverb
      src.start(t);
    };

    // --- Macro Structure Logic ---
    const BPM = 80; // Slower, relaxed tempo
    const spb = 60 / BPM;
    const s16 = spb / 4;
    let step = 0;
    let arpIdx = 0;
    let nextTime = now + 0.15;

    const TOTAL_BARS = 220; // ~11 minutes at 80 BPM

    const scheduleStep = (t) => {
      const bar = Math.floor(step / 16);
      const inBar = step % 16;

      const phase = Math.min(1.0, bar / TOTAL_BARS);

      let progType = phase > 0.3 && phase < 0.7 ? "epic" : "dark";
      let energy = 0;

      if (phase > 0.1 && phase < 0.85) energy = 1;
      if (phase > 0.4 && phase < 0.6) energy = 2; // Peak cinematic moment

      const chordArr = PROGS[progType];
      const chord = chordArr[(bar % 8) % chordArr.length];

      // --- Extremely Smooth Chord Transitions ---
      if (inBar === 0) {
        // Glide pads to new chord over 4 entire seconds
        chord.pad.forEach((m, k) => {
          const f = mfreq(m);
          padVoices[k].a.frequency.exponentialRampToValueAtTime(f, t + 4.0);
          padVoices[k].b.frequency.exponentialRampToValueAtTime(f, t + 4.0);
        });

        subOsc.frequency.exponentialRampToValueAtTime(
          mfreq(chord.bass),
          t + 3.0,
        );

        const pVol = [0.12, 0.18, 0.22][energy];
        const sVol = [0.3, 0.45, 0.6][energy];
        const baseCutoff = [400, 800, 1200][energy];

        padGain.gain.setTargetAtTime(pVol, t, 1.0); // Ultra smooth volume changes
        subGain.gain.setTargetAtTime(sVol, t, 1.0);
        padFilter.frequency.setTargetAtTime(baseCutoff, t, 2.0);
      }

      // --- Minimalist Rhythm ---
      if (energy >= 1) {
        if (inBar === 0) kick(t, 0.8);
        if (energy === 2 && inBar === 10) kick(t, 0.6); // Gentle syncopation

        if (inBar === 8) softSnare(t, 0.4 + energy * 0.1);
      } else {
        // Just a heartbeat pulse in quiet sections
        if (inBar === 0) kick(t, 0.4);
      }

      // --- Plucky Ambient Arp (Dark & Filtered) ---
      if (energy >= 1 && inBar % 2 === 0) {
        // 8th notes, not frantic 16ths
        const arpNote = chord.arp[arpIdx % chord.arp.length] + 12;
        arpIdx++;
        playSynth(t, arpNote, 0.08, "triangle", true, {
          atk: 0.02,
          dec: 0.2,
          sus: 0.1,
          rel: 0.1,
          filtStart: 1200,
          filtEnd: 300,
        });
      }

      // --- Vangelis-style Lead Synth (Expressive & Slow) ---
      if (energy >= 1) {
        const rSeed = (bar * 17 + inBar * 23) % 100;

        // Only plays rarely, holding notes beautifully
        if (rSeed < 12 && inBar % 4 === 0) {
          const leadNote = getLeadNote(bar, inBar, chord);
          // Very long, emotional note
          playSynth(t, leadNote, 0.07, "sawtooth", true, {
            atk: 0.4,
            dec: 1.0,
            sus: 0.8,
            rel: 1.5,
            filtStart: 1800,
            filtEnd: 800,
          });
        }
      }
    };

    const timer = setInterval(() => {
      if (!score) return;
      while (nextTime < ctx.currentTime + 0.2) {
        scheduleStep(nextTime);
        nextTime += s16;
        step++;
      }
    }, 25);

    const sustained = [subOsc, padLFO];
    padVoices.forEach((v) => sustained.push(v.a, v.b));
    score = { bus, sustained, timer };
  }

  function stopScore() {
    if (!score) return;
    const s = score;
    score = null;
    clearInterval(s.timer);
    if (ctx) {
      const t = ctx.currentTime;
      s.bus.gain.cancelScheduledValues(t);
      s.bus.gain.setValueAtTime(s.bus.gain.value, t);
      s.bus.gain.linearRampToValueAtTime(0, t + 6); // Very long, 6-second fade out
    }
    setTimeout(() => {
      s.sustained.forEach((n) => {
        try {
          n.stop();
        } catch (e) {}
      });
    }, 6200);
  }

  window.WallSFX = {
    init,
    setMuted,
    setMusicMuted,
    get musicMuted() {
      return musicMuted;
    },
    typing,
    glitch,
    error,
    impact,
    beep,
    select,
    powerUp,
    denied,
    chime,
    whoosh,
    scan,
    startScore,
    stopScore,
    get ready() {
      return !!ctx;
    },
  };
})();
