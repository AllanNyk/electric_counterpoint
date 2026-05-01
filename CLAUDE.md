# Electric Counterpoint — project guide

Browser-based interactive realization of Steve Reich's *Electric Counterpoint*
(1987). The user picks a movement, then conducts a top-down stage of guitars
arranged in a half-moon facing a draggable listener dot. All sounds are
spatialised relative to the listener.

Live at https://allansjoelin.com/electric_counterpoint/. Source at
https://github.com/AllanNyk/electric_counterpoint.

Sister project to `c:\myapps\in_c` (Terry Riley's *In C*); shares the same
stack and several patterns, but with significant differences (see below).

## Stack

- Vanilla JavaScript (ES modules), no framework, no build step.
- Web Audio API for sample playback, per-voice positional channels (dry pan
  + reverb send), shared convolution reverb, master 3-band EQ + compressor.
- Canvas 2D for the stage view. HTML overlay for the movement-select screen,
  top bar, modals, touch panel, and curtain.
- Pointer Events for unified mouse / touch handling.
- Sample sources (all CC0):
  - **Clean electric guitar** — Karoryfer "Black-and-Green Guitars"
    (`sfzinstruments/karoryfer.black-and-green-guitars` on GitHub),
    chromatic A3..C7 in `Samples/black/ord/`, sustain articulation.
    Default for live + numbered guitars.
  - **Acoustic / archtop guitar** — Karoryfer "Shinyguitar"
    (`sfzinstruments/karoryfer.shinyguitar`), 17 minor-third-spaced points
    Db2..C6 in `Samples/acoustic/`. Swap-palette alternate. **Note:** this
    library labels its files an octave below the sounding pitch, so
    build_samples.sh passes `src_label_offset = -12`.
  - **Bass guitar** — Karoryfer "Black-and-Blue Basses"
    (`sfzinstruments/karoryfer.black-and-blue-basses`), chromatic B1..E5
    in `Samples/darkblack/reg/`. Bg1 / Bg2.
  - **Wood block** — VCSL (`sgossner/VCSL`), single `wood_click_mp.wav`
    under `Idiophones/Struck Idiophones/Woodblock/`. Click track.
- `tools/build_samples.sh` curls the specific source WAVs from GitHub raw
  URLs into a local cache (`tools/.cache/`, gitignored), then ffmpeg
  pitch-shifts them to chromatic MP3 banks under
  `assets/audio/<instrument>/<note>.mp3`. Sharps written as 's'
  (`cs4 = C#4`) for URL safety, mirroring `in_c`. The wood-block sample
  is baked with a +12 dB volume boost (the source is mezzo-piano and
  was inaudible at default channel gain).
- Reverb IR: Theatre@41 from openairlib.net (CC-BY, University of York) —
  same IR file as `in_c`.
- Target deploy: static hosting (one.com). GitHub Actions workflow in
  `.github/workflows/deploy.yml` uploads to `webroots/www/electric_counterpoint/`
  via SFTP on every push to `master`.

## How this differs from In C

- **Through-composed, not modular.** No 53 figures, no figure advance, no
  align / lock. Each voice plays its own fixed written part once.
- **Movement select first.** Page loads on a menu (I, II, III). Mvts I & II
  are disabled until their MusicXML is authored.
- **Stage as 2D space.** The ostinato circle is replaced by a draggable
  *listener dot*. Voices arrange in a half-moon facing the listener.
  Voices are also draggable, constrained to the stage half-moon.
- **True positional audio.** Per-voice dry-pan + distance-driven gain +
  distance-driven reverb send, recomputed live as voices or the listener
  move. (In C only had angular pan into a global wet bus.)
- **Live guitar is special.** Larger circle, warmer color, sits in front
  of the half-moon near the listener, default volume slightly higher.
- **No humanization.** Reich's phase-canon idiom depends on precise timing.
  Per-note velocity / timing / detune jitter is intentionally omitted.
- **No visualization gloss.** No background ripples, no unison strands, no
  polyrhythmic sparkles, no rhythm rings, no mandala. Only a brightness
  pulse on each voice's note onsets. Visualization may grow later but In C's
  visual layer is not carried over.
- **No mandala / no Conclude.** The piece has a written end; the scheduler
  detects "all voices exhausted + 3s reverb tail" and fades to a quiet
  curtain.

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
index.html               — movement-select screen, stage view, top bar,
                           touch panel, help & about modals, endgame curtain
src/
  main.js                — orchestration entry point: menu wiring, scheduler
                           tick, render loop, pointer / wheel / keyboard
                           input, drag, modal & curtain handlers, hints
  movements.js           — movement metadata: xml path, notatedBPM, parts
                           map (P1=live, P9-P10=bass, P11=click, …)
  audio.js               — AudioEngine: AudioContext + master chain (EQ,
                           gain, compressor, convolver), per-voice channel
                           with dry+wet split, sample loader, scheduleNote
  score.js               — multi-part MusicXML parser; one note timeline
                           per <part>, walked in absolute seconds @120 BPM
  voice.js               — Voice class: per-voice state (volume, mute,
                           position, instrument, recent onsets), schedule
                           cursor, defaultVolume
  layout.js              — half-moon geometry; default positions per role;
                           clampToStage; voiceColor / voiceRadius helpers
  roster.js              — guitar swap palette + helpers (isSwappable,
                           instrumentLabel, nextInstrument)
assets/audio/<instrument>/  — pre-rendered MP3 banks (one folder per inst)
assets/audio/ir/         — convolution reverb IR (theatre41.wav)
tools/build_samples.sh   — curl + ffmpeg → chromatic MP3 banks (Karoryfer
                           + VCSL sources, cached under tools/.cache/)
.github/workflows/
  deploy.yml             — SFTP deploy to one.com on push to master
III_fast.xml             — MusicXML transcription (NOT in public repo —
                           Reich's score is copyrighted)
roadmap.md               — phased build plan + status
README.md                — public-facing project description
```

## Score source files

`*.xml` are derivatives of Reich's copyrighted 1987 score and are
intentionally `.gitignore`d. `III_fast.xml` is the only authored movement
right now; I_fast.xml and II_slow.xml are placeholders.

## Movement III — part mapping

The MusicXML has 12 `<part>` entries; we map them by `<score-part id>`
in `movements.js`:

| XML id | Role     | Display label | Default position                   |
| ------ | -------- | ------------- | ---------------------------------- |
| P1     | live     | Live          | Front-center, near the listener    |
| P2–P8  | guitar   | Guitar 1–7    | Half-moon arc (left → center)      |
| P9     | bass     | Bg1           | Right flank, inner                 |
| P10    | bass     | Bg2           | Right flank, outer                 |
| P11    | click    | Click         | Back-left of stage (off-center)    |
| P12    | ignore   | —             | (second wood-block stave; skipped) |

The score is encoded at ♩=120 in MusicXML; Reich's notated tempo for mvt
III is ♩=192. The scheduler scales by `notatedBPM / 120` at each
scheduling tick, so the tempo slider's default sits at 192. Mid-piece
tempo changes pivot `playbackStart` so the current score position stays
put across the change (already-scheduled notes within the 0.5 s lookahead
window play at the old timing; new ones use the new tempoFactor).

## Audio chain

Per voice, built by `audio.createVoiceChannel`:

```
source → noteGain → channelGain → splitter
                                 ├─ dryGain → panner → masterSum
                                 └─ wetSend → sharedConvolver → wetReturn → masterSum
```

Master:

```
masterSum → eqBass → eqMid → eqTreble → masterGain → compressor → destination
```

- `pan` = horizontal offset to listener, `dx / (arcRadius * 1.05)`, clamped ±1.
- `dryGain` lerps 1.00 → 0.35 over normalised distance to listener.
- `wetSend` lerps 0.15 → 0.55 over normalised distance — far voices feel
  more "in the room", near voices feel direct/dry.
- All three are recomputed on every drag of any voice or the listener,
  smoothed via `setTargetAtTime` (25 ms time constant — avoids zipper noise).
- `masterGain` sits **after** the EQ so the master volume slider attenuates
  dry AND wet together (the reverb tail doesn't outlive a fade-down).
- The shared `convolver` is a single ConvolverNode loaded with
  Theatre@41. `wetReturn` is the master "Reverb" knob.

## Per-role tunables

In `voice.js`:

- `ROLE_GAIN`  — default channel gain per role
  (live 1.10, guitar 0.90, bass 0.85, click 0.75)
- `ROLE_RELEASE` — gain envelope release time (seconds) after each note's
  written duration. Trims natural sample decay so adjacent eighths don't
  smear into one another.
  (live / guitar 1.1 s, bass 2.0 s, click `null` = natural decay)

In `main.js`:

- `SCHEDULER_LOOKAHEAD` — seconds of audio scheduled ahead of currentTime
  (0.5 s — large enough to survive iOS rapid-tap stalls)
- `SCHEDULER_TICK_MS` — how often the scheduler wakes (100 ms)
- `PLAYBACK_LEAD_IN` — seconds between Play click and t=0 (0.3 s)
- `SPATIAL_SMOOTH` — setTargetAtTime time constant for pan/dry/wet (25 ms)
- `PAN_HALF_WIDTH_SCALE` — how aggressive the stereo pan is (1.05)
- `HINTS` — onboarding hint times + texts (3 s, 13 s, 24 s after Play)

In `layout.js`:

- `STAGE_PADDING` (40 px gutter), `LISTENER_BOTTOM_OFFSET` (0.18 from
  bottom). `VISUAL` — circle radii per role.

## Parser quirks (intentional)

`src/score.js` makes two non-obvious choices:

- **Ignores `<octave-change>`.** The XML carries
  `<octave-change>-1</octave-change>` on every guitar / bass part — the
  standard guitar-clef transposition Sibelius emits for "Electric Guitar"
  parts. Applying it produces music that plays an octave below where it
  should sound: the score is already notated at sounding pitch
  (treble-clef-with-8 in the original), so the transposition is a Sibelius
  export artefact. The parser silently ignores it. If a future movement
  uses non-guitar instruments with real transposition, this will need to
  become role-aware.
- **Reads `<unpitched>` for percussion.** The wood-block click part
  encodes its notes as `<unpitched>` with a `<display-step>` /
  `<display-octave>` pair (standard MusicXML for unpitched percussion).
  The parser uses the display pitch as a sentinel MIDI so the note still
  enters the timeline — the click voice's `filenameFor()` always returns
  `'click'` and ignores the actual MIDI value.

## Conventions

- HTML widgets only for: movement-select, top bar, modals, touch panel,
  endgame curtain. Stage / voice / listener interaction happens on the
  canvas.
- AudioContext is created on first user click (browser autoplay policy)
  and defensively resumed on every pointerdown.
- Sample paths are relative (`assets/audio/<instr>/<note>.mp3`) so the
  page works under any URL prefix.
- Range-input sliders carry `autocomplete="off"` AND have their values
  re-applied in JS on movement-select — browser session caching otherwise
  overrides intended defaults (Firefox in particular).
- Touch vs drag distinguished by `TAP_SLOP_PX = 6` of pointer movement.
  Touch tap on a voice opens the bottom touch panel; drag still works on
  touch the same as mouse.
- A single Esc handler with priority `modal → curtain → touch panel`
  ensures one Esc press always picks the right thing to dismiss.

## Adding the next movement

1. Author the MusicXML for the movement (transpose-ignored conventions
   above apply). Save as `I_fast.xml` or `II_slow.xml` at the project
   root.
2. In `movements.js`, set the entry's `available: true` and fill in its
   `parts` map (live + guitars 1-12 + 2 bass + click for I & II — note
   the higher voice count vs III).
3. Confirm the layout in `layout.js` handles 12 numbered guitars on the
   arc (current geometry should scale; verify spacing).
4. Add the movement's notated BPM to the entry's `notatedBPM` so the
   tempo slider defaults to Reich's tempo.
