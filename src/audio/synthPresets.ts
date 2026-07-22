// Named synth presets combining waveform + amp ADSR + filter envelope, selectable
// as a one-time snapshot into the live/scene-editor controls (not a live link —
// later manual edits to the fields aren't overwritten). Parameter values are
// original, informed by general subtractive-synthesis sound-design conventions
// for these patch archetypes, not copied from any specific commercial preset.

import type { ADSR, WaveType, FilterEnvelope } from './audioEngine.ts';

export interface SynthPreset {
  name: string;
  waveform: WaveType;
  adsr: ADSR;
  filterEnvelope: FilterEnvelope;
}

export const SYNTH_PRESETS: SynthPreset[] = [
  {
    name: 'Default (no sweep)',
    waveform: 'triangle',
    adsr: { attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.3 },
    filterEnvelope: {
      adsr: { attack: 0, decay: 0, sustain: 1, release: 0 },
      baseCutoff: 2000,
      depthOctaves: 0,
      resonance: Math.SQRT1_2,
    },
  },
  {
    name: 'Classic Pluck',
    waveform: 'triangle',
    adsr: { attack: 0.005, decay: 0.15, sustain: 0.05, release: 0.2 },
    filterEnvelope: {
      adsr: { attack: 0.005, decay: 0.12, sustain: 0.1, release: 0.15 },
      baseCutoff: 300,
      depthOctaves: 3.5,
      resonance: 4,
    },
  },
  {
    name: 'Warm Pad',
    waveform: 'triangle',
    adsr: { attack: 0.8, decay: 0.4, sustain: 0.8, release: 1.2 },
    filterEnvelope: {
      adsr: { attack: 1.0, decay: 0.5, sustain: 0.6, release: 1.0 },
      baseCutoff: 400,
      depthOctaves: 2,
      resonance: 1,
    },
  },
  {
    name: 'Sub Bass',
    waveform: 'sawtooth',
    adsr: { attack: 0.002, decay: 0.1, sustain: 0.7, release: 0.15 },
    filterEnvelope: {
      adsr: { attack: 0.002, decay: 0.08, sustain: 0.3, release: 0.1 },
      baseCutoff: 150,
      depthOctaves: 2.5,
      resonance: 2,
    },
  },
  {
    name: 'Analog Lead',
    waveform: 'sawtooth',
    adsr: { attack: 0.01, decay: 0.1, sustain: 0.8, release: 0.2 },
    filterEnvelope: {
      adsr: { attack: 0.01, decay: 0.3, sustain: 0.5, release: 0.25 },
      baseCutoff: 600,
      depthOctaves: 3,
      resonance: 6,
    },
  },
  {
    name: 'Brass Swell',
    waveform: 'square',
    adsr: { attack: 0.08, decay: 0.15, sustain: 0.75, release: 0.3 },
    filterEnvelope: {
      adsr: { attack: 0.15, decay: 0.2, sustain: 0.6, release: 0.3 },
      baseCutoff: 500,
      depthOctaves: 2.5,
      resonance: 2,
    },
  },
];
