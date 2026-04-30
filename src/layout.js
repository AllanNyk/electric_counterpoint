// layout.js — top-down stage geometry for Electric Counterpoint.
//
// Coordinate system: CSS pixels with origin at canvas top-left, y growing
// downward. The listener sits low-center (representing the conductor /
// audience position); the half-moon stage curves up and away from there.
//
//   y=0  ┌───────────────────────────────┐
//        │             (back wall)        │   ← click voice sits here
//        │      ╱── arc of guitars ──╲    │
//        │     ╱                      ╲   │   ← Bg1 / Bg2 on right flank
//        │    ●     ● live guitar     ●   │
//        │                                │
//        │            ◉ listener          │
//        │                                │
//   y=H  └───────────────────────────────┘
//
// computeLayout is called any time the canvas resizes. It returns the
// derived geometry; initialVoicePositions slots each part into its
// default spot by role (using arc-radius units so it scales with viewport).

const STAGE_PADDING = 40;            // CSS px gutter from canvas edge
const LISTENER_BOTTOM_OFFSET = 0.18; // listener sits 18% from the bottom

export function computeLayout(canvasWidth, canvasHeight) {
  const cx = canvasWidth / 2;
  const listenerY = canvasHeight * (1 - LISTENER_BOTTOM_OFFSET);
  const arcRadius = Math.max(
    120,
    Math.min(canvasWidth * 0.42, listenerY - STAGE_PADDING)
  );
  return { cx, listenerY, arcRadius, canvasWidth, canvasHeight };
}

// Slot each part into its default stage position. Arc holds 7 guitars +
// 2 basses (live and click sit elsewhere). Returns Map<part.id, {x,y}>.
export function initialVoicePositions(parts, layout) {
  const { cx, listenerY, arcRadius } = layout;
  const positions = new Map();

  const guitarParts = parts.filter(p => p.role === 'guitar');
  const liveParts = parts.filter(p => p.role === 'live');
  const bassParts = parts.filter(p => p.role === 'bass');
  const clickParts = parts.filter(p => p.role === 'click');

  // Arc: guitars from the left through center, basses on the right
  // flank. Total arc slots = guitarParts.length + bassParts.length.
  // Angles run π → 0 in math convention (left → right through top), and
  // we offset by half a slot so positions sit at slot centers rather
  // than at the very edges where the arc meets the listener level.
  const arcOrder = [...guitarParts, ...bassParts];
  const slots = Math.max(1, arcOrder.length);
  for (let i = 0; i < arcOrder.length; i++) {
    const t = (i + 0.5) / slots;
    const angle = Math.PI - t * Math.PI;
    positions.set(arcOrder[i].id, {
      x: cx + arcRadius * Math.cos(angle),
      y: listenerY - arcRadius * Math.sin(angle),
    });
  }

  // Live guitar: in front of the half-moon, between listener and arc.
  for (const p of liveParts) {
    positions.set(p.id, { x: cx, y: listenerY - arcRadius * 0.45 });
  }

  // Click: back-left of stage, off-center so it doesn't overlap G5 (the
  // arc's top-center voice). Suggests a percussionist position upstage.
  for (const p of clickParts) {
    positions.set(p.id, {
      x: cx - arcRadius * 0.40,
      y: Math.max(STAGE_PADDING * 0.5, listenerY - arcRadius * 1.18),
    });
  }

  return positions;
}

// Clamp (x, y) into the half-moon stage area used for both voices and
// the listener dot. Returns the constrained coordinates.
export function clampToStage(x, y, layout) {
  const { cx, listenerY, arcRadius } = layout;
  // Maximum radius from the default listener position (the "stage edge").
  const maxR = arcRadius * 1.18;
  const dx = x - cx;
  const dy = y - listenerY;
  const dist = Math.hypot(dx, dy);
  let nx = x, ny = y;
  if (dist > maxR) {
    const k = maxR / dist;
    nx = cx + dx * k;
    ny = listenerY + dy * k;
  }
  // Keep things from drifting below the listener line by more than a
  // small slack — the half-moon opens upward.
  const maxY = listenerY + 24;
  if (ny > maxY) ny = maxY;
  return { x: nx, y: ny };
}

// Listener default position — bottom-center of the stage. Phase 6 makes
// this draggable; phase 5 just renders it static.
export function defaultListenerPosition(layout) {
  return { x: layout.cx, y: layout.listenerY };
}

// Visual constants used by the renderer. Sizes are in CSS px.
export const VISUAL = {
  liveRadius:   30,
  guitarRadius: 22,
  bassRadius:   24,
  clickRadius:  14,
  listenerRadius: 12,
};

// Role-driven color. For the 7 numbered guitars we shift hue slightly
// per voice so they read as distinct points along the arc.
export function voiceColor(part, indexAmongRole = 0) {
  switch (part.role) {
    case 'live':
      return 'hsl(15, 75%, 58%)';        // warm orange — soloist
    case 'guitar': {
      // Cool blue range, hue shifts ~30° across guitars 1..7.
      const h = 198 + indexAmongRole * 4;
      return `hsl(${h}, 55%, 56%)`;
    }
    case 'bass':
      return 'hsl(285, 38%, 36%)';        // dark plum
    case 'click':
      return 'hsl(34, 42%, 47%)';         // wood tone
    default:
      return 'hsl(0, 0%, 60%)';
  }
}

export function voiceRadius(part) {
  switch (part.role) {
    case 'live':   return VISUAL.liveRadius;
    case 'guitar': return VISUAL.guitarRadius;
    case 'bass':   return VISUAL.bassRadius;
    case 'click':  return VISUAL.clickRadius;
    default:       return VISUAL.guitarRadius;
  }
}
