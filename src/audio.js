// audio.js — Web Audio engine for Electric Counterpoint.
//
// Architecture (chain shared by every voice):
//
//   voice source → noteGain → channelGain → splitter
//                                         ├─ dryGain → [panner2d | panner3d] → masterSum
//                                         └─ wetSend → sharedConvolver → wetReturn → masterSum
//   masterSum → eqBass → eqMid → eqTreble → masterGain → compressor → destination
//
// Differences vs the In C engine:
// - Each voice has its OWN wetSend so spatial position can drive how much
//   reverb that voice contributes (close = direct, far = roomy). The
//   convolver itself is shared (one IR for the whole stage).
// - masterGain is post-EQ so the master volume slider attenuates dry AND
//   wet together — the reverb tail doesn't outlive a fade-down.
//
// 2D vs 3D panning: every channel has both a StereoPanner (panner2d) and
// a PannerNode in HRTF mode (panner3d). setSpatialMode() rewires which
// one feeds masterSum. The 3D panner does direction only — distance
// attenuation stays in dryGain so the existing distance-driven dry/wet
// crossfade is preserved unchanged.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();          // 'instrument:note' -> AudioBuffer
    this.loadingPromises = new Map();  // 'instrument:note' -> Promise
    this.channels = [];                // every voice channel ever created
    this.spatialMode = '2d';           // '2d' | '3d'
  }

  async init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();

    // Final summing bus for both dry and wet paths.
    this.masterSum = this.ctx.createGain();
    this.masterSum.gain.value = 1.0;

    // 3-band master EQ.
    this.eqBass = this.ctx.createBiquadFilter();
    this.eqBass.type = 'lowshelf';
    this.eqBass.frequency.value = 200;
    this.eqBass.gain.value = 0;

    this.eqMid = this.ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 1.0;
    this.eqMid.gain.value = 0;

    this.eqTreble = this.ctx.createBiquadFilter();
    this.eqTreble.type = 'highshelf';
    this.eqTreble.frequency.value = 4000;
    this.eqTreble.gain.value = 0;

    // Master volume — sits after EQ so the slider attenuates the whole mix.
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.85;

    // Transparent peak-catcher. Original settings (-18/12/3) glued the
    // mix nicely but squashed authored dynamics — a 6.8 dB p↔f spread
    // at source compressed to ~2 dB at the output. Threshold raised to
    // -6 with ratio 2 lets soft notes pass through untouched and only
    // bites on transient peaks above the knee.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -6;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 2;
    this.compressor.attack.value = 0.005;
    this.compressor.release.value = 0.150;

    // Chain: masterSum → EQ → masterGain → compressor → destination.
    this.masterSum
      .connect(this.eqBass)
      .connect(this.eqMid)
      .connect(this.eqTreble)
      .connect(this.masterGain)
      .connect(this.compressor)
      .connect(this.ctx.destination);

    // Shared reverb. Each voice's wetSend connects INTO the convolver;
    // wetReturn after it scales the convolver's output before it joins
    // masterSum. wetReturn is the master "reverb" knob. Until loadIR fills
    // the convolver buffer this path is silent and the engine works dry.
    this.convolver = this.ctx.createConvolver();
    this.wetReturn = this.ctx.createGain();
    this.wetReturn.gain.value = 0.5; // multiplied by per-voice wetSend
    this.convolver.connect(this.wetReturn).connect(this.masterSum);
  }

  async loadIR(url) {
    if (!this.ctx) return;
    const arr = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`failed to fetch ${url}`);
      return r.arrayBuffer();
    });
    this.convolver.buffer = await this.ctx.decodeAudioData(arr);
  }

  setMasterGain(v) { if (this.masterGain) this.masterGain.gain.value = clamp01(v); }
  setReverbWet(v)  { if (this.wetReturn)  this.wetReturn.gain.value  = clamp01(v); }
  setEqBass(db)    { if (this.eqBass)     this.eqBass.gain.value     = clampDb(db); }
  setEqMid(db)     { if (this.eqMid)      this.eqMid.gain.value      = clampDb(db); }
  setEqTreble(db)  { if (this.eqTreble)   this.eqTreble.gain.value   = clampDb(db); }

  // Per-voice channel: a gain stage that splits to dry (panner → master)
  // and wet (send → convolver). Returns the nodes so the Voice can drive
  // them: channelGain (its own volume), dryGain / wetSend (spatial),
  // panner2d (StereoPanner — current pan target in 2D mode), panner3d
  // (HRTF PannerNode — current pan target in 3D mode). Only one panner
  // is connected to masterSum at a time; setSpatialMode swaps them.
  createVoiceChannel({ initialGain = 1.0, initialPan = 0, initialDry = 1.0, initialWet = 0.25 } = {}) {
    const channelGain = this.ctx.createGain();
    channelGain.gain.value = initialGain;

    const dryGain = this.ctx.createGain();
    dryGain.gain.value = initialDry;

    const panner2d = this.ctx.createStereoPanner();
    panner2d.pan.value = clampPan(initialPan);

    // PannerNode handles directional cues only. rolloffFactor=0 disables
    // its built-in distance attenuation so the existing dryGain/wetSend
    // crossfade (driven from main.js) is the single source of truth for
    // distance — keeps the musical "close=direct, far=roomy" feel intact.
    const panner3d = this.ctx.createPanner();
    panner3d.panningModel = 'HRTF';
    panner3d.distanceModel = 'inverse';
    panner3d.refDistance = 1;
    panner3d.maxDistance = 50;
    panner3d.rolloffFactor = 0;

    const wetSend = this.ctx.createGain();
    wetSend.gain.value = initialWet;

    channelGain.connect(dryGain);
    // Dry path routed through whichever panner matches the current mode.
    if (this.spatialMode === '3d') {
      dryGain.connect(panner3d).connect(this.masterSum);
    } else {
      dryGain.connect(panner2d).connect(this.masterSum);
    }
    channelGain.connect(wetSend).connect(this.convolver);

    // Back-compat: existing call sites read channel.panner — keep it
    // pointing at the 2D panner, which is what they expect.
    const channel = { channelGain, dryGain, panner: panner2d, panner2d, panner3d, wetSend };
    this.channels.push(channel);
    return channel;
  }

  // Switch dry-path routing for every channel between the StereoPanner
  // (2D) and the HRTF PannerNode (3D). Must be called after every channel
  // exists; safe to call repeatedly.
  setSpatialMode(mode) {
    if (mode !== '2d' && mode !== '3d') return;
    if (mode === this.spatialMode) return;
    this.spatialMode = mode;
    if (!this.ctx) return;
    for (const ch of this.channels) {
      try { ch.dryGain.disconnect(); } catch {}
      try { ch.panner2d.disconnect(); } catch {}
      try { ch.panner3d.disconnect(); } catch {}
      if (mode === '3d') {
        ch.dryGain.connect(ch.panner3d);
        ch.panner3d.connect(this.masterSum);
      } else {
        ch.dryGain.connect(ch.panner2d);
        ch.panner2d.connect(this.masterSum);
      }
    }
  }

  // Drive the AudioContext's listener pose. Used in 3D mode to track the
  // first-person camera; in 2D mode the listener is implicit (everything
  // panned around an at-origin head). Coordinates are in metres, matching
  // the world-space units used by panner3d positions.
  setListenerPose(x, y, z, fwdX, fwdY, fwdZ, upX = 0, upY = 1, upZ = 0, smooth = 0.02) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const t = this.ctx.currentTime;
    if (L.positionX) {
      L.positionX.setTargetAtTime(x, t, smooth);
      L.positionY.setTargetAtTime(y, t, smooth);
      L.positionZ.setTargetAtTime(z, t, smooth);
      L.forwardX.setTargetAtTime(fwdX, t, smooth);
      L.forwardY.setTargetAtTime(fwdY, t, smooth);
      L.forwardZ.setTargetAtTime(fwdZ, t, smooth);
      L.upX.setTargetAtTime(upX, t, smooth);
      L.upY.setTargetAtTime(upY, t, smooth);
      L.upZ.setTargetAtTime(upZ, t, smooth);
    } else {
      // Older Safari fallback (deprecated API).
      L.setPosition(x, y, z);
      L.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
    }
  }

  // Set a voice's 3D position. Called from main.js's recomputeSpatial in
  // 3D mode. Smoothed to match dry/wet/pan slewing (no zipper).
  setVoicePose(channel, x, y, z, smooth = 0.02) {
    if (!this.ctx || !channel?.panner3d) return;
    const t = this.ctx.currentTime;
    const p = channel.panner3d;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, smooth);
      p.positionY.setTargetAtTime(y, t, smooth);
      p.positionZ.setTargetAtTime(z, t, smooth);
    } else {
      p.setPosition(x, y, z);
    }
  }

  async loadSample(instrument, note) {
    const key = `${instrument}:${note}`;
    if (this.buffers.has(key)) return this.buffers.get(key);
    if (this.loadingPromises.has(key)) return this.loadingPromises.get(key);
    const p = (async () => {
      const url = `assets/audio/${instrument}/${note}.mp3`;
      // Any failure (404, network error, decode error) → cache null and
      // resolve null. Lets palettes with partial pitch coverage (e.g.
      // marimba 48–84 vs score reaching 88) and partial-deploy hosts
      // load without exploding the whole Promise.all; Voice.scheduleAhead
      // falls back to the nearest loaded semitone via playbackRate.
      try {
        const r = await fetch(url);
        if (!r.ok) {
          this.buffers.set(key, null);
          return null;
        }
        const arr = await r.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(arr);
        this.buffers.set(key, buf);
        return buf;
      } catch (err) {
        this.buffers.set(key, null);
        return null;
      }
    })();
    this.loadingPromises.set(key, p);
    try { return await p; }
    finally { this.loadingPromises.delete(key); }
  }

  // True if a non-null buffer is cached for (instrument, note). Lets a
  // Voice probe semitone neighbours when its bank doesn't cover the
  // exact pitch.
  hasBuffer(instrument, note) {
    const buf = this.buffers.get(`${instrument}:${note}`);
    return !!buf;
  }

  // Schedule a buffered note on a voice channel.
  // `channel` is the object returned by createVoiceChannel (we connect
  // through its channelGain). When `releaseTime` is null (or duration is
  // null) the sample plays its full natural decay — right for percussive
  // hits like the wood-block click. Otherwise the gain envelope holds
  // at full from `when` to `when + duration`, then linearly ramps to 0
  // over `releaseTime`, trimming the bleed between adjacent eighths
  // without quantising onsets.
  scheduleNote(channel, instrument, note, when, gain = 1.0, duration = null, releaseTime = null, playbackRate = 1) {
    const key = `${instrument}:${note}`;
    const buf = this.buffers.get(key);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (playbackRate !== 1) src.playbackRate.value = playbackRate;
    const noteGain = this.ctx.createGain();
    noteGain.gain.value = gain;
    src.connect(noteGain).connect(channel.channelGain);
    src.start(when);
    if (duration != null && releaseTime != null) {
      // playbackRate compresses the buffer in time too, but `duration`
      // here is the score-driven hold time, not the sample length, so
      // the envelope still lands where it should regardless of rate.
      const stopAt = when + duration + releaseTime;
      noteGain.gain.setValueAtTime(gain, when + duration);
      noteGain.gain.linearRampToValueAtTime(0, stopAt);
      src.stop(stopAt + 0.01);
    }
    return when;
  }

  get currentTime() { return this.ctx ? this.ctx.currentTime : 0; }
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function clampPan(v) { return Math.max(-1, Math.min(1, v)); }
function clampDb(v) { return Math.max(-12, Math.min(12, v)); }
