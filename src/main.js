// Phase 1: scaffold + movement-select screen.
// Phase 2: load the chosen movement's MusicXML and log a smoke test of the
// parsed timeline (per-part note counts, total duration). Audio engine,
// stage view, and input handling land in later phases.

import { MOVEMENTS, getMovement } from './movements.js';
import { loadScore } from './score.js';

const movementSelectEl = document.getElementById('movement-select');
const stageViewEl = document.getElementById('stage-view');
const movementTitleEl = document.getElementById('movement-title-text');
const backBtn = document.getElementById('back-btn');
const placeholderEl = document.getElementById('stage-placeholder');

let activeMovement = null;
let activeScore = null;

async function chooseMovement(id) {
  const m = getMovement(id);
  if (!m || !m.available) return;
  activeMovement = m;
  movementTitleEl.textContent = m.label;
  placeholderEl.textContent = `loading ${m.xml}…`;

  movementSelectEl.classList.add('fading');
  setTimeout(() => {
    movementSelectEl.style.display = 'none';
    stageViewEl.classList.add('active');
  }, 600);

  try {
    activeScore = await loadScore(m.xml, m.parts);
    renderScoreSmokeTest(m, activeScore);
  } catch (err) {
    placeholderEl.textContent = `failed to load score: ${err.message}`;
    console.error(err);
  }
}

// Phase-2 smoke test: prove the parser produces sane per-part timelines.
// Replaces the placeholder with a per-part summary; deeper validation
// happens later when the audio engine actually plays the notes.
function renderScoreSmokeTest(movement, score) {
  const totalNotes = score.parts.reduce((sum, p) => sum + p.notes.length, 0);
  const durMin = Math.floor(score.duration / 60);
  const durSec = Math.round(score.duration % 60).toString().padStart(2, '0');

  const lines = [
    `${movement.label} — parsed`,
    `${score.parts.length} parts, ${totalNotes} notes, ${durMin}:${durSec} @ ♩=${ENCODED_BPM_DISPLAY}`,
    '',
    ...score.parts.map(p => {
      const first = p.notes[0]?.time?.toFixed(2) ?? '–';
      const last = p.notes[p.notes.length - 1]?.time?.toFixed(2) ?? '–';
      return `  ${p.id.padEnd(3)} ${p.role.padEnd(7)} ${p.label.padEnd(10)} ${String(p.notes.length).padStart(5)} notes  [${first}s → ${last}s]`;
    }),
  ];
  placeholderEl.style.fontFamily = 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace';
  placeholderEl.style.whiteSpace = 'pre';
  placeholderEl.style.textAlign = 'left';
  placeholderEl.style.fontSize = '12px';
  placeholderEl.textContent = lines.join('\n');
}

// Cosmetic alias — keeps the smoke-test line readable without importing the
// raw constant just for display.
const ENCODED_BPM_DISPLAY = 120;

function returnToMenu() {
  stageViewEl.classList.remove('active');
  movementSelectEl.style.display = 'flex';
  // next frame to let display change settle, then fade in
  requestAnimationFrame(() => movementSelectEl.classList.remove('fading'));
  activeMovement = null;
}

// Wire menu buttons
for (const btn of document.querySelectorAll('.movement-btn')) {
  btn.addEventListener('click', () => {
    const id = btn.dataset.movement;
    chooseMovement(id);
  });
}

backBtn.addEventListener('click', returnToMenu);

// Resize canvas to fill viewport (rendering will land in a later phase)
const canvas = document.getElementById('stage-canvas');
function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
