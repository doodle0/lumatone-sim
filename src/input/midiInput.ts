// Web MIDI input — connects to all available MIDI inputs and fires note callbacks.
// MIDI note 60 = C4 = degree 0 in our system.

import { build12ToEdoMap } from '../core/spiralFifths.ts';

export type MidiStatus = 'unavailable' | 'denied' | 'connected' | 'no-devices';

export interface MidiController {
  dispose(): void;
}

export async function createMidiInput(
  onNoteOn: (midiNote: number, velocity: number) => void,
  onNoteOff: (midiNote: number) => void,
  onStatus: (s: MidiStatus) => void,
): Promise<MidiController> {
  if (!navigator.requestMIDIAccess) {
    onStatus('unavailable');
    return { dispose() {} };
  }

  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess();
  } catch {
    onStatus('denied');
    return { dispose() {} };
  }

  function handleMessage(e: MIDIMessageEvent): void {
    if (!e.data || e.data.length < 2) return;
    const status = e.data[0]!;
    const note = e.data[1]!;
    const velocity = e.data[2] ?? 0;
    const type = status & 0xf0;
    if (type === 0x90 && velocity > 0) {
      onNoteOn(note, velocity);
    } else if (type === 0x80 || (type === 0x90 && velocity === 0)) {
      onNoteOff(note);
    }
  }

  function attachAll(): void {
    for (const input of access.inputs.values()) {
      input.onmidimessage = handleMessage;
    }
    onStatus(access.inputs.size > 0 ? 'connected' : 'no-devices');
  }

  attachAll();

  access.onstatechange = () => attachAll();

  return {
    dispose() {
      access.onstatechange = null;
      for (const input of access.inputs.values()) {
        input.onmidimessage = null;
      }
    },
  };
}

// Cached pitch-class maps, keyed by "edo:modeOffset".
const edoMapCache = new Map<string, number[]>();

function getEdoMap(edo: number, modeOffset: number): number[] {
  const key = `${edo}:${modeOffset}`;
  let m = edoMapCache.get(key);
  if (!m) { m = build12ToEdoMap(edo, modeOffset); edoMapCache.set(key, m); }
  return m;
}

/**
 * Maps a MIDI note number to a degree in the given EDO.
 *
 * For 12-EDO this is simply midiNote − 60 (modeOffset has no effect on pitch).
 * For 19/31-EDO the modeOffset shifts the enharmonic window: e.g. at offset −1
 * MIDI C# maps to Db (a slightly higher pitch in 31-EDO).
 */
export function midiToDegree(midiNote: number, edo: number, modeOffset = 0): number {
  const degree12 = midiNote - 60;
  if (edo === 12) return degree12;
  const pc12  = ((degree12 % 12) + 12) % 12;
  const pcEdo = getEdoMap(edo, modeOffset)[pc12]!;
  // Pick the octave that places pcEdo closest in pitch to degree12.
  // (floor-based octave is wrong when pcEdo is near the top of the EDO range,
  // e.g. B# at pcEdo=30 in 31-EDO must land at −1, not +30.)
  const target = degree12 * edo / 12;
  const octave = Math.round((target - pcEdo) / edo);
  return octave * edo + pcEdo;
}
