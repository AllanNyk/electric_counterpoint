# Electric Counterpoint

Browser-based interactive realization of Steve Reich's *Electric
Counterpoint* (1987). Pick a movement, then conduct a top-down stage of
guitars arranged in a half-moon facing a draggable listener dot. Every
voice is spatialised relative to the listener — drag a guitar across the
stage and you hear it pan and recede.

**Live at https://allansjoelin.com/electric_counterpoint/.**

Sister project to my [In C](https://allansjoelin.com/in_c/) realization.

## Status

Movement III. Fast is fully playable. Movements I & II are placeholders
in the menu; their MusicXML transcriptions haven't been authored yet.
See `roadmap.md` for the build history and `CLAUDE.md` for architecture
notes.

## Controls

**Mouse / keyboard**
- Drag any voice or the listener dot to move it
- Hover a voice — small panel shows label, instrument, volume, hints
- Scroll wheel on a hovered voice — volume up / down
- `M` — mute / unmute hovered voice
- `← / →` — swap instrument on hovered live or guitar voice
- `?` — open the controls reference, `Esc` — close any overlay
- Top bar: master volume, tempo, reverb wet, 3-band EQ, Reset

**Touch**
- Tap a voice — bottom panel slides in with the same controls
- Tap empty space or ✕ — closes
- Drag still works the same as on desktop

## Run locally

ES modules require an HTTP origin, so:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

You'll also need `III_fast.xml` at the project root — it's not in the
public repo because Reich's score is copyrighted (see "Score source files"
in `CLAUDE.md`). To rebuild the sample banks from scratch:

```sh
bash tools/build_samples.sh
```

Requires `curl`, `ffmpeg`, `awk`, `bash 4+`. Source WAVs are cached
under `tools/.cache/` so re-runs are near-instant.

## Stack

Vanilla JavaScript (ES modules), Web Audio API, Canvas 2D, Pointer
Events. No framework, no build step.

## Credits

- **Music**: *Electric Counterpoint* by Steve Reich (Hendon Music /
  Boosey & Hawkes, 1987). All rights to the score remain with the
  publisher; this app is an interactive realization, not a redistribution.
- **Clean / acoustic guitar samples**: Karoryfer
  [black-and-green-guitars](https://github.com/sfzinstruments/karoryfer.black-and-green-guitars)
  and [shinyguitar](https://github.com/sfzinstruments/karoryfer.shinyguitar)
  (CC0).
- **Bass guitar samples**: Karoryfer
  [black-and-blue-basses](https://github.com/sfzinstruments/karoryfer.black-and-blue-basses)
  (CC0).
- **Wood block**: [Versilian Community Sample Library](https://github.com/sgossner/VCSL)
  (CC0).
- **Reverb impulse**: [Theatre@41](https://www.openair.hosted.york.ac.uk/),
  openairlib.net, CC-BY (University of York).

## License

Code: MIT. Score: copyright Steve Reich. Samples: CC0 (Karoryfer / VCSL).
Reverb impulse: CC-BY.
