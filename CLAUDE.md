# Electric Counterpoint — project guide

Browser-based interactive realization of Steve Reich's *Electric Counterpoint*
(1987). The user picks a movement, then conducts a top-down stage of guitars
arranged in a half-moon facing a draggable listener dot. All sounds are
spatialised relative to the listener.

Sister project to `c:\myapps\in_c` (Terry Riley's *In C*); shares the same
stack and several patterns, but with significant differences (see below).

## Stack

- Vanilla JavaScript (ES modules), no framework, no build step.
- Web Audio API for sample playback, per-voice positional channels (dry pan
  + reverb send), shared convolution reverb, master 3-band EQ + compressor.
- Canvas 2D for the stage view. HTML overlay for the movement-select screen,
  top bar, modals, and touch panel.
- Pointer Events for unified mouse / touch handling.
- Sample library: Versilian Community Sample Library (VCSL, CC0). Source
  WAVs are pre-rendered to chromatic MP3 banks under `assets/audio/`.
- Reverb IR: Theatre@41 from openairlib.net (CC-BY, University of York) —
  same IR file as `in_c`.

## How this differs from In C

- **Through-composed, not modular.** No 53 figures, no figure advance, no
  align / lock. Each voice plays its own fixed written part once.
- **Movement select first.** Page loads on a menu (I, II, III). Mvts I & II
  are disabled until their MusicXML is authored.
- **Stage as 2D space.** The ostinato circle is replaced by a draggable
  *listener dot*. Voices arrange in a half-moon facing the listener.
  Voices are also draggable (constrained to the stage).
- **True positional audio.** Per-voice dry-pan + distance-driven gain +
  distance-driven reverb send, recomputed live as voices or the listener
  move. (In C only had angular pan into a global wet bus.)
- **Live guitar is special.** Larger circle, warmer color, sits in front
  of the half-moon near the listener, default volume slightly higher.
- **No humanization.** Reich's phase-canon idiom depends on precise timing.
  Per-note velocity/timing/detune jitter is intentionally omitted.
- **No visualization gloss.** No background ripples, no unison strands, no
  polyrhythmic sparkles, no rhythm rings, no mandala. We may add focused
  visualization later, but the In C visuals are not carried over.
- **No mandala / no Conclude.** The piece has a written end; we just fade
  to a quiet curtain.

## How to run locally

From the project root:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

ES modules require an HTTP origin — opening `index.html` directly via
`file://` will not work. You also need the relevant movement's MusicXML at
the project root (`III_fast.xml` is the one currently authored).

## File structure

```
index.html               — movement-select screen + stage view, top bar styles
src/
  main.js                — orchestration entry point: menu wiring, scheduler,
                           render loop, input handling (filled out per phase)
  movements.js           — movement metadata: xml path, notated BPM, voice
                           layout (P1 = live, P9-P10 = bass, P11 = click, …)
  audio.js               — AudioEngine: sample loading, per-voice positional
                           channels (dry pan + wet send), master EQ +
                           compressor + shared convolution reverb        (TBD)
  score.js               — multi-part MusicXML parser; one note timeline
                           per <part>, walked in absolute seconds @120 BPM (TBD)
  voice.js               — Voice class: per-voice state, sample preload,
                           drag position, mute / gain, instrument swap    (TBD)
  layout.js              — half-moon geometry; computes default stage
                           positions for live / guitars / basses / click  (TBD)
  roster.js              — guitar swap palette (clean / nylon / acoustic)  (TBD)
assets/audio/<instrument>/  — pre-rendered MP3 banks (one folder per inst)  (TBD)
assets/audio/ir/         — convolution reverb IR (theatre41.wav)            (TBD)
tools/build_samples.sh   — ffmpeg pipeline → chromatic MP3 banks            (TBD)
III_fast.xml             — MusicXML transcription (NOT in public repo —
                           Reich's score is copyrighted)
roadmap.md               — phased build plan + status
```

## Score source files

`*.xml` are derivatives of Reich's copyrighted 1987 score and are
intentionally `.gitignore`d. `III_fast.xml` is the only authored movement
right now; I_fast.xml and II_slow.xml are placeholders.

## Movement III — part mapping

The MusicXML has 12 `<part>` entries; we map them by `<score-part id>`:

| XML id | Role     | Display label | Default position                   |
| ------ | -------- | ------------- | ---------------------------------- |
| P1     | live     | Live          | Front-center, near the listener    |
| P2–P8  | guitar   | Guitar 1–7    | Half-moon arc (left → center)      |
| P9     | bass     | Bg1           | Right flank, inner                 |
| P10    | bass     | Bg2           | Right flank, outer                 |
| P11    | click    | Click         | Fixed at center-back of stage      |
| P12    | ignore   | —             | (second wood-block stave; skipped) |

The score is encoded at ♩=120 in MusicXML; Reich's notated tempo for mvt
III is ♩=192. The scheduler scales by `notatedBPM / 120` at each scheduling
boundary, so the tempo slider's default sits at 192.

## Spatial audio chain (per voice)

```
source → noteGain → channelGain → highpass → presence → splitter
                                                       ├─ dryGain → panner → masterDry
                                                       └─ wetSend → convolver → wetReturn → masterDry
masterDry → eqBass → eqMid → eqTreble → compressor → destination
```

- `pan` = horizontal offset to listener, `dx / halfStageWidth` clamped to ±1.
- `dryGain` lerps 1.0 → 0.35 over distance to listener.
- `wetSend` lerps 0.15 → 0.55 over distance — far voices feel more "in the
  room", near voices feel direct/dry.
- All three are recomputed on every drag of any voice or the listener,
  smoothed via `setTargetAtTime` (avoids zipper noise).

## Conventions

- HTML widgets only for: movement-select, top bar, modals, touch panel.
  Stage / voice / listener interaction happens on the canvas.
- AudioContext is created on first user click (browser autoplay policy)
  and defensively resumed on every pointerdown.
- Sample paths are relative (`assets/audio/<instr>/<note>.mp3`) so the
  page works under any URL prefix.
- Range-input sliders carry `autocomplete="off"` and re-apply defaults on
  page load — browser session caching otherwise overrides intended values.
