# Electric Counterpoint — Roadmap

A browser-based interactive realization of Steve Reich's *Electric
Counterpoint* (1987). The user picks a movement, then conducts a top-down
stage of guitars arranged in a half-moon facing a draggable listener.

This document tracks the phased build order. Each phase is a listenable,
playable artifact in its own right — we never build something we can't hear.
See `CLAUDE.md` for the project guide and architecture notes.

---

## Phase 1 — Scaffold + movement select ◐ (in progress)

Single page boots to a movement-select menu. Mvt III is enabled; I & II
are visibly disabled with "coming soon". Clicking III fades to a stage-view
shell with a top bar (movement title + back button) and an empty canvas.
"Back" returns to the menu.

**Status:** scaffold landed; visual polish pending later phases.

---

## Phase 2 — Multi-part score parser

Build `src/score.js`. Walk every `<part>` in `III_fast.xml`, accumulate
absolute-time note streams (handling ties, grace notes, divisions changes,
tempo encoded at 120). Returns
`{ parts: [{id, role, label, notes:[{time, midi, duration, isGrace, tieStop}]}], duration }`.

Smoke test: log per-part note counts and total duration; eyeball-verify
against the score length.

---

## Phase 3 — Sample pipeline

Source CC0 sample banks (VCSL):
- `guitar_clean` — clean electric (default for live + guitars 1-7)
- `guitar_nylon` — classical/nylon (palette swap)
- `guitar_acoustic` — steel-string (palette swap)
- `bass_guitar` — electric bass (Bg1, Bg2)
- `woodblock` — single-pitch click (P11)

Build `tools/build_samples.sh`: ffmpeg → chromatic mp3 banks under
`assets/audio/<instrument>/<note>.mp3`. Sharps written as `s` (cs4 = C#4)
for URL safety, mirroring `in_c`. Verify ranges cover what the score asks.

---

## Phase 4 — Audio engine + first audible playback

Build `src/audio.js` and `src/voice.js`. Per-voice positional chain:
dry-path panner + wet-path send to a shared convolver. Master EQ +
compressor + reverb wired through. Schedule the whole score from t=0 once
the user clicks "play" and listen end-to-end. Voices stationary at the
canvas center — no spatial movement yet.

Goal of this phase: the score plays, mixed, in time.

---

## Phase 5 — Stage view + half-moon layout

Build `src/layout.js`. Compute default positions: live in front-center,
Guitars 1-7 along the arc (left → center), Bg1/Bg2 on the right flank,
click fixed center-back. Draw stage edge, listener dot, voice circles.
No drag yet.

---

## Phase 6 — Drag (listener + voices) → live spatial audio

Pointer-down on listener / voice / click → drag-to-move, constrained to
stage. On drag, recompute pan + dryGain + wetSend per voice. Smooth via
`setTargetAtTime`.

This phase is where the central mechanic clicks: hear the mix shift as
guitars move around the listener.

---

## Phase 7 — Per-voice controls

- Scroll wheel = volume
- M = mute (~150 ms exponential fade)
- ←/→ = swap instrument (live + guitars 1-7 only; bass and click excluded)
- Mobile touch panel parity (same actions as buttons)

---

## Phase 8 — Top bar

Master volume, tempo (default 192 for mvt III), reverb wet, bass/mid/treble
EQ. Tempo slider re-applies on every scheduling boundary.

---

## Phase 9 — Endgame curtain

Detect when the longest part has finished, wait ~3 s for the natural
reverb tail, fade to a quiet curtain:

```
Electric Counterpoint — III. Fast
thank you for listening
[ Start over ]   [ Choose movement ]
```

---

## Phase 10 — Onboarding + help/about

A few transient hints over the first 30 s of playback (drag the listener,
drag a guitar, mute with M, swap with ←/→). Help modal `?` lists controls.
About modal credits Reich, VCSL, Theatre@41 IR.

---

## Phase 11 — Mobile QA + deploy

Pointer events, touch panel, viewport-zoom locked, defensive
`audio.ctx.resume()` on every pointerdown. GitHub Actions workflow uploads
to `webroots/www/electric_counterpoint/` on push to master (mirrors `in_c`).

---

## Beyond core (future)

- **Visualization deepening** — selectively port from `in_c`: rhythm rings
  on note onsets, polyrhythmic sparkles between out-of-phase voices,
  unison-strand brightening when canon converges. Intentionally deferred.
- **Movements I & II** — author MusicXMLs, enable buttons.
- **Marimba arrangement** — Reich's piece has been performed on marimbas;
  add a marimba palette as a non-guitar swap option.
- **Performance recording** — capture the spatial mix as audio.
- **Stage rotation** — rotate the listener's facing direction (currently
  fixed). Would need HRTF-style binaural rather than simple stereo pan.
