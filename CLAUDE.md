# Lumatone Simulator

Browser-based simulator for the Lumatone microtonal keyboard instrument. Pure TypeScript + Vite. Zero external runtime dependencies, with one deliberate exception: `@tonejs/midi` (MIDI file parsing for the scene editor).

## Commands

```bash
pnpm dev       # dev server with HMR
pnpm build     # tsc + vite build → dist/
pnpm preview   # preview production build
```

## Architecture

All modules use the factory-function pattern (no classes).

| File | Responsibility |
|------|----------------|
| `src/tuningEngine.ts` | EDO frequency calculation. Interface designed to accept JI later. |
| `src/layout.ts` | Bosanquet-Wilson pitch mapping: `degree = q·qStep + r·rStep`. |
| `src/hexGrid.ts` | Infinite axial hex grid, pixel geometry, grid rotation, visible-key culling. |
| `src/spiralFifths.ts` | Spiral-of-fifths note naming for any EDO. Note names, accidental counts, `kToName`, `build12ToEdoMap`. |
| `src/audioEngine.ts` | Polyphonic Web Audio API synth. Per-voice oscillator + ADSR gain envelope. |
| `src/renderer.ts` | Canvas 2D rendering. Offscreen static layer + per-frame active-key overlay. OKLCH colours. |
| `src/keyboardInput.ts` | QWERTY → hex position mapping. Shiftable keyboard window. |
| `src/midiInput.ts` | Web MIDI input. Maps MIDI notes to EDO degrees via `midiToDegree`; uses `build12ToEdoMap` for enharmonic mapping. |
| `src/recordingEngine.ts` | Records the canvas + audio output (via `audioEngine.getAudioContext()`/`getMasterOutput()`) into a WebM blob using `MediaRecorder`. |
| `src/midiFile.ts` | Parses a Standard MIDI File (via `@tonejs/midi`) into a flat, time-sorted list of note on/off events. |
| `src/camera.ts` | Scripted camera for scene playback: `{q, r, zoom}` state, hold-then-ease keyframe interpolation. |
| `src/scene.ts` | Scene JSON schema (MIDI reference, per-channel ADSR/waveform, camera/mode keyframes) and parser. |
| `src/scenePlayer.ts` | Scene playback orchestrator: schedules MIDI + camera + mode keyframes against a shared clock, drives `audioEngine`/`renderer`, auto-starts/stops `recordingEngine`. |
| `src/timelineTrack.ts` | Generic draggable keyframe-track UI component, used by the scene editor's Camera and Mode tracks. |
| `src/sceneEditor.ts` | Scene editor page (`scene-editor.html`): file loading, timeline editing, channel config, and Render. |
| `src/main.ts` | Wires all modules for the interactive performance page (`index.html`); handles keyboard, mouse, MIDI, UI controls, resize, recording. |

## Hex grid geometry

- **Orientation**: pointy-top hexagons, pure axial coordinates.
- **Axes**: `q` points right; `r` points lower-right at 60° below horizontal.
- **Origin**: `(q, r) = (0, 0)` is always at canvas centre = degree 0 = middle C.
- **Infinite grid**: virtual index space supports `q ∈ (−300, 300)`, `r ∈ (−200, 200)`.
  - `keyIndex(q, r) = (q + 300) + (r + 200) × 600`
  - `keyCoords(index)` is the O(1) inverse.
- **Unrotated pixel formulas** (circumradius `size`, before grid rotation):
  - `x₀ = √3·size·q + (√3/2)·size·r`
  - `y₀ = (3/2)·size·r`
- **Configurable size**: `DEFAULT_HEX_SIZE = 50`; adjustable via the Size slider (10–80).

## Grid rotation

The grid is rotated by `GRID_ANGLE = arctan(−1 / (2√3)) ≈ −16.1°` so that the diatonic octave path (**5q + 2r**) is exactly horizontal.

Derivation: one diatonic octave = 5 whole tones + 2 semitones = 5 q-steps + 2 r-steps.
For that path to have zero net vertical displacement after rotation by θ:

```
5·√3·sin θ + 2·(√3/2·sin θ + 3/2·cos θ) = 0
6√3·sin θ + 3·cos θ = 0
tan θ = −1/(2√3)
```

This derivation is layout-independent — it holds for all EDO presets. Both `hexCenter` and `hexVertices` apply this rotation. `visibleKeys` inverse-rotates the screen bounding box to compute the correct axial range.

## Pitch mapping (Bosanquet-Wilson)

```
degree = q·qStep + r·rStep
```

| EDO | `qStep` | `rStep` | right (+q) | lower-right (+r) | upper-right (+q−r), accidental |
|-----|---------|---------|------------|------------------|--------------------------------|
| 12  | 2 | 1 | whole tone | diatonic semitone | chromatic semitone |
| 19  | 3 | 2 | whole tone | diatonic semitone | chromatic semitone |
| 31  | 5 | 3 | whole tone | diatonic semitone | chromatic semitone |

All presets satisfy `5·qStep + 2·rStep = stepsPerOctave` (diatonic octave identity).

## Tuning

`getFrequency(degree) = 261.626 × 2^(degree / stepsPerOctave)`  (root = C4)

Supported EDOs: 12, 19, 31. The `TuningEngine` interface accepts any integer EDO; JI support can be added by implementing it with a ratio table.

## Spiral of fifths (`spiralFifths.ts`)

Assigns a unique note name to every pitch class by its position in the chain of fifths (…B♭–F–C–G–D–A–E–B–F♯–C♯…). Unlike the 12-TET circle, enharmonic pairs stay distinct (e.g. C♯ ≠ D♭ in 31-TET).

- **Center**: D (k = 2), the midpoint of the 7 natural notes in fifths order (F C G **D** A E B), keeping accidental counts balanced.
- **Algorithm**: modular inverse of the fifth size maps any degree to a position k on the spiral; `acc = floor((k+1)/7)` gives the accidental count.
- `spiralNote(degree, edo)` → `{ name: string, acc: number }` — works for all integers including negative and multi-octave degrees.
- `kToName(k)` — EDO-independent; returns the note name for a spiral position k (used for the spiral strip UI).
- `build12ToEdoMap(edo, modeOffset)` — returns a 12-element array mapping each 12-EDO pitch class to the corresponding EDO degree, shifted by `modeOffset` steps along the spiral. Used by the chromatic mode window and MIDI input.

## Chromatic mode window

For 19-EDO and 31-EDO, only 12 of the available pitch classes are "in mode" at a time — matching the enharmonic spelling chosen by the current spiral window. Out-of-mode keys are dimmed (L × 0.5, C × 0.5) in the static layer.

- **`modeOffset`**: integer offset along the spiral of fifths; 0 = D-centred default.
- **Shift+← →**: move the window one step flatter/sharper along the spiral.
- The spiral strip UI shows the current 12-note window with ±3 neighbours visible.
- 12-EDO always returns `null` for `inModePitchClasses` (all notes in mode, concept doesn't apply).
- `modeOffset` is clamped per EDO so every window position has a matching pitch class.

## Colour modes

### Accidentals (default)
Keys are coloured by spiral position (accidental count). Configured in `spiralLch()`:

| `acc` | L | C | H | Appearance |
|-------|---|---|---|------------|
| 0 (natural) | 0.80 | 0 | — | light gray |
| +1 (sharp) | 0.60 | 0.10 | 30 | red |
| +2 (double sharp) | 0.60 | 0.10 | 60 | orange |
| −1 (flat) | 0.60 | 0.10 | 210 | sky blue |
| −2 (double flat) | 0.60 | 0.10 | 240 | blue |
| beyond | 0.50 | 0.15 | 30 | fallback red |

### Pitch (rainbow)
Hue sweeps the full circle by pitch class: `H = (degree mod edo) / edo × 360°`. Fixed `L = 0.60`, `C = 0.10`.

### Colour formula
All colours use OKLCH for perceptual uniformity: `oklch(L C H / alpha)`.

- **Idle fill**: from `idleLCH()` per mode above.
- **Idle stroke**: `L ± STROKE_L_DELTA (0.15)`, `C × STROKE_C_FACTOR (0.7)`.
- **Active fill**: idle `L + D_ACTIVE_L (0.20)`, same C and H.
- **Active stroke**: `L + D_ACTIVE_L + STROKE_L_DELTA`.
- **Label contrast**: `L < 0.5 ? L + 0.5 : L − 0.5` (dark text on light keys, light on dark).
- **Keyboard window outline**: `oklch(KB_OUTLINE_L (0.90)  c·KB_OUTLINE_C_FACTOR (0.5)  H / KB_OUTLINE_A (1.0))` — hue-adaptive, achromatic keys stay achromatic.
- **Out-of-mode keys**: L and C multiplied by 0.5 in the static layer; label alpha also halved.

## Rendering pipeline

1. **Static layer** (OffscreenCanvas): rebuilt on tuning, layout, colour-mode, or `inModePitchClasses` change. Draws all visible idle hexes + labels, with out-of-mode keys dimmed.
2. **Dynamic overlay** (main canvas): composited every animation frame on top. Draws keyboard-window outlines and active key highlights.
   - `activeKeys`: hex indices pressed by keyboard or mouse.
   - `activeDegrees`: scale degrees active via MIDI (highlights all matching hex positions on screen).

Labels are hidden when `hexSize < 18`.

## Keyboard window

QWERTY rows map to a 4-row window into the axial grid (12 keys on rows 0–1, 11 on row 2, 10 on row 3).

- Default offset: `(qOffset, rOffset) = (−6, −2)`, centred on (0, 0) = middle C.
- **←→↑↓** arrow keys: shift the keyboard window (no grid-bounds clamping; max offset ±250).
- **Shift+← →**: shift the chromatic mode window along the spiral of fifths (see above).
- Keyboard labels (1–=, q–], a–', z–/) are drawn inside each hex at reduced size.

## MIDI input (`midiInput.ts`)

- Connects to all available Web MIDI inputs via `navigator.requestMIDIAccess`.
- MIDI note 60 = C4 = degree 0.
- For 12-EDO: `midiToDegree(note) = note − 60`.
- For 19/31-EDO: uses `build12ToEdoMap(edo, modeOffset)` to resolve each MIDI pitch class to the correct EDO degree given the current enharmonic window. Octave is chosen to minimise pitch distance from the 12-EDO degree.
- Status reported to the UI: `unavailable` | `denied` | `connected` | `no-devices`.
- `modeOffset` changes release all active MIDI notes to avoid stuck voices.
- Note-on velocity is forwarded to `audio.noteOn` as `velocity / 127`, driving the ADSR peak/sustain scaling described in "Audio engine".

## Audio engine

- Polyphonic, one `OscillatorNode + GainNode` per active voice.
- ADSR envelope (attack, decay, sustain, release) applied per voice; peak (attack target) and sustain level both scale with note velocity (`noteOn`'s `velocity` override, `0..1`).
- Waveforms: sine, triangle, sawtooth, square.
- Per-voice signal chain: `osc → gain (ADSR×velocity) → lowpass filter → StereoPannerNode → masterGain`. The lowpass (2kHz cutoff, Q = 1/√2 Butterworth) tames high harmonics, especially on sawtooth/square. `pan` (`-1`=left … `1`=right, default 0) is per-`noteOn` — scene playback passes each channel's configured pan (see "Scene editor"); the interactive page leaves it centered.
- Master bus: `masterGain → limiter (DynamicsCompressorNode) → destination`. The limiter (threshold −3dB, ratio 20:1, knee 0, attack 3ms, release 250ms) keeps the summed output of many simultaneous voices/channels from clipping, since per-voice peak gain alone doesn't bound that. `getMasterOutput()` returns the limiter (post-master-gain, pre-destination) — this is the tap point `recordingEngine` uses.
- `AudioContext` created lazily on first note (satisfies browser autoplay policy).

## Scene editor

`scene-editor.html` (`src/sceneEditor.ts`) authors and renders MIDI-driven "scenes" for educational microtonal-scale videos — separate from the interactive performance page (`index.html`/`main.ts`).

- A **scene** = one MIDI file + one keyframe timeline = one rendered `.webm` output. Multiple scenes are assembled into a full video by hand, outside the app.
- **Scene JSON** (`src/scene.ts`): `{ name, midiFile, tuning: { edo }, channels: Record<midiChannel, { waveform, adsr, pan }>, cameraKeyframes, modeKeyframes }`. `tuning.edo` is fixed for the whole scene; per-channel `waveform`/`adsr`/`pan` is static for the whole scene (not keyframable). `pan` (`-1`=left … `1`=right) is auto-seeded per channel from the MIDI file's own Pan CC (#10) when a MIDI file is loaded (`parseMidiChannelPans` in `src/midiFile.ts`), editable in the Channels table.
- **Camera keyframes** (`src/camera.ts`): `{ t, q, r, zoom, duration?, easing? }`. Hold-then-ease semantics — the camera holds at the previous keyframe's `(q, r, zoom)` until `duration` seconds before this keyframe's `t`, then eases in (`easing` ∈ `linear | easeIn | easeOut | easeInOut`, default `easeInOut`), arriving exactly at `t`.
- **Mode keyframes**: `{ t, modeOffset }`. Instant switch (no easing — `modeOffset` is discrete). Only affects the pitch mapping of subsequent note-on events and the dimmed in-mode overlay — currently-sustained notes are *not* cut off or retuned (unlike the live Shift+←/→ control, which does release active notes since it's remapping notes the performer is still holding).
- **Camera state** `{q, r, zoom}` (`src/camera.ts`) is the single source of truth for `renderer.ts`'s view transform — `RendererState.camera` (optional, defaults to `{q:0,r:0,zoom:1}`), effective hex size = `hexSize × zoom`, origin derived so `(q, r)` renders at canvas center. The interactive page never sets this field, so its behavior is unchanged.
- **Play vs. Render**: `scenePlayer.ts`'s `play()` runs the same MIDI/camera/mode clock as `render()` but skips `recordingEngine` entirely (audible preview only) and starts from the scrub head (`startAt`) instead of always `t=0`; `stop()` cancels either early. Render always renders the full scene from `t=0`, recording throughout, and auto-downloads the WebM when the MIDI ends (+ 1s release tail).
- **Scrub preview**: dragging the Time slider (or the ←/→/Home/End shortcuts) calls `updatePreview()`, which renders a static snapshot at that timestamp — camera position (`interpolateCamera`), the in-mode overlay for whatever mode keyframe is active at that time (`modeOffsetAt`/`inModePitchClassesFor`), and which notes are actually sounding then (`activeDegreesAt`, all in `src/scene.ts`/`src/scenePlayer.ts`) — without playing audio.
- **Keyboard shortcuts** (scene editor only): `Space` toggles Play/Stop and `Esc` stops — both are global and always win, regardless of focus, so neither ever falls through to a focused element's own native behavior (a button click, a `<select>` popping open, a file input's OS picker). `←`/`→` scrub 0.1s (`Shift` = 1s), `Home`/`End` jump to the start/end of the scene, and `Delete`/`Backspace` removes the selected Camera or Mode keyframe — these back off while a genuinely-editable control (number field, select, button, contenteditable) has focus, except the `#scrub` range input itself, which they take over cleanly from. The interactive page's shortcuts (arrow keys / Shift+arrows, see "Keyboard window" above) are unchanged and separate.
- Full design and rationale: `docs/superpowers/specs/2026-07-13-scene-editor-design.md`.

Ideas noted in that spec but intentionally out of scope for the first pass: caption/text-overlay keyframes, live interval/ratio readout, A/B tuning comparison, slow-motion playback, WAV-only audio export, keyframable per-channel ADSR, multi-MIDI-file scenes, interactive pan/zoom in the editor preview canvas.

## Planned extensions

- **JI support**: implement `TuningEngine` with a ratio table; `spiralFifths` already maps lattice positions to names.
- **Custom layout axes**: expose `qStep` / `rStep` sliders in the UI.
- **MIDI output**: send NoteOn/NoteOff to a Web MIDI output port.
- **Panning**: drag the canvas to pan the infinite grid.
- **Colour editor**: expose `spiralLch` breakpoints in the UI.
