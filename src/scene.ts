// Scene JSON schema: a MIDI-driven timeline of camera and mode-window keyframes,
// plus static per-channel instrument config. See docs/superpowers/specs/2026-07-13-scene-editor-design.md.

import type { ADSR, WaveType } from './audioEngine.ts';
import type { CameraKeyframe } from './camera.ts';
import { build12ToEdoMap } from './spiralFifths.ts';

export interface ModeKeyframe {
  t: number;
  modeOffset: number;
}

/** modeOffset active at time `t`: the last keyframe at or before `t` (instant switch, no interpolation), else 0. */
export function modeOffsetAt(keyframes: readonly ModeKeyframe[], t: number): number {
  let offset = 0;
  for (const kf of keyframes) {
    if (kf.t > t) break;
    offset = kf.modeOffset;
  }
  return offset;
}

/** In-mode pitch classes for `edo` at the given `modeOffset`; null for 12-EDO (the concept doesn't apply). */
export function inModePitchClassesFor(edo: number, modeOffset: number): Set<number> | null {
  return edo === 12 ? null : new Set(build12ToEdoMap(edo, modeOffset));
}

export interface ChannelConfig {
  waveform: WaveType;
  adsr: ADSR;
  /** Stereo position in [-1, 1] (-1 = full left, 0 = center, 1 = full right). */
  pan: number;
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
  pan: 0,
};

/** Config for a channel, falling back to the default if the scene doesn't configure it. */
export function channelConfig(scene: Scene, channel: number): ChannelConfig {
  return scene.channels[channel] ?? DEFAULT_CHANNEL_CONFIG;
}

/**
 * A minimal scene for a freshly loaded MIDI file with no scene JSON yet —
 * no camera/mode keyframes, 12-EDO, default channel config. Lets the editor
 * preview and render without requiring the user to author JSON first.
 */
export function createDefaultScene(midiFileName: string): Scene {
  return {
    name: midiFileName.replace(/\.[^.]+$/, ''),
    midiFile: midiFileName,
    tuning: { edo: 12 },
    channels: {},
    cameraKeyframes: [],
    modeKeyframes: [],
  };
}

function isValidAdsr(v: unknown): v is ADSR {
  const a = v as Partial<ADSR> | undefined;
  return !!a
    && typeof a.attack === 'number'
    && typeof a.decay === 'number'
    && typeof a.sustain === 'number'
    && typeof a.release === 'number';
}

function hasNumericT<T extends { t: unknown }>(v: T): v is T & { t: number } {
  return typeof v === 'object' && v !== null && typeof v.t === 'number';
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
      channels[channel] = {
        waveform: DEFAULT_CHANNEL_CONFIG.waveform,
        adsr: { ...DEFAULT_CHANNEL_CONFIG.adsr },
        pan: DEFAULT_CHANNEL_CONFIG.pan,
      };
      continue;
    }
    channels[channel] = {
      waveform: v.waveform as WaveType,
      adsr: v.adsr,
      pan: typeof v.pan === 'number' ? v.pan : DEFAULT_CHANNEL_CONFIG.pan,
    };
  }

  return {
    name: raw.name,
    midiFile: raw.midiFile,
    tuning: { edo: raw.tuning.edo },
    channels,
    cameraKeyframes: raw.cameraKeyframes.filter((kf) => {
      if (hasNumericT(kf)) return true;
      console.warn('Scene JSON: dropping cameraKeyframe with invalid or missing "t"', kf);
      return false;
    }).sort((a, b) => a.t - b.t),
    modeKeyframes: raw.modeKeyframes.filter((kf) => {
      if (hasNumericT(kf)) return true;
      console.warn('Scene JSON: dropping modeKeyframe with invalid or missing "t"', kf);
      return false;
    }).sort((a, b) => a.t - b.t),
  };
}
