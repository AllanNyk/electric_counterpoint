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

// Phase-7 swap palette. live + guitar voices cycle through these; bass
// and click are not swappable (separate scoring role).
export const GUITAR_PALETTE = [
  { id: 'guitar_clean',    label: 'Clean Electric' },
  // Added in phase 7:
  // { id: 'guitar_nylon',    label: 'Nylon' },
  // { id: 'guitar_acoustic', label: 'Acoustic' },
];
