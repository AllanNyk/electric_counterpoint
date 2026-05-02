# Electric Counterpoint — Roadmap

A browser-based interactive realization of Steve Reich's *Electric
Counterpoint* (1987). The user picks a movement, then conducts a top-down
stage of guitars arranged in a half-moon facing a draggable listener.

This document tracks the phased build order. Each phase was a listenable,
playable artifact in its own right — we never built something we couldn't
hear. See `CLAUDE.md` for the project guide and architecture notes.

Phases 1–11 are complete and live at
https://allansjoelin.com/electric_counterpoint/. The "Beyond core" section
collects the items intentionally deferred.

---

## Phase 1 — Scaffold + movement select ✓

Movement-select menu (I, II, III). Mvt III enabled, I & II greyed out
"coming soon". Clicking III fades to a stage-view shell with a top bar
and an empty canvas. Back returns to the menu.

---

## Phase 2 — Multi-part score parser ✓

`src/score.js` walks every `<part>` in `III_fast.xml`, accumulates
absolute-time note streams (handling ties, grace notes, divisions
changes, transpose). Returns
`{ parts: [{id, role, label, notes:[{time, midi, duration, grace?}]}], duration }`.

Smoke test landed alongside it: per-part note counts and per-role MIDI
range printed to the stage placeholder so we could sanity-check note
counts and discover which sample-bank ranges each role needed.

---

## Phase 3 — Sample pipeline ✓

Three CC0 banks built by `tools/build_samples.sh`:

- `guitar_clean` — Karoryfer black-and-green-guitars, chromatic E2..C7
  (default for live + guitars 1-7)
- `bass_guitar` — Karoryfer black-and-blue-basses, chromatic E1..E5
  (Bg1, Bg2)
- `woodblock` — VCSL single click (P11), pre-amplified +12 dB

Script flow: curl WAVs from GitHub raw URLs into `tools/.cache/`, then
ffmpeg pitch-shifts to chromatic mp3 banks under
`assets/audio/<instrument>/<note>.mp3`. Sharps written as `s`
(`cs4 = C#4`) for URL safety.

Phase 7 added `guitar_acoustic` (Karoryfer shinyguitar) for the swap
palette — needed a `src_label_offset = -12` because that library labels
its files an octave below the sounding pitch.

---

## Phase 4 — Audio engine + first audible playback ✓

`src/audio.js` and `src/voice.js`. Per-voice positional chain with
dry-path panner and a wet-path send to a shared convolver, even though
this phase held everyone at center pan with a fixed reverb send. Master
EQ + compressor + reverb wired through. Schedule the whole score from
t=0 once the user clicks Play and listen end-to-end.

Surprise on first audible: every guitar/bass part played an octave too
low because the parser was applying `<octave-change>-1</octave-change>`
on top of an already-sounding-pitch score. Fixed by ignoring
octave-change in the parser. Plucked-sample decay was also too long
and bled across eighths — added per-role release envelopes
(guitar 1.1 s, bass 2.0 s).

---

## Phase 5 — Stage view + half-moon layout ✓

`src/layout.js` — top-down stage geometry computed from canvas dims.
Live in front-center, guitars 1-7 along the arc (left → center), Bg1/
Bg2 on the right flank, click at back-left of stage. Stage floor +
back-arc guide line, voice circles with role-driven color (cool blues
hue-shifted across the 7 numbered guitars, warm orange for live, dark
plum for bass, wood-tone for click). Listener dot at bottom-center
with a forward-facing tick.

Each note onset triggers a 180 ms brightness pulse on its voice's
circle (the closest thing to In C's rhythm rings; rest of the
visualization layer was intentionally skipped).

Initial bug: page-load resizeCanvas ran while stage-view was hidden
so the canvas was 1×1 stretched to the viewport — looked white/dark
depending on browser. Fixed by re-syncing the canvas bitmap on
applyStageLayout.

---

## Phase 6 — Drag (listener + voices) → live spatial audio ✓

Pointer events on the canvas drive a small drag system. `clampToStage`
in layout.js keeps everything inside the half-moon. `recomputeSpatial`
walks every voice on each drag and updates pan + dryGain + wetSend via
`setTargetAtTime` (25 ms time constant — smooth slides, no zipper
noise).

This is where the central mechanic clicks: drag a guitar far from the
listener and you hear it recede + pick up reverb send.

---

## Phase 7 — Per-voice controls ✓

- Hover (mouse) → cursor=grab + small canvas-drawn hover panel showing
  voice label, instrument, volume bar, and shortcut hints
- Scroll wheel on hovered voice → volume up/down
- M on hovered voice → mute / unmute (~150 ms exponential fade)
- ←/→ on hovered live or guitar voice → cycle through GUITAR_PALETTE
- Tap (touch) on a voice → bottom touch panel slides in: volume slider,
  mute button, prev/next instrument arrows
- Tap-vs-drag distinguished by 6 px movement threshold; tap on empty
  space closes the touch panel

---

## Phase 8 — Top bar ✓

Six compact range inputs: Vol, Tempo (with live BPM display), Reverb
wet, Bass, Mid, Treble. Plus a Reset button that restores all sliders
to defaults, voice positions to canonical layout, per-voice
volume/mute/instrument to defaults.

Mid-piece tempo change pivots `playbackStart` so the current score
position stays put across the change (already-scheduled notes within
the 0.5 s lookahead window play at the old timing).

---

## Phase 9 — Endgame curtain ✓

`schedulerTick` detects "every voice exhausted + 3 s reverb tail" and
raises a full-viewport curtain (z-index 8, 2 s fade-in):

```
Electric Counterpoint
III. Fast
thank you for listening
[ Start over ]   [ Choose movement ]
```

Esc dismisses to the menu. Start over restores masterGain and replays.

---

## Phase 10 — Onboarding + help / about ✓

Three transient hints fade across the bottom of the canvas during the
first ~32 s of the user's first playback in this session (drag voices,
hover/tap for controls, ? for the full reference). `hintsCompleted`
latches so they don't repeat on second Play.

Help modal (`?` button + key) lists all controls. About modal credits
Reich + Karoryfer + VCSL + Theatre@41 IR + sister-project link to In C
+ GitHub source.

A single Esc handler with priority `modal → curtain → touch panel`
ensures one Esc press always picks the right thing.

---

## Phase 11 — Mobile QA + deploy ✓

Verified at 390×844 (iPhone 12 viewport): top bar wraps cleanly to
multiple rows, stage half-moon scales down with all 11 voices visible,
touch panel slides in over the stage. Canvas gets explicit
`touch-action: none` so iOS Safari's gesture handlers don't preempt
pointer events. AudioContext defensively resumes on every pointerdown.

Open Graph + meta description for shared-link previews. GitHub Actions
workflow uploads to `webroots/www/electric_counterpoint/` on push to
master via SFTP. First deploy needed `actions/checkout@v5` (Node 20
deprecated) and `-v` on sftp to debug a 255-exit auth issue.

---

## Phase 12 — Score scrubber ✓

Thin track at the top of the canvas with a draggable playhead.
Click to jump, drag to scrub (master gain dips silently during drag,
restores on release). Works while paused too — sets the position next
Play picks up from. Time label shows wall-clock seconds at the current
tempo, not score-encoded seconds.

---

## Phase 13 — Spotlight a voice ✓

Double-click a voice to bring it to the front and dim the others
(non-spotlit voices duck to ~22% gain via a per-voice
`spotlightAttenuation` multiplier on `channelGain`, smoothed with a
0.25 s linear ramp). The spotlit voice gets a bright outer ring and
draws on top so a click lands cleanly even if circles overlap.
Double-click again or double-click empty stage to exit; Esc clears
when no other overlay is in the way; Reset and back-to-menu both clear
implicitly. Touch parity through a Spotlight button in the voice panel.

---

## Beyond core (future)

### Maximum leverage from the existing engine

- **Vermont Counterpoint** (1982, flutes) and **New York Counterpoint**
  (1985, clarinets) are structurally identical to Electric Counterpoint
  — live soloist + N prerecorded same-instrument tracks. Same engine,
  swap the sample banks and the part-mapping. A "Reich's Counterpoints"
  trilogy would emerge with one codebase.
- **Movements I & II of Electric Counterpoint.** Author the MusicXMLs
  (live + 12 guitars + 2 bass + click each) and flip `available: true`
  in `movements.js`. Verify the half-moon layout handles 12 numbered
  guitars — current geometry should scale, spacing wants confirming.
- **Audio recording / WAV export.** Capture the spatial mix the user
  conducts as a downloadable WAV via `MediaStreamDestination` +
  `MediaRecorder`. People could share their mix, not just the link.

### Novel interactions

- **Auto-tour mode.** Listener drifts on its own (path or random walk,
  speed slider) — turns the conductor app into a passive listening
  installation.
- **Stage state in URL.** Encode listener + voice positions + tempo
  into a `?…` query string so a specific configuration is shareable.
  Reload the link, hear exactly the same mix.
- **WebXR / 3D stage.** Put the user inside the half-moon with head
  tracking. The spatial-audio model already does most of the work;
  binaural HRTF panning instead of StereoPanner would be the new
  piece. Significant lift but the engine is set up for it.

### Educational layer

- **Phase indicator.** Reich's whole technique is canon-by-shifting.
  Visualise *which* beat each voice is on (a tiny dot rotating around
  each circle, like In C's rhythm rings but tighter). Watching them
  drift apart is half the appeal of the piece.
- **Section markers on the scrubber.** Reich's score has labelled
  sections / rehearsal letters; markers on the scrubber would let the
  user jump straight to specific passages.

### Visualization deepening

- **Selective ports from `in_c`.** Polyrhythmic sparkles between out-
  of-phase voices, unison-strand brightening when canon converges,
  voice rhythm rings around each circle. Held back so the meditative
  legibility of the stage stays intact; revisit after the catalog
  expands.

### Catalog / sample additions

- **Marimba / vibraphone palette.** Reich's piece has authorised
  arrangements for marimbas and similar mallet ensembles. Adds a
  non-guitar palette as an extra swap option.
- **Nylon / classical guitar.** No CC0 nylon source on GitHub; Iowa
  MIS Classical Guitar (public domain) is the most likely candidate
  but would need a manual download step in `build_samples.sh`.

### Cross-project

- **Landing page** combining In C + Electric Counterpoint (+ future
  Reich pieces) under `allansjoelin.com/` as a small "interactive
  scores" gallery.

### Polish / metadata

- **OG preview image.** Render a wide stage screenshot (1200 × 630)
  for richer link previews on social.
