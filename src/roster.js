// roster.js — instrument palette for voice swap (phase 7).
//
// For phase 4 only the default instrument per role is used; the swap
// palette below is the menu the ←/→ keys will cycle through later.

export const ROLE_TO_DEFAULT_INSTRUMENT = {
  live:   'guitar_clean',
  guitar: 'guitar_clean',
  bass:   'bass_guitar',
  click:  'woodblock',
};

// Swap palette. live + guitar voices cycle through these via ←/→ keys
// or the touch-panel arrows. Bass and click stay locked to their own
// banks — they have a specific scoring role in the piece.
//
// Marimba's top-of-range note (C6, MIDI 84) sits 4 semitones below the
// score's highest swappable pitch (E6, MIDI 88); the missing notes are
// played by the nearest loaded sample shifted via playbackRate (see
// Voice.scheduleAhead). Vibraphone covers the full range natively.
// Banks for marimba + vibraphone come from the In C project (Sonatina
// Symphonic Orchestra, CC0).
export const GUITAR_PALETTE = [
  { id: 'guitar_clean',    label: 'Clean Electric' },
  { id: 'guitar_acoustic', label: 'Acoustic' },
  { id: 'marimba',         label: 'Marimba' },
  { id: 'vibraphone',      label: 'Vibraphone' },
  // A 'guitar_nylon' entry can be added once a CC0 nylon bank is sourced
  // (Iowa MIS Classical Guitar is the most likely candidate; not on
  // GitHub so it'll need a manual download step).
];

export function isSwappable(role) {
  return role === 'live' || role === 'guitar';
}

export function instrumentLabel(id) {
  return GUITAR_PALETTE.find(p => p.id === id)?.label ?? id;
}

export function nextInstrument(currentId, dir) {
  const idx = GUITAR_PALETTE.findIndex(p => p.id === currentId);
  if (idx < 0) return currentId;
  const n = GUITAR_PALETTE.length;
  return GUITAR_PALETTE[(idx + dir + n) % n].id;
}
