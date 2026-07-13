# Scene Editor & Video Scene Rendering — Design

**Date**: 2026-07-13
**Status**: Approved, not yet implemented

## Goal

Turn Lumatone into a video-scene creation tool for educational microtonal-scale videos. A "scene" is a MIDI file plus a scripted camera (pan/zoom) and mode-window timeline. You author scenes visually in a dedicated editor, then render each one to a local WebM file (reusing the existing `recordingEngine.ts`). Multiple rendered clips are assembled into a full video manually, outside the app.

## Scope decisions (from brainstorming)

- One scene = one MIDI file + one keyframe timeline = one rendered output file. Multiple scenes are separate JSON files, sequenced by hand later.
- "Mode" keyframes affect only `modeOffset` (the chromatic mode window / enharmonic spelling), not EDO or color mode — those stay fixed for the whole scene.
- Per-MIDI-channel ADSR + waveform is a **static** config for the whole scene (not keyframable). Keyframable per-channel ADSR is a possible future extension, not in scope now.
- Camera keyframes ease in: the camera **holds** at the previous value, then eases into the next keyframe's `(q, r, zoom)` over an explicit `duration` ending exactly at `t`. It does not continuously interpolate across the whole timeline — matches that panning is mostly static with occasional moves (an After-Effects-style "hold then animate" scheme, not a continuous spline).
- Camera state `{q, r, zoom}` (floating axial position + zoom multiplier) is the single source of truth for the view; it is layered generally into `hexGrid`/`renderer` rather than reusing the existing `hexSize` slider / fixed-origin assumption.
- Rendering is fully automatic: load a scene + its MIDI file, click Render, it plays start-to-finish while recording, and auto-downloads the WebM when the MIDI ends. No manual start/stop during playback.
- MIDI files are parsed using a small external MIDI-parsing library — a deliberate, explicit exception to the project's zero-runtime-dependency principle (see CLAUDE.md). Everything else in the project stays dependency-free.
- The scene editor includes a **visual timeline** (draggable keyframe markers on Camera/Mode tracks + a playhead), not just raw JSON editing — reduces hand-typing JSON.
- Camera keyframe values are entered **numerically** in v1 (no interactive pan/zoom drag in the preview canvas yet — that's a follow-on).
- Educational extras suggested during brainstorming (caption keyframes, interval/ratio readout, A/B tuning comparison, slow-motion playback, WAV-only export) are explicitly **out of scope** for this spec; listed under Planned Extensions.

## Architecture

New scene editor lives on a **separate page** (`scene-editor.html` + `src/sceneEditor.ts`), a second Vite entry point alongside the existing `index.html`/`main.ts`. It shares core engine modules (`audioEngine`, `renderer`, `hexGrid`, `tuningEngine`, `spiralFifths`, `midiInput`'s `midiToDegree`) via plain imports, but has its own UI/state — kept separate from the live-performance path so the timeline editor's complexity can't bloat or risk-regress `main.ts`.

### Scene JSON schema

```jsonc
{
  "name": "Demo scene",
  "midiFile": "demo.mid",          // label only, for the human — loaded separately via file picker
  "tuning": { "edo": 31 },          // fixed for the whole scene
  "channels": {
    "0": { "waveform": "triangle", "adsr": { "attack": 0.01, "decay": 0.1, "sustain": 0.6, "release": 0.3 } },
    "1": { "waveform": "sine",     "adsr": { "attack": 0.5,  "decay": 0.3, "sustain": 0.8, "release": 1.2 } }
  },
  "cameraKeyframes": [
    { "t": 0,    "q": 0, "r": 0,  "zoom": 1.0 },                      // initial state, no incoming transition
    { "t": 8.5,  "q": 6, "r": -2, "zoom": 1.8, "duration": 1.5, "easing": "easeInOut" },
    { "t": 20,   "q": 0, "r": 0,  "zoom": 1.0, "duration": 2.0, "easing": "easeInOut" }
  ],
  "modeKeyframes": [
    { "t": 0,    "modeOffset": 0 },
    { "t": 12.3, "modeOffset": -1 }
  ]
}
```

- `t` is seconds from the start of MIDI playback — the single shared clock for all tracks.
- `easing` is one of `"linear" | "easeIn" | "easeOut" | "easeInOut"` (standard cubic ease curves); omitted defaults to `"easeInOut"`.
- Mode keyframes are instant switches (no easing — `modeOffset` is discrete); reuses the existing "release all active notes on modeOffset change" behavior from `midiInput.ts`.
- Channels not listed fall back to default waveform/ADSR.

### Module breakdown

| Module | Status | Responsibility |
|---|---|---|
| `src/midiFile.ts` | new | Wraps the external MIDI-parsing library; converts a parsed `.mid` into a flat, tempo-resolved, time-sorted list of `{ tAbs: seconds, channel, midiNote, velocity, type: 'on'\|'off' }`. |
| `src/camera.ts` | new | `CameraState { q, r, zoom }` + a pure function that, given a keyframe list and a playback time, returns the interpolated (hold/ease) camera state. No DOM/canvas dependency. |
| `src/hexGrid.ts` | modified | Generalize `hexCenter`/`visibleKeys` so the axial "focus" point and its screen pixel position are explicit parameters, instead of hardcoding `(0,0)` at canvas center. Existing callers keep passing `(0,0)` + canvas-center, so interactive mode (`main.ts`) is unaffected. |
| `src/renderer.ts` | modified | `RendererState` gains a `camera: CameraState` field (default `{q:0,r:0,zoom:1}` preserves current behavior). Effective hex size = `hexSize * camera.zoom`; origin comes from the generalized `hexGrid` functions. |
| `src/audioEngine.ts` | modified | `noteOn(id, frequency, overrides?: { adsr?: ADSR, waveform?: WaveType })` — optional per-call override, defaulting to current global settings. Existing keyboard/mouse/live-MIDI call sites are unaffected (they omit the third arg). |
| `src/scenePlayer.ts` | new | Orchestrator. Runs a `requestAnimationFrame` clock from `t=0` given a parsed scene + MIDI events: fires MIDI on/off events via `audioEngine` (using the channel's ADSR/waveform override and `midiToDegree`), updates `renderer`'s camera via `camera.ts`, applies mode keyframes (updates `modeOffset`, rebuilds the static layer, releases active notes). Calls `recordingEngine.start()` at `t=0`; calls `.stop()` after the last MIDI event plus a short release-tail grace period. |
| `scene-editor.html` + `src/sceneEditor.ts` | new | File pickers (scene JSON, MIDI file), preview canvas (reusing `renderer.ts` in scrub mode), transport + playhead, Camera/Mode keyframe tracks with draggable markers and a property inspector, channel/ADSR config table, Save/Load Scene JSON, Render button. |

Scene-playback voice IDs use a `scene-{channel}-{note}` prefix, distinct from `main.ts`'s `key-`/`midi-` prefixes.

### Timeline editor UI

- Preview canvas (read-only "scrub" mode, reusing `renderer.ts`) + transport controls (play/pause/scrub, current time) + Camera and Mode keyframe tracks below + a collapsible channel/ADSR config table.
- Keyframe markers are draggable along the time axis (updates `t`); click to select and edit properties (q/r/zoom/duration/easing, or modeOffset) in an inspector; add via button or double-click on the track; delete via the inspector.
- Scrubbing the playhead updates the preview canvas live (camera + mode state at that time) without audio. Audio only plays during an explicit "Preview with audio" action or an actual Render.
- Camera keyframe values are entered numerically in the inspector for v1 (no interactive drag-to-pan/scroll-to-zoom in the preview canvas yet).
- Render button is disabled until both a scene and a MIDI file are loaded.

### Render & recording workflow

Render → `scenePlayer` resets `renderer`'s camera/mode to the scene's `t=0` state → `recordingEngine.start()` (existing canvas+audio capture) → rAF clock fires MIDI/camera/mode events in order, editing controls disabled, progress shown as elapsed/total → after the last MIDI event and a release-tail grace period (~1s), `recordingEngine.stop()` triggers the existing auto-download flow (e.g. `<scene-name>-<timestamp>.webm`).

### Error handling

- Malformed/unparseable MIDI file: show an inline error near the file picker; don't crash the page.
- Scene JSON with an invalid channel waveform or missing ADSR field: fall back to defaults, log a console warning (non-fatal — the editor itself authors valid JSON, so this mainly guards hand-edited files).
- If `recordingEngine.start()` throws (e.g. unsupported browser): abort the render and show an error, rather than silently playing through unrecorded. (This also closes a gap in the current `main.ts` Record button, which has no such handling today.)

### Testing

No test framework exists in this project currently; verification is manual (dev server, render a short test scene end-to-end, inspect the output file), consistent with the rest of the codebase. `camera.ts`'s interpolation math and `midiFile.ts`'s event-flattening are the most bug-prone pure-function pieces, and are the best first candidates if/when a test runner is introduced — noted rather than acted on, since introducing a test framework is out of scope for this feature.

## Out of scope / Planned extensions

- Interactive pan/zoom (drag/scroll) in the scene-editor preview canvas, with a "capture current view as keyframe" button.
- Caption/text-overlay keyframes (timestamped on-screen text).
- Interval/ratio readout (live cents/JI-ratio display between sounding notes).
- A/B tuning comparison (flash between two modeOffset/EDO settings on the same notes).
- Slow-motion playback (scene-level playback-rate multiplier).
- Audio-only (WAV) export alongside the WebM, for use as a voiceover bed.
- Keyframable (not just static) per-channel ADSR.
- Scenes referencing multiple MIDI files/segments on one timeline.
