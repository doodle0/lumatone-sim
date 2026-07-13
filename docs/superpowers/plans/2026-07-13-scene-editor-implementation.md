# Scene Editor & Video Scene Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a scene editor page where the user authors MIDI-driven "scenes" (scripted camera pans/zooms + mode-window changes on a timeline, static per-channel ADSR/waveform), and renders each scene to a local WebM file for use in educational microtonal-scale videos.

**Architecture:** A new Vite entry point (`scene-editor.html` / `src/sceneEditor.ts`) reuses the existing `audioEngine`, `renderer`, `hexGrid`, `tuningEngine`, `spiralFifths`, `midiInput`, and `recordingEngine` modules, adding a camera view-transform layer, a MIDI file parser, a scene JSON schema, and a scene-playback orchestrator. The interactive performance page (`index.html` / `main.ts`) is left functionally unchanged except for one error-handling fix.

**Tech Stack:** TypeScript + Vite (existing), Web Audio API, Canvas 2D / OffscreenCanvas, `MediaRecorder` (existing, via `recordingEngine.ts`), `@tonejs/midi` (new dependency, added this plan).

Full design reference: `docs/superpowers/specs/2026-07-13-scene-editor-design.md`.

## Global Constraints

- Project uses the factory-function pattern throughout — no classes (see CLAUDE.md).
- Zero external runtime dependencies, with one deliberate, spec-approved exception: `@tonejs/midi` for MIDI file parsing.
- No test framework exists in this project — verification is manual (dev server + browser devtools console + `pnpm build` typecheck), per the design spec's Testing section. Do not introduce a test framework as a side effect of this work.
- One scene = one MIDI file + one keyframe timeline = one rendered output file.
- Mode keyframes affect only `modeOffset`; EDO/tuning is fixed per scene (`scene.tuning.edo`).
- Camera keyframes use hold-then-ease semantics: hold at the previous value until `duration` seconds before the keyframe's `t`, then ease in, arriving exactly at `t`. `easing` ∈ `"linear" | "easeIn" | "easeOut" | "easeInOut"`, default `"easeInOut"`.
- Per-channel ADSR/waveform is static for the whole scene (not keyframable).
- Camera state `{q, r, zoom}` is the single source of truth for the renderer's view transform.
- Rendering is fully automatic: load scene + MIDI → click Render → plays start-to-finish while recording → auto-downloads WebM when done. No manual start/stop during playback.
- The scene editor lives on a separate page/entry point from the interactive performance page (`main.ts` is not modified except for the Task 11 error-handling fix).

---

### Task 1: MIDI file parsing (`src/midiFile.ts`)

**Files:**
- Modify: `package.json` (add `@tonejs/midi` dependency)
- Create: `src/midiFile.ts`

**Interfaces:**
- Produces: `MidiEvent { tAbs: number; channel: number; midiNote: number; velocity: number; type: 'on' | 'off' }`, `parseMidiFile(buffer: ArrayBuffer): MidiEvent[]`, `midiDuration(events: readonly MidiEvent[]): number`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm add @tonejs/midi
```

- [ ] **Step 2: Write `src/midiFile.ts`**

```ts
// Parses a Standard MIDI File into a flat, time-sorted list of note on/off events.
// Uses @tonejs/midi (this project's one deliberate external runtime dependency)
// because it resolves tempo-map timing to absolute seconds for us.

import { Midi } from '@tonejs/midi';

export interface MidiEvent {
  tAbs: number;    // seconds from the start of the file
  channel: number;
  midiNote: number;
  velocity: number; // 0-127; 0 for 'off' events
  type: 'on' | 'off';
}

export function parseMidiFile(buffer: ArrayBuffer): MidiEvent[] {
  const midi = new Midi(buffer);
  const events: MidiEvent[] = [];

  for (const track of midi.tracks) {
    for (const note of track.notes) {
      events.push({
        tAbs: note.time,
        channel: track.channel,
        midiNote: note.midi,
        velocity: Math.round(note.velocity * 127),
        type: 'on',
      });
      events.push({
        tAbs: note.time + note.duration,
        channel: track.channel,
        midiNote: note.midi,
        velocity: 0,
        type: 'off',
      });
    }
  }

  events.sort((a, b) => a.tAbs - b.tAbs);
  return events;
}

/** Time of the last event, in seconds. 0 for an empty event list. */
export function midiDuration(events: readonly MidiEvent[]): number {
  return events.length === 0 ? 0 : events[events.length - 1]!.tAbs;
}
```

- [ ] **Step 3: Verify by round-tripping a synthetic MIDI file**

Run `pnpm dev`, open `http://localhost:5173` in a browser, open devtools console, and run:

```js
const { Midi } = await import('@tonejs/midi');
const midi = new Midi();
const track = midi.addTrack();
track.channel = 0;
track.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 });
track.addNote({ midi: 64, time: 1, duration: 0.5, velocity: 0.8 });
const { parseMidiFile, midiDuration } = await import('/src/midiFile.ts');
const events = parseMidiFile(midi.toArray().buffer);
console.log(events);
console.log(midiDuration(events));
```

Expected: `events` is a 4-entry array sorted by `tAbs`: `on` at `0` (note 60), `off` at `0.5` (note 60), `on` at `1` (note 64), `off` at `1.5` (note 64). `midiDuration(events)` logs `1.5`.

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/midiFile.ts
git commit -m "feat: add MIDI file parsing via @tonejs/midi"
```

---

### Task 2: Camera keyframe interpolation (`src/camera.ts`)

**Files:**
- Create: `src/camera.ts`

**Interfaces:**
- Produces: `CameraState { q: number; r: number; zoom: number }`, `Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'`, `CameraKeyframe { t: number; q: number; r: number; zoom: number; duration?: number; easing?: Easing }`, `DEFAULT_CAMERA: CameraState`, `interpolateCamera(keyframes: readonly CameraKeyframe[], t: number): CameraState`.

- [ ] **Step 1: Write `src/camera.ts`**

```ts
// Scripted camera for scene playback: hold-then-ease keyframes over (q, r, zoom).
// The camera holds at the previous keyframe's value until `duration` seconds
// before the next keyframe's `t`, then eases in, arriving exactly at `t`.

export interface CameraState {
  q: number;
  r: number;
  zoom: number;
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface CameraKeyframe {
  t: number;
  q: number;
  r: number;
  zoom: number;
  /** Seconds; the transition into this keyframe, ending at `t`. Ignored on the first keyframe. */
  duration?: number;
  easing?: Easing;
}

export const DEFAULT_CAMERA: CameraState = { q: 0, r: 0, zoom: 1 };

function ease(progress: number, kind: Easing): number {
  switch (kind) {
    case 'linear':    return progress;
    case 'easeIn':    return progress * progress;
    case 'easeOut':   return 1 - (1 - progress) * (1 - progress);
    case 'easeInOut': return progress < 0.5
      ? 2 * progress * progress
      : 1 - ((-2 * progress + 2) ** 2) / 2;
  }
}

function toState(kf: CameraKeyframe): CameraState {
  return { q: kf.q, r: kf.r, zoom: kf.zoom };
}

/**
 * Interpolated camera state at time `t`, given keyframes sorted ascending by `t`.
 * Before the first keyframe, returns its value. After the last, returns its value.
 */
export function interpolateCamera(keyframes: readonly CameraKeyframe[], t: number): CameraState {
  if (keyframes.length === 0) return DEFAULT_CAMERA;
  if (t <= keyframes[0]!.t) return toState(keyframes[0]!);

  for (let i = 1; i < keyframes.length; i++) {
    const kf = keyframes[i]!;
    if (t > kf.t) continue;

    const prev = toState(keyframes[i - 1]!);
    const duration = kf.duration ?? 0;
    const transitionStart = kf.t - duration;
    if (duration <= 0 || t <= transitionStart) return prev;

    const progress = ease((t - transitionStart) / duration, kf.easing ?? 'easeInOut');
    return {
      q: prev.q + (kf.q - prev.q) * progress,
      r: prev.r + (kf.r - prev.r) * progress,
      zoom: prev.zoom + (kf.zoom - prev.zoom) * progress,
    };
  }

  return toState(keyframes[keyframes.length - 1]!);
}
```

- [ ] **Step 2: Verify interpolation in the browser console**

With `pnpm dev` running, in the devtools console:

```js
const { interpolateCamera } = await import('/src/camera.ts');
const kfs = [
  { t: 0, q: 0, r: 0, zoom: 1 },
  { t: 10, q: 6, r: -2, zoom: 1.8, duration: 2, easing: 'linear' },
];
console.log(interpolateCamera(kfs, 0));  // { q: 0, r: 0, zoom: 1 }
console.log(interpolateCamera(kfs, 7));  // { q: 0, r: 0, zoom: 1 }  (before transition starts at t=8)
console.log(interpolateCamera(kfs, 9));  // { q: 3, r: -1, zoom: 1.4 }  (halfway through the 8→10 transition)
console.log(interpolateCamera(kfs, 20)); // { q: 6, r: -2, zoom: 1.8 }  (after the last keyframe)
```

Expected: outputs match the comments above.

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/camera.ts
git commit -m "feat: add camera keyframe interpolation"
```

---

### Task 3: Scene schema (`src/scene.ts`)

**Files:**
- Create: `src/scene.ts`

**Interfaces:**
- Consumes: `CameraKeyframe` from `src/camera.ts` (Task 2); `ADSR`, `WaveType` from `src/audioEngine.ts` (already exist).
- Produces: `ModeKeyframe { t: number; modeOffset: number }`, `ChannelConfig { waveform: WaveType; adsr: ADSR }`, `Scene { name; midiFile; tuning: { edo: number }; channels: Record<number, ChannelConfig>; cameraKeyframes: CameraKeyframe[]; modeKeyframes: ModeKeyframe[] }`, `DEFAULT_CHANNEL_CONFIG: ChannelConfig`, `channelConfig(scene: Scene, channel: number): ChannelConfig`, `parseScene(json: string): Scene`.

- [ ] **Step 1: Write `src/scene.ts`**

```ts
// Scene JSON schema: a MIDI-driven timeline of camera and mode-window keyframes,
// plus static per-channel instrument config. See docs/superpowers/specs/2026-07-13-scene-editor-design.md.

import type { ADSR, WaveType } from './audioEngine.ts';
import type { CameraKeyframe } from './camera.ts';

export interface ModeKeyframe {
  t: number;
  modeOffset: number;
}

export interface ChannelConfig {
  waveform: WaveType;
  adsr: ADSR;
}

export interface Scene {
  name: string;
  midiFile: string;
  tuning: { edo: number };
  channels: Record<number, ChannelConfig>;
  cameraKeyframes: CameraKeyframe[];
  modeKeyframes: ModeKeyframe[];
}

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  waveform: 'triangle',
  adsr: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.3 },
};

/** Config for a channel, falling back to the default if the scene doesn't configure it. */
export function channelConfig(scene: Scene, channel: number): ChannelConfig {
  return scene.channels[channel] ?? DEFAULT_CHANNEL_CONFIG;
}

function isValidAdsr(v: unknown): v is ADSR {
  const a = v as Partial<ADSR> | undefined;
  return !!a
    && typeof a.attack === 'number'
    && typeof a.decay === 'number'
    && typeof a.sustain === 'number'
    && typeof a.release === 'number';
}

/**
 * Parses and validates a scene JSON string. Throws with a descriptive message
 * on structurally invalid input (missing required top-level fields). Falls
 * back to DEFAULT_CHANNEL_CONFIG (with a console warning) for any per-channel
 * config that's missing or malformed, since this mainly guards hand-edited files.
 */
export function parseScene(json: string): Scene {
  const raw = JSON.parse(json) as Partial<Scene>;

  if (typeof raw.name !== 'string') throw new Error('Scene JSON missing "name" string');
  if (typeof raw.midiFile !== 'string') throw new Error('Scene JSON missing "midiFile" string');
  if (!raw.tuning || ![12, 19, 31].includes(raw.tuning.edo)) {
    throw new Error('Scene JSON "tuning.edo" must be 12, 19, or 31');
  }
  if (!Array.isArray(raw.cameraKeyframes)) throw new Error('Scene JSON missing "cameraKeyframes" array');
  if (!Array.isArray(raw.modeKeyframes)) throw new Error('Scene JSON missing "modeKeyframes" array');

  const channels: Record<number, ChannelConfig> = {};
  for (const [key, value] of Object.entries(raw.channels ?? {})) {
    const channel = Number(key);
    const v = value as Partial<ChannelConfig> | undefined;
    if (!v || typeof v.waveform !== 'string' || !isValidAdsr(v.adsr)) {
      console.warn(`Scene channel ${key}: invalid config, using default`);
      channels[channel] = DEFAULT_CHANNEL_CONFIG;
      continue;
    }
    channels[channel] = { waveform: v.waveform as WaveType, adsr: v.adsr };
  }

  return {
    name: raw.name,
    midiFile: raw.midiFile,
    tuning: { edo: raw.tuning.edo },
    channels,
    cameraKeyframes: [...raw.cameraKeyframes].sort((a, b) => a.t - b.t),
    modeKeyframes: [...raw.modeKeyframes].sort((a, b) => a.t - b.t),
  };
}
```

- [ ] **Step 2: Verify parsing and channel fallback**

With `pnpm dev` running, in the devtools console:

```js
const { parseScene, channelConfig } = await import('/src/scene.ts');
const json = JSON.stringify({
  name: 'Test', midiFile: 'test.mid', tuning: { edo: 31 },
  channels: { '0': { waveform: 'sine', adsr: { attack: 0.1, decay: 0.1, sustain: 0.5, release: 0.5 } } },
  cameraKeyframes: [{ t: 5, q: 0, r: 0, zoom: 1 }, { t: 0, q: 1, r: 1, zoom: 1 }],
  modeKeyframes: [{ t: 0, modeOffset: 0 }],
});
const scene = parseScene(json);
console.log(scene.cameraKeyframes.map(k => k.t)); // [0, 5]  (sorted)
console.log(scene.channels[0]);                    // { waveform: 'sine', adsr: {...} }
console.log(channelConfig(scene, 7));               // DEFAULT_CHANNEL_CONFIG (channel 7 not configured)
```

Expected: outputs match the comments above.

- [ ] **Step 3: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/scene.ts
git commit -m "feat: add scene JSON schema and parser"
```

---

### Task 4: Generalize `hexGrid.ts` for a pannable origin

**Files:**
- Modify: `src/hexGrid.ts:76-114`

**Interfaces:**
- Produces: `visibleKeys(canvasW: number, canvasH: number, size: number, originX?: number, originY?: number): HexKey[]` — `originX`/`originY` default to `canvasW / 2`/`canvasH / 2`, preserving current behavior for existing callers.

`hexCenter` and `hexVertices` already accept an arbitrary origin and need no changes. Only `visibleKeys` hardcodes the origin internally — this task turns that into an optional parameter.

- [ ] **Step 1: Edit `visibleKeys`**

In `src/hexGrid.ts`, replace:

```ts
export function visibleKeys(canvasW: number, canvasH: number, size: number): HexKey[] {
  const originX = canvasW / 2;
  const originY = canvasH / 2;
  const pad = size * 2;
```

with:

```ts
export function visibleKeys(
  canvasW: number,
  canvasH: number,
  size: number,
  originX: number = canvasW / 2,
  originY: number = canvasH / 2,
): HexKey[] {
  const pad = size * 2;
```

No other lines in the function change — the rest of the function already computes everything relative to `originX`/`originY`.

- [ ] **Step 2: Verify default behavior is unchanged**

With `pnpm dev` running, in the devtools console:

```js
const { visibleKeys } = await import('/src/hexGrid.ts');
const a = visibleKeys(800, 600, 50);
const b = visibleKeys(800, 600, 50, 400, 300);
console.log(a.length === b.length && JSON.stringify(a) === JSON.stringify(b)); // true
```

Expected: `true`.

- [ ] **Step 3: Manual regression check of the interactive app**

Open `http://localhost:5173/` (the main page). Confirm the hex grid still renders centered, keyboard input (QWERTY rows) and mouse clicks still play the correct notes, and the Size slider still works. This confirms the default-origin behavior is unaffected.

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/hexGrid.ts
git commit -m "refactor: generalize visibleKeys to accept an explicit origin"
```

---

### Task 5: Camera support in `renderer.ts`

**Files:**
- Modify: `src/renderer.ts`

**Interfaces:**
- Consumes: `CameraState`, `DEFAULT_CAMERA` from `src/camera.ts` (Task 2); generalized `visibleKeys` from `src/hexGrid.ts` (Task 4).
- Produces: `RendererState` gains optional `camera?: CameraState` (defaults to `DEFAULT_CAMERA` — `{q:0,r:0,zoom:1}` — preserving current interactive behavior with no `main.ts` changes needed).

- [ ] **Step 1: Add the camera import and `RendererState` field**

In `src/renderer.ts`, add to the imports:

```ts
import type { CameraState } from './camera.ts';
import { DEFAULT_CAMERA } from './camera.ts';
```

Add a field to `RendererState` (after `showKbGuide: boolean;`):

```ts
  /** Scripted view transform; defaults to {q:0, r:0, zoom:1} (unrotated, centered). */
  camera?: CameraState;
```

- [ ] **Step 2: Track camera and effective size in `createRenderer`**

Replace:

```ts
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  let offscreen: OffscreenCanvas | null = null;
  let offCtx: OffscreenCanvasRenderingContext2D | null = null;
  let hexSize = DEFAULT_HEX_SIZE;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let lastState: RendererState | null = null;
  let keys: HexKey[] = [];

  function recomputeKeys(): void {
    originX = cssW / 2;
    originY = cssH / 2;
    keys = visibleKeys(cssW, cssH, hexSize);
  }
```

with:

```ts
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  let offscreen: OffscreenCanvas | null = null;
  let offCtx: OffscreenCanvasRenderingContext2D | null = null;
  let hexSize = DEFAULT_HEX_SIZE;
  let effSize = DEFAULT_HEX_SIZE;
  let camera: CameraState = DEFAULT_CAMERA;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let lastState: RendererState | null = null;
  let keys: HexKey[] = [];

  function camerasEqual(a: CameraState, b: CameraState): boolean {
    return a.q === b.q && a.r === b.r && a.zoom === b.zoom;
  }

  function recomputeKeys(): void {
    effSize = hexSize * camera.zoom;
    const [focusX, focusY] = hexCenter(camera.q, camera.r, effSize, 0, 0);
    originX = cssW / 2 - focusX;
    originY = cssH / 2 - focusY;
    keys = visibleKeys(cssW, cssH, effSize, originX, originY);
  }
```

- [ ] **Step 3: Replace every drawing/hit-test use of `hexSize` with `effSize`**

In `buildStaticLayer`, `render`, and `hitTest`, replace `hexSize` with `effSize` everywhere it's used as the drawing/hit-test size (i.e. everywhere except the `hexSize = Math.max(8, s)` assignment in `setHexSize` and the `getSize()` accessor, which both intentionally refer to the base/slider value).

Concretely, in `buildStaticLayer`:

```ts
    drawHex(offCtx, key.q, key.r, effSize,
      ok(l, c, h),
      ok(sl, c * STROKE_C_FACTOR, h),
      0.5,
    );

    if (effSize >= 18) {
      const ll = l < 0.5 ? l + 0.5 : l - 0.5;
      drawLabel(offCtx, key.q, key.r, effSize, note.name,
        ok(ll, c * 0.55, h, inMode ? 0.70 : 0.35));
    }
```

In `render`, the keyboard-window-outline block:

```ts
      drawHex(ctx, q, r, effSize, 'transparent', ok(KB_OUTLINE_L, c * KB_OUTLINE_C_FACTOR, h, KB_OUTLINE_A), 3);
        if (effSize >= 18) {
          const label = keyWindow.keyLabels.get(keyCode) ?? '';
          const [cx, cy] = hexCenter(q, r, effSize, originX, originY);
          const fontSize = Math.max(6, Math.min(9, effSize * 0.30));
          ctx.font = `${fontSize}px system-ui, sans-serif`;
          ctx.fillStyle = ok(l < 0.5 ? l + 0.40 : l - 0.25, c * 0.5, h, 0.55);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(label, cx, cy + effSize * SQRT3 * 0.28);
        }
```

and the active-keys block:

```ts
      drawHex(ctx, key.q, key.r, effSize,
        ok(l + D_ACTIVE_L, c, h),
        ok(l + D_ACTIVE_L + STROKE_L_DELTA, c, h),
        1,
        ok(l + D_ACTIVE_L, c, h),
      );
      if (effSize >= 18) {
        const al = l + D_ACTIVE_L;
        const ll = al < 0.5 ? al + 0.5 : al - 0.5;
        drawLabel(ctx, key.q, key.r, effSize, note.name, ok(ll, c * 0.55, h));
      }
```

In `hitTest`:

```ts
  function hitTest(x: number, y: number): number {
    let best = -1;
    let bestDist = Infinity;
    const sqRadius = (effSize * 0.96) ** 2;
    for (const key of keys) {
      const [cx, cy] = hexCenter(key.q, key.r, effSize, originX, originY);
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < sqRadius && d2 < bestDist) { bestDist = d2; best = key.index; }
    }
    return best;
  }
```

- [ ] **Step 4: Update camera on render, guarded to avoid recomputing every frame when unchanged**

At the top of `render`, replace:

```ts
  function render(state: RendererState): void {
    const rebuild = !lastState
      || lastState.tuning !== state.tuning
      || lastState.layout !== state.layout
      || lastState.colorMode !== state.colorMode
      || lastState.inModePitchClasses !== state.inModePitchClasses;
    if (rebuild || !offscreen) buildStaticLayer(state);
    lastState = state;
```

with:

```ts
  function render(state: RendererState): void {
    const nextCamera = state.camera ?? DEFAULT_CAMERA;
    const cameraChanged = !camerasEqual(camera, nextCamera);
    if (cameraChanged) {
      camera = nextCamera;
      recomputeKeys();
    }

    const rebuild = !lastState
      || lastState.tuning !== state.tuning
      || lastState.layout !== state.layout
      || lastState.colorMode !== state.colorMode
      || lastState.inModePitchClasses !== state.inModePitchClasses
      || cameraChanged;
    if (rebuild || !offscreen) buildStaticLayer(state);
    lastState = state;
```

This guard means `recomputeKeys()` (which re-runs `visibleKeys`) only runs when the camera actually differs from the previous frame — the interactive page (`main.ts`), which never sets `camera`, keeps its original per-frame cost since `nextCamera` is always `DEFAULT_CAMERA` and `cameraChanged` is `false` after the first frame.

- [ ] **Step 5: Manual regression check**

Run `pnpm dev`, open `http://localhost:5173/`. Confirm the app behaves exactly as before: grid renders centered, keyboard/mouse input works, Size slider works, no console errors.

- [ ] **Step 6: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/renderer.ts
git commit -m "feat: add scripted camera (pan/zoom) support to renderer"
```

---

### Task 6: Per-voice ADSR/waveform overrides in `audioEngine.ts`

**Files:**
- Modify: `src/audioEngine.ts`

**Interfaces:**
- Produces: `AudioEngine.noteOn(id: string, frequency: number, overrides?: { adsr?: ADSR; waveform?: WaveType }): void` — omitting `overrides` preserves current behavior exactly (uses the engine's global ADSR/waveform, set via `setADSR`/`setWaveform`).

- [ ] **Step 1: Give each voice its own release time**

Replace the `Voice` interface:

```ts
interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  released: boolean;
}
```

with:

```ts
interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  released: boolean;
  release: number;
}
```

- [ ] **Step 2: Make `startVoice` accept explicit ADSR/waveform**

Replace:

```ts
  function startVoice(id: string, frequency: number): void {
    const context = ensureCtx();
    const now = context.currentTime;

    const osc = context.createOscillator();
    osc.type = waveType;
    osc.frequency.value = frequency;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    // Attack
    gain.gain.linearRampToValueAtTime(1.0, now + adsr.attack);
    // Decay to sustain
    gain.gain.setTargetAtTime(adsr.sustain, now + adsr.attack, adsr.decay / 3);

    osc.connect(gain);
    gain.connect(masterGain!);
    osc.start(now);

    voices.set(id, { osc, gain, released: false });
  }
```

with:

```ts
  function startVoice(id: string, frequency: number, voiceAdsr: ADSR, voiceWave: WaveType): void {
    const context = ensureCtx();
    const now = context.currentTime;

    const osc = context.createOscillator();
    osc.type = voiceWave;
    osc.frequency.value = frequency;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    // Attack
    gain.gain.linearRampToValueAtTime(1.0, now + voiceAdsr.attack);
    // Decay to sustain
    gain.gain.setTargetAtTime(voiceAdsr.sustain, now + voiceAdsr.attack, voiceAdsr.decay / 3);

    osc.connect(gain);
    gain.connect(masterGain!);
    osc.start(now);

    voices.set(id, { osc, gain, released: false, release: voiceAdsr.release });
  }
```

- [ ] **Step 3: Use the voice's own release time in `stopVoice`**

Replace:

```ts
    voice.gain.gain.linearRampToValueAtTime(0, now + adsr.release);
    voice.osc.stop(now + adsr.release + 0.01);
```

with:

```ts
    voice.gain.gain.linearRampToValueAtTime(0, now + voice.release);
    voice.osc.stop(now + voice.release + 0.01);
```

- [ ] **Step 4: Update `noteOn` on the returned engine object**

Replace:

```ts
    noteOn(id: string, frequency: number): void {
      const existing = voices.get(id);
      if (existing) {
        // Initiate release ramp if not already releasing.
        if (!existing.released) stopVoice(id);
        // Detach the onended callback so the old oscillator's natural end
        // cannot delete the new voice we're about to insert at the same id.
        existing.osc.onended = null;
        voices.delete(id);
      }
      startVoice(id, frequency);
    },
```

with:

```ts
    noteOn(id: string, frequency: number, overrides?: { adsr?: ADSR; waveform?: WaveType }): void {
      const existing = voices.get(id);
      if (existing) {
        // Initiate release ramp if not already releasing.
        if (!existing.released) stopVoice(id);
        // Detach the onended callback so the old oscillator's natural end
        // cannot delete the new voice we're about to insert at the same id.
        existing.osc.onended = null;
        voices.delete(id);
      }
      startVoice(id, frequency, overrides?.adsr ?? adsr, overrides?.waveform ?? waveType);
    },
```

- [ ] **Step 5: Update the `AudioEngine` interface**

Replace:

```ts
  noteOn(id: string, frequency: number): void;
```

with:

```ts
  noteOn(id: string, frequency: number, overrides?: { adsr?: ADSR; waveform?: WaveType }): void;
```

- [ ] **Step 6: Verify overrides are structurally accepted**

With `pnpm dev` running, in the devtools console (click anywhere on the page first so the browser permits audio):

```js
const { createAudioEngine } = await import('/src/audioEngine.ts');
const engine = createAudioEngine();
engine.noteOn('a', 440);
engine.noteOn('b', 550, { adsr: { attack: 0.5, decay: 0.5, sustain: 0.5, release: 2 }, waveform: 'square' });
console.log(engine.isActive('a'), engine.isActive('b')); // true true
engine.noteOff('a'); engine.noteOff('b');
```

Expected: `true true`, no thrown errors.

- [ ] **Step 7: Manual regression check**

Open `http://localhost:5173/`, play a few notes with the keyboard/mouse, adjust the ADSR sliders and confirm they still audibly affect notes (the override path is unused by `main.ts`, so this confirms the default path — omitting `overrides` — is unaffected).

- [ ] **Step 8: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 9: Commit**

```bash
git add src/audioEngine.ts
git commit -m "feat: support per-note ADSR/waveform overrides in audioEngine"
```

---

### Task 7: Scene playback orchestrator (`src/scenePlayer.ts`)

**Files:**
- Create: `src/scenePlayer.ts`

**Interfaces:**
- Consumes: `Scene`, `channelConfig` from `src/scene.ts` (Task 3); `MidiEvent`, `midiDuration` from `src/midiFile.ts` (Task 1); `CameraState`, `interpolateCamera` from `src/camera.ts` (Task 2); `AudioEngine` from `src/audioEngine.ts` (Task 6); `Renderer`, `RendererState`, `ColorMode` from `src/renderer.ts` (Task 5); `RecordingEngine` from `src/recordingEngine.ts` (existing); `midiToDegree` from `src/midiInput.ts` (existing); `TUNINGS` from `src/tuningEngine.ts`; `LAYOUT_PRESETS` from `src/layout.ts`; `buildKeyboardWindow` from `src/keyboardInput.ts`; `build12ToEdoMap` from `src/spiralFifths.ts`.
- Produces: `ScenePlayerCallbacks { onProgress(elapsedSec, totalSec): void; onDone(blob: Blob): void; onError(error: Error): void }`, `createScenePlayer(scene, events, audio, renderer, recording, callbacks): { render(): void }`.

- [ ] **Step 1: Write `src/scenePlayer.ts`**

```ts
// Orchestrates scene playback: schedules MIDI note on/off, camera keyframes,
// and mode keyframes against a shared rAF clock, drives audioEngine + renderer,
// and starts/stops recordingEngine automatically for a start-to-finish render.

import type { AudioEngine } from './audioEngine.ts';
import type { Renderer, RendererState, ColorMode } from './renderer.ts';
import type { RecordingEngine } from './recordingEngine.ts';
import type { TuningEngine } from './tuningEngine.ts';
import { TUNINGS } from './tuningEngine.ts';
import type { LayoutConfig } from './layout.ts';
import { LAYOUT_PRESETS } from './layout.ts';
import type { Scene } from './scene.ts';
import { channelConfig } from './scene.ts';
import type { MidiEvent } from './midiFile.ts';
import { midiDuration } from './midiFile.ts';
import type { CameraState } from './camera.ts';
import { interpolateCamera } from './camera.ts';
import { midiToDegree } from './midiInput.ts';
import { buildKeyboardWindow } from './keyboardInput.ts';
import { build12ToEdoMap } from './spiralFifths.ts';

export interface ScenePlayerCallbacks {
  onProgress(elapsedSec: number, totalSec: number): void;
  onDone(blob: Blob): void;
  onError(error: Error): void;
}

export interface ScenePlayer {
  render(): void;
}

const RELEASE_TAIL_SEC = 1;
const EMPTY_KEYS = new Set<number>();

interface ActiveNote {
  degree: number;
  channel: number;
  midiNote: number;
}

function buildInModePcs(edo: number, offset: number): Set<number> | null {
  if (edo === 12) return null;
  return new Set(build12ToEdoMap(edo, offset));
}

function voiceId(channel: number, midiNote: number): string {
  return `scene-${channel}-${midiNote}`;
}

export function createScenePlayer(
  scene: Scene,
  events: MidiEvent[],
  audio: AudioEngine,
  renderer: Renderer,
  recording: RecordingEngine,
  callbacks: ScenePlayerCallbacks,
): ScenePlayer {
  const tuning: TuningEngine = TUNINGS[String(scene.tuning.edo)]!;
  const layout: LayoutConfig = LAYOUT_PRESETS[String(scene.tuning.edo)]!;
  const totalSec = midiDuration(events) + RELEASE_TAIL_SEC;
  const keyWindow = buildKeyboardWindow(-6, -2);

  function render(): void {
    const activeDegrees = new Set<number>();
    const activeNotes = new Map<string, ActiveNote>(); // key = `${channel}:${midiNote}`
    let eventIdx = 0;
    let modeKfIdx = 1;
    let modeOffset = scene.modeKeyframes[0]?.modeOffset ?? 0;
    let inModePcs = buildInModePcs(tuning.stepsPerOctave, modeOffset);

    try {
      recording.start();
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const startTime = performance.now();

    function frame(): void {
      const elapsed = (performance.now() - startTime) / 1000;

      // Mode keyframes: instant switch, release all currently-sounding scene notes.
      while (modeKfIdx < scene.modeKeyframes.length && scene.modeKeyframes[modeKfIdx]!.t <= elapsed) {
        modeOffset = scene.modeKeyframes[modeKfIdx]!.modeOffset;
        inModePcs = buildInModePcs(tuning.stepsPerOctave, modeOffset);
        for (const { degree, channel, midiNote } of activeNotes.values()) {
          audio.noteOff(voiceId(channel, midiNote));
          activeDegrees.delete(degree);
        }
        activeNotes.clear();
        modeKfIdx++;
      }

      // MIDI note on/off.
      while (eventIdx < events.length && events[eventIdx]!.tAbs <= elapsed) {
        const ev = events[eventIdx]!;
        const key = `${ev.channel}:${ev.midiNote}`;
        if (ev.type === 'on') {
          const degree = midiToDegree(ev.midiNote, tuning.stepsPerOctave, modeOffset);
          const { waveform, adsr } = channelConfig(scene, ev.channel);
          activeNotes.set(key, { degree, channel: ev.channel, midiNote: ev.midiNote });
          activeDegrees.add(degree);
          audio.noteOn(voiceId(ev.channel, ev.midiNote), tuning.getFrequency(degree), { adsr, waveform });
        } else {
          const entry = activeNotes.get(key);
          if (entry) {
            activeDegrees.delete(entry.degree);
            activeNotes.delete(key);
          }
          audio.noteOff(voiceId(ev.channel, ev.midiNote));
        }
        eventIdx++;
      }

      const camera: CameraState = interpolateCamera(scene.cameraKeyframes, elapsed);
      const state: RendererState = {
        tuning, layout,
        activeKeys: EMPTY_KEYS,
        activeDegrees,
        inModePitchClasses: inModePcs,
        keyWindow,
        colorMode: 'spiral' as ColorMode,
        showKbGuide: false,
        camera,
      };
      renderer.render(state);

      callbacks.onProgress(Math.min(elapsed, totalSec), totalSec);

      if (elapsed >= totalSec) {
        audio.releaseAll();
        recording.stop()
          .then((blob) => callbacks.onDone(blob))
          .catch((err) => callbacks.onError(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }

  return { render };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors. (End-to-end behavior is verified in Task 8, once there's a page that can call `createScenePlayer`.)

- [ ] **Step 3: Commit**

```bash
git add src/scenePlayer.ts
git commit -m "feat: add scene playback orchestrator"
```

---

### Task 8: Scene editor page shell — file loading and end-to-end render

**Files:**
- Modify: `vite.config.ts` (multi-page build)
- Create: `scene-editor.html`
- Create: `src/sceneEditor.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 1–7 (`parseMidiFile`, `parseScene`, `createScenePlayer`, `createAudioEngine`, `createRenderer`, `createRecordingEngine`).

This task produces the first fully working end-to-end slice: load a scene JSON + MIDI file, click Render, get a downloaded WebM. The visual timeline (Task 9) and channel/ADSR table + save/load (Task 10) build on top of this shell.

- [ ] **Step 1: Configure Vite for a second HTML entry point**

Replace the contents of `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        sceneEditor: resolve(__dirname, 'scene-editor.html'),
      },
    },
  },
});
```

- [ ] **Step 2: Create `scene-editor.html`**

```html
<!doctype html>
<html lang="en">

<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lumatone Scene Editor</title>
  <link rel="stylesheet" href="/src/style.css" />
</head>

<body class="flex flex-col w-full h-full">

  <div id="controls" class="flex-none flex flex-col bg-surface border-b border-border text-fg/high">
    <div class="flex items-center gap-4 px-4 py-2 flex-wrap">
      <span class="text-lg font-semibold tracking-wide text-accent">Scene Editor</span>

      <label class="ctrl-label">
        Scene JSON
        <input type="file" id="scene-file-input" accept="application/json" class="ctrl-select">
      </label>

      <label class="ctrl-label">
        MIDI File
        <input type="file" id="midi-file-input" accept=".mid,.midi" class="ctrl-select">
      </label>

      <button id="render-btn" disabled
        class="px-3 py-1 rounded text-sm font-medium bg-accent/ghost text-accent hover:bg-accent/hover transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
        ▶ Render
      </button>

      <span id="render-status" class="text-fg/label text-sm"></span>
    </div>
  </div>

  <canvas id="preview-canvas" class="flex-1 block w-full min-h-0"></canvas>
  <script type="module" src="/src/sceneEditor.ts"></script>
</body>

</html>
```

- [ ] **Step 3: Create `src/sceneEditor.ts`**

```ts
import './style.css';
import { createAudioEngine } from './audioEngine.ts';
import { createRenderer } from './renderer.ts';
import { createRecordingEngine } from './recordingEngine.ts';
import { parseScene } from './scene.ts';
import type { Scene } from './scene.ts';
import { parseMidiFile } from './midiFile.ts';
import type { MidiEvent } from './midiFile.ts';
import { createScenePlayer } from './scenePlayer.ts';

const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const audio = createAudioEngine();
const renderer = createRenderer(canvas);

const sceneFileInput = document.getElementById('scene-file-input') as HTMLInputElement;
const midiFileInput  = document.getElementById('midi-file-input')  as HTMLInputElement;
const renderBtn      = document.getElementById('render-btn')       as HTMLButtonElement;
const statusEl       = document.getElementById('render-status')    as HTMLSpanElement;

let scene: Scene | null = null;
let events: MidiEvent[] | null = null;

function updateRenderButton(): void {
  renderBtn.disabled = !(scene && events);
}

sceneFileInput.addEventListener('change', async () => {
  const file = sceneFileInput.files?.[0];
  if (!file) return;
  try {
    scene = parseScene(await file.text());
    statusEl.textContent = `Loaded scene "${scene.name}"`;
  } catch (err) {
    scene = null;
    statusEl.textContent = `Scene error: ${err instanceof Error ? err.message : String(err)}`;
  }
  updateRenderButton();
});

midiFileInput.addEventListener('change', async () => {
  const file = midiFileInput.files?.[0];
  if (!file) return;
  try {
    events = parseMidiFile(await file.arrayBuffer());
    statusEl.textContent = `Loaded MIDI (${events.length} events)`;
  } catch (err) {
    events = null;
    statusEl.textContent = `MIDI error: ${err instanceof Error ? err.message : String(err)}`;
  }
  updateRenderButton();
});

renderBtn.addEventListener('click', () => {
  if (!scene || !events) return;
  renderBtn.disabled = true;
  const recording = createRecordingEngine(canvas, audio.getAudioContext(), audio.getMasterOutput());
  const player = createScenePlayer(scene, events, audio, renderer, recording, {
    onProgress(elapsed, total) {
      statusEl.textContent = `Rendering… ${elapsed.toFixed(1)}s / ${total.toFixed(1)}s`;
    },
    onDone(blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${scene!.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      statusEl.textContent = 'Render complete — downloaded.';
      renderBtn.disabled = false;
    },
    onError(err) {
      statusEl.textContent = `Render error: ${err.message}`;
      renderBtn.disabled = false;
    },
  });
  player.render();
});

const resizeObserver = new ResizeObserver((entries) => {
  const entry = entries[0];
  if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
});
resizeObserver.observe(canvas);
const initRect = canvas.getBoundingClientRect();
if (initRect.width > 0) renderer.resize(initRect.width, initRect.height);
```

- [ ] **Step 4: Generate a test MIDI file**

With `pnpm dev` running, open `http://localhost:5173/` (either page works — `@tonejs/midi` is available from both), open devtools console, and run:

```js
const { Midi } = await import('@tonejs/midi');
const midi = new Midi();
const track = midi.addTrack();
track.channel = 0;
track.addNote({ midi: 60, time: 0, duration: 0.5, velocity: 0.8 });
track.addNote({ midi: 64, time: 1, duration: 0.5, velocity: 0.8 });
track.addNote({ midi: 67, time: 2, duration: 1.0, velocity: 0.8 });
const blob = new Blob([midi.toArray()], { type: 'audio/midi' });
const url = URL.createObjectURL(blob);
const a = document.createElement('a'); a.href = url; a.download = 'test-scene.mid'; a.click();
```

This downloads `test-scene.mid` (3 notes: C4 at 0s, E4 at 1s, G4 at 2s, roughly a 3-second scene).

- [ ] **Step 5: Create a matching test scene JSON**

Save this as `test-scene.json` anywhere on disk (e.g. next to the downloaded `test-scene.mid`):

```json
{
  "name": "Test Scene",
  "midiFile": "test-scene.mid",
  "tuning": { "edo": 31 },
  "channels": {
    "0": { "waveform": "triangle", "adsr": { "attack": 0.01, "decay": 0.1, "sustain": 0.6, "release": 0.3 } }
  },
  "cameraKeyframes": [
    { "t": 0, "q": 0, "r": 0, "zoom": 1 },
    { "t": 2, "q": 4, "r": -2, "zoom": 1.5, "duration": 1.5, "easing": "easeInOut" }
  ],
  "modeKeyframes": [
    { "t": 0, "modeOffset": 0 }
  ]
}
```

- [ ] **Step 6: Verify the end-to-end render**

Navigate to `http://localhost:5173/scene-editor.html`. Use the "Scene JSON" picker to load `test-scene.json`, the "MIDI File" picker to load `test-scene.mid`. The status line should read "Loaded MIDI (6 events)" and the Render button should become enabled. Click Render.

Expected: the preview canvas plays three notes (visible as highlighted hexes) while the camera holds still until ~0.5s before t=2, then eases into a pan+zoom over 1.5s. After ~4 seconds (3s of MIDI + 1s release tail) a `.webm` file downloads automatically and the status reads "Render complete — downloaded." Play the downloaded file in a media player or browser tab and confirm it contains video (the hex grid, panning/zooming) and audio (three notes).

- [ ] **Step 7: Typecheck and build**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors, and `dist/` contains both `index.html` and `scene-editor.html` (multi-page build working).

- [ ] **Step 8: Commit**

```bash
git add vite.config.ts scene-editor.html src/sceneEditor.ts
git commit -m "feat: add scene editor page with end-to-end MIDI-to-WebM rendering"
```

---

### Task 9: Timeline UI — camera and mode keyframe tracks

**Files:**
- Create: `src/timelineTrack.ts`
- Modify: `scene-editor.html`
- Modify: `src/sceneEditor.ts`

**Interfaces:**
- Produces (`timelineTrack.ts`): `TimelineKeyframeLike { t: number }`, `TimelineTrack<K> { setKeyframes(kfs: K[]): void; setPlayhead(t: number): void; setDuration(seconds: number): void }`, `createTimelineTrack<K extends TimelineKeyframeLike>(container: HTMLElement, onSelect: (index: number) => void, onDrag: (index: number, newT: number) => void): TimelineTrack<K>`.

- [ ] **Step 1: Write `src/timelineTrack.ts`**

```ts
// Generic draggable keyframe track: renders one marker per keyframe (any shape
// with a numeric `t`), lets the user drag a marker to retime it and click to
// select one. Used for both the Camera and Mode tracks in the scene editor.

export interface TimelineKeyframeLike {
  t: number;
}

export interface TimelineTrack<K extends TimelineKeyframeLike> {
  setKeyframes(keyframes: K[]): void;
  setPlayhead(t: number): void;
  setDuration(seconds: number): void;
}

export function createTimelineTrack<K extends TimelineKeyframeLike>(
  container: HTMLElement,
  onSelect: (index: number) => void,
  onDrag: (index: number, newT: number) => void,
): TimelineTrack<K> {
  let keyframes: K[] = [];
  let duration = 1;
  let selectedIndex = -1;

  const trackEl = document.createElement('div');
  trackEl.className = 'relative h-8 bg-fg/ghost rounded';
  container.appendChild(trackEl);

  const playheadEl = document.createElement('div');
  playheadEl.className = 'absolute top-0 bottom-0 w-px bg-accent pointer-events-none';
  trackEl.appendChild(playheadEl);

  function timeToPct(t: number): number {
    return duration > 0 ? Math.max(0, Math.min(1, t / duration)) * 100 : 0;
  }

  function pxToTime(clientX: number): number {
    const rect = trackEl.getBoundingClientRect();
    const pct = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    return pct * duration;
  }

  function redrawMarkers(): void {
    trackEl.querySelectorAll('.kf-marker').forEach((el) => el.remove());
    keyframes.forEach((kf, index) => {
      const marker = document.createElement('div');
      marker.className = 'kf-marker absolute top-0.5 bottom-0.5 w-2.5 rounded-sm cursor-grab '
        + (index === selectedIndex ? 'bg-accent' : 'bg-fg/label');
      marker.style.left = `calc(${timeToPct(kf.t)}% - 5px)`;

      marker.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        selectedIndex = index;
        onSelect(index);
        redrawMarkers();

        function onMove(ev: PointerEvent): void {
          onDrag(index, pxToTime(ev.clientX));
        }
        function onUp(): void {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });

      trackEl.appendChild(marker);
    });
  }

  return {
    setKeyframes(kfs: K[]): void {
      keyframes = kfs;
      redrawMarkers();
    },
    setPlayhead(t: number): void {
      playheadEl.style.left = `${timeToPct(t)}%`;
    },
    setDuration(seconds: number): void {
      duration = Math.max(seconds, 0.001);
      redrawMarkers();
    },
  };
}
```

- [ ] **Step 2: Add timeline markup to `scene-editor.html`**

Insert this block after the closing `</div>` of the existing `#controls` div (before the `<canvas id="preview-canvas">` line):

```html
  <div id="timeline" class="flex-none flex flex-col gap-2 px-4 py-3 bg-surface border-b border-border">
    <div class="flex items-center gap-3">
      <span class="ctrl-label w-16">Time</span>
      <input type="range" id="scrub" min="0" max="1" step="0.01" value="0" class="ctrl-range flex-1">
      <span id="scrub-time" class="text-fg/label text-sm tabular-nums w-24 text-right">0.0 / 0.0s</span>
    </div>

    <div class="flex items-center gap-3">
      <span class="ctrl-label w-16">Camera</span>
      <div id="camera-track" class="flex-1"></div>
      <button id="camera-add-btn" class="px-2 py-0.5 rounded text-xs bg-accent/ghost text-accent hover:bg-accent/hover cursor-pointer">+ kf</button>
      <button id="camera-del-btn" class="px-2 py-0.5 rounded text-xs bg-red-500/ghost text-red-400 hover:bg-red-500/hover cursor-pointer">delete</button>
    </div>
    <div id="camera-inspector" class="flex items-center gap-3 pl-[4.75rem] text-sm"></div>

    <div class="flex items-center gap-3">
      <span class="ctrl-label w-16">Mode</span>
      <div id="mode-track" class="flex-1"></div>
      <button id="mode-add-btn" class="px-2 py-0.5 rounded text-xs bg-accent/ghost text-accent hover:bg-accent/hover cursor-pointer">+ kf</button>
      <button id="mode-del-btn" class="px-2 py-0.5 rounded text-xs bg-red-500/ghost text-red-400 hover:bg-red-500/hover cursor-pointer">delete</button>
    </div>
    <div id="mode-inspector" class="flex items-center gap-3 pl-[4.75rem] text-sm"></div>
  </div>
```

- [ ] **Step 3: Wire the timeline into `src/sceneEditor.ts`**

Add imports at the top:

```ts
import { createTimelineTrack } from './timelineTrack.ts';
import type { CameraKeyframe } from './camera.ts';
import { interpolateCamera, DEFAULT_CAMERA } from './camera.ts';
import type { ModeKeyframe } from './scene.ts';
import { midiDuration } from './midiFile.ts';
```

Add this block after the existing `let scene: Scene | null = null; let events: MidiEvent[] | null = null;` lines, replacing the rest of the file from `function updateRenderButton()` onward with the version below (the file grows; everything from `updateRenderButton` through the end of the original Task 8 file is included here, extended):

```ts
let selectedCameraIndex = -1;
let selectedModeIndex = -1;
let scrubTime = 0;

const scrubInput   = document.getElementById('scrub')            as HTMLInputElement;
const scrubTimeEl  = document.getElementById('scrub-time')       as HTMLSpanElement;
const cameraTrackEl     = document.getElementById('camera-track')     as HTMLDivElement;
const cameraInspectorEl = document.getElementById('camera-inspector') as HTMLDivElement;
const cameraAddBtn      = document.getElementById('camera-add-btn')   as HTMLButtonElement;
const cameraDelBtn      = document.getElementById('camera-del-btn')   as HTMLButtonElement;
const modeTrackEl       = document.getElementById('mode-track')       as HTMLDivElement;
const modeInspectorEl   = document.getElementById('mode-inspector')   as HTMLDivElement;
const modeAddBtn        = document.getElementById('mode-add-btn')     as HTMLButtonElement;
const modeDelBtn        = document.getElementById('mode-del-btn')     as HTMLButtonElement;

const cameraTrack = createTimelineTrack<CameraKeyframe>(cameraTrackEl,
  (index) => { selectedCameraIndex = index; renderCameraInspector(); },
  (index, newT) => {
    if (!scene) return;
    scene.cameraKeyframes[index]!.t = Math.max(0, newT);
    scene.cameraKeyframes.sort((a, b) => a.t - b.t);
    refreshTimeline();
  });

const modeTrack = createTimelineTrack<ModeKeyframe>(modeTrackEl,
  (index) => { selectedModeIndex = index; renderModeInspector(); },
  (index, newT) => {
    if (!scene) return;
    scene.modeKeyframes[index]!.t = Math.max(0, newT);
    scene.modeKeyframes.sort((a, b) => a.t - b.t);
    refreshTimeline();
  });

function sceneDuration(): number {
  return events ? midiDuration(events) + 1 : 1;
}

function refreshTimeline(): void {
  if (!scene) return;
  const duration = sceneDuration();
  scrubInput.max = String(duration);
  cameraTrack.setDuration(duration);
  cameraTrack.setKeyframes(scene.cameraKeyframes);
  modeTrack.setDuration(duration);
  modeTrack.setKeyframes(scene.modeKeyframes);
  renderCameraInspector();
  renderModeInspector();
  updatePreview();
}

function renderCameraInspector(): void {
  cameraInspectorEl.innerHTML = '';
  if (!scene || selectedCameraIndex < 0 || selectedCameraIndex >= scene.cameraKeyframes.length) return;
  const kf = scene.cameraKeyframes[selectedCameraIndex]!;

  function numberField(label: string, value: number, onInput: (v: number) => void, step = 0.1): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'ctrl-label';
    wrap.textContent = label + ' ';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.value = String(value);
    input.className = 'ctrl-select w-20';
    input.addEventListener('input', () => { onInput(parseFloat(input.value)); refreshTimeline(); });
    wrap.appendChild(input);
    return wrap;
  }

  cameraInspectorEl.appendChild(numberField('q', kf.q, (v) => { kf.q = v; }));
  cameraInspectorEl.appendChild(numberField('r', kf.r, (v) => { kf.r = v; }));
  cameraInspectorEl.appendChild(numberField('zoom', kf.zoom, (v) => { kf.zoom = v; }, 0.05));
  cameraInspectorEl.appendChild(numberField('duration', kf.duration ?? 0, (v) => { kf.duration = v; }, 0.1));

  const easingSelect = document.createElement('select');
  easingSelect.className = 'ctrl-select';
  for (const opt of ['easeInOut', 'linear', 'easeIn', 'easeOut']) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt;
    if ((kf.easing ?? 'easeInOut') === opt) o.selected = true;
    easingSelect.appendChild(o);
  }
  easingSelect.addEventListener('change', () => {
    kf.easing = easingSelect.value as CameraKeyframe['easing'];
    refreshTimeline();
  });
  cameraInspectorEl.appendChild(easingSelect);
}

function renderModeInspector(): void {
  modeInspectorEl.innerHTML = '';
  if (!scene || selectedModeIndex < 0 || selectedModeIndex >= scene.modeKeyframes.length) return;
  const kf = scene.modeKeyframes[selectedModeIndex]!;

  const wrap = document.createElement('label');
  wrap.className = 'ctrl-label';
  wrap.textContent = 'modeOffset ';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.value = String(kf.modeOffset);
  input.className = 'ctrl-select w-20';
  input.addEventListener('input', () => { kf.modeOffset = parseInt(input.value, 10) || 0; refreshTimeline(); });
  wrap.appendChild(input);
  modeInspectorEl.appendChild(wrap);
}

cameraAddBtn.addEventListener('click', () => {
  if (!scene) return;
  const prev = interpolateCamera(scene.cameraKeyframes, scrubTime) ?? DEFAULT_CAMERA;
  scene.cameraKeyframes.push({ t: scrubTime, q: prev.q, r: prev.r, zoom: prev.zoom, duration: 1, easing: 'easeInOut' });
  scene.cameraKeyframes.sort((a, b) => a.t - b.t);
  selectedCameraIndex = scene.cameraKeyframes.findIndex((k) => k.t === scrubTime);
  refreshTimeline();
});

cameraDelBtn.addEventListener('click', () => {
  if (!scene || selectedCameraIndex < 0) return;
  scene.cameraKeyframes.splice(selectedCameraIndex, 1);
  selectedCameraIndex = -1;
  refreshTimeline();
});

modeAddBtn.addEventListener('click', () => {
  if (!scene) return;
  scene.modeKeyframes.push({ t: scrubTime, modeOffset: 0 });
  scene.modeKeyframes.sort((a, b) => a.t - b.t);
  selectedModeIndex = scene.modeKeyframes.findIndex((k) => k.t === scrubTime);
  refreshTimeline();
});

modeDelBtn.addEventListener('click', () => {
  if (!scene || selectedModeIndex < 0) return;
  scene.modeKeyframes.splice(selectedModeIndex, 1);
  selectedModeIndex = -1;
  refreshTimeline();
});

scrubInput.addEventListener('input', () => {
  scrubTime = parseFloat(scrubInput.value);
  updatePreview();
});

function updatePreview(): void {
  const duration = sceneDuration();
  scrubTimeEl.textContent = `${scrubTime.toFixed(1)} / ${duration.toFixed(1)}s`;
  cameraTrack.setPlayhead(scrubTime);
  modeTrack.setPlayhead(scrubTime);
  if (!scene) return;
  const camera = interpolateCamera(scene.cameraKeyframes, scrubTime);
  renderer.render({
    tuning: TUNINGS[String(scene.tuning.edo)]!,
    layout: LAYOUT_PRESETS[String(scene.tuning.edo)]!,
    activeKeys: new Set(),
    activeDegrees: new Set(),
    inModePitchClasses: null,
    keyWindow: PREVIEW_KEY_WINDOW,
    colorMode: 'spiral',
    showKbGuide: false,
    camera,
  });
}

function updateRenderButton(): void {
  renderBtn.disabled = !(scene && events);
}
```

Add these two imports at the top alongside the others:

```ts
import { TUNINGS } from './tuningEngine.ts';
import { LAYOUT_PRESETS } from './layout.ts';
import { buildKeyboardWindow } from './keyboardInput.ts';
```

and this constant near the top-level state declarations:

```ts
const PREVIEW_KEY_WINDOW = buildKeyboardWindow(-6, -2);
```

Finally, call `refreshTimeline()` at the end of both the `sceneFileInput` and `midiFileInput` change handlers (right after `updateRenderButton();` in each), so the tracks populate as soon as both files are loaded.

- [ ] **Step 4: Manual verification**

Run `pnpm dev`, open `http://localhost:5173/scene-editor.html`, load `test-scene.json` and `test-scene.mid` from Task 8. Confirm:
- The Camera and Mode tracks show markers at the correct relative positions.
- Dragging the scrub slider moves the preview canvas's camera (pan/zoom) live, matching what Render later produces.
- Clicking a camera marker selects it (turns accent-colored) and shows q/r/zoom/duration/easing fields in the inspector; editing a field updates the marker's position on the track if `t` isn't what changed, or the camera preview if a spatial field changed.
- "+ kf" adds a new keyframe at the current scrub time; "delete" removes the selected one.
- Render still works exactly as in Task 8's verification.

- [ ] **Step 5: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/timelineTrack.ts scene-editor.html src/sceneEditor.ts
git commit -m "feat: add draggable camera/mode keyframe timeline to scene editor"
```

---

### Task 10: Channel/ADSR config table + Save/Load Scene JSON

**Files:**
- Modify: `scene-editor.html`
- Modify: `src/sceneEditor.ts`

- [ ] **Step 1: Add markup to `scene-editor.html`**

Insert this block right after the `#timeline` div's closing `</div>` (before `<canvas id="preview-canvas">`):

```html
  <div id="channels-panel" class="flex-none flex flex-col gap-2 px-4 py-3 bg-surface border-b border-border">
    <div class="flex items-center gap-3">
      <span class="ctrl-label">Channels</span>
      <button id="channel-add-btn" class="px-2 py-0.5 rounded text-xs bg-accent/ghost text-accent hover:bg-accent/hover cursor-pointer">+ channel</button>
      <button id="save-scene-btn" class="px-2 py-0.5 rounded text-xs bg-accent/ghost text-accent hover:bg-accent/hover cursor-pointer ml-auto">Save Scene JSON</button>
    </div>
    <div id="channels-table" class="flex flex-col gap-1"></div>
  </div>
```

- [ ] **Step 2: Add channel table + save logic to `src/sceneEditor.ts`**

Add these imports:

```ts
import type { ChannelConfig } from './scene.ts';
import { DEFAULT_CHANNEL_CONFIG } from './scene.ts';
```

Add these element lookups near the other DOM lookups:

```ts
const channelsTableEl = document.getElementById('channels-table')  as HTMLDivElement;
const channelAddBtn   = document.getElementById('channel-add-btn') as HTMLButtonElement;
const saveSceneBtn    = document.getElementById('save-scene-btn')  as HTMLButtonElement;
```

Add this function and wire it into `refreshTimeline()` (call `renderChannelsTable();` at the end of `refreshTimeline`):

```ts
function renderChannelsTable(): void {
  channelsTableEl.innerHTML = '';
  if (!scene) return;

  for (const [key, config] of Object.entries(scene.channels)) {
    const channel = Number(key);
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 text-sm';

    const label = document.createElement('span');
    label.className = 'ctrl-label w-20';
    label.textContent = `Ch ${channel}`;
    row.appendChild(label);

    const waveSelect = document.createElement('select');
    waveSelect.className = 'ctrl-select';
    for (const wave of ['sine', 'triangle', 'sawtooth', 'square']) {
      const o = document.createElement('option');
      o.value = wave; o.textContent = wave;
      if (config.waveform === wave) o.selected = true;
      waveSelect.appendChild(o);
    }
    waveSelect.addEventListener('change', () => {
      config.waveform = waveSelect.value as ChannelConfig['waveform'];
    });
    row.appendChild(waveSelect);

    for (const field of ['attack', 'decay', 'sustain', 'release'] as const) {
      const wrap = document.createElement('label');
      wrap.className = 'ctrl-label';
      wrap.textContent = field[0]!.toUpperCase() + ' ';
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.01';
      input.value = String(config.adsr[field]);
      input.className = 'ctrl-select w-16';
      input.addEventListener('input', () => { config.adsr[field] = parseFloat(input.value) || 0; });
      wrap.appendChild(input);
      row.appendChild(wrap);
    }

    const delBtn = document.createElement('button');
    delBtn.textContent = 'remove';
    delBtn.className = 'px-2 py-0.5 rounded text-xs bg-red-500/ghost text-red-400 hover:bg-red-500/hover cursor-pointer';
    delBtn.addEventListener('click', () => {
      delete scene!.channels[channel];
      renderChannelsTable();
    });
    row.appendChild(delBtn);

    channelsTableEl.appendChild(row);
  }
}

channelAddBtn.addEventListener('click', () => {
  if (!scene) return;
  let next = 0;
  while (scene.channels[next]) next++;
  scene.channels[next] = { waveform: DEFAULT_CHANNEL_CONFIG.waveform, adsr: { ...DEFAULT_CHANNEL_CONFIG.adsr } };
  renderChannelsTable();
});

saveSceneBtn.addEventListener('click', () => {
  if (!scene) return;
  const json = JSON.stringify(scene, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scene.name.replace(/\s+/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});
```

- [ ] **Step 3: Manual verification**

Run `pnpm dev`, open `http://localhost:5173/scene-editor.html`, load `test-scene.json` and `test-scene.mid`. Confirm the Channels panel shows channel 0 with its waveform/ADSR values pre-filled from the loaded scene, editing a field doesn't error, "+ channel" adds a new row with defaults, "remove" deletes a row, and "Save Scene JSON" downloads a `.json` file whose contents (open it) reflect the current edits, including any timeline keyframe edits from Task 9.

- [ ] **Step 4: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add scene-editor.html src/sceneEditor.ts
git commit -m "feat: add channel/ADSR config table and scene JSON save to scene editor"
```

---

### Task 11: Error handling polish

**Files:**
- Modify: `index.html`
- Modify: `src/main.ts`

This closes the one pre-existing gap the design spec calls out: `main.ts`'s Record button has no handling if `recordingEngine.start()` throws. (The scene editor's equivalent path was already handled in Task 7/8 via `scenePlayer.ts`'s `try/catch` around `recording.start()`, and malformed-MIDI / invalid-scene-JSON handling was already added in Task 8's file input handlers.)

- [ ] **Step 1: Add an error slot to `index.html`**

In the "Row 3: Recording" block, after the `#record-status` span, add:

```html
      <span id="record-error" class="hidden text-red-400 text-sm"></span>
```

- [ ] **Step 2: Catch `recEngine.start()` failures in `src/main.ts`**

Add this lookup next to the other recording element lookups:

```ts
const recordErrorEl = document.getElementById('record-error') as HTMLSpanElement;
```

Replace the `recordBtn` click handler:

```ts
recordBtn.addEventListener('click', () => {
  if (!recEngine) {
    recEngine = createRecordingEngine(canvas, audio.getAudioContext(), audio.getMasterOutput());
  }
  recEngine.start();
  recordStart = Date.now();
  recordTimeEl.textContent = '0:00';
  recordBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  recordStatus.classList.remove('hidden');
  timerInterval = setInterval(() => {
    recordTimeEl.textContent = formatRecTime(Date.now() - recordStart);
  }, 1000);
});
```

with:

```ts
recordBtn.addEventListener('click', () => {
  if (!recEngine) {
    recEngine = createRecordingEngine(canvas, audio.getAudioContext(), audio.getMasterOutput());
  }
  recordErrorEl.classList.add('hidden');
  try {
    recEngine.start();
  } catch (err) {
    recordErrorEl.textContent = `Recording error: ${err instanceof Error ? err.message : String(err)}`;
    recordErrorEl.classList.remove('hidden');
    return;
  }
  recordStart = Date.now();
  recordTimeEl.textContent = '0:00';
  recordBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  recordStatus.classList.remove('hidden');
  timerInterval = setInterval(() => {
    recordTimeEl.textContent = formatRecTime(Date.now() - recordStart);
  }, 1000);
});
```

- [ ] **Step 3: Verify the malformed-input error paths in the scene editor still behave correctly**

Run `pnpm dev`, open `http://localhost:5173/scene-editor.html`.
- Select any non-MIDI file (e.g. rename a `.txt` file to end in `.mid`, or pick a `.json` file) via the "MIDI File" picker. Expected: status line shows "MIDI error: …" — no uncaught exception in the console, Render button stays disabled.
- Create a text file containing `{ "not": "a scene" }` and select it via the "Scene JSON" picker. Expected: status line shows "Scene error: Scene JSON missing "name" string" (or similar) — no uncaught exception, Render button stays disabled.

- [ ] **Step 4: Verify the main page still records normally**

Run `pnpm dev`, open `http://localhost:5173/`, click Record, wait a couple seconds, click Stop. Expected: unchanged behavior from before this task — a `.webm` downloads, no error text shown (since `recEngine.start()` succeeds under normal conditions in a modern browser).

- [ ] **Step 5: Typecheck**

Run: `pnpm build`
Expected: succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add index.html src/main.ts
git commit -m "fix: handle recordingEngine.start() failures in the main page's Record button"
```

---

### Task 12: Documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the top-of-file dependency claim**

Replace:

```markdown
Browser-based simulator for the Lumatone microtonal keyboard instrument. Pure TypeScript + Vite, no external runtime dependencies.
```

with:

```markdown
Browser-based simulator for the Lumatone microtonal keyboard instrument. Pure TypeScript + Vite. Zero external runtime dependencies, with one deliberate exception: `@tonejs/midi` (MIDI file parsing for the scene editor).
```

- [ ] **Step 2: Add new modules to the architecture table**

In the `## Architecture` table, replace the row order after `src/recordingEngine.ts` (added in an earlier session) — i.e. replace:

```markdown
| `src/recordingEngine.ts` | Records the canvas + audio output (via `audioEngine.getAudioContext()`/`getMasterOutput()`) into a WebM blob using `MediaRecorder`. |
| `src/main.ts` | Wires all modules; handles keyboard, mouse, MIDI, UI controls, resize, recording. |
```

with:

```markdown
| `src/recordingEngine.ts` | Records the canvas + audio output (via `audioEngine.getAudioContext()`/`getMasterOutput()`) into a WebM blob using `MediaRecorder`. |
| `src/midiFile.ts` | Parses a Standard MIDI File (via `@tonejs/midi`) into a flat, time-sorted list of note on/off events. |
| `src/camera.ts` | Scripted camera for scene playback: `{q, r, zoom}` state, hold-then-ease keyframe interpolation. |
| `src/scene.ts` | Scene JSON schema (MIDI reference, per-channel ADSR/waveform, camera/mode keyframes) and parser. |
| `src/scenePlayer.ts` | Scene playback orchestrator: schedules MIDI + camera + mode keyframes against a shared clock, drives `audioEngine`/`renderer`, auto-starts/stops `recordingEngine`. |
| `src/timelineTrack.ts` | Generic draggable keyframe-track UI component, used by the scene editor's Camera and Mode tracks. |
| `src/sceneEditor.ts` | Scene editor page (`scene-editor.html`): file loading, timeline editing, channel config, and Render. |
| `src/main.ts` | Wires all modules for the interactive performance page (`index.html`); handles keyboard, mouse, MIDI, UI controls, resize, recording. |
```

- [ ] **Step 3: Add a Scene editor section**

Replace the "Planned extensions" bullet added for this feature:

```markdown
- **Scene editor & video rendering**: a separate `scene-editor.html` page for authoring MIDI-driven "scenes" — scripted camera pans/zooms and mode-window changes on a timeline, per-channel ADSR/waveform config, rendered to WebM via `recordingEngine.ts` for use in educational microtonal-scale videos. Introduces the project's first external runtime dependency (a MIDI file parser), as a deliberate scoped exception to the zero-deps principle. Full design: `docs/superpowers/specs/2026-07-13-scene-editor-design.md`. Further ideas noted there but out of scope for the first pass: caption keyframes, interval/ratio readout, A/B tuning comparison, slow-motion playback, WAV export, interactive pan/zoom in the editor preview.
```

with a new dedicated section, inserted right before `## Planned extensions`:

```markdown
## Scene editor

`scene-editor.html` (`src/sceneEditor.ts`) authors and renders MIDI-driven "scenes" for educational microtonal-scale videos — separate from the interactive performance page (`index.html`/`main.ts`).

- A **scene** = one MIDI file + one keyframe timeline = one rendered `.webm` output. Multiple scenes are assembled into a full video by hand, outside the app.
- **Scene JSON** (`src/scene.ts`): `{ name, midiFile, tuning: { edo }, channels: Record<midiChannel, { waveform, adsr }>, cameraKeyframes, modeKeyframes }`. `tuning.edo` is fixed for the whole scene; per-channel `waveform`/`adsr` is static for the whole scene (not keyframable).
- **Camera keyframes** (`src/camera.ts`): `{ t, q, r, zoom, duration?, easing? }`. Hold-then-ease semantics — the camera holds at the previous keyframe's `(q, r, zoom)` until `duration` seconds before this keyframe's `t`, then eases in (`easing` ∈ `linear | easeIn | easeOut | easeInOut`, default `easeInOut`), arriving exactly at `t`.
- **Mode keyframes**: `{ t, modeOffset }`. Instant switch (no easing — `modeOffset` is discrete), releases all currently-sounding scene notes on change (same safety behavior as the Shift+←/→ live control).
- **Camera state** `{q, r, zoom}` (`src/camera.ts`) is the single source of truth for `renderer.ts`'s view transform — `RendererState.camera` (optional, defaults to `{q:0,r:0,zoom:1}`), effective hex size = `hexSize × zoom`, origin derived so `(q, r)` renders at canvas center. The interactive page never sets this field, so its behavior is unchanged.
- **Render**: fully automatic. Load a scene JSON + its `.mid` file, click Render — `scenePlayer.ts` plays the scene start-to-finish (scheduling MIDI note on/off, camera, and mode keyframes against one clock) while `recordingEngine.ts` records, then auto-downloads the WebM when the MIDI ends (+ 1s release tail). No manual start/stop during playback.
- Full design and rationale: `docs/superpowers/specs/2026-07-13-scene-editor-design.md`.

Ideas noted in that spec but intentionally out of scope for the first pass: caption/text-overlay keyframes, live interval/ratio readout, A/B tuning comparison, slow-motion playback, WAV-only audio export, keyframable per-channel ADSR, multi-MIDI-file scenes, interactive pan/zoom in the editor preview canvas.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the scene editor architecture in CLAUDE.md"
```

---

## Self-Review Notes

- **Spec coverage**: scene JSON schema (Task 3), MIDI parsing (Task 1), camera hold-then-ease (Task 2, Task 5), mode-keyframe instant switch + note release (Task 7), static per-channel ADSR (Task 3, Task 10), separate-page architecture (Task 8), automatic render→record→download (Task 7, Task 8), numeric-only camera authoring (Task 9), visual draggable timeline (Task 9), error handling for malformed MIDI/invalid scene/recording failures (Task 8, Task 11), zero-deps exception documented (Task 1, Task 12) — all covered.
- **Type consistency checked**: `voiceId(channel, midiNote)` format (`scene-{channel}-{midiNote}`) is identical in `scenePlayer.ts` (Task 7) and not referenced elsewhere. `ChannelConfig`/`Scene`/`ModeKeyframe` types from Task 3 are used with matching field names in Tasks 7, 9, 10. `CameraKeyframe`/`CameraState`/`interpolateCamera`/`DEFAULT_CAMERA` from Task 2 are used with matching signatures in Tasks 5, 7, 9. `AudioEngine.noteOn`'s third parameter shape (`{ adsr?: ADSR; waveform?: WaveType }`) from Task 6 matches its one caller in Task 7.
- **No placeholders**: every step has complete, concrete code or exact manual-verification commands with expected output; no "TBD"/"add error handling"/"similar to Task N" left in.
