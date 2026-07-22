// Frequency calculation for equal-temperament tunings.
// Designed so JI can be added later by implementing TuningEngine with a different strategy.

export interface TuningEngine {
  readonly label: string;
  readonly stepsPerOctave: number;
  /** Returns frequency in Hz for a given scale degree (can be negative or > stepsPerOctave). */
  getFrequency(degree: number): number;
}

export function createEDOTuning(
  edo: number,
  rootHz = 261.626,   // C4
): TuningEngine {
  return {
    label: `${edo}-TET`,
    stepsPerOctave: edo,
    getFrequency(degree: number): number {
      return rootHz * 2 ** (degree / edo);
    },
  };
}

export const TUNINGS: Record<string, TuningEngine> = {
  '12': createEDOTuning(12),
  '19': createEDOTuning(19),
  '31': createEDOTuning(31),
};
