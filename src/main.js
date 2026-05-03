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
  randomVoicePositions,
  defaultListenerPosition,
  voiceColor,
  voiceRadius,
  clampToStage,
  VISUAL,
} from './layout.js';

const SCHEDULER_LOOKAHEAD = 0.5;     // seconds of audio scheduled ahead of currentTime
const SCHEDULER_TICK_MS = 100;        // how often the scheduler wakes
const PLAYBACK_LEAD_IN = 0.3;         // seconds between Play click and t=0

// ---- score scrubber ----
const SCRUBBER_Y = 14;                // baseline y for the track
const SCRUBBER_TRACK_H = 4;           // visible track thickness
const SCRUBBER_HIT_PAD = 12;          // ± padding around the track for taps
const SCRUBBER_GUTTER = 16;           // x-margin from canvas edges
const SCRUBBER_TIME_W = 96;           // reserved width for the "M:SS / M:SS" label

// ---- spotlight ----
const SPOTLIGHT_DIM = 0.22;           // gain multiplier on non-spotlit voices (~ -13 dB)
const SPOTLIGHT_VISUAL_DIM = 0.35;    // alpha multiplier on non-spotlit voices in the canvas
const DOUBLE_TAP_MS = 350;            // window for mouse double-click detection

const movementSelectEl = document.getElementById('movement-select');
const stageViewEl = document.getElementById('stage-view');
const movementTitleEl = document.getElementById('movement-title-text');
const backBtn = document.getElementById('back-btn');
const playBtn = document.getElementById('play-btn');
const placeholderEl = document.getElementById('stage-placeholder');

const volSlider     = document.getElementById('vol-slider');
const tempoSlider   = document.getElementById('tempo-slider');
const tempoValueEl  = document.getElementById('tempo-value');
const reverbSlider  = document.getElementById('reverb-slider');
const eqBassSlider  = document.getElementById('eq-bass-slider');
const eqMidSlider   = document.getElementById('eq-mid-slider');
const eqTrebleSlider= document.getElementById('eq-treble-slider');
const loadoutSelect = document.getElementById('loadout-select');
const randomBtn     = document.getElementById('random-btn');
const resetBtn      = document.getElementById('reset-btn');

const curtainEl       = document.getElementById('curtain');
const curtainMovement = document.getElementById('curtain-movement');
const curtainRestart  = document.getElementById('curtain-restart');
const curtainMenu     = document.getElementById('curtain-menu');

const helpBtn   = document.getElementById('help-btn');
const helpModal = document.getElementById('help-modal');
const helpClose = document.getElementById('help-close');
const aboutBtn   = document.getElementById('about-btn');
const aboutModal = document.getElementById('about-modal');
const aboutClose = document.getElementById('about-close');

// Defaults — kept here in JS rather than relying on the slider's initial
// value attribute because browsers cache form state across reloads.
const DEFAULT_MASTER_VOL = 0.85;
const DEFAULT_REVERB_WET = 0.5;
const DEFAULT_EQ_DB = 0;

let masterVolume = DEFAULT_MASTER_VOL;  // tracked so stop/play restore correctly
let currentBPM = 120;                   // overwritten per-movement
let pendingScoreStart = 0;              // where the next Play picks up from (set by scrubber while paused)

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
let spotlightVoice = null;  // Voice | null — currently spotlit voice
let lastTap = null;         // { time, target, pointerType } for double-click detection

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
  applyTopBarDefaults();
  refreshLoadoutSelect();

  setStatus(`ready — press ▶ Play to hear ${m.label}`);
  playBtn.disabled = false;
}

// Force the slider DOM values to our intended defaults and push them
// into the audio engine. Tempo defaults to the movement's notated BPM
// (♩=192 for III); other controls reset only on first movement-select
// (volume/reverb/EQ persist across menu trips so a user who tuned the
// mix doesn't lose it switching movements). Sliders carry
// autocomplete="off" but Firefox in particular still caches values.
function applyTopBarDefaults() {
  if (!activeMovement) return;
  currentBPM = activeMovement.notatedBPM;
  tempoSlider.value = String(currentBPM);
  tempoValueEl.textContent = String(currentBPM);

  // Master controls only get reset on first init (when audio.masterGain
  // is still at its constructor default). Subsequent movement-selects
  // leave the user's chosen mix alone.
  if (!topBarInitialized) {
    volSlider.value     = String(DEFAULT_MASTER_VOL);
    reverbSlider.value  = String(DEFAULT_REVERB_WET);
    eqBassSlider.value  = String(DEFAULT_EQ_DB);
    eqMidSlider.value   = String(DEFAULT_EQ_DB);
    eqTrebleSlider.value= String(DEFAULT_EQ_DB);
    masterVolume = DEFAULT_MASTER_VOL;
    audio.setMasterGain(masterVolume);
    audio.setReverbWet(DEFAULT_REVERB_WET);
    audio.setEqBass(DEFAULT_EQ_DB);
    audio.setEqMid(DEFAULT_EQ_DB);
    audio.setEqTreble(DEFAULT_EQ_DB);
    topBarInitialized = true;
  } else {
    // Re-push the user's chosen values into the new audio context state.
    masterVolume = parseFloat(volSlider.value);
    audio.setMasterGain(masterVolume);
    audio.setReverbWet(parseFloat(reverbSlider.value));
    audio.setEqBass(parseFloat(eqBassSlider.value));
    audio.setEqMid(parseFloat(eqMidSlider.value));
    audio.setEqTreble(parseFloat(eqTrebleSlider.value));
  }
}

let topBarInitialized = false;

// Tempo slider mid-piece change: pivot playbackStart so the current
// score position stays put across the tempo change. Notes already
// scheduled within the lookahead window play at the old timing; new
// scheduleAhead calls pick up the new tempoFactor automatically.
function setTempo(bpm) {
  bpm = Math.max(60, Math.min(240, Math.round(bpm)));
  if (isPlaying && audio.ctx) {
    const oldFactor = ENCODED_BPM / currentBPM;
    const newFactor = ENCODED_BPM / bpm;
    const tNow = audio.currentTime;
    const scorePos = (tNow - playbackStart) / oldFactor;
    playbackStart = tNow - scorePos * newFactor;
  }
  currentBPM = bpm;
  tempoValueEl.textContent = String(currentBPM);
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

// ---- spotlight ----
//
// Highlight one voice by smoothly ducking every other voice's gain via
// each Voice's spotlightAttenuation. Visual emphasis (outer ring + dim
// on the others) is layered on top in drawOneVoice. Passing the same
// voice that's already spotlit toggles the spotlight off; passing null
// clears it explicitly.
function setSpotlight(voice) {
  if (voice && spotlightVoice === voice) voice = null;
  spotlightVoice = voice;
  for (const v of voices) {
    const target = (!spotlightVoice || v === spotlightVoice) ? 1.0 : SPOTLIGHT_DIM;
    v.setSpotlightAttenuation(target);
  }
  if (touchPanelVoice) refreshTouchPanel();
}

// Returns true if (target, pointerType) matches a tap recorded within
// DOUBLE_TAP_MS — i.e. this is the second click of a double-click. Otherwise
// records the new tap and returns false.
function recordTap(target, pointerType) {
  const now = performance.now();
  if (
    lastTap &&
    now - lastTap.time < DOUBLE_TAP_MS &&
    lastTap.target === target &&
    lastTap.pointerType === pointerType
  ) {
    lastTap = null;
    return true;
  }
  lastTap = { time: now, target, pointerType };
  return false;
}

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
  // Spotlit voice is drawn on top — hit-test it first so a click on its
  // bright outer ring always lands on it, even if it overlaps another.
  if (spotlightVoice) {
    const r = voiceRadius(spotlightVoice.part) + 8;
    const dx = x - spotlightVoice.x;
    const dy = y - spotlightVoice.y;
    if (dx * dx + dy * dy <= r * r) return spotlightVoice;
  }
  // Voices, in reverse order so visually-on-top ones are picked first.
  for (let i = voices.length - 1; i >= 0; i--) {
    const v = voices[i];
    if (v === spotlightVoice) continue;
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

  // Scrubber takes priority — it sits along the top edge above
  // everything else.
  if (scrubberHit(x, y)) {
    e.preventDefault();
    if (canvas.setPointerCapture) {
      try { canvas.setPointerCapture(e.pointerId); } catch {}
    }
    dragTarget = 'scrubber';
    dragStart = { x, y, pointerType: e.pointerType, moved: false };
    canvas.style.cursor = 'grabbing';
    // While playing, hold silence for the full drag — restored on up.
    if (isPlaying && audio.ctx) {
      const g = audio.masterGain.gain;
      const tNow = audio.currentTime;
      g.cancelScheduledValues(tNow);
      g.setValueAtTime(g.value, tNow);
      g.linearRampToValueAtTime(0, tNow + 0.04);
    }
    seekTo(scrubberSecondsAt(x), { keepSilent: true });
    return;
  }

  const target = hitTest(x, y);
  if (!target) {
    // Tap on empty space (touch only) closes the touch panel.
    if (e.pointerType === 'touch') closeTouchPanel();
    // Stash a tap marker so pointerup can detect a mouse double-click on
    // empty stage (used to clear an active spotlight).
    dragStart = { x, y, pointerType: e.pointerType, moved: false };
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
    // A drag invalidates the in-progress double-click — otherwise a quick
    // click after a drag could spuriously trigger spotlight.
    lastTap = null;
  }
  if (dragTarget === 'scrubber') {
    seekTo(scrubberSecondsAt(x), { keepSilent: true });
    return;
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
    dragTarget !== 'listener' &&
    dragTarget !== 'scrubber'
  ) {
    openTouchPanel(dragTarget);
  }
  // End-of-scrub: restore master gain. seekTo already reseated
  // playbackStart and re-filled the lookahead during the drag.
  if (dragTarget === 'scrubber' && isPlaying && audio.ctx) {
    const g = audio.masterGain.gain;
    const tNow = audio.currentTime;
    g.cancelScheduledValues(tNow);
    g.setValueAtTime(0, tNow);
    g.linearRampToValueAtTime(masterVolume, tNow + 0.12);
  }
  // Mouse tap (clean click, no drag) → double-click detection for spotlight.
  // Voice double-click toggles its spotlight; empty-stage double-click
  // clears an active spotlight. Touch parity goes through the touch panel
  // (single tap there opens the panel, which has a Spotlight button).
  if (
    dragStart &&
    !dragStart.moved &&
    dragStart.pointerType !== 'touch' &&
    dragTarget !== 'scrubber'
  ) {
    if (recordTap(dragTarget, 'mouse')) {
      if (dragTarget && dragTarget !== 'listener') {
        setSpotlight(dragTarget);
      } else if (!dragTarget && spotlightVoice) {
        setSpotlight(null);
      }
    }
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
  g.setValueAtTime(masterVolume, audio.currentTime);
  // Skip each voice's cursor past pendingScoreStart so playback picks
  // up wherever the scrubber was last left.
  const startSec = Math.max(0, Math.min(activeScore.duration, pendingScoreStart));
  voices.forEach(v => {
    v.reset();
    advanceVoiceTo(v, startSec);
  });
  const tempoFactor = ENCODED_BPM / currentBPM;
  playbackStart = audio.currentTime + PLAYBACK_LEAD_IN - startSec * tempoFactor;
  isPlaying = true;
  playBtn.textContent = '■ Stop';
  playBtn.classList.add('playing');
  setStatus(`playing ${activeMovement.label} @ ♩=${activeMovement.notatedBPM}`);
  schedulerTick();
}

// Move a voice's scheduling cursor past every note that ends before
// `scoreSeconds`. Anything that's still partly in the future from that
// point is left to scheduleAhead.
function advanceVoiceTo(voice, scoreSeconds) {
  let i = 0;
  while (i < voice.notes.length && voice.notes[i].time < scoreSeconds) i++;
  voice.scheduledIdx = i;
  voice.recentOnsets = [];
}

// Where are we in the score right now? Used by the scrubber drawing.
function currentScoreSeconds() {
  if (isPlaying && audio.ctx) {
    const tempoFactor = ENCODED_BPM / currentBPM;
    return Math.max(0, (audio.currentTime - playbackStart) / tempoFactor);
  }
  return pendingScoreStart;
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
  const tempoFactor = ENCODED_BPM / currentBPM;
  const scheduleUntil = audio.currentTime + SCHEDULER_LOOKAHEAD;
  for (const voice of voices) {
    voice.scheduleAhead(playbackStart, scheduleUntil, tempoFactor);
  }
  // If every voice is exhausted AND we're past the last note's audio
  // time + a little reverb tail, raise the curtain.
  if (voices.every(v => v.isExhausted)) {
    const endAudioTime = playbackStart + activeScore.duration * tempoFactor + 3;
    if (audio.currentTime >= endAudioTime) {
      isPlaying = false;
      playBtn.textContent = '▶ Play';
      playBtn.classList.remove('playing');
      // Rewind so "Start over" on the curtain plays from the top.
      pendingScoreStart = 0;
      setStatus(`finished.`);
      showCurtain();
      return;
    }
  }
  schedulerHandle = setTimeout(schedulerTick, SCHEDULER_TICK_MS);
}

function returnToMenu() {
  if (isPlaying) stopPlayback();
  stopRenderLoop();
  closeTouchPanel();
  hideCurtain();
  pendingScoreStart = 0;
  stageViewEl.classList.remove('active');
  movementSelectEl.style.display = 'flex';
  requestAnimationFrame(() => movementSelectEl.classList.remove('fading'));
  activeMovement = null;
  voices = [];
  layout = null;
  listenerPos = null;
  hoveredVoice = null;
  spotlightVoice = null;
  lastTap = null;
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
  if (scrubberHit(x, y)) {
    hoveredVoice = null;
    canvas.style.cursor = 'pointer';
    return;
  }
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

  if (e.key === ' ' || e.code === 'Space') {
    // Global play / stop. Skip when a modal or the curtain is up so
    // their own buttons can still receive Space (e.g. Start over on
    // the curtain).
    if (anyModalOpen() || !curtainEl.hidden) return;
    if (playBtn.disabled) return;
    e.preventDefault();
    if (isPlaying) stopPlayback();
    else startPlayback();
    return;
  }

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
      refreshLoadoutSelect();
    }
  }
  // Escape and `?` are handled by the consolidated overlay handler
  // further down so a single Esc press always picks the right thing
  // to dismiss.
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
const tpSpotlight     = document.getElementById('tp-spotlight');
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
  const isSpot = (spotlightVoice === v);
  tpSpotlight.textContent = isSpot ? 'Exit spotlight' : 'Spotlight';
  tpSpotlight.classList.toggle('active', isSpot);
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
tpSpotlight.addEventListener('click', () => {
  if (!touchPanelVoice) return;
  setSpotlight(touchPanelVoice);
});
tpPrev.addEventListener('click', () => {
  if (!touchPanelVoice || !isSwappable(touchPanelVoice.role)) return;
  touchPanelVoice.changeInstrument(nextInstrument(touchPanelVoice.instrument, -1));
  refreshTouchPanel();
  refreshLoadoutSelect();
});
tpNext.addEventListener('click', () => {
  if (!touchPanelVoice || !isSwappable(touchPanelVoice.role)) return;
  touchPanelVoice.changeInstrument(nextInstrument(touchPanelVoice.instrument, 1));
  refreshTouchPanel();
  refreshLoadoutSelect();
});
tpClose.addEventListener('click', closeTouchPanel);

// ---- top-bar slider handlers ----

volSlider.addEventListener('input', () => {
  masterVolume = parseFloat(volSlider.value);
  audio.setMasterGain(masterVolume);
});
tempoSlider.addEventListener('input', () => {
  setTempo(parseInt(tempoSlider.value, 10));
});
reverbSlider.addEventListener('input', () => {
  audio.setReverbWet(parseFloat(reverbSlider.value));
});
eqBassSlider.addEventListener('input', () => {
  audio.setEqBass(parseFloat(eqBassSlider.value));
});
eqMidSlider.addEventListener('input', () => {
  audio.setEqMid(parseFloat(eqMidSlider.value));
});
eqTrebleSlider.addEventListener('input', () => {
  audio.setEqTreble(parseFloat(eqTrebleSlider.value));
});

// Loadout: set every swappable voice (live + numbered guitars) to one
// instrument bank in a single click. Bass and click stay locked to their
// own banks. The select doubles as a status display — shows "Mixed"
// (disabled) when ←/→ has made voices heterogeneous.
function setLoadout(instrumentId) {
  if (!instrumentId || !voices.length) return;
  for (const v of voices) {
    if (!isSwappable(v.role)) continue;
    if (v.instrument !== instrumentId) v.changeInstrument(instrumentId);
  }
  if (touchPanelVoice) refreshTouchPanel();
}

function refreshLoadoutSelect() {
  if (!loadoutSelect) return;
  const swap = voices.filter(v => isSwappable(v.role));
  if (!swap.length) { loadoutSelect.value = ''; return; }
  const first = swap[0].instrument;
  const allSame = swap.every(v => v.instrument === first);
  loadoutSelect.value = allSame ? first : '';
}

loadoutSelect.addEventListener('change', () => {
  setLoadout(loadoutSelect.value);
  refreshLoadoutSelect();
});

// Reset everything that the user can change while playing back to its
// out-of-the-box state for the current movement: top-bar sliders to
// defaults, per-voice volumes / mutes / instruments to defaults, and
// the stage layout (voice positions + listener) to the canonical
// half-moon. The audio engine state follows the slider values.
function resetAll() {
  if (!activeMovement || !voices.length) return;

  // Top-bar sliders.
  volSlider.value      = String(DEFAULT_MASTER_VOL);
  reverbSlider.value   = String(DEFAULT_REVERB_WET);
  eqBassSlider.value   = String(DEFAULT_EQ_DB);
  eqMidSlider.value    = String(DEFAULT_EQ_DB);
  eqTrebleSlider.value = String(DEFAULT_EQ_DB);
  tempoSlider.value    = String(activeMovement.notatedBPM);
  masterVolume = DEFAULT_MASTER_VOL;
  audio.setMasterGain(masterVolume);
  audio.setReverbWet(DEFAULT_REVERB_WET);
  audio.setEqBass(DEFAULT_EQ_DB);
  audio.setEqMid(DEFAULT_EQ_DB);
  audio.setEqTreble(DEFAULT_EQ_DB);
  setTempo(activeMovement.notatedBPM);

  // Clear any active spotlight before per-voice resets so every voice
  // ends back at full gain (no lingering attenuation).
  setSpotlight(null);

  // Per-voice state.
  for (const v of voices) {
    if (v.muted) v.setMuted(false);
    v.setVolume(v.defaultVolume);
    if (isSwappable(v.role)) {
      v.changeInstrument(ROLE_TO_DEFAULT_INSTRUMENT[v.role]);
    }
  }

  // Stage geometry — also recomputes spatial audio for each voice from
  // its newly-reset position.
  applyStageLayout();

  // Rewind to the start of the piece. While playing this seeks live;
  // while paused it just resets the "next play" position.
  seekTo(0);

  // Sync any visible touch panel with the new state.
  if (touchPanelVoice) refreshTouchPanel();
  refreshLoadoutSelect();
}

resetBtn.addEventListener('click', resetAll);

// Scatter every voice to a random position inside the half-moon. Listener
// stays where it is. Works whether playing or paused — recomputeSpatial
// pushes the new pan / dry / wet values through.
function randomizeLayout() {
  if (!voices.length || !layout || !listenerPos) return;
  const positions = randomVoicePositions(activeScore.parts, layout, listenerPos);
  for (const v of voices) {
    const pos = positions.get(v.id);
    if (pos) v.setPosition(pos.x, pos.y);
  }
  recomputeSpatial();
}

randomBtn.addEventListener('click', randomizeLayout);

// ---- endgame curtain ----
//
// Shown when the score finishes naturally (every voice exhausted plus a
// 3-second reverb tail in schedulerTick). Two buttons: replay the same
// movement, or pop back to the menu. Esc dismisses to the menu.

function showCurtain() {
  if (!activeMovement) return;
  curtainMovement.textContent = activeMovement.label;
  curtainEl.hidden = false;
  // Force a reflow before adding .visible so the opacity transition
  // actually fires (going from display:none to flex skips transitions).
  void curtainEl.offsetWidth;
  curtainEl.classList.add('visible');
}

function hideCurtain() {
  if (curtainEl.hidden) return;
  curtainEl.classList.remove('visible');
  // Wait for the fade-out before yanking display:none.
  setTimeout(() => { curtainEl.hidden = true; }, 600);
}

curtainRestart.addEventListener('click', () => {
  hideCurtain();
  // Small delay so the fade-out doesn't fight the audio resuming.
  setTimeout(() => startPlayback(), 200);
});
curtainMenu.addEventListener('click', () => {
  // returnToMenu hides the curtain itself.
  returnToMenu();
});

// ---- help / about modals ----

function openModal(el) {
  // Closing any other modal first keeps state simple.
  closeAllModals();
  el.hidden = false;
}
function closeAllModals() {
  helpModal.hidden = true;
  aboutModal.hidden = true;
}
function anyModalOpen() {
  return !helpModal.hidden || !aboutModal.hidden;
}

helpBtn.addEventListener('click', () => openModal(helpModal));
helpClose.addEventListener('click', closeAllModals);
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) closeAllModals(); });

aboutBtn.addEventListener('click', () => openModal(aboutModal));
aboutClose.addEventListener('click', closeAllModals);
aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) closeAllModals(); });

// ---- consolidated Esc / `?` handler ----
//
// Priority on Escape: open modal → curtain → touch panel → nothing.
// `?` toggles the help modal (when no other modal is in the way).

window.addEventListener('keydown', (e) => {
  if (e.key === '?') {
    e.preventDefault();
    if (helpModal.hidden) openModal(helpModal);
    else closeAllModals();
    return;
  }
  if (e.key !== 'Escape') return;
  if (anyModalOpen()) {
    e.preventDefault();
    closeAllModals();
  } else if (!curtainEl.hidden) {
    e.preventDefault();
    returnToMenu();
  } else if (touchPanelVoice) {
    e.preventDefault();
    closeTouchPanel();
  } else if (spotlightVoice) {
    e.preventDefault();
    setSpotlight(null);
  }
});

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
  // Hover panel goes on top of the voices so it's never occluded.
  // Suppressed during a drag (the user already knows what they grabbed
  // and the panel would just clutter the gesture).
  if (hoveredVoice && !dragTarget) drawHoverPanel(hoveredVoice);
  drawScrubber();
  drawHint();
  drawStatusLine();
}

// Score scrubber drawn at the top of the canvas: full-width track,
// accent-coloured fill up to the playhead, small playhead marker, and
// "M:SS / M:SS" elapsed/total to the right.
function drawScrubber() {
  if (!activeScore || !activeScore.duration) return;
  const W = layout.canvasWidth;
  const trackX = SCRUBBER_GUTTER;
  const trackY = SCRUBBER_Y;
  const trackW = W - SCRUBBER_GUTTER * 2 - SCRUBBER_TIME_W;
  const trackH = SCRUBBER_TRACK_H;

  const sec = currentScoreSeconds();
  const frac = Math.max(0, Math.min(1, sec / activeScore.duration));
  const headX = trackX + trackW * frac;

  // Track background.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fillRect(trackX, trackY, trackW, trackH);

  // Filled portion.
  ctx.fillStyle = dragTarget === 'scrubber'
    ? 'rgba(217, 107, 58, 0.85)'        // accent, brighter while dragging
    : 'rgba(217, 107, 58, 0.65)';
  ctx.fillRect(trackX, trackY, trackW * frac, trackH);

  // Playhead marker — a small vertical bar.
  ctx.fillStyle = '#f3f3f5';
  ctx.fillRect(headX - 1, trackY - 4, 2, trackH + 8);

  // Time label — wall-clock seconds at the current tempo, not score-
  // seconds at the encoded ♩=120 (a user listening at 192 BPM should
  // see ~4:22 for mvt III, not the 7:00 the score is encoded at).
  const tempoFactor = ENCODED_BPM / currentBPM;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
  ctx.font = '11px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(
    `${formatTime(sec * tempoFactor)} / ${formatTime(activeScore.duration * tempoFactor)}`,
    W - SCRUBBER_GUTTER,
    trackY + trackH / 2
  );
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function scrubberHit(x, y) {
  if (!layout || !activeScore) return false;
  const trackX = SCRUBBER_GUTTER;
  const trackW = layout.canvasWidth - SCRUBBER_GUTTER * 2 - SCRUBBER_TIME_W;
  return x >= trackX
      && x <= trackX + trackW
      && y >= SCRUBBER_Y - SCRUBBER_HIT_PAD
      && y <= SCRUBBER_Y + SCRUBBER_TRACK_H + SCRUBBER_HIT_PAD;
}

function scrubberSecondsAt(x) {
  const trackX = SCRUBBER_GUTTER;
  const trackW = layout.canvasWidth - SCRUBBER_GUTTER * 2 - SCRUBBER_TIME_W;
  const frac = Math.max(0, Math.min(1, (x - trackX) / trackW));
  return frac * activeScore.duration;
}

// Jump playback to a score-time position. While playing this dips
// masterGain to silence (so notes already in the lookahead window
// don't ring through the seek), reseats playbackStart, advances every
// voice's scheduledIdx, and triggers an immediate scheduler tick so
// the new lookahead window fills before the gain restores.
//
// `keepSilent` is set during scrubber drag so we hold silence through
// the whole drag and only restore on release.
function seekTo(scoreSeconds, { keepSilent = false } = {}) {
  scoreSeconds = Math.max(0, Math.min(activeScore.duration, scoreSeconds));
  pendingScoreStart = scoreSeconds;
  if (!isPlaying || !audio.ctx) return;

  const tempoFactor = ENCODED_BPM / currentBPM;
  const tNow = audio.currentTime;
  playbackStart = tNow - scoreSeconds * tempoFactor;
  for (const v of voices) advanceVoiceTo(v, scoreSeconds);

  // Re-fill the lookahead at the new position right now.
  if (schedulerHandle) clearTimeout(schedulerHandle);
  schedulerTick();

  if (!keepSilent) {
    // Quick dip+restore so the old lookahead's tail doesn't bleed
    // through. Total ducking ~120 ms.
    const g = audio.masterGain.gain;
    g.cancelScheduledValues(tNow);
    g.setValueAtTime(g.value, tNow);
    g.linearRampToValueAtTime(0, tNow + 0.04);
    g.setValueAtTime(0, tNow + 0.10);
    g.linearRampToValueAtTime(masterVolume, tNow + 0.20);
  }
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

// roleIndex of each voice — built each frame in drawVoices so we can
// reuse it in drawHoverPanel for the bar-fill color.
const voiceRoleIndex = new Map();

function drawVoices() {
  if (!voices.length) return;
  voiceRoleIndex.clear();
  const counter = new Map();
  const tNow = audio.currentTime;
  for (const voice of voices) {
    const idx = counter.get(voice.role) ?? 0;
    counter.set(voice.role, idx + 1);
    voiceRoleIndex.set(voice, idx);
  }
  // Draw non-spotlit voices first, then the spotlit voice last so its
  // outer ring sits on top of any overlapping circles.
  for (const voice of voices) {
    if (voice === spotlightVoice) continue;
    drawOneVoice(voice, voiceRoleIndex.get(voice), tNow);
  }
  if (spotlightVoice) {
    drawOneVoice(spotlightVoice, voiceRoleIndex.get(spotlightVoice), tNow);
  }
}

function drawOneVoice(voice, indexAmongRole, tNow) {
  const r = voiceRadius(voice.part);
  const baseColor = voiceColor(voice.part, indexAmongRole);
  const pulse = voice.pulseIntensity(tNow);
  // Visual dim on non-spotlit voices when a spotlight is active. Multiplied
  // into every alpha so the entire voice (halo, body, border, label) fades
  // back together.
  const dim = (spotlightVoice && voice !== spotlightVoice) ? SPOTLIGHT_VISUAL_DIM : 1.0;

  // Glow on note onset — soft halo whose radius scales with pulse.
  if (pulse > 0) {
    const glowR = r + 12 * pulse;
    ctx.fillStyle = baseColor;
    ctx.globalAlpha = 0.25 * pulse * dim;
    ctx.beginPath();
    ctx.arc(voice.x, voice.y, glowR, 0, 2 * Math.PI);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Body. Brighten slightly on pulse.
  ctx.fillStyle = baseColor;
  ctx.globalAlpha = (voice.muted ? 0.25 : 1) * dim;
  ctx.beginPath();
  ctx.arc(voice.x, voice.y, r, 0, 2 * Math.PI);
  ctx.fill();
  ctx.globalAlpha = 1;

  if (pulse > 0) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.30 * pulse * dim})`;
    ctx.beginPath();
    ctx.arc(voice.x, voice.y, r, 0, 2 * Math.PI);
    ctx.fill();
  }

  // Border.
  ctx.strokeStyle = `rgba(0, 0, 0, ${0.4 * dim})`;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(voice.x, voice.y, r, 0, 2 * Math.PI);
  ctx.stroke();

  // Spotlight indicator — bright outer ring on the spotlit voice.
  if (spotlightVoice === voice) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(voice.x, voice.y, r + 6, 0, 2 * Math.PI);
    ctx.stroke();
  }

  // Label.
  if (r >= 14) {
    ctx.fillStyle = `rgba(255, 255, 255, ${0.92 * dim})`;
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

// Mouse-only hover panel (touch users get the bottom #touch-panel
// overlay instead). Drawn on the canvas next to the hovered voice
// with: voice label, role + current instrument, a volume bar, and
// shortcut hints. Mirrors the In C drawVoicePanel pattern but styled
// to match EC's dark stage theme.
function drawHoverPanel(voice) {
  if (!layout) return;
  const swappable = isSwappable(voice.role);
  const lines = swappable
    ? ['scroll · volume', 'M · mute', '← → · swap instrument', 'drag · move']
    : ['scroll · volume', 'M · mute', 'drag · move'];
  const w = 196;
  const h = 64 + lines.length * 14;
  const r = voiceRadius(voice.part);
  const onLeft = voice.x < layout.canvasWidth / 2;
  let sx = onLeft ? voice.x + r + 14 : voice.x - r - 14 - w;
  let sy = voice.y - h / 2;
  // Clamp inside canvas with a small margin.
  sx = Math.max(8, Math.min(layout.canvasWidth - w - 8, sx));
  sy = Math.max(8, Math.min(layout.canvasHeight - h - 8, sy));

  ctx.fillStyle = 'rgba(24, 24, 32, 0.95)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(sx, sy, w, h, 4);
  } else {
    ctx.rect(sx, sy, w, h);
  }
  ctx.fill();
  ctx.stroke();

  // Header — voice label.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.font = '13px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(voice.label, sx + 12, sy + 10);

  // Sub — role + instrument name.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.font = '11px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  const sub = swappable
    ? `${voice.role} · ${instrumentLabel(voice.instrument)}`
    : voice.role;
  ctx.fillText(sub, sx + 12, sy + 26);

  // Volume bar — the bar maxes at the slider's 1.5 ceiling so a default
  // setVolume(0.9) reads as 60%, matching the touch panel.
  const barX = sx + 12, barY = sy + 46, barW = w - 24, barH = 5;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
  ctx.fillRect(barX, barY, barW, barH);
  const fillFrac = Math.max(0, Math.min(1, voice.userVolume / 1.5));
  ctx.fillStyle = voice.muted
    ? 'rgba(255, 255, 255, 0.25)'
    : voiceColor(voice.part, voiceRoleIndex.get(voice) ?? 0);
  ctx.fillRect(barX, barY, barW * fillFrac, barH);
  if (voice.muted) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '10px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.fillText('muted', barX + barW, sy + 32);
    ctx.textAlign = 'left';
  }

  // Hints.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '10px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], sx + 12, sy + 60 + i * 14);
  }
}

function drawStatusLine() {
  if (!statusLine) return;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.font = '12px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(statusLine, 16, layout.canvasHeight - 24);
}

// ---- onboarding hints ----
//
// During the first ~30 s of the user's first playback in this session,
// fade transient hints across the bottom of the canvas to walk through
// the core interactions. Hint times are in *score seconds* from
// playback start; tempo changes don't affect hint timing because we
// read straight from audio.currentTime - playbackStart.

const HINTS = [
  { at: 3,  duration: 8, text: 'drag any voice or the listener to move it around the stage' },
  { at: 13, duration: 8, text: 'tap or hover a voice for volume, mute, instrument swap' },
  { at: 24, duration: 8, text: 'press ? for the full controls reference' },
];
let hintsCompleted = false;

function activeHint() {
  if (hintsCompleted || !isPlaying || !playbackStart) return null;
  const t = audio.currentTime - playbackStart;
  const lastEnd = HINTS[HINTS.length - 1].at + HINTS[HINTS.length - 1].duration;
  if (t > lastEnd) {
    hintsCompleted = true;
    return null;
  }
  for (const h of HINTS) {
    if (t >= h.at && t < h.at + h.duration) {
      return { ...h, elapsed: t - h.at };
    }
  }
  return null;
}

function drawHint() {
  const h = activeHint();
  if (!h) return;
  // Fade in over 0.5 s, fade out over the last 0.8 s.
  let alpha = 1;
  if (h.elapsed < 0.5) alpha = h.elapsed / 0.5;
  else if (h.elapsed > h.duration - 0.8) alpha = Math.max(0, (h.duration - h.elapsed) / 0.8);
  ctx.fillStyle = `rgba(230, 230, 235, ${alpha * 0.85})`;
  ctx.font = '14px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(h.text, layout.canvasWidth / 2, layout.canvasHeight - 18);
}
