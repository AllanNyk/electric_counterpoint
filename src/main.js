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
import { ROLE_TO_DEFAULT_INSTRUMENT } from './roster.js';
import {
  computeLayout,
  initialVoicePositions,
  defaultListenerPosition,
  voiceColor,
  voiceRadius,
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
  setStatus('loading samples and IR…');
  try {
    await Promise.all([
      audio.loadIR('assets/audio/ir/theatre41.wav'),
      ...voices.map(v => v.loadSamples()),
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

function applyStageLayout() {
  if (!voices.length) return;
  const rect = canvas.getBoundingClientRect();
  layout = computeLayout(rect.width, rect.height);
  listenerPos = defaultListenerPosition(layout);
  const positions = initialVoicePositions(activeScore.parts, layout);
  for (const voice of voices) {
    const pos = positions.get(voice.id);
    if (pos) voice.setPosition(pos.x, pos.y);
  }
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
  stageViewEl.classList.remove('active');
  movementSelectEl.style.display = 'flex';
  requestAnimationFrame(() => movementSelectEl.classList.remove('fading'));
  activeMovement = null;
  voices = [];
  layout = null;
  listenerPos = null;
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

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  if (voices.length) applyStageLayout();
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

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
