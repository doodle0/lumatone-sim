// Polyphonic analog-style synth built on Tone.js: one Tone.MonoSynth (oscillator +
// amp envelope + filter + filter envelope) per active voice, panned individually and
// summed through a shared compressor/limiter bus.
// Voices are created on noteOn and released+disposed on noteOff.

import { MonoSynth, Panner, Gain, Compressor, Freeverb, getContext, start, now } from 'tone';

export interface ADSR {
  attack: number;   // seconds
  decay: number;    // seconds
  sustain: number;  // 0–1 gain level
  release: number;  // seconds
}

export interface FilterEnvelope {
  adsr: ADSR;             // filter's own attack/decay/sustain/release, independent of the amp ADSR
  baseCutoff: number;     // Hz — cutoff at rest and at envelope sustain=0
  depthOctaves: number;   // peakCutoff = baseCutoff * 2^depthOctaves; negative closes instead of opens
  resonance: number;      // filter Q — static per voice, not enveloped
}

export type WaveType = 'sine' | 'triangle' | 'sawtooth' | 'square';

export interface ReverbConfig {
  roomSize: number;  // 0–1, Freeverb's own room-size parameter (larger = longer decay)
  dampening: number; // Hz — lowpass cutoff applied to the reverberant tail (Freeverb's own param)
  wet: number;       // 0–1, dry/wet mix
}

interface Voice {
  synth: MonoSynth;
  panner: Panner;
  released: boolean;
  release: number;
}

export interface AudioEngine {
  noteOn(id: string, frequency: number, overrides?: {
    adsr?: ADSR;
    waveform?: WaveType;
    velocity?: number;
    pan?: number;
    filterEnvelope?: FilterEnvelope;
  }): void;
  noteOff(id: string): void;
  releaseAll(): void;
  setADSR(adsr: Partial<ADSR>): void;
  setWaveform(type: WaveType): void;
  setFilterEnvelope(partial: Partial<Omit<FilterEnvelope, 'adsr'>> & { adsr?: Partial<ADSR> }): void;
  setReverb(partial: Partial<ReverbConfig>): void;
  setMasterVolume(value: number): void;
  isActive(id: string): boolean;
  getAudioContext(): AudioContext;
  getMasterOutput(): AudioNode;
}

// -12dB/octave lowpass on every voice, tamed high harmonics (esp. sawtooth/square).
// A single 2-pole filter (rolloff -12) at Q = 1/√2 is the maximally-flat (Butterworth) shape.
const DEFAULT_FILTER_ENVELOPE: FilterEnvelope = {
  adsr: { attack: 0, decay: 0, sustain: 1, release: 0 },
  baseCutoff: 2000,
  depthOctaves: 0,
  resonance: Math.SQRT1_2,
};

export const DEFAULT_REVERB: ReverbConfig = { roomSize: 0.9, dampening: 3000, wet: 0.05 };

export function createAudioEngine(): AudioEngine {
  let masterGain: Gain | null = null;
  let reverb: Freeverb | null = null;
  let compressor: Compressor | null = null;
  const voices = new Map<string, Voice>();

  let adsr: ADSR = { attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.3 };
  let waveType: WaveType = 'triangle';
  let filterEnvelope: FilterEnvelope = { ...DEFAULT_FILTER_ENVELOPE };
  let reverbConfig: ReverbConfig = { ...DEFAULT_REVERB };
  let masterVolume = 0.5;

  function ensureBus(): void {
    if (getContext().state !== 'running') void start();
    if (masterGain) return;
    masterGain = new Gain(masterVolume);
    reverb = new Freeverb(reverbConfig.roomSize, reverbConfig.dampening);
    reverb.wet.value = reverbConfig.wet;
    compressor = new Compressor();
    compressor.threshold.value = -3;
    compressor.knee.value = 0;
    compressor.ratio.value = 20;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    masterGain.connect(reverb);
    reverb.connect(compressor);
    compressor.toDestination();
  }

  function startVoice(
    id: string,
    frequency: number,
    voiceAdsr: ADSR,
    voiceWave: WaveType,
    velocity: number,
    pan: number,
    voiceFilterEnv: FilterEnvelope,
  ): void {
    ensureBus();
    const t = now();

    const synth = new MonoSynth({
      oscillator: { type: voiceWave },
      envelope: {
        attack: voiceAdsr.attack,
        decay: voiceAdsr.decay,
        sustain: voiceAdsr.sustain,
        release: voiceAdsr.release,
      },
      filter: { type: 'lowpass', Q: voiceFilterEnv.resonance, rolloff: -12 },
      filterEnvelope: {
        attack: voiceFilterEnv.adsr.attack,
        decay: voiceFilterEnv.adsr.decay,
        sustain: voiceFilterEnv.adsr.sustain,
        release: voiceFilterEnv.adsr.release,
        baseFrequency: voiceFilterEnv.baseCutoff,
        octaves: voiceFilterEnv.depthOctaves,
      },
    });

    const panner = new Panner(Math.max(-1, Math.min(1, pan)));
    synth.connect(panner);
    panner.connect(masterGain!);

    synth.triggerAttack(frequency, t, velocity);

    voices.set(id, { synth, panner, released: false, release: voiceAdsr.release });
  }

  function stopVoice(id: string): void {
    const voice = voices.get(id);
    if (!voice || voice.released) return;
    voice.released = true;

    voice.synth.triggerRelease(now());
    // No native "onended" callback on Tone instruments — schedule cleanup by
    // wall-clock delay instead. Guard the map delete by identity in case a new
    // voice was already inserted at this id (see noteOn) before this fires.
    setTimeout(() => {
      voice.synth.dispose();
      voice.panner.dispose();
      if (voices.get(id) === voice) voices.delete(id);
    }, (voice.release + 0.05) * 1000);
  }

  return {
    noteOn(id, frequency, overrides): void {
      const existing = voices.get(id);
      if (existing && !existing.released) stopVoice(id);
      voices.delete(id);

      const velocity = Math.max(0, Math.min(1, overrides?.velocity ?? 1));
      startVoice(
        id,
        frequency,
        overrides?.adsr ?? adsr,
        overrides?.waveform ?? waveType,
        velocity,
        overrides?.pan ?? 0,
        overrides?.filterEnvelope ?? filterEnvelope,
      );
    },

    noteOff(id): void {
      stopVoice(id);
    },

    releaseAll(): void {
      for (const id of voices.keys()) stopVoice(id);
    },

    setADSR(partial): void {
      adsr = { ...adsr, ...partial };
    },

    setWaveform(type): void {
      waveType = type;
    },

    setFilterEnvelope(partial): void {
      filterEnvelope = {
        ...filterEnvelope,
        ...partial,
        adsr: partial.adsr ? { ...filterEnvelope.adsr, ...partial.adsr } : filterEnvelope.adsr,
      };
    },

    setReverb(partial): void {
      reverbConfig = { ...reverbConfig, ...partial };
      if (partial.roomSize !== undefined) reverb?.roomSize.rampTo(partial.roomSize, 0.02);
      if (partial.dampening !== undefined && reverb) reverb.dampening = partial.dampening;
      if (partial.wet !== undefined) reverb?.wet.rampTo(partial.wet, 0.02);
    },

    setMasterVolume(value): void {
      masterVolume = value;
      if (masterGain) masterGain.gain.rampTo(value, 0.02);
    },

    isActive(id): boolean {
      return voices.has(id);
    },

    getAudioContext(): AudioContext {
      ensureBus();
      return getContext().rawContext as AudioContext;
    },

    getMasterOutput(): AudioNode {
      ensureBus();
      // Tone.Compressor isn't literally an AudioNode, but its .connect() accepts one
      // as a native interop target (what recordingEngine.ts does) — that's the only
      // safe use of this return value; don't rely on other native AudioNode members.
      return compressor as unknown as AudioNode;
    },
  };
}
