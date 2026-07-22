// Polyphonic analog-style synth: sine (or other wave) with per-voice ADSR envelopes.
// One voice = OscillatorNode + GainNode per active note.
// Voices are created on noteOn and released on noteOff.

export interface ADSR {
  attack: number;   // seconds
  decay: number;    // seconds
  sustain: number;  // 0–1 gain level
  release: number;  // seconds
}

export type WaveType = OscillatorType; // 'sine' | 'sawtooth' | 'triangle' | 'square'

interface Voice {
  osc: OscillatorNode;
  gain: GainNode;
  released: boolean;
  release: number;
}

export interface AudioEngine {
  noteOn(id: string, frequency: number, overrides?: { adsr?: ADSR; waveform?: WaveType; velocity?: number; pan?: number }): void;
  noteOff(id: string): void;
  releaseAll(): void;
  setADSR(adsr: Partial<ADSR>): void;
  setWaveform(type: WaveType): void;
  setMasterVolume(value: number): void;
  isActive(id: string): boolean;
  getAudioContext(): AudioContext;
  getMasterOutput(): AudioNode;
}

// -12dB/octave lowpass on every voice, tamed high harmonics (esp. sawtooth/square).
// A single 2-pole BiquadFilterNode already rolls off at -12dB/octave past cutoff;
// Q = 1/√2 is the maximally-flat (Butterworth) value, so there's no resonant bump.
const FILTER_CUTOFF_HZ = 2000;
const FILTER_Q = Math.SQRT1_2;

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  // Sits after masterGain, before destination — keeps the summed output of
  // however many notes/channels are sounding at once from exceeding 0dB,
  // since per-voice peak gain (velocity * sustain) alone doesn't bound that.
  let limiter: DynamicsCompressorNode | null = null;
  const voices = new Map<string, Voice>();

  let adsr: ADSR = { attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.3 };
  let waveType: WaveType = 'triangle';
  let masterVolume = 0.5;

  function ensureCtx(): AudioContext {
    if (!ctx) {
      ctx = new AudioContext();
      masterGain = ctx.createGain();
      masterGain.gain.value = masterVolume;
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      masterGain.connect(limiter);
      limiter.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function startVoice(id: string, frequency: number, voiceAdsr: ADSR, voiceWave: WaveType, velocity: number, pan: number): void {
    const context = ensureCtx();
    const now = context.currentTime;

    const osc = context.createOscillator();
    osc.type = voiceWave;
    osc.frequency.value = frequency;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    // Attack — peak scales with note velocity (dynamics).
    gain.gain.linearRampToValueAtTime(velocity, now + voiceAdsr.attack);
    // Decay to sustain
    gain.gain.setTargetAtTime(voiceAdsr.sustain * velocity, now + voiceAdsr.attack, voiceAdsr.decay / 3);

    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_CUTOFF_HZ;
    filter.Q.value = FILTER_Q;

    const panner = context.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));

    osc.connect(gain);
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(masterGain!);
    osc.start(now);

    voices.set(id, { osc, gain, released: false, release: voiceAdsr.release });
  }

  function stopVoice(id: string): void {
    const voice = voices.get(id);
    if (!voice || voice.released) return;
    voice.released = true;

    const context = ensureCtx();
    const now = context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + voice.release);
    voice.osc.stop(now + voice.release + 0.01);
    voice.osc.onended = () => { voices.delete(id); };
  }

  return {
    noteOn(id: string, frequency: number, overrides?: { adsr?: ADSR; waveform?: WaveType; velocity?: number; pan?: number }): void {
      const existing = voices.get(id);
      if (existing) {
        // Initiate release ramp if not already releasing.
        if (!existing.released) stopVoice(id);
        // Detach the onended callback so the old oscillator's natural end
        // cannot delete the new voice we're about to insert at the same id.
        existing.osc.onended = null;
        voices.delete(id);
      }
      const velocity = Math.max(0, Math.min(1, overrides?.velocity ?? 1));
      startVoice(id, frequency, overrides?.adsr ?? adsr, overrides?.waveform ?? waveType, velocity, overrides?.pan ?? 0);
    },

    noteOff(id: string): void {
      stopVoice(id);
    },

    releaseAll(): void {
      for (const id of voices.keys()) stopVoice(id);
    },

    setADSR(partial: Partial<ADSR>): void {
      adsr = { ...adsr, ...partial };
    },

    setWaveform(type: WaveType): void {
      waveType = type;
    },

    setMasterVolume(value: number): void {
      masterVolume = value;
      if (masterGain) masterGain.gain.setTargetAtTime(value, ensureCtx().currentTime, 0.02);
    },

    isActive(id: string): boolean {
      return voices.has(id);
    },

    getAudioContext(): AudioContext {
      return ensureCtx();
    },

    getMasterOutput(): AudioNode {
      ensureCtx();
      return limiter!;
    },
  };
}
