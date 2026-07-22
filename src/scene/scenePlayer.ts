// Orchestrates scene playback: schedules MIDI note on/off, camera keyframes,
// and mode keyframes against a shared rAF clock, drives audioEngine + renderer,
// and starts/stops recordingEngine automatically for a start-to-finish render.

import type { AudioEngine } from '../audio/audioEngine.ts';
import type { Renderer, RendererState, ColorMode } from '../render/renderer.ts';
import type { RecordingEngine } from '../io/recordingEngine.ts';
import type { TuningEngine } from '../core/tuningEngine.ts';
import { TUNINGS } from '../core/tuningEngine.ts';
import type { LayoutConfig } from '../core/layout.ts';
import { LAYOUT_PRESETS } from '../core/layout.ts';
import type { Scene } from './scene.ts';
import { channelConfig, modeOffsetAt, inModePitchClassesFor } from './scene.ts';
import type { MidiEvent } from '../io/midiFile.ts';
import { midiDuration } from '../io/midiFile.ts';
import type { CameraState } from '../render/camera.ts';
import { interpolateCamera } from '../render/camera.ts';
import { midiToDegree } from '../input/midiInput.ts';
import { buildKeyboardWindow } from '../input/keyboardInput.ts';

export interface ScenePlayerCallbacks {
  onProgress(elapsedSec: number, totalSec: number): void;
  /** blob is null for play() — there's nothing to save, playback just finished. */
  onDone(blob: Blob | null): void;
  onError(error: Error): void;
}

export interface ScenePlayer {
  /** Plays the scene while recording canvas + audio, downloading a WebM on completion. */
  render(): void;
  /** Plays the scene with no recording, starting at `startAt` seconds (default 0) — for previewing in the editor. */
  play(startAt?: number): void;
  /** Stops playback/recording early, releasing all voices. Safe to call when idle. */
  stop(): void;
}

const RELEASE_TAIL_SEC = 1;
const EMPTY_KEYS = new Set<number>();

interface ActiveNote {
  degree: number;
  channel: number;
  midiNote: number;
}

function voiceId(channel: number, midiNote: number): string {
  return `scene-${channel}-${midiNote}`;
}

/**
 * Scale degrees sounding at time `t` — a static snapshot for the editor's scrub
 * preview (no audio, no rAF clock). Each note's degree is computed from the
 * modeOffset active at that note's own on-time, matching actual playback
 * (sustained notes aren't pitch-remapped by a later mode keyframe — see `run`).
 */
export function activeDegreesAt(scene: Scene, events: readonly MidiEvent[], edo: number, t: number): Set<number> {
  const active = new Map<string, number>(); // key = `${channel}:${midiNote}` -> degree
  for (const ev of events) {
    if (ev.tAbs > t) break;
    const key = `${ev.channel}:${ev.midiNote}`;
    if (ev.type === 'on') {
      active.set(key, midiToDegree(ev.midiNote, edo, modeOffsetAt(scene.modeKeyframes, ev.tAbs)));
    } else {
      active.delete(key);
    }
  }
  return new Set(active.values());
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

  let rafId = 0;
  let stopFn: (() => void) | null = null;

  function run(recordingEnabled: boolean, startAt: number): void {
    const activeDegrees = new Set<number>();
    const activeNotes = new Map<string, ActiveNote>(); // key = `${channel}:${midiNote}`

    // Fast-forward past everything at or before startAt: already-elapsed MIDI
    // events aren't replayed (notes "already sounding" at the seek point don't
    // retroactively fire), and modeOffset/inModePcs are seeded from whichever
    // mode keyframe was active at startAt.
    let eventIdx = events.findIndex((e) => e.tAbs >= startAt);
    if (eventIdx === -1) eventIdx = events.length;
    let modeKfIdx = scene.modeKeyframes.findIndex((kf) => kf.t > startAt);
    if (modeKfIdx === -1) modeKfIdx = scene.modeKeyframes.length;
    let modeOffset = modeOffsetAt(scene.modeKeyframes, startAt);
    let inModePcs = inModePitchClassesFor(tuning.stepsPerOctave, modeOffset);

    if (recordingEnabled) {
      try {
        recording.start();
      } catch (err) {
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    const startTime = performance.now();

    function finish(): void {
      stopFn = null;
      audio.releaseAll();
      if (recordingEnabled) {
        recording.stop()
          .then((blob) => callbacks.onDone(blob))
          .catch((err) => callbacks.onError(err instanceof Error ? err : new Error(String(err))));
      } else {
        callbacks.onDone(null);
      }
    }

    stopFn = () => {
      cancelAnimationFrame(rafId);
      finish();
    };

    function frame(): void {
      const elapsed = startAt + (performance.now() - startTime) / 1000;

      // Mode keyframes: instant switch. Only affects the pitch mapping of
      // subsequent note-on events and the dimmed in-mode overlay — currently
      // sustained notes keep sounding at their already-computed frequency.
      while (modeKfIdx < scene.modeKeyframes.length && scene.modeKeyframes[modeKfIdx]!.t <= elapsed) {
        modeOffset = scene.modeKeyframes[modeKfIdx]!.modeOffset;
        inModePcs = inModePitchClassesFor(tuning.stepsPerOctave, modeOffset);
        modeKfIdx++;
      }

      // MIDI note on/off.
      while (eventIdx < events.length && events[eventIdx]!.tAbs <= elapsed) {
        const ev = events[eventIdx]!;
        const key = `${ev.channel}:${ev.midiNote}`;
        if (ev.type === 'on') {
          const degree = midiToDegree(ev.midiNote, tuning.stepsPerOctave, modeOffset);
          const { waveform, adsr, pan } = channelConfig(scene, ev.channel);
          activeNotes.set(key, { degree, channel: ev.channel, midiNote: ev.midiNote });
          activeDegrees.add(degree);
          const velocity = Math.max(0, Math.min(1, ev.velocity / 127));
          audio.noteOn(voiceId(ev.channel, ev.midiNote), tuning.getFrequency(degree), { adsr, waveform, velocity, pan });
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
        finish();
        return;
      }
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
  }

  return {
    render(): void { run(true, 0); },
    play(startAt = 0): void { run(false, startAt); },
    stop(): void { stopFn?.(); },
  };
}
