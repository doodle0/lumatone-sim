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
