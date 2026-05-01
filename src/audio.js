// audio.js — Web Audio engine for Electric Counterpoint.
//
// Architecture (chain shared by every voice):
//
//   voice source → noteGain → channelGain → splitter
//                                         ├─ dryGain → panner → masterSum
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
// Phase 4 plays everyone at center, dryGain=1, wetSend=0.25. Phase 6
// drives those three numbers from listener position.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();          // 'instrument:note' -> AudioBuffer
    this.loadingPromises = new Map();  // 'instrument:note' -> Promise
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

    // Gentle gluing compressor.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 3;
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
  // them: channelGain (its own volume), dryGain / wetSend (spatial), panner.
  createVoiceChannel({ initialGain = 1.0, initialPan = 0, initialDry = 1.0, initialWet = 0.25 } = {}) {
    const channelGain = this.ctx.createGain();
    channelGain.gain.value = initialGain;

    const dryGain = this.ctx.createGain();
    dryGain.gain.value = initialDry;

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clampPan(initialPan);

    const wetSend = this.ctx.createGain();
    wetSend.gain.value = initialWet;

    channelGain.connect(dryGain).connect(panner).connect(this.masterSum);
    channelGain.connect(wetSend).connect(this.convolver);

    return { channelGain, dryGain, panner, wetSend };
  }

  async loadSample(instrument, note) {
    const key = `${instrument}:${note}`;
    if (this.buffers.has(key)) return this.buffers.get(key);
    if (this.loadingPromises.has(key)) return this.loadingPromises.get(key);
    const p = (async () => {
      const url = `assets/audio/${instrument}/${note}.mp3`;
      const arr = await fetch(url).then(r => {
        if (!r.ok) throw new Error(`failed to fetch ${url}`);
        return r.arrayBuffer();
      });
      const buf = await this.ctx.decodeAudioData(arr);
      this.buffers.set(key, buf);
      return buf;
    })();
    this.loadingPromises.set(key, p);
    try { return await p; }
    finally { this.loadingPromises.delete(key); }
  }

  // Schedule a buffered note on a voice channel.
  // `channel` is the object returned by createVoiceChannel (we connect
  // through its channelGain). When `releaseTime` is null (or duration is
  // null) the sample plays its full natural decay — right for percussive
  // hits like the wood-block click. Otherwise the gain envelope holds
  // at full from `when` to `when + duration`, then linearly ramps to 0
  // over `releaseTime`, trimming the bleed between adjacent eighths
  // without quantising onsets.
  scheduleNote(channel, instrument, note, when, gain = 1.0, duration = null, releaseTime = null) {
    const key = `${instrument}:${note}`;
    const buf = this.buffers.get(key);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const noteGain = this.ctx.createGain();
    noteGain.gain.value = gain;
    src.connect(noteGain).connect(channel.channelGain);
    src.start(when);
    if (duration != null && releaseTime != null) {
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
