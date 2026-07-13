// Parses a Standard MIDI File into a flat, time-sorted list of note on/off events.
// Uses @tonejs/midi (this project's one deliberate external runtime dependency)
// because it resolves tempo-map timing to absolute seconds for us.

import { Midi } from '@tonejs/midi';

export interface MidiEvent {
  tAbs: number;    // seconds from the start of the file
  channel: number;
  midiNote: number;
  velocity: number; // 0-127; 0 for 'off' events
  type: 'on' | 'off';
}

export function parseMidiFile(buffer: ArrayBuffer): MidiEvent[] {
  const midi = new Midi(buffer);
  const events: MidiEvent[] = [];

  for (const track of midi.tracks) {
    for (const note of track.notes) {
      events.push({
        tAbs: note.time,
        channel: track.channel,
        midiNote: note.midi,
        velocity: Math.round(note.velocity * 127),
        type: 'on',
      });
      events.push({
        tAbs: note.time + note.duration,
        channel: track.channel,
        midiNote: note.midi,
        velocity: 0,
        type: 'off',
      });
    }
  }

  events.sort((a, b) => a.tAbs - b.tAbs);
  return events;
}

/** Time of the last event, in seconds. 0 for an empty event list. */
export function midiDuration(events: readonly MidiEvent[]): number {
  return events.length === 0 ? 0 : events[events.length - 1]!.tAbs;
}
