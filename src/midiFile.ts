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

/**
 * Each track's initial Pan CC (#10), in the Web Audio StereoPannerNode range
 * [-1, 1] (-1 = full left, 0 = center, 1 = full right). A channel with no Pan
 * CC in the file is omitted (callers should default it to 0/center).
 */
export function parseMidiChannelPans(buffer: ArrayBuffer): Record<number, number> {
  const midi = new Midi(buffer);
  const pans: Record<number, number> = {};

  for (const track of midi.tracks) {
    const panCcs = track.controlChanges.pan;
    if (panCcs && panCcs.length > 0) {
      pans[track.channel] = panCcs[0]!.value * 2 - 1;
    }
  }

  return pans;
}
