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
  click:  0.55,
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
    this.userVolume = ROLE_GAIN[this.role] ?? 1.0;
    this.scheduledIdx = 0;

    this.channel = audio.createVoiceChannel({ initialGain: this.effectiveGain() });
  }

  effectiveGain() {
    return this.muted ? 0 : this.userVolume;
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
      this.channel.channelGain.gain.value = this.effectiveGain();
    }
  }

  // Filename token for a given MIDI on this voice. Click is unpitched —
  // always returns 'click', so the woodblock single sample serves every
  // notated pitch in the click part.
  filenameFor(midi) {
    if (this.role === 'click') return 'click';
    return midiToFilename(midi);
  }

  // Pre-load every sample this part will need so playback never stalls
  // mid-piece on a network round-trip.
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
        const fname = this.filenameFor(note.midi);
        // Per-note gain: 1.0 baseline; channel gain handles volume/mute.
        this.audio.scheduleNote(this.channel, this.instrument, fname, audioTime, 1.0, null);
      }
      this.scheduledIdx++;
    }
  }

  // True once every note in the part has been scheduled.
  get isExhausted() {
    return this.scheduledIdx >= this.notes.length;
  }
}
