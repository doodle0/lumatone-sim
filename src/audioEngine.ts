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
}

export interface AudioEngine {
  noteOn(id: string, frequency: number): void;
  noteOff(id: string): void;
  releaseAll(): void;
  setADSR(adsr: Partial<ADSR>): void;
  setWaveform(type: WaveType): void;
  setMasterVolume(value: number): void;
  isActive(id: string): boolean;
}

export function createAudioEngine(): AudioEngine {
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  const voices = new Map<string, Voice>();

  let adsr: ADSR = { attack: 0.01, decay: 0.1, sustain: 0.1, release: 0.3 };
  let waveType: WaveType = 'triangle';
  let masterVolume = 0.5;

  function ensureCtx(): AudioContext {
    if (!ctx) {
      ctx = new AudioContext();
      masterGain = ctx.createGain();
      masterGain.gain.value = masterVolume;
      masterGain.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function startVoice(id: string, frequency: number): void {
    const context = ensureCtx();
    const now = context.currentTime;

    const osc = context.createOscillator();
    osc.type = waveType;
    osc.frequency.value = frequency;

    const gain = context.createGain();
    gain.gain.setValueAtTime(0, now);
    // Attack
    gain.gain.linearRampToValueAtTime(1.0, now + adsr.attack);
    // Decay to sustain
    gain.gain.setTargetAtTime(adsr.sustain, now + adsr.attack, adsr.decay / 3);

    osc.connect(gain);
    gain.connect(masterGain!);
    osc.start(now);

    voices.set(id, { osc, gain, released: false });
  }

  function stopVoice(id: string): void {
    const voice = voices.get(id);
    if (!voice || voice.released) return;
    voice.released = true;

    const context = ensureCtx();
    const now = context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + adsr.release);
    voice.osc.stop(now + adsr.release + 0.01);
    voice.osc.onended = () => { voices.delete(id); };
  }

  return {
    noteOn(id: string, frequency: number): void {
      const existing = voices.get(id);
      if (existing) {
        // Initiate release ramp if not already releasing.
        if (!existing.released) stopVoice(id);
        // Detach the onended callback so the old oscillator's natural end
        // cannot delete the new voice we're about to insert at the same id.
        existing.osc.onended = null;
        voices.delete(id);
      }
      startVoice(id, frequency);
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
  };
}
