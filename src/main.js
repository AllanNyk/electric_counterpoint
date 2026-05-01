// Phase 1: scaffold + movement-select screen.
// Phase 2: parse MusicXML into per-part absolute-time timelines.
// Phase 3: chromatic mp3 sample banks built by tools/build_samples.sh.
// Phase 4: AudioEngine + Voice + scheduler. Movement-select click creates
//          the AudioContext and pre-loads samples + IR; the play button
//          starts the scheduler so every voice plays its part end-to-end.
//          Voices are stationary at center pan with default reverb send;
//          spatial audio lands in phase 6.

import { MOVEMENTS, getMovement } from './movements.js';
import { loadScore, ENCODED_BPM } from './score.js';
import { AudioEngine } from './audio.js';
import { Voice } from './voice.js';
import {
  ROLE_TO_DEFAULT_INSTRUMENT,
  GUITAR_PALETTE,
  isSwappable,
  instrumentLabel,
  nextInstrument,
} from './roster.js';
import { midiToFilename } from './score.js';
import {
  computeLayout,
  initialVoicePositions,
  defaultListenerPosition,
  voiceColor,
  voiceRadius,
  clampToStage,
  VISUAL,
} from './layout.js';

const SCHEDULER_LOOKAHEAD = 0.5;     // seconds of audio scheduled ahead of currentTime
const SCHEDULER_TICK_MS = 100;        // how often the scheduler wakes
const PLAYBACK_LEAD_IN = 0.3;         // seconds between Play click and t=0

const movementSelectEl = document.getElementById('movement-select');
const stageViewEl = document.getElementById('stage-view');
const movementTitleEl = document.getElementById('movement-title-text');
const backBtn = document.getElementById('back-btn');
const playBtn = document.getElementById('play-btn');
const placeholderEl = document.getElementById('stage-placeholder');

const audio = new AudioEngine();

let activeMovement = null;
let activeScore = null;
let voices = [];
let isPlaying = false;
let playbackStart = 0;     // audio-context time corresponding to score t=0
let schedulerHandle = null;
let statusLine = '';        // appended below the smoke test

let layout = null;          // current stage geometry (CSS px)
let listenerPos = null;     // { x, y } — phase 6 makes draggable

async function chooseMovement(id) {
  const m = getMovement(id);
  if (!m || !m.available) return;
  activeMovement = m;
  movementTitleEl.textContent = m.label;
  setStatus(`loading ${m.xml}…`);

  movementSelectEl.classList.add('fading');
  setTimeout(() => {
    movementSelectEl.style.display = 'none';
    stageViewEl.classList.add('active');
  }, 600);

  // Movement-select click is a user gesture, so this is the right moment
  // to create the AudioContext (browser autoplay policy).
  try {
    await audio.init();
  } catch (err) {
    setStatus(`audio init failed: ${err.message}`);
    console.error(err);
    return;
  }

  try {
    activeScore = await loadScore(m.xml, m.parts);
    renderScoreSmokeTest(m, activeScore);
  } catch (err) {
    setStatus(`failed to load score: ${err.message}`);
    console.error(err);
    return;
  }

  // Build voices from parts; each voice owns its audio channel.
  voices = activeScore.parts.map(part => {
    const instrument = ROLE_TO_DEFAULT_INSTRUMENT[part.role];
    return new Voice(part, audio, instrument);
  });

  // Load the IR + every needed sample in parallel before enabling Play.
  // Also pre-load every entry in the swap palette for swappable voices
  // (live + guitars), so the ←/→ swap is instant — no network stall on
  // first switch. Bass and click stay locked to their default banks.
  setStatus('loading samples and IR…');
  const paletteIds = GUITAR_PALETTE.map(p => p.id);
  const palettePreloads = [];
  for (const v of voices) {
    if (!isSwappable(v.role)) continue;
    const uniqueMidis = new Set(v.notes.map(n => n.midi));
    for (const id of paletteIds) {
      if (id === v.instrument) continue; // covered by v.loadSamples()
      for (const midi of uniqueMidis) {
        palettePreloads.push(audio.loadSample(id, midiToFilename(midi)));
      }
    }
  }
  try {
    await Promise.all([
      audio.loadIR('assets/audio/ir/theatre41.wav'),
      ...voices.map(v => v.loadSamples()),
      ...palettePreloads,
    ]);
  } catch (err) {
    setStatus(`failed to load audio: ${err.message}`);
    console.error(err);
    return;
  }

  // Lay the voices on the stage and start the render loop. Stage takes
  // over the placeholder area now that the smoke test has done its job.
  applyStageLayout();
  placeholderEl.style.display = 'none';
  startRenderLoop();

  setStatus(`ready — press ▶ Play to hear ${m.label}`);
  playBtn.disabled = false;
}

function syncCanvasBitmap() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
}

function applyStageLayout() {
  if (!voices.length || !activeScore) return;
  // Page-load resizeCanvas ran while stage-view was display:none, so the
  // canvas bitmap was set to 1×1 (rect was 0×0). Re-sync now that the
  // stage is actually on screen.
  syncCanvasBitmap();
  const rect = canvas.getBoundingClientRect();
  layout = computeLayout(rect.width, rect.height);
  listenerPos = defaultListenerPosition(layout);
  const positions = initialVoicePositions(activeScore.parts, layout);
  for (const voice of voices) {
    const pos = positions.get(voice.id);
    if (pos) voice.setPosition(pos.x, pos.y);
  }
  recomputeSpatial();
}

// ---- spatial audio ----
//
// Per voice: pan from horizontal offset to listener (left/right), dry
// gain attenuated by distance, reverb send increased by distance. All
// three are smoothed via setTargetAtTime so dragging doesn't produce
// zipper noise. Recomputed whenever the listener or any voice moves;
// also called once after applyStageLayout so initial values are right.

const SPATIAL_SMOOTH = 0.025;   // setTargetAtTime time constant (sec)
const PAN_HALF_WIDTH_SCALE = 1.05;

function recomputeSpatial() {
  if (!listenerPos || !layout || !voices.length || !audio.ctx) return;
  const t = audio.currentTime;
  const halfW = layout.arcRadius * PAN_HALF_WIDTH_SCALE;
  const maxDist = layout.arcRadius * 1.4;
  for (const v of voices) {
    const dx = v.x - listenerPos.x;
    const dy = v.y - listenerPos.y;
    const dist = Math.hypot(dx, dy);
    const nDist = Math.min(1, dist / maxDist);
    const pan = Math.max(-1, Math.min(1, dx / halfW));
    const dry = lerp(1.0, 0.35, nDist);
    const wet = lerp(0.15, 0.55, nDist);
    v.channel.panner.pan.setTargetAtTime(pan, t, SPATIAL_SMOOTH);
    v.channel.dryGain.gain.setTargetAtTime(dry, t, SPATIAL_SMOOTH);
    v.channel.wetSend.gain.setTargetAtTime(wet, t, SPATIAL_SMOOTH);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

// ---- pointer drag + hover + tap ----
//
// Mouse: drag to move; hover sets `hoveredVoice` so wheel/keyboard act
// on whatever's under the cursor. Touch: drag still works, but a tap
// (pointerdown→pointerup with no significant movement) opens the touch
// panel for that voice instead. We distinguish tap vs drag by tracking
// whether the pointer moved past TAP_SLOP_PX while held.

const TAP_SLOP_PX = 6;

let dragTarget = null;       // 'listener' | Voice | null
let dragOffsetX = 0;
let dragOffsetY = 0;
let dragStart = null;        // { x, y, pointerType, moved }
let hoveredVoice = null;     // Voice | null — drives wheel + keyboard

function pointerCoords(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function hitTest(x, y) {
  if (!listenerPos) return null;
  // Listener wins ties — it's the conductor's avatar.
  const dxL = x - listenerPos.x;
  const dyL = y - listenerPos.y;
  const lr = VISUAL.listenerRadius + 8;
  if (dxL * dxL + dyL * dyL <= lr * lr) return 'listener';
  // Voices, in reverse order so visually-on-top ones are picked first.
  for (let i = voices.length - 1; i >= 0; i--) {
    const v = voices[i];
    const r = voiceRadius(v.part) + 8;
    const dx = x - v.x;
    const dy = y - v.y;
    if (dx * dx + dy * dy <= r * r) return v;
  }
  return null;
}

function onPointerDown(e) {
  // iOS Safari sometimes leaves the audio context suspended after a
  // gap — defensively resume on every pointerdown.
  if (audio.ctx?.state === 'suspended') audio.ctx.resume();
  if (!layout) return;
  const { x, y } = pointerCoords(e);
  const target = hitTest(x, y);
  if (!target) {
    // Tap on empty space (touch only) closes the touch panel.
    if (e.pointerType === 'touch') closeTouchPanel();
    return;
  }
  e.preventDefault();
  if (canvas.setPointerCapture) {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
  }
  dragTarget = target;
  dragStart = { x, y, pointerType: e.pointerType, moved: false };
  if (target === 'listener') {
    dragOffsetX = listenerPos.x - x;
    dragOffsetY = listenerPos.y - y;
  } else {
    dragOffsetX = target.x - x;
    dragOffsetY = target.y - y;
  }
  canvas.style.cursor = 'grabbing';
}

function onPointerMove(e) {
  if (!dragTarget || !layout) return;
  const { x, y } = pointerCoords(e);
  if (dragStart && Math.hypot(x - dragStart.x, y - dragStart.y) > TAP_SLOP_PX) {
    dragStart.moved = true;
  }
  const clamped = clampToStage(x + dragOffsetX, y + dragOffsetY, layout);
  if (dragTarget === 'listener') {
    listenerPos = { x: clamped.x, y: clamped.y };
  } else {
    dragTarget.setPosition(clamped.x, clamped.y);
  }
  recomputeSpatial();
}

function onPointerUp(e) {
  if (canvas.releasePointerCapture && e?.pointerId != null) {
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  }
  // Touch + tap (no drag) on a voice opens the touch panel.
  if (
    dragStart &&
    !dragStart.moved &&
    dragStart.pointerType === 'touch' &&
    dragTarget &&
    dragTarget !== 'listener'
  ) {
    openTouchPanel(dragTarget);
  }
  dragTarget = null;
  dragStart = null;
  canvas.style.cursor = '';
}

// Phase-2/3 smoke test: per-part timelines + per-role MIDI ranges.
function renderScoreSmokeTest(movement, score) {
  const totalNotes = score.parts.reduce((sum, p) => sum + p.notes.length, 0);
  const durMin = Math.floor(score.duration / 60);
  const durSec = Math.round(score.duration % 60).toString().padStart(2, '0');

  const roleRanges = new Map();
  for (const p of score.parts) {
    if (p.notes.length === 0) continue;
    const midis = p.notes.map(n => n.midi);
    const lo = Math.min(...midis);
    const hi = Math.max(...midis);
    const cur = roleRanges.get(p.role);
    if (cur) {
      cur.lo = Math.min(cur.lo, lo);
      cur.hi = Math.max(cur.hi, hi);
    } else {
      roleRanges.set(p.role, { lo, hi });
    }
  }

  const lines = [
    `${movement.label} — parsed`,
    `${score.parts.length} parts, ${totalNotes} notes, ${durMin}:${durSec} @ ♩=${ENCODED_BPM}`,
    '',
    'per-part:',
    ...score.parts.map(p => {
      const midis = p.notes.map(n => n.midi);
      const lo = midis.length ? Math.min(...midis) : '–';
      const hi = midis.length ? Math.max(...midis) : '–';
      return `  ${p.id.padEnd(3)} ${p.role.padEnd(7)} ${p.label.padEnd(10)} ${String(p.notes.length).padStart(5)} notes  MIDI ${String(lo).padStart(3)}–${String(hi).padStart(3)} (${midiName(lo)}–${midiName(hi)})`;
    }),
    '',
    'per-role:',
    ...[...roleRanges.entries()].map(([role, r]) =>
      `  ${role.padEnd(7)} MIDI ${r.lo}–${r.hi} (${midiName(r.lo)}–${midiName(r.hi)})`
    ),
  ];
  placeholderEl.style.fontFamily = 'ui-monospace, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace';
  placeholderEl.style.whiteSpace = 'pre';
  placeholderEl.style.textAlign = 'left';
  placeholderEl.style.fontSize = '12px';
  placeholderEl.dataset.smokeText = lines.join('\n');
  paintPlaceholder();
}

function setStatus(s) {
  statusLine = s;
  paintPlaceholder();
}

function paintPlaceholder() {
  const smoke = placeholderEl.dataset.smokeText || '';
  placeholderEl.textContent = smoke ? `${smoke}\n\n${statusLine}` : statusLine;
}

function midiName(midi) {
  if (typeof midi !== 'number') return '–';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return names[midi % 12] + (Math.floor(midi / 12) - 1);
}

function startPlayback() {
  if (isPlaying || !voices.length) return;
  // Defensive: iOS Safari sometimes leaves the context suspended.
  if (audio.ctx.state === 'suspended') audio.ctx.resume();
  // Restore master gain in case the previous stop faded it to 0.
  const g = audio.masterGain.gain;
  g.cancelScheduledValues(audio.currentTime);
  g.setValueAtTime(0.85, audio.currentTime);
  voices.forEach(v => v.reset());
  playbackStart = audio.currentTime + PLAYBACK_LEAD_IN;
  isPlaying = true;
  playBtn.textContent = '■ Stop';
  playBtn.classList.add('playing');
  setStatus(`playing ${activeMovement.label} @ ♩=${activeMovement.notatedBPM}`);
  schedulerTick();
}

function stopPlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  if (schedulerHandle) {
    clearTimeout(schedulerHandle);
    schedulerHandle = null;
  }
  // Already-scheduled notes can ring for several seconds (natural pluck
  // decay). Fade master gain to 0 over 0.5s; the next Play call restores
  // it before resetting voice cursors.
  const g = audio.masterGain.gain;
  const t = audio.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.linearRampToValueAtTime(0, t + 0.5);

  playBtn.textContent = '▶ Play';
  playBtn.classList.remove('playing');
  setStatus(`stopped — press ▶ Play to restart`);
}

function schedulerTick() {
  if (!isPlaying) return;
  const tempoFactor = ENCODED_BPM / activeMovement.notatedBPM;
  const scheduleUntil = audio.currentTime + SCHEDULER_LOOKAHEAD;
  for (const voice of voices) {
    voice.scheduleAhead(playbackStart, scheduleUntil, tempoFactor);
  }
  // If every voice is exhausted AND we're past the last note's audio
  // time + a little reverb tail, end gracefully.
  if (voices.every(v => v.isExhausted)) {
    const endAudioTime = playbackStart + activeScore.duration * tempoFactor + 3;
    if (audio.currentTime >= endAudioTime) {
      isPlaying = false;
      playBtn.textContent = '▶ Play';
      playBtn.classList.remove('playing');
      setStatus(`finished. press ▶ Play to listen again.`);
      return;
    }
  }
  schedulerHandle = setTimeout(schedulerTick, SCHEDULER_TICK_MS);
}

function returnToMenu() {
  if (isPlaying) stopPlayback();
  stopRenderLoop();
  closeTouchPanel();
  stageViewEl.classList.remove('active');
  movementSelectEl.style.display = 'flex';
  requestAnimationFrame(() => movementSelectEl.classList.remove('fading'));
  activeMovement = null;
  voices = [];
  layout = null;
  listenerPos = null;
  hoveredVoice = null;
  playBtn.disabled = true;
  playBtn.textContent = '▶ Play';
  playBtn.classList.remove('playing');
  // Reset smoke text so the next selection rebuilds it.
  delete placeholderEl.dataset.smokeText;
  placeholderEl.style.display = 'flex';
  statusLine = '';
}

// ---- wire up ----

for (const btn of document.querySelectorAll('.movement-btn')) {
  btn.addEventListener('click', () => chooseMovement(btn.dataset.movement));
}
backBtn.addEventListener('click', returnToMenu);
playBtn.addEventListener('click', () => (isPlaying ? stopPlayback() : startPlayback()));

const canvas = document.getElementById('stage-canvas');
const ctx = canvas.getContext('2d');

function onResize() {
  syncCanvasBitmap();
  if (voices.length) applyStageLayout();
}
window.addEventListener('resize', onResize);
syncCanvasBitmap();

canvas.addEventListener('pointerdown', onPointerDown);
canvas.addEventListener('pointermove', onPointerMove);
canvas.addEventListener('pointerup', onPointerUp);
canvas.addEventListener('pointercancel', onPointerUp);

// Hover state: shift cursor + remember which voice is under the pointer
// so wheel + keyboard shortcuts know what to act on.
canvas.addEventListener('pointermove', (e) => {
  if (dragTarget) return; // already grabbing
  if (!layout) return;
  const { x, y } = pointerCoords(e);
  const target = hitTest(x, y);
  hoveredVoice = (target && target !== 'listener') ? target : null;
  canvas.style.cursor = target ? 'grab' : '';
});
canvas.addEventListener('pointerleave', () => {
  if (!dragTarget) hoveredVoice = null;
});

// ---- volume scroll wheel ----
canvas.addEventListener('wheel', (e) => {
  if (!hoveredVoice) return;
  e.preventDefault();
  // Scroll up = louder. 0.06 per detent feels close to In C's response.
  const delta = -Math.sign(e.deltaY) * 0.06;
  hoveredVoice.setVolume(hoveredVoice.userVolume + delta);
  // If the touch panel happens to be showing this voice, sync its slider.
  syncTouchPanelIfShowing(hoveredVoice);
}, { passive: false });

// ---- keyboard shortcuts ----
window.addEventListener('keydown', (e) => {
  if (!stageViewEl.classList.contains('active')) return;
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (e.key === 'm' || e.key === 'M') {
    if (hoveredVoice) {
      e.preventDefault();
      hoveredVoice.setMuted(!hoveredVoice.muted);
      syncTouchPanelIfShowing(hoveredVoice);
    }
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    if (hoveredVoice && isSwappable(hoveredVoice.role)) {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      const next = nextInstrument(hoveredVoice.instrument, dir);
      hoveredVoice.changeInstrument(next);
      syncTouchPanelIfShowing(hoveredVoice);
    }
  } else if (e.key === 'Escape') {
    if (touchPanelVoice) closeTouchPanel();
  }
});

// ---- touch panel ----
//
// Opens on tap of a voice (touch only — desktop uses hover + keys).
// Mirrors all the controls available via wheel/keyboard so mobile has
// parity. Bass and click voices show only volume + mute (the swap row
// stays hidden because their bank is fixed by scoring role).

const touchPanelEl    = document.getElementById('touch-panel');
const tpTitle         = document.getElementById('tp-title');
const tpRole          = document.getElementById('tp-role');
const tpVolume        = document.getElementById('tp-volume');
const tpMute          = document.getElementById('tp-mute');
const tpSwapRow       = document.getElementById('tp-swap-row');
const tpInstrument    = document.getElementById('tp-instrument-label');
const tpPrev          = document.getElementById('tp-prev');
const tpNext          = document.getElementById('tp-next');
const tpClose         = document.getElementById('tp-close');

let touchPanelVoice = null;

function openTouchPanel(voice) {
  touchPanelVoice = voice;
  tpTitle.textContent = voice.label;
  tpRole.textContent = voice.role;
  refreshTouchPanel();
  touchPanelEl.hidden = false;
}

function closeTouchPanel() {
  touchPanelEl.hidden = true;
  touchPanelVoice = null;
}

function refreshTouchPanel() {
  if (!touchPanelVoice) return;
  const v = touchPanelVoice;
  tpVolume.value = String(v.userVolume);
  tpMute.textContent = v.muted ? 'Unmute' : 'Mute';
  tpMute.classList.toggle('muted', v.muted);
  if (isSwappable(v.role)) {
    tpSwapRow.hidden = false;
    tpInstrument.textContent = instrumentLabel(v.instrument);
  } else {
    tpSwapRow.hidden = true;
  }
}

function syncTouchPanelIfShowing(voice) {
  if (touchPanelVoice === voice) refreshTouchPanel();
}

tpVolume.addEventListener('input', () => {
  if (!touchPanelVoice) return;
  touchPanelVoice.setVolume(parseFloat(tpVolume.value));
});
tpMute.addEventListener('click', () => {
  if (!touchPanelVoice) return;
  touchPanelVoice.setMuted(!touchPanelVoice.muted);
  refreshTouchPanel();
});
tpPrev.addEventListener('click', () => {
  if (!touchPanelVoice || !isSwappable(touchPanelVoice.role)) return;
  touchPanelVoice.changeInstrument(nextInstrument(touchPanelVoice.instrument, -1));
  refreshTouchPanel();
});
tpNext.addEventListener('click', () => {
  if (!touchPanelVoice || !isSwappable(touchPanelVoice.role)) return;
  touchPanelVoice.changeInstrument(nextInstrument(touchPanelVoice.instrument, 1));
  refreshTouchPanel();
});
tpClose.addEventListener('click', closeTouchPanel);

// ---- render loop ----

let renderHandle = null;

function startRenderLoop() {
  if (renderHandle) return;
  const loop = () => {
    drawStage();
    renderHandle = requestAnimationFrame(loop);
  };
  loop();
}

function stopRenderLoop() {
  if (renderHandle) cancelAnimationFrame(renderHandle);
  renderHandle = null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawStage() {
  if (!layout) return;
  const dpr = window.devicePixelRatio || 1;
  const W = layout.canvasWidth;
  const H = layout.canvasHeight;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  drawStageFloor();
  drawBackArc();
  drawListener();
  drawVoices();
  drawStatusLine();
}

function drawStageFloor() {
  const { cx, listenerY, arcRadius } = layout;
  // Subtle radial gradient suggesting a lit stage floor.
  const grad = ctx.createRadialGradient(cx, listenerY - arcRadius * 0.4, 20, cx, listenerY - arcRadius * 0.4, arcRadius * 1.4);
  grad.addColorStop(0, 'rgba(40, 36, 30, 0.55)');
  grad.addColorStop(1, 'rgba(14, 14, 16, 0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, listenerY, arcRadius * 1.18, Math.PI, 2 * Math.PI);
  ctx.lineTo(cx + arcRadius * 1.18, listenerY);
  ctx.lineTo(cx - arcRadius * 1.18, listenerY);
  ctx.closePath();
  ctx.fill();
}

function drawBackArc() {
  const { cx, listenerY, arcRadius } = layout;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, listenerY, arcRadius * 1.13, Math.PI, 2 * Math.PI);
  ctx.stroke();
}

function drawListener() {
  if (!listenerPos) return;
  const r = VISUAL.listenerRadius;
  ctx.fillStyle = '#f3f3f5';
  ctx.beginPath();
  ctx.arc(listenerPos.x, listenerPos.y, r, 0, 2 * Math.PI);
  ctx.fill();
  // Forward-facing tick (the conductor "looks" toward the stage).
  ctx.strokeStyle = '#f3f3f5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(listenerPos.x, listenerPos.y - r);
  ctx.lineTo(listenerPos.x, listenerPos.y - r - 8);
  ctx.stroke();
}

function drawVoices() {
  if (!voices.length) return;
  // Build per-role index so voice colors get hue-shifted across guitars 1..7.
  const roleIndex = new Map();
  const tNow = audio.currentTime;
  for (const voice of voices) {
    const idx = roleIndex.get(voice.role) ?? 0;
    roleIndex.set(voice.role, idx + 1);
    drawOneVoice(voice, idx, tNow);
  }
}

function drawOneVoice(voice, indexAmongRole, tNow) {
  const r = voiceRadius(voice.part);
  const baseColor = voiceColor(voice.part, indexAmongRole);
  const pulse = voice.pulseIntensity(tNow);

  // Glow on note onset — soft halo whose radius scales with pulse.
  if (pulse > 0) {
    const glowR = r + 12 * pulse;
    ctx.fillStyle = baseColor;
    ctx.globalAlpha = 0.25 * pulse;
    ctx.beginPath();
    ctx.arc(voice.x, voice.y, glowR, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Body. Brighten slightly on pulse.
  ctx.fillStyle = baseColor;
  ctx.globalAlpha = voice.muted ? 0.25 : 1;
  ctx.beginPath();
  ctx.arc(voice.x, voice.y, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (pulse > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.30 * pulse})`;
    ctx.beginPath();
    ctx.arc(voice.x, voice.y, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Border.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(voice.x, voice.y, r, 0, 2 * Math.PI);
  ctx.stroke();

  // Label.
  if (r >= 14) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.font = `${Math.round(r * 0.55)}px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(shortLabel(voice.label), voice.x, voice.y);
  }
}

// "Live" / "Bg1" / "Bg2" / "Click" stay as-is; "Guitar 3" → "G3" so it
// fits inside a 22-px circle without spilling.
function shortLabel(label) {
  const m = label.match(/^Guitar (\d+)$/);
  if (m) return `G${m[1]}`;
  return label;
}

function drawStatusLine() {
  if (!statusLine) return;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '12px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(statusLine, 16, layout.canvasHeight - 24);
}
