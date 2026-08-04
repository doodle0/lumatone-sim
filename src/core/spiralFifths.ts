// Spiral-of-fifths note naming for equal-division-of-the-octave tunings.
//
// The spiral assigns a unique name to every pitch class based on its position
// in the chain of fifths  …Bb – F – C – G – D – A – E – B – F# – C#…
// Unlike the 12-TET circle of fifths, enharmonic pairs are kept distinct:
// e.g. in 31-TET, C# (k=7) and Db (k=−5) are genuinely different pitches.
//
// D (k=2) is used as the spiral center because it is the midpoint of the
// seven natural notes in fifths order (F C G **D** A E B), which keeps the
// accidental count balanced for typical playing ranges.

// Seven natural note names ordered by ascending fifths: F(−1) C(0) G(1) D(2) A(3) E(4) B(5).
// Stored starting at F so that index = ((k + 1) mod 7 + 7) mod 7.
const LETTERS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'] as const;
const D_FIFTH_POS = 2; // D is 2 ascending fifths from C

function modinv(a: number, m: number): number {
  let [r0, r1] = [a, m];
  let [s0, s1] = [1, 0];
  while (r1 !== 0) {
    const q = Math.floor(r0 / r1);
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  return ((s0 % m) + m) % m;
}

/** Fifth-position k for the given degree, centered on D (k = D_FIFTH_POS = 2). */
function computeK(degree: number, edo: number): number {
  const fifth = Math.round(edo * Math.log2(3 / 2));
  const inv   = modinv(fifth, edo);
  const pc    = ((degree % edo) + edo) % edo;
  const kRaw  = (pc * inv) % edo;
  const half  = Math.floor(edo / 2);
  const lo    = D_FIFTH_POS - half;
  return ((kRaw - lo) % edo + edo) % edo + lo;
}

export interface SpiralNote {
  /** Note name, e.g. "C", "F♯", "D♭". */
  name: string;
  /** Sharps count (positive) or flats count (negative). 0 = natural. */
  acc: number;
}

/**
 * Returns the spiral-of-fifths note name and accidental count for a degree.
 * Works for any integer degree (negative, multi-octave).
 *
 * Examples (31-TET):
 *   spiralNote(0,  31) → { name: "C",  acc:  0 }
 *   spiralNote(18, 31) → { name: "G",  acc:  0 }
 *   spiralNote(2,  31) → { name: "C♯", acc:  1 }   ← chromatic semitone
 *   spiralNote(3,  31) → { name: "D♭", acc: −1 }   ← diatonic semitone (distinct pitch)
 */
export function spiralNote(degree: number, edo: number): SpiralNote {
  const k         = computeK(degree, edo);
  const letterIdx = ((k + 1) % 7 + 7) % 7;
  const acc       = Math.floor((k + 1) / 7);
  const name      = LETTERS[letterIdx] + (acc >= 0 ? '♯'.repeat(acc) : '♭'.repeat(-acc));
  return { name, acc };
}

/** Convenience wrapper returning just the note name string. */
export function spiralName(degree: number, edo: number): string {
  return spiralNote(degree, edo).name;
}

/** Note name for spiral position k (EDO-independent). */
export function kToName(k: number): string {
  const letterIdx = ((k + 1) % 7 + 7) % 7;
  const acc       = Math.floor((k + 1) / 7);
  const letter    = LETTERS[letterIdx]!;
  if (acc > 0) return letter + '♯'.repeat(acc);
  if (acc < 0) return letter + '♭'.repeat(-acc);
  return letter;
}

/**
 * Returns a 12-element lookup table: entry [pc12] is the pitch class in `edo`
 * whose spiral position matches the note name chosen by 12-EDO for that pitch
 * class, shifted by `modeOffset` steps along the spiral.
 *
 * modeOffset =  0 → D-centred default  (Ab Eb Bb F C G D A E B F# C#)
 * modeOffset = +1 → one step sharper   (Eb Bb F C G D A E B F# C# G#)
 * modeOffset = −1 → one step flatter   (Db Ab Eb Bb F C G D A E B F#)
 */
export function build12ToEdoMap(edo: number, modeOffset = 0): number[] {
  const lo12 = D_FIFTH_POS - 6; // −4: default 12-EDO window start
  const newLo = lo12 + modeOffset;
  const map: number[] = [];

  for (let pc12 = 0; pc12 < 12; pc12++) {
    let targetK = computeK(pc12, 12);
    while (targetK < newLo)      targetK += 12;
    while (targetK > newLo + 11) targetK -= 12;

    for (let d = 0; d < edo; d++) {
      if (computeK(d, edo) === targetK) { map.push(d); break; }
    }
  }
  return map;
}
