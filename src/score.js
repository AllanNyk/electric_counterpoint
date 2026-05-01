// Multi-part MusicXML parser for Electric Counterpoint.
//
// Unlike In C — which builds a list of 53 short patterns — Electric
// Counterpoint is through-composed: each <part> is a single linear
// timeline of notes from t=0 to the end of the movement. We walk every
// part in parallel and accumulate notes in absolute seconds at the
// score's encoded tempo (♩=120). The audio scheduler scales by
// notatedBPM/120 at runtime so the slider's default sits at Reich's
// notation (♩=192 for mvt III).
//
// Output shape:
//   { parts: [{ id, role, label, notes:[{time, midi, duration, grace?}], duration }],
//     duration }

export const ENCODED_BPM = 120;
export const GRACE_OFFSET = 0.0625; // 32nd note at 120 BPM, in seconds

const SECONDS_PER_QUARTER = 60 / ENCODED_BPM;
const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// MIDI number → filename note (e.g. 70 → "as4", 60 → "c4"). Sharps written
// as 's' keep filenames URL-safe.
export function midiToFilename(midi) {
  const names = ['c', 'cs', 'd', 'ds', 'e', 'f', 'fs', 'g', 'gs', 'a', 'as', 'b'];
  const octave = Math.floor(midi / 12) - 1;
  return names[midi % 12] + octave;
}

function readPitch(noteEl, transposeSemitones) {
  const pitchEl = noteEl.querySelector('pitch');
  if (pitchEl) {
    const step = pitchEl.querySelector('step').textContent.trim();
    const octave = parseInt(pitchEl.querySelector('octave').textContent, 10);
    const alterEl = pitchEl.querySelector('alter');
    const alter = alterEl ? parseInt(alterEl.textContent, 10) : 0;
    const written = (octave + 1) * 12 + STEP_TO_SEMITONE[step] + alter;
    return written + transposeSemitones;
  }
  // Unpitched percussion (e.g. the wood-block click track in mvt III).
  // Use the notational display pitch so the note still has a MIDI value
  // — the click Voice maps every MIDI to the same sample anyway, but
  // returning null here would silently drop every wood-block note from
  // the parsed timeline.
  const unpitchedEl = noteEl.querySelector('unpitched');
  if (unpitchedEl) {
    const stepEl = unpitchedEl.querySelector('display-step');
    const octEl = unpitchedEl.querySelector('display-octave');
    const step = stepEl ? stepEl.textContent.trim() : 'C';
    const octave = octEl ? parseInt(octEl.textContent, 10) : 4;
    return (octave + 1) * 12 + STEP_TO_SEMITONE[step];
  }
  return null;
}

function parsePartTimeline(partEl, initialDivisions, transposeSemitones) {
  const measures = Array.from(partEl.querySelectorAll('measure'));
  const notes = [];
  let divisions = initialDivisions;
  let beats = 4, beatType = 4;
  let measureStart = 0;

  for (const measure of measures) {
    const timeEl = measure.querySelector('time');
    if (timeEl) {
      beats = parseInt(timeEl.querySelector('beats').textContent, 10);
      beatType = parseInt(timeEl.querySelector('beat-type').textContent, 10);
    }
    const divEl = measure.querySelector('divisions');
    if (divEl) divisions = parseInt(divEl.textContent, 10);

    const measureDurationDivisions = (beats * divisions * 4) / beatType;
    const divToSec = (d) => (d / divisions) * SECONDS_PER_QUARTER;

    let cursor = 0;
    let pendingGraceMidi = null;

    const noteEls = Array.from(measure.children).filter(c => c.tagName === 'note');
    for (const noteEl of noteEls) {
      const isGrace = !!noteEl.querySelector('grace');
      const isRest = !!noteEl.querySelector('rest');
      const isChord = !!noteEl.querySelector('chord');
      const tieEl = noteEl.querySelector('tie');
      const tieStop = tieEl && tieEl.getAttribute('type') === 'stop';

      const durEl = noteEl.querySelector('duration');
      const dur = durEl ? parseInt(durEl.textContent, 10) : 0;

      if (isGrace) {
        const midi = readPitch(noteEl, transposeSemitones);
        if (midi != null) pendingGraceMidi = midi;
        continue;
      }

      if (isRest) {
        cursor += dur;
        pendingGraceMidi = null;
        continue;
      }

      const onsetDivisions = isChord ? cursor - dur : cursor;
      const onsetSeconds = measureStart + divToSec(onsetDivisions);
      const noteDurationSeconds = divToSec(dur);

      const midi = readPitch(noteEl, transposeSemitones);
      if (midi != null) {
        if (pendingGraceMidi != null && !isChord) {
          notes.push({
            time: Math.max(0, onsetSeconds - GRACE_OFFSET),
            midi: pendingGraceMidi,
            grace: true,
            duration: GRACE_OFFSET,
          });
          pendingGraceMidi = null;
        }
        if (tieStop && notes.length > 0) {
          // Tied continuation: extend the previous note's duration.
          notes[notes.length - 1].duration += noteDurationSeconds;
        } else {
          notes.push({ time: onsetSeconds, midi, duration: noteDurationSeconds });
        }
      }

      if (!isChord) cursor += dur;
    }

    measureStart += divToSec(measureDurationDivisions);
  }

  return { notes, totalSeconds: measureStart };
}

// Load a movement's MusicXML and return per-part absolute-time note
// timelines. `partsMap` is the `parts` field from a movement entry in
// movements.js — it tells us which <part id> maps to which role.
export async function loadScore(url, partsMap) {
  const xmlText = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`failed to fetch ${url}: ${r.status}`);
    return r.text();
  });
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

  const partEls = Array.from(doc.querySelectorAll('part[id]'));
  if (partEls.length === 0) throw new Error('no <part> elements in MusicXML');

  const parts = [];
  let maxDuration = 0;

  for (const partEl of partEls) {
    const id = partEl.getAttribute('id');
    const config = partsMap[id];
    if (!config || config.role === 'ignore') continue;

    // Initial divisions / transpose come from the first <attributes> block.
    const initDivEl = partEl.querySelector('attributes > divisions');
    const divisions = initDivEl ? parseInt(initDivEl.textContent, 10) : 256;

    // NOTE on octave transposition: the XML often carries
    // <octave-change>-1</octave-change> on guitar/bass parts (standard
    // guitar-clef transposition). Applying it produces music that plays
    // an octave below where it should sound — a common Sibelius export
    // quirk where the transposition gets emitted even though the score
    // is already notated at sounding pitch (treble-clef-with-8). We
    // intentionally ignore octave-change so written pitch maps directly
    // to sounding MIDI.
    const transposeSemitones = 0;

    const { notes, totalSeconds } = parsePartTimeline(partEl, divisions, transposeSemitones);

    parts.push({
      id,
      role: config.role,
      label: config.label,
      notes,
      duration: totalSeconds,
    });

    if (totalSeconds > maxDuration) maxDuration = totalSeconds;
  }

  return { parts, duration: maxDuration };
}
