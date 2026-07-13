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
