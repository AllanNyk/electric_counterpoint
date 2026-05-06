// voice.js — one Voice per <part> in the score. Holds the part's note
// timeline, its audio channel, mute / volume state, and a scheduling
// cursor that advances as time passes.
//
// Phase 4: voices are stationary, default pan=0. Phase 6 adds setPosition
// which recomputes pan / dryGain / wetSend from listener distance.

import { midiToFilename } from './score.js';

// Default starting volume per role. Live guitar is intentionally pushed
// up — it's the soloist on stage. Click sits low so it functions as a
// quiet structural pulse, not a foreground voice.
const ROLE_GAIN = {
  live:   1.10,
  guitar: 0.90,
  bass:   0.85,
  click:  0.75,
};

// Per-role release time (seconds) applied after the note's written
// duration. Karoryfer guitar samples are ~2.6 s natural decay; bass ~5 s.
// 1.1 s on guitar trims the bleed between consecutive eighth notes
// roughly in half. Bass holds longer (musically appropriate — the bass
// is the harmonic anchor). Click is null = no envelope, natural decay.
const ROLE_RELEASE = {
  live:   1.1,
  guitar: 1.1,
  bass:   1.1,
  click:  null,
};

// Per-instrument tuning that overrides role defaults. Mallet samples
// behave very differently from guitar:
//   - Marimba:    short natural decay (~0.5 s); a 1.1 s release tail just
//                 fades silence, but a tighter envelope keeps adjacent
//                 sixteenths clean. Slight gain bump because the bank
//                 reads a touch quiet next to clean electric.
//   - Vibraphone: long bell-like sustain. A 1.1 s release chops the ring
//                 off prematurely; 2.4 s lets the bars sing. Gain trimmed
//                 because the bank's brightness can sit forward in the mix.
const INSTRUMENT_RELEASE = {
  marimba:    0.5,
  vibraphone: 2.4,
};
const INSTRUMENT_GAIN_BIAS = {
  marimba:    1.10,
  vibraphone: 0.85,
};

export class Voice {
  constructor(part, audio, instrument) {
    this.part = part;
    this.audio = audio;
    this.instrument = instrument; // 'guitar_clean' | 'bass_guitar' | 'woodblock'

    this.id = part.id;
    this.role = part.role;
    this.label = part.label;
    this.notes = part.notes;

    this.muted = false;
    this.defaultVolume = ROLE_GAIN[this.role] ?? 1.0;
    this.userVolume = this.defaultVolume;
    // Multiplier applied while another voice is spotlit (1.0 = no spotlight
    // active or this voice is the spotlit one). Set via setSpotlightAttenuation.
    this.spotlightAttenuation = 1.0;
    this.scheduledIdx = 0;

    // Stage position — set by main.js once layout is computed. Phase 5
    // renders these statically; phase 6 makes them user-draggable.
    this.x = 0;
    this.y = 0;

    // Onset history for the visual pulse. Each scheduled note pushes its
    // audioTime; the renderer reads the most recent and fades brightness
    // back to baseline over PULSE_DURATION seconds.
    this.recentOnsets = [];

    this.channel = audio.createVoiceChannel({ initialGain: this.effectiveGain() });
  }

  setPosition(x, y) {
    this.x = x;
    this.y = y;
  }

  effectiveGain() {
    if (this.muted) return 0;
    return this.userVolume * this.spotlightAttenuation;
  }

  setMuted(muted) {
    this.muted = muted;
    // Apply a short fade so toggling doesn't click.
    const g = this.channel.channelGain.gain;
    const ctx = this.audio.ctx;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(this.effectiveGain(), ctx.currentTime + 0.15);
  }

  setVolume(v) {
    this.userVolume = Math.max(0, Math.min(1.5, v));
    if (!this.muted) {
      const g = this.channel.channelGain.gain;
      const ctx = this.audio.ctx;
      // Cancel any in-flight ramp (e.g. spotlight fade) so the new value
      // sticks rather than getting overwritten when the ramp continues.
      g.cancelScheduledValues(ctx.currentTime);
      g.setValueAtTime(this.effectiveGain(), ctx.currentTime);
    }
  }

  // Smoothly ramp channelGain to effectiveGain() at the new attenuation.
  // 0.25 s feels like a natural "duck" — long enough to be musical, short
  // enough that switching spotlight between voices stays responsive.
  setSpotlightAttenuation(target) {
    this.spotlightAttenuation = Math.max(0, Math.min(1, target));
    const g = this.channel.channelGain.gain;
    const ctx = this.audio.ctx;
    g.cancelScheduledValues(ctx.currentTime);
    g.setValueAtTime(g.value, ctx.currentTime);
    g.linearRampToValueAtTime(this.effectiveGain(), ctx.currentTime + 0.25);
  }

  // Switch to a new instrument bank. Currently-playing notes finish on
  // the old samples (already scheduled); future scheduleAhead calls pick
  // up the new bank automatically. Caller must ensure samples for the
  // new bank are pre-loaded — main.js loads the whole swap palette at
  // movement-select time so this is a synchronous, instant switch.
  changeInstrument(newInstrumentId) {
    this.instrument = newInstrumentId;
  }

  // Filename token for a given MIDI on this voice. Click is unpitched —
  // always returns 'click', so the woodblock single sample serves every
  // notated pitch in the click part.
  filenameFor(midi) {
    if (this.role === 'click') return 'click';
    return midiToFilename(midi);
  }

  // Pre-load every sample this part will need so playback never stalls
  // mid-piece on a network round-trip. The click voice always plays a
  // single unpitched sample (see filenameFor), so we only need that one.
  async loadSamples() {
    if (this.role === 'click') {
      await this.audio.loadSample(this.instrument, 'click');
      return;
    }
    const uniqueMidis = new Set(this.notes.map(n => n.midi));
    await Promise.all(
      [...uniqueMidis].map(midi => this.audio.loadSample(this.instrument, midiToFilename(midi)))
    );
  }

  reset() {
    this.scheduledIdx = 0;
  }

  // Schedule any notes whose mapped audio time falls in
  // [audio.currentTime, scheduleUntil]. `playbackStart` is the audio-
  // context time corresponding to score t=0; `tempoFactor` scales score
  // seconds (encoded at 120 BPM) into wall-clock seconds at the active
  // BPM (tempoFactor = 120 / currentBPM).
  scheduleAhead(playbackStart, scheduleUntil, tempoFactor) {
    while (this.scheduledIdx < this.notes.length) {
      const note = this.notes[this.scheduledIdx];
      const audioTime = playbackStart + note.time * tempoFactor;
      if (audioTime > scheduleUntil) break;

      // Skip notes that are already in the past (e.g. graces with
      // negative score time when playback starts at t=0).
      if (audioTime >= this.audio.currentTime - 0.005) {
        let fname = this.filenameFor(note.midi);
        let rate = 1;
        // Pitched voices: if the current bank doesn't cover this MIDI
        // (e.g. marimba tops out at C6 but the score reaches E6), find
        // the nearest loaded semitone and pitch-shift via playbackRate.
        // Click is unpitched and always uses the single 'click' file.
        if (this.role !== 'click' && !this.audio.hasBuffer(this.instrument, fname)) {
          for (let k = 1; k <= 12; k++) {
            let found = false;
            for (const d of [-k, k]) {
              const altFname = midiToFilename(note.midi + d);
              if (this.audio.hasBuffer(this.instrument, altFname)) {
                fname = altFname;
                rate = Math.pow(2, -d / 12);
                found = true;
                break;
              }
            }
            if (found) break;
          }
        }
        const release = INSTRUMENT_RELEASE[this.instrument] ?? ROLE_RELEASE[this.role];
        const dur = release != null ? note.duration * tempoFactor : null;
        // Per-note gain: parsed dynamic-marking velocity (defaults to
        // 1.0 = mf for unmarked notes), then biased by the instrument bank
        // so e.g. vibraphone doesn't sit too forward when swapped in mid-
        // piece. Channel gain handles user volume / mute / spotlight.
        const vel = (note.velocity ?? 1.0) * (INSTRUMENT_GAIN_BIAS[this.instrument] ?? 1.0);
        this.audio.scheduleNote(this.channel, this.instrument, fname, audioTime, vel, dur, release, rate);
        this.recentOnsets.push(audioTime);
      }
      this.scheduledIdx++;
    }
  }

  // True once every note in the part has been scheduled.
  get isExhausted() {
    return this.scheduledIdx >= this.notes.length;
  }

  // Pulse intensity in [0, 1] for the visual flash on note onsets.
  // Returns the freshest onset's brightness (linear fade over `pulseDur`
  // seconds) and trims stale entries while we're at it.
  pulseIntensity(currentTime, pulseDur = 0.18) {
    // Drop entries fully decayed.
    while (this.recentOnsets.length && currentTime - this.recentOnsets[0] > pulseDur) {
      this.recentOnsets.shift();
    }
    if (this.recentOnsets.length === 0) return 0;
    // Find the most recent onset that's already started (audioTime <= now).
    let latestStarted = -Infinity;
    for (const t of this.recentOnsets) {
      if (t <= currentTime && t > latestStarted) latestStarted = t;
    }
    if (latestStarted === -Infinity) return 0;
    const dt = currentTime - latestStarted;
    if (dt < 0 || dt > pulseDur) return 0;
    return 1 - dt / pulseDur;
  }
}
