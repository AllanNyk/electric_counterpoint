// stage3d.js — first-person 3D walkthrough of the half-moon stage.
//
// Renders the same voices the 2D canvas draws, but as floating colored
// spheres at ear height inside a simple boxed room. The user pilots a
// camera with pointer-lock + WASD; main.js pipes the camera pose into
// AudioEngine.setListenerPose every frame so the audio listener tracks
// head position. Voice positions in 3D mirror their 2D positions through
// stageMetersPerPx (set when entering 3D).
//
// World units = metres. World Y up, -Z forward (Three.js convention).
// 2D-canvas (x, y) maps to world (X, Z) via:
//   worldX = (canvasX - cx) * metersPerPx
//   worldZ = (canvasY - listenerY) * metersPerPx     // -Z = forward
// Voices float at VOICE_Y; player camera at PLAYER_EYE_Y.

import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  PlaneGeometry,
  SphereGeometry,
  CircleGeometry,
  MeshStandardMaterial,
  MeshBasicMaterial,
  Mesh,
  Group,
  AmbientLight,
  DirectionalLight,
  SpotLight,
  Color,
  Vector3,
  BackSide,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  LinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';

const ROOM_W = 24;          // metres, X span
const ROOM_D = 21;          // metres, Z span
const ROOM_H = 4;           // metres, ceiling height (unchanged — only widening horizontally)
const ROOM_X_MIN = -ROOM_W / 2;
const ROOM_X_MAX =  ROOM_W / 2;
const ROOM_Z_MIN = -ROOM_D * 0.75;   // farther ahead of origin
const ROOM_Z_MAX =  ROOM_D * 0.25;   // small space behind origin
const PLAYER_PAD = 0.4;     // clamp from walls
const PLAYER_EYE_Y = 1.6;
const PLAYER_RADIUS = 0.3;  // collision capsule radius (treated cylindrical)
const VOICE_Y = 1.45;
const VOICE_RADIUS = 0.28;
const FOOTPRINT_RADIUS = 0.4;
const VOICE_BUMP_MS = 220;  // visual + haptic-feel pulse on collision
const LABEL_OFFSET_Y = 0.55;       // metres above sphere centre
const LABEL_WIDTH_M = 1.1;         // sprite width in world metres
const LABEL_TEX_W = 256;           // off-screen canvas width (px)
const LABEL_TEX_H = 64;            // off-screen canvas height (px)

const INTERACT_RADIUS = 1.6;       // metres — within this, E opens the panel
const CARRY_FORWARD = 1.2;         // metres in front of camera
const CARRY_DOWN = 0.18;           // drop slightly below eye-line so you can see it
const CARRY_LERP = 0.25;           // 0..1 per-frame blend → smooths the carried position

// Idle bobbing — every voice drifts up/down by BOB_AMP_M at BOB_FREQ_HZ,
// each with a random phase offset so they don't move in lockstep. Skipped
// for the carried voice so the held one tracks the camera cleanly.
const BOB_FREQ_HZ = 0.55;
const BOB_AMP_M = 0.025;
const BOB_OMEGA = BOB_FREQ_HZ * 2 * Math.PI;

const WALK_SPEED = 3.0;     // m/s
const RUN_SPEED  = 5.0;     // m/s (shift)
const MOUSE_SENS = 0.0022;  // radians per pixel
const PITCH_LIMIT = Math.PI * 0.49;

export class Stage3D {
  constructor(canvas, promptEl, hintEl) {
    this.canvas = canvas;
    this.promptEl = promptEl;        // "click to look around" overlay
    this.hintEl = hintEl;             // in-world action hint ("Press E to …")
    this.active = false;
    this.onUpdate = null;             // (pose) => void; called once per frame
    this.onInteract = null;           // (voiceId) => void; E pressed near a voice
    this.onDrop = null;               // (voiceId, worldX, worldZ) => void; E pressed while carrying
    this.metersPerPx = 1;             // set in enter()

    // Interaction state.
    this._nearVoiceId = null;
    this._carriedVoiceId = null;
    this._carryTarget = new Vector3(); // smoothed target so picked-up voice doesn't snap

    this.scene = new Scene();
    this.scene.background = new Color('#06060a');

    this.camera = new PerspectiveCamera(70, 1, 0.05, 100);
    this.camera.position.set(0, PLAYER_EYE_Y, 0);

    this.renderer = new WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    this._buildRoom();
    this._buildLights();

    // Voice meshes live in a group so we can clear them on rebuild.
    this.voiceGroup = new Group();
    this.scene.add(this.voiceGroup);
    this.voiceMeshes = new Map();   // id -> { mesh, baseColor, pulseIntensity }

    this.footprint = null;          // marker for the original 2D listener spot

    // Input state.
    this.yaw = 0;       // facing -Z when 0
    this.pitch = 0;
    this.keys = new Set();
    this._locked = false;
    this._rafHandle = null;
    this._lastFrame = 0;

    // Bind handlers so add/remove can pair up.
    this._onClick = this._onClick.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._tick = this._tick.bind(this);
  }

  _buildRoom() {
    const cz = (ROOM_Z_MIN + ROOM_Z_MAX) / 2;

    // Floor — wood planks running along the X axis. PLANK_W in metres
    // sets the visual scale; repeat counts derive from the room dims.
    const PLANK_TILE_W_M = 4;     // texture covers 4 m of plank width
    const PLANK_TILE_D_M = 1;     // 1 m of depth (= one plank's length unit)
    const floorTex = makePlankTexture();
    floorTex.wrapS = floorTex.wrapT = RepeatWrapping;
    floorTex.repeat.set(ROOM_W / PLANK_TILE_W_M, ROOM_D / PLANK_TILE_D_M);
    floorTex.colorSpace = SRGBColorSpace;
    const floorMat = new MeshStandardMaterial({
      map: floorTex,
      roughness: 0.85,
      metalness: 0.05,
    });
    const floor = new Mesh(new PlaneGeometry(ROOM_W, ROOM_D), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, cz);
    this.scene.add(floor);

    // Stage half-disc — slightly lighter, warmer wood under where the
    // voices sit so the half-moon reads visibly even in low light.
    const stageTex = makePlankTexture(0.18);  // brighter tone
    stageTex.wrapS = stageTex.wrapT = RepeatWrapping;
    stageTex.repeat.set(2.5, 2.5);
    stageTex.colorSpace = SRGBColorSpace;
    const stageMark = new Mesh(
      new CircleGeometry(7.5, 64, Math.PI, Math.PI),
      new MeshStandardMaterial({ map: stageTex, roughness: 0.7, metalness: 0.05 })
    );
    stageMark.rotation.x = -Math.PI / 2;
    stageMark.position.set(0, 0.005, 0);
    this.scene.add(stageMark);

    // Walls — vertical paneling. Repeat sized per wall length.
    const PANEL_TILE_W_M = 2;     // texture covers 2 m of wall length
    const wallTex = makePanelTexture();
    wallTex.wrapS = wallTex.wrapT = RepeatWrapping;
    wallTex.colorSpace = SRGBColorSpace;
    const wallMatWide = new MeshStandardMaterial({
      map: cloneTexture(wallTex, ROOM_W / PANEL_TILE_W_M, 1),
      roughness: 0.95,
      metalness: 0.0,
      side: BackSide,
    });
    const wallMatDeep = new MeshStandardMaterial({
      map: cloneTexture(wallTex, ROOM_D / PANEL_TILE_W_M, 1),
      roughness: 0.95,
      metalness: 0.0,
      side: BackSide,
    });

    const front = new Mesh(new PlaneGeometry(ROOM_W, ROOM_H), wallMatWide);
    front.position.set(0, ROOM_H / 2, ROOM_Z_MIN);
    front.rotation.y = Math.PI;
    this.scene.add(front);

    const back = new Mesh(new PlaneGeometry(ROOM_W, ROOM_H), wallMatWide);
    back.position.set(0, ROOM_H / 2, ROOM_Z_MAX);
    this.scene.add(back);

    const left = new Mesh(new PlaneGeometry(ROOM_D, ROOM_H), wallMatDeep);
    left.position.set(ROOM_X_MIN, ROOM_H / 2, cz);
    left.rotation.y = Math.PI / 2;
    this.scene.add(left);

    const right = new Mesh(new PlaneGeometry(ROOM_D, ROOM_H), wallMatDeep);
    right.position.set(ROOM_X_MAX, ROOM_H / 2, cz);
    right.rotation.y = -Math.PI / 2;
    this.scene.add(right);

    // Ceiling — flat plane, dark, with a gentle vignette toward the edges
    // (rendered straight onto the texture). Closes the room visually so
    // it stops feeling like an outdoor box.
    const ceilTex = makeCeilingTexture();
    ceilTex.colorSpace = SRGBColorSpace;
    const ceiling = new Mesh(
      new PlaneGeometry(ROOM_W, ROOM_D),
      new MeshStandardMaterial({ map: ceilTex, roughness: 1.0, metalness: 0.0 })
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(0, ROOM_H, cz);
    this.scene.add(ceiling);

    // Skirting trim — a thin lighter strip along each wall at floor level.
    // Subtle but it kills the "infinite black" feel where wall meets floor.
    const trimMat = new MeshBasicMaterial({ color: 0x2a2a32 });
    const trimH = 0.08;
    const trimY = trimH / 2;
    const trimFront = new Mesh(new PlaneGeometry(ROOM_W, trimH), trimMat);
    trimFront.position.set(0, trimY, ROOM_Z_MIN + 0.001);
    this.scene.add(trimFront);
    const trimBack = new Mesh(new PlaneGeometry(ROOM_W, trimH), trimMat);
    trimBack.position.set(0, trimY, ROOM_Z_MAX - 0.001);
    trimBack.rotation.y = Math.PI;
    this.scene.add(trimBack);
    const trimLeft = new Mesh(new PlaneGeometry(ROOM_D, trimH), trimMat);
    trimLeft.position.set(ROOM_X_MIN + 0.001, trimY, cz);
    trimLeft.rotation.y = Math.PI / 2;
    this.scene.add(trimLeft);
    const trimRight = new Mesh(new PlaneGeometry(ROOM_D, trimH), trimMat);
    trimRight.position.set(ROOM_X_MAX - 0.001, trimY, cz);
    trimRight.rotation.y = -Math.PI / 2;
    this.scene.add(trimRight);
  }

  _buildLights() {
    // Low ambient — most of the colour comes from the spot.
    this.scene.add(new AmbientLight(0xffffff, 0.18));

    // Warm key from above, slightly to camera-right of the stage.
    const key = new DirectionalLight(0xffe0bd, 0.55);
    key.position.set(2.5, 6, 1.5);
    this.scene.add(key);

    // Cool fill from behind so the listener side isn't pure shadow.
    const fill = new DirectionalLight(0x8aa0c8, 0.22);
    fill.position.set(-3, 4, 2);
    this.scene.add(fill);

    // Stage spot — pools warm light over the half-moon, mimicking the
    // 2D stage's radial gradient. Penumbra softens the edge.
    const spot = new SpotLight(0xffd2a0, 1.6, 20, Math.PI / 4, 0.55, 1.2);
    spot.position.set(0, ROOM_H - 0.2, -1.5);
    spot.target.position.set(0, 0, -4);
    this.scene.add(spot);
    this.scene.add(spot.target);
  }

  // Replace the voice set. Called whenever the active movement's voices
  // are known. Voice positions follow afterwards via syncVoicePositions.
  setVoices(voiceList) {
    // Clear old meshes + labels.
    for (const entry of this.voiceMeshes.values()) {
      this.voiceGroup.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      if (entry.label) {
        this.voiceGroup.remove(entry.label);
        entry.label.material.map?.dispose();
        entry.label.material.dispose();
      }
    }
    this.voiceMeshes.clear();

    for (const v of voiceList) {
      const baseColor = new Color(v.color);
      const mat = new MeshStandardMaterial({
        color: baseColor,
        roughness: 0.45,
        metalness: 0.1,
        emissive: baseColor.clone().multiplyScalar(0.15),
      });
      const mesh = new Mesh(new SphereGeometry(VOICE_RADIUS, 24, 16), mat);
      mesh.position.set(0, VOICE_Y, 0);
      this.voiceGroup.add(mesh);

      const label = v.label ? this._buildLabelSprite(v.label) : null;
      if (label) this.voiceGroup.add(label);

      this.voiceMeshes.set(v.id, {
        mesh, label, labelText: v.label || v.id,
        baseColor, pulseIntensity: 0, bumpUntil: 0,
        bobPhase: Math.random() * Math.PI * 2,
      });
    }
  }

  // Off-screen canvas → CanvasTexture → Sprite. Sprite always faces the
  // camera, so labels stay readable from any angle without per-frame work
  // on our side.
  _buildLabelSprite(text) {
    const c = document.createElement('canvas');
    c.width = LABEL_TEX_W;
    c.height = LABEL_TEX_H;
    const cx2d = c.getContext('2d');
    cx2d.clearRect(0, 0, c.width, c.height);
    cx2d.font = '600 36px ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';
    cx2d.textAlign = 'center';
    cx2d.textBaseline = 'middle';
    // Dark stroke + bright fill keeps the label legible against any
    // sphere color or against the dark background.
    cx2d.lineWidth = 6;
    cx2d.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    cx2d.strokeText(text, c.width / 2, c.height / 2);
    cx2d.fillStyle = '#f3f3f5';
    cx2d.fillText(text, c.width / 2, c.height / 2);

    const tex = new CanvasTexture(c);
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.needsUpdate = true;

    const mat = new SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    const sprite = new Sprite(mat);
    const aspect = LABEL_TEX_W / LABEL_TEX_H;
    sprite.scale.set(LABEL_WIDTH_M, LABEL_WIDTH_M / aspect, 1);
    return sprite;
  }

  // Reposition every voice using its current 2D-canvas (x, y) and the
  // layout (cx, listenerY) we anchor against. metersPerPx is the constant
  // we picked when entering 3D mode.
  syncVoicePositions(voices, layout) {
    const { cx, listenerY } = layout;
    for (const v of voices) {
      const entry = this.voiceMeshes.get(v.id);
      if (!entry) continue;
      const wx = (v.x - cx) * this.metersPerPx;
      const wz = (v.y - listenerY) * this.metersPerPx;   // canvas Y down → world Z forward (negative for "ahead")
      entry.mesh.position.set(wx, VOICE_Y, wz);
      if (entry.label) {
        entry.label.position.set(wx, VOICE_Y + LABEL_OFFSET_Y, wz);
      }
    }
  }

  // Convert a 2D canvas (x, y) point to world (X, Z) using the same scale.
  canvasToWorld(canvasX, canvasY, layout) {
    return {
      x: (canvasX - layout.cx) * this.metersPerPx,
      z: (canvasY - layout.listenerY) * this.metersPerPx,
    };
  }

  // Mark the original 2D listener-dot position with a faint disc on the
  // floor so the user can find their way back. Called once on enter.
  setFootprint(canvasX, canvasY, layout) {
    if (this.footprint) {
      this.scene.remove(this.footprint);
      this.footprint.geometry.dispose();
      this.footprint.material.dispose();
      this.footprint = null;
    }
    const w = this.canvasToWorld(canvasX, canvasY, layout);
    const ring = new Mesh(
      new CircleGeometry(FOOTPRINT_RADIUS, 32),
      new MeshBasicMaterial({ color: 0xd96b3a, transparent: true, opacity: 0.35 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(w.x, 0.01, w.z);
    this.scene.add(ring);
    this.footprint = ring;
  }

  // Set per-voice instantaneous pulse intensity (0..1). Caller updates
  // this every frame from Voice.pulseIntensity; we just translate it to
  // emissive material brightness.
  setVoicePulse(id, intensity) {
    const entry = this.voiceMeshes.get(id);
    if (!entry) return;
    entry.pulseIntensity = Math.max(0, Math.min(1, intensity));
  }

  // Enter 3D mode. layout, listenerCanvasPos, voices come from main.js.
  // metersPerPxOverride lets the caller pick the canvas→world scale up
  // front (so audio + visuals agree); defaults to a reasonable choice.
  enter({ layout, listenerCanvasPos, voices, metersPerPx }) {
    if (this.active) return;
    this.active = true;
    this.metersPerPx = metersPerPx;

    // Spawn the player at the 2D listener-dot position.
    const start = this.canvasToWorld(listenerCanvasPos.x, listenerCanvasPos.y, layout);
    this.camera.position.set(start.x, PLAYER_EYE_Y, start.z);
    this.yaw = 0;       // face -Z (toward stage front)
    this.pitch = 0;
    this._applyCameraOrientation();

    this.setFootprint(listenerCanvasPos.x, listenerCanvasPos.y, layout);
    this.setVoices(voices);
    this.syncVoicePositions(voices, layout);

    this.canvas.addEventListener('click', this._onClick);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);

    this.resize();
    this.promptEl.hidden = false;

    this._lastFrame = performance.now();
    this._rafHandle = requestAnimationFrame(this._tick);
  }

  exit() {
    if (!this.active) return;
    this.active = false;

    if (document.pointerLockElement === this.canvas) {
      document.exitPointerLock();
    }
    if (this._rafHandle) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }

    this.canvas.removeEventListener('click', this._onClick);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.keys.clear();

    if (this.promptEl) this.promptEl.hidden = true;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // Where the player ended up, in 2D canvas coordinates — so 2D mode can
  // snap the listener dot to that spot when we exit.
  getPlayerCanvasPos(layout) {
    return {
      x: layout.cx + this.camera.position.x / this.metersPerPx,
      y: layout.listenerY + this.camera.position.z / this.metersPerPx,
    };
  }

  // Camera pose → AudioEngine.setListenerPose. Forward + up vectors are
  // unit vectors in world space.
  getCameraPose() {
    const fwd = new Vector3();
    this.camera.getWorldDirection(fwd);
    const up = this.camera.up;     // (0, 1, 0)
    const p = this.camera.position;
    return {
      x: p.x, y: p.y, z: p.z,
      fwdX: fwd.x, fwdY: fwd.y, fwdZ: fwd.z,
      upX: up.x, upY: up.y, upZ: up.z,
    };
  }

  // ---- internals ----

  _onClick() {
    if (this._locked) return;
    // Don't re-engage pointer lock while an overlay (voice panel, modal)
    // is up — user may be trying to interact with it, not the canvas.
    if (this._overlayActive) return;
    this.canvas.requestPointerLock?.();
  }

  _onPointerLockChange() {
    this._locked = (document.pointerLockElement === this.canvas);
    if (this._locked) {
      document.addEventListener('mousemove', this._onMouseMove);
      this.promptEl.hidden = true;
    } else {
      document.removeEventListener('mousemove', this._onMouseMove);
      // Release any held movement keys when lock drops, otherwise the
      // player would keep gliding while the user clicked away.
      this.keys.clear();
      if (this.active && !this._overlayActive) this.promptEl.hidden = false;
    }
    this._refreshHint();
  }

  _onMouseMove(e) {
    if (!this._locked) return;
    this.yaw   -= e.movementX * MOUSE_SENS;
    this.pitch -= e.movementY * MOUSE_SENS;
    if (this.pitch >  PITCH_LIMIT) this.pitch =  PITCH_LIMIT;
    if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
    this._applyCameraOrientation();
  }

  _onKeyDown(e) {
    if (!this._locked) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'shift'].includes(k)) {
      this.keys.add(k);
      e.preventDefault();
    } else if (k === 'e') {
      e.preventDefault();
      if (this._carriedVoiceId) {
        // Drop at current carried-mesh position.
        const entry = this.voiceMeshes.get(this._carriedVoiceId);
        if (entry && this.onDrop) {
          this.onDrop(this._carriedVoiceId, entry.mesh.position.x, entry.mesh.position.z);
        }
        this._carriedVoiceId = null;
        this._refreshHint();
      } else if (this._nearVoiceId && this.onInteract) {
        this.onInteract(this._nearVoiceId);
      }
    }
  }

  // Begin / end carry. main.js calls startCarry when the user clicks
  // "Move" in the panel; stopCarry is called from _onKeyDown when E
  // drops, or externally when the player exits 3D mode.
  startCarry(voiceId) {
    if (!this.voiceMeshes.has(voiceId)) return;
    this._carriedVoiceId = voiceId;
    // Seed the smoothed target at the voice's current spot so the first
    // frame doesn't snap it to the player.
    const entry = this.voiceMeshes.get(voiceId);
    this._carryTarget.copy(entry.mesh.position);
    this._refreshHint();
  }

  stopCarry() {
    if (!this._carriedVoiceId) return null;
    const id = this._carriedVoiceId;
    const entry = this.voiceMeshes.get(id);
    const pos = entry ? { x: entry.mesh.position.x, z: entry.mesh.position.z } : null;
    this._carriedVoiceId = null;
    this._refreshHint();
    return pos ? { id, ...pos } : null;
  }

  isCarrying() { return this._carriedVoiceId != null; }
  carriedVoiceId() { return this._carriedVoiceId; }

  // Read a voice mesh's current world position (used by main.js to keep
  // the audio panner + 2D state in sync with the visual mesh during carry).
  getVoiceWorldPos(id) {
    const entry = this.voiceMeshes.get(id);
    if (!entry) return null;
    const p = entry.mesh.position;
    return { x: p.x, y: p.y, z: p.z };
  }

  // External "I'm using HTML overlays right now, hush" toggle. Used by
  // main.js to suppress the click-to-lock prompt + interact hint while
  // the voice panel is open.
  setOverlayActive(on) {
    this._overlayActive = on;
    if (on) {
      if (this.promptEl) this.promptEl.hidden = true;
      if (this.hintEl) this.hintEl.hidden = true;
    } else {
      // Let the next _refreshHint / pointerlockchange repaint correctly.
      this._refreshHint();
      if (!this._locked && this.active) this.promptEl.hidden = false;
    }
  }

  _refreshHint() {
    if (!this.hintEl) return;
    if (this._overlayActive || !this.active || !this._locked) {
      this.hintEl.hidden = true;
      return;
    }
    let text = null;
    if (this._carriedVoiceId) {
      const label = this._labelFor(this._carriedVoiceId);
      text = `carrying ${label} — <kbd>E</kbd> to drop`;
    } else if (this._nearVoiceId) {
      const label = this._labelFor(this._nearVoiceId);
      text = `<kbd>E</kbd> · interact with ${label}`;
    }
    const pill = this.hintEl.querySelector('.hint-pill');
    if (text == null) {
      this.hintEl.hidden = true;
    } else {
      pill.innerHTML = text;
      this.hintEl.hidden = false;
    }
  }

  _labelFor(voiceId) {
    const entry = this.voiceMeshes.get(voiceId);
    return entry?.labelText || voiceId;
  }

  _onKeyUp(e) {
    const k = e.key.toLowerCase();
    this.keys.delete(k);
  }

  _applyCameraOrientation() {
    // Rotation order matters: yaw around Y first, then pitch around X.
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = 0;
  }

  _disposeProceduralTextures() {
    // For future: walk scene and dispose CanvasTexture instances + their
    // .source.data canvases. Not currently needed (Stage3D persists for
    // the lifetime of the page) but worth a stub if we ever rebuild.
  }

  _tick(tNow) {
    if (!this.active) return;
    const dt = Math.min(0.05, (tNow - this._lastFrame) / 1000);
    this._lastFrame = tNow;

    // Movement (only when locked). Forward = horizontal projection of
    // the camera's facing direction so looking up/down doesn't fly the
    // player off the floor.
    if (this._locked) {
      const speed = this.keys.has('shift') ? RUN_SPEED : WALK_SPEED;
      const fwdX = -Math.sin(this.yaw);
      const fwdZ = -Math.cos(this.yaw);
      const rightX =  Math.cos(this.yaw);
      const rightZ = -Math.sin(this.yaw);
      let mx = 0, mz = 0;
      if (this.keys.has('w')) { mx += fwdX; mz += fwdZ; }
      if (this.keys.has('s')) { mx -= fwdX; mz -= fwdZ; }
      if (this.keys.has('d')) { mx += rightX; mz += rightZ; }
      if (this.keys.has('a')) { mx -= rightX; mz -= rightZ; }
      const mag = Math.hypot(mx, mz);
      if (mag > 0) {
        mx /= mag; mz /= mag;
        const p = this.camera.position;
        let nx = p.x + mx * speed * dt;
        let nz = p.z + mz * speed * dt;
        // Wall clamp.
        if (nx < ROOM_X_MIN + PLAYER_PAD) nx = ROOM_X_MIN + PLAYER_PAD;
        if (nx > ROOM_X_MAX - PLAYER_PAD) nx = ROOM_X_MAX - PLAYER_PAD;
        if (nz < ROOM_Z_MIN + PLAYER_PAD) nz = ROOM_Z_MIN + PLAYER_PAD;
        if (nz > ROOM_Z_MAX - PLAYER_PAD) nz = ROOM_Z_MAX - PLAYER_PAD;
        // Voice collision (treat each voice as a vertical cylinder; we
        // ignore Y because the player walks on the floor and voices float
        // at ear height — a 2D circle test is enough). Push the player
        // out radially. A short bump pulse highlights the contacted voice.
        // The carried voice (if any) is excluded — otherwise the player
        // would be shoved away from the thing they're holding.
        const minSep = PLAYER_RADIUS + VOICE_RADIUS;
        for (const [id, entry] of this.voiceMeshes) {
          if (id === this._carriedVoiceId) continue;
          const vx = entry.mesh.position.x;
          const vz = entry.mesh.position.z;
          const dx = nx - vx;
          const dz = nz - vz;
          const d = Math.hypot(dx, dz);
          if (d < minSep && d > 0) {
            const k = minSep / d;
            nx = vx + dx * k;
            nz = vz + dz * k;
            entry.bumpUntil = tNow + VOICE_BUMP_MS;
          } else if (d === 0) {
            // Player exactly on top — push along +X arbitrarily.
            nx = vx + minSep;
            entry.bumpUntil = tNow + VOICE_BUMP_MS;
          }
        }
        p.x = nx; p.z = nz;
      }
    }

    // Carry: pin the held voice to a point in front of the camera, with
    // a short lerp so the motion doesn't feel rigidly stuck. Clamp to
    // room bounds so you can't push it through a wall.
    if (this._carriedVoiceId) {
      const entry = this.voiceMeshes.get(this._carriedVoiceId);
      if (entry) {
        const fwdX = -Math.sin(this.yaw);
        const fwdZ = -Math.cos(this.yaw);
        let tx = this.camera.position.x + fwdX * CARRY_FORWARD;
        let tz = this.camera.position.z + fwdZ * CARRY_FORWARD;
        const ty = this.camera.position.y - CARRY_DOWN;
        if (tx < ROOM_X_MIN + PLAYER_PAD) tx = ROOM_X_MIN + PLAYER_PAD;
        if (tx > ROOM_X_MAX - PLAYER_PAD) tx = ROOM_X_MAX - PLAYER_PAD;
        if (tz < ROOM_Z_MIN + PLAYER_PAD) tz = ROOM_Z_MIN + PLAYER_PAD;
        if (tz > ROOM_Z_MAX - PLAYER_PAD) tz = ROOM_Z_MAX - PLAYER_PAD;
        this._carryTarget.set(tx, ty, tz);
        entry.mesh.position.lerp(this._carryTarget, CARRY_LERP);
        if (entry.label) {
          entry.label.position.set(
            entry.mesh.position.x,
            entry.mesh.position.y + LABEL_OFFSET_Y,
            entry.mesh.position.z
          );
        }
      }
    }

    // Idle bob — sinusoidal Y offset per voice (skipping the carried one,
    // whose Y is driven by the camera). Phase is randomised per voice so
    // the half-moon visibly breathes rather than rising and falling in
    // unison. Label tracks the sphere so the text doesn't detach.
    const tSec = tNow / 1000;
    for (const [id, entry] of this.voiceMeshes) {
      if (id === this._carriedVoiceId) continue;
      const bobY = Math.sin(tSec * BOB_OMEGA + entry.bobPhase) * BOB_AMP_M;
      entry.mesh.position.y = VOICE_Y + bobY;
      if (entry.label) entry.label.position.y = VOICE_Y + LABEL_OFFSET_Y + bobY;
    }

    // Proximity check → drive interact prompt. Skip while carrying since
    // the hint is already showing the drop instruction.
    if (!this._carriedVoiceId) {
      const cam = this.camera.position;
      let nearestId = null;
      let nearestD = INTERACT_RADIUS;
      for (const [id, entry] of this.voiceMeshes) {
        const dx = entry.mesh.position.x - cam.x;
        const dz = entry.mesh.position.z - cam.z;
        const d = Math.hypot(dx, dz);
        if (d < nearestD) { nearestD = d; nearestId = id; }
      }
      if (nearestId !== this._nearVoiceId) {
        this._nearVoiceId = nearestId;
        this._refreshHint();
      }
    }

    // Translate the latest per-voice pulse intensity (note onset, set
    // each frame from main.js) AND the collision bump (set above when
    // the player ran into the sphere) into emissive brightness. Either
    // can drive a glow; whichever is brighter wins.
    for (const entry of this.voiceMeshes.values()) {
      const bumpRemain = entry.bumpUntil - tNow;
      const bumpK = bumpRemain > 0 ? Math.min(1, bumpRemain / VOICE_BUMP_MS) : 0;
      const k = Math.max(entry.pulseIntensity, bumpK);
      const e = 0.15 + 0.55 * k;
      entry.mesh.material.emissive.copy(entry.baseColor).multiplyScalar(e);
    }

    if (this.onUpdate) this.onUpdate(this.getCameraPose());

    this.renderer.render(this.scene, this.camera);
    this._rafHandle = requestAnimationFrame(this._tick);
  }
}

// ---- procedural textures ----
//
// All built once at scene-construction time onto off-screen canvases,
// uploaded as CanvasTexture, then tiled across surfaces via RepeatWrapping.
// Procedural lets us avoid shipping image assets; the visual identity is
// just "warm wood floor, dark paneled walls, dim theatre overhead."

// Wood-plank floor texture. `lighten` (0..1) brightens the base tone for
// the stage half-disc so it pools visibly under the voices.
function makePlankTexture(lighten = 0) {
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.fillStyle = '#0d0a08';
  cx.fillRect(0, 0, W, H);
  const PLANKS = 4;
  const plankH = H / PLANKS;
  for (let p = 0; p < PLANKS; p++) {
    const y = p * plankH;
    // Vary tone per plank for natural-wood feel.
    const baseL = 22 + Math.random() * 16 + lighten * 18;
    const hue   = 24 + Math.random() * 10;
    const sat   = 22 + Math.random() * 8;
    cx.fillStyle = `hsl(${hue}, ${sat}%, ${baseL}%)`;
    cx.fillRect(0, y, W, plankH);

    // Vertical grain — narrow darker streaks.
    for (let i = 0; i < 90; i++) {
      const gx = Math.random() * W;
      const a = 0.04 + Math.random() * 0.10;
      cx.fillStyle = `rgba(0, 0, 0, ${a})`;
      cx.fillRect(gx, y, 1 + Math.random() * 2, plankH);
    }
    // Faint long highlights.
    for (let i = 0; i < 20; i++) {
      const gx = Math.random() * W;
      cx.fillStyle = `rgba(255, 240, 220, ${0.03 + Math.random() * 0.04})`;
      cx.fillRect(gx, y, 1, plankH);
    }
    // Dark seam at the top edge of every plank — sells the joint.
    cx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    cx.fillRect(0, y, W, 1);

    // Occasional knot.
    if (Math.random() < 0.35) {
      const kx = Math.random() * W;
      const ky = y + plankH * (0.25 + Math.random() * 0.5);
      const rad = 4 + Math.random() * 8;
      const grad = cx.createRadialGradient(kx, ky, 0, kx, ky, rad);
      grad.addColorStop(0, 'rgba(15, 8, 4, 0.85)');
      grad.addColorStop(1, 'rgba(15, 8, 4, 0)');
      cx.fillStyle = grad;
      cx.beginPath();
      cx.arc(kx, ky, rad, 0, Math.PI * 2);
      cx.fill();
    }
  }
  // Final dark seam at the bottom edge for tiling continuity.
  cx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  cx.fillRect(0, H - 1, W, 1);
  return new CanvasTexture(c);
}

// Vertical-panel wall texture — dim charcoal with thin highlights along
// each panel's left edge and dark seams between them.
function makePanelTexture() {
  const W = 256, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const cx = c.getContext('2d');
  cx.fillStyle = '#15151c';
  cx.fillRect(0, 0, W, H);

  const PANELS = 4;
  const panelW = W / PANELS;
  for (let p = 0; p < PANELS; p++) {
    const x = p * panelW;
    // Subtle horizontal sheen across each panel — slight gradient.
    const g = cx.createLinearGradient(x, 0, x + panelW, 0);
    g.addColorStop(0.0, 'rgba(255, 245, 230, 0.05)');
    g.addColorStop(0.4, 'rgba(255, 245, 230, 0.0)');
    g.addColorStop(1.0, 'rgba(0, 0, 0, 0.18)');
    cx.fillStyle = g;
    cx.fillRect(x, 0, panelW, H);

    // Sparse vertical streaks for noise.
    for (let i = 0; i < 8; i++) {
      const sx = x + Math.random() * panelW;
      cx.fillStyle = `rgba(0, 0, 0, ${0.04 + Math.random() * 0.06})`;
      cx.fillRect(sx, 0, 1, H);
    }

    // Panel seam (dark line at left edge).
    cx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    cx.fillRect(x, 0, 1, H);
  }
  // Tiling continuity at the right edge.
  cx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  cx.fillRect(W - 1, 0, 1, H);
  return new CanvasTexture(c);
}

// Ceiling — radial vignette darker toward the corners. Single tile, no
// repeat (so the vignette covers the whole room evenly).
function makeCeilingTexture() {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const cx = c.getContext('2d');
  const grad = cx.createRadialGradient(S / 2, S / 2, S * 0.05, S / 2, S / 2, S * 0.7);
  grad.addColorStop(0, '#1a1a22');
  grad.addColorStop(1, '#070708');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, S, S);
  // A few faint specks → suggestion of overhead rigging / dust.
  for (let i = 0; i < 30; i++) {
    cx.fillStyle = `rgba(255, 230, 200, ${0.04 + Math.random() * 0.05})`;
    const x = Math.random() * S, y = Math.random() * S;
    cx.fillRect(x, y, 1, 1);
  }
  return new CanvasTexture(c);
}

// Clone a CanvasTexture sharing the same source canvas but with its own
// repeat / wrap settings. (Three.js .clone() handles this for us — we
// just set the repeat afterwards.)
function cloneTexture(src, repeatX, repeatY) {
  const t = src.clone();
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.needsUpdate = true;
  return t;
}
