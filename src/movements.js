// Movement metadata. Each entry describes one movement of Electric Counterpoint:
// where its score lives, what tempo it's encoded at vs. what tempo Reich notates,
// and which voices appear on stage. `available: false` greys the menu button.
//
// Score files are encoded at 120 BPM in MusicXML. The scheduler scales by
// `notatedBPM / encodedBPM` so the slider's default sits at Reich's notation.

export const ENCODED_BPM = 120;

export const MOVEMENTS = [
  {
    id: 'I',
    label: 'I. Fast',
    xml: 'I_fast.xml',
    notatedBPM: 192,
    available: false,
    voiceCount: 15, // live + 12 + 2 bass
  },
  {
    id: 'II',
    label: 'II. Slow',
    xml: 'II_slow.xml',
    notatedBPM: 108,
    available: false,
    voiceCount: 15,
  },
  {
    id: 'III',
    label: 'III. Fast',
    xml: 'III_fast.xml',
    notatedBPM: 192,
    available: true,
    voiceCount: 10, // live + 7 + 2 bass (plus 1 click track)
    // Maps XML <part id="P*"> → role used by layout / audio.
    // P1  → live guitar (front, near listener)
    // P2-P8 → guitars 1-7 (half-moon arc)
    // P9, P10 → Bg1, Bg2 (right flank)
    // P11 → click (fixed, mutable)
    // P12 → ignored (second wood-block stave)
    parts: {
      P1: { role: 'live',   label: 'Live' },
      P2: { role: 'guitar', label: 'Guitar 1' },
      P3: { role: 'guitar', label: 'Guitar 2' },
      P4: { role: 'guitar', label: 'Guitar 3' },
      P5: { role: 'guitar', label: 'Guitar 4' },
      P6: { role: 'guitar', label: 'Guitar 5' },
      P7: { role: 'guitar', label: 'Guitar 6' },
      P8: { role: 'guitar', label: 'Guitar 7' },
      P9: { role: 'bass',   label: 'Bg1' },
      P10:{ role: 'bass',   label: 'Bg2' },
      P11:{ role: 'click',  label: 'Click' },
      P12:{ role: 'ignore', label: '' },
    },
  },
];

export function getMovement(id) {
  return MOVEMENTS.find(m => m.id === id) || null;
}
