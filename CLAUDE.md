# Lumatone Simulator

Browser-based simulator for the Lumatone microtonal keyboard instrument. Pure TypeScript + Vite, no external runtime dependencies.

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
| `src/main.ts` | Wires all modules; handles keyboard, mouse, MIDI, UI controls, resize. |

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

## Audio engine

- Polyphonic, one `OscillatorNode + GainNode` per active voice.
- ADSR envelope (attack, decay, sustain, release) applied per voice.
- Master gain with smooth ramping.
- Waveforms: sine, triangle, sawtooth, square.
- `AudioContext` created lazily on first note (satisfies browser autoplay policy).

## Planned extensions

- **JI support**: implement `TuningEngine` with a ratio table; `spiralFifths` already maps lattice positions to names.
- **Custom layout axes**: expose `qStep` / `rStep` sliders in the UI.
- **MIDI output**: send NoteOn/NoteOff to a Web MIDI output port.
- **Panning**: drag the canvas to pan the infinite grid.
- **Colour editor**: expose `spiralLch` breakpoints in the UI.
