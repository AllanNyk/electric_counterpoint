# Electric Counterpoint

Browser-based interactive realization of Steve Reich's *Electric
Counterpoint* (1987). Pick a movement, then conduct a top-down stage of
guitars arranged in a half-moon facing a draggable listener dot. Every
voice is spatialised relative to the listener — drag a guitar across the
stage and you hear it pan and recede.

Sister project to my [In C](https://allansjoelin.com/in_c/) realization.

## Status

This is in active build-out. Movement III is the only authored one so
far; I and II will follow. See `roadmap.md` for the phased plan and
`CLAUDE.md` for the architecture.

## Run locally

ES modules require an HTTP origin, so:

```sh
python -m http.server 8000
# then open http://localhost:8000
```

You'll also need `III_fast.xml` at the project root — it's not in the
public repo because Reich's score is copyrighted (see "Score source files"
in `CLAUDE.md`).

## Stack

Vanilla JavaScript (ES modules), Web Audio API, Canvas 2D. No framework,
no build step.

## Credits

- **Music**: *Electric Counterpoint* by Steve Reich (Hendon Music / Boosey &
  Hawkes, 1987). All rights to the score remain with the publisher; this
  app is an interactive realization, not a redistribution.
- **Samples**: Versilian Community Sample Library (VCSL), CC0.
- **Reverb impulse**: Theatre@41, openairlib.net, CC-BY (University of York).

## License

Code: MIT. Score: copyright Steve Reich. Samples: CC0.
