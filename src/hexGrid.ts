// Infinite pointy-top hex grid with pure axial coordinates.
// q-axis faces right (0°); r-axis faces lower-right (60° below horizontal).
// (0, 0) maps to degree 0 = middle C.
//
// The grid is rotated so that the diatonic octave path (5q + 2r) is horizontal:
//   5·dy_q + 2·dy_r = 0  →  tan θ = −1/(2√3)  ≈ −16.1°

export const SQRT3 = Math.sqrt(3);

export const DEFAULT_HEX_SIZE = 50;

// Rotation angle that makes the diatonic octave (5q + 2r) level.
export const GRID_ANGLE = Math.atan(-1 / (2 * SQRT3));
const GRID_COS = Math.cos(GRID_ANGLE);
const GRID_SIN = Math.sin(GRID_ANGLE);

// Virtual coordinate bounds for integer key indices.
// Supports q ∈ (-Q_RANGE, Q_RANGE) and r ∈ (-R_RANGE, R_RANGE).
const Q_RANGE  = 300;
const R_RANGE  = 200;
const V_STRIDE = Q_RANGE * 2; // 600 — columns in the virtual grid

export interface HexKey {
  readonly q: number;
  readonly r: number;
  readonly index: number;
}

/** Unique integer index for (q, r). Supports q ∈ (-300, 300), r ∈ (-200, 200). */
export function keyIndex(q: number, r: number): number {
  return (q + Q_RANGE) + (r + R_RANGE) * V_STRIDE;
}

/** Decode an integer index back to (q, r). */
export function keyCoords(index: number): [number, number] {
  return [
    (index % V_STRIDE) - Q_RANGE,
    Math.floor(index / V_STRIDE) - R_RANGE,
  ];
}

/**
 * Pixel center of hex (q, r), with the grid rotated by GRID_ANGLE.
 * originX/Y is the canvas pixel coordinate of the (0, 0) key center.
 */
export function hexCenter(
  q: number,
  r: number,
  size: number,
  originX: number,
  originY: number,
): [number, number] {
  const x0 = SQRT3 * size * q + (SQRT3 / 2) * size * r;
  const y0 = (3 / 2) * size * r;
  return [
    originX + x0 * GRID_COS - y0 * GRID_SIN,
    originY + x0 * GRID_SIN + y0 * GRID_COS,
  ];
}

/** Six vertices of a hexagon centered at (cx, cy), rotated to match GRID_ANGLE. */
export function hexVertices(cx: number, cy: number, size: number): [number, number][] {
  const verts: [number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const angle = ((30 + i * 60) * Math.PI) / 180 + GRID_ANGLE;
    verts.push([cx + size * Math.cos(angle), cy + size * Math.sin(angle)]);
  }
  return verts;
}

/**
 * All hex keys whose centers are visible within [0, canvasW] × [0, canvasH].
 * Inverse-rotates the screen bounding box into unrotated axial space to compute
 * the correct (q, r) range regardless of GRID_ANGLE.
 */
export function visibleKeys(
  canvasW: number,
  canvasH: number,
  size: number,
  originX: number = canvasW / 2,
  originY: number = canvasH / 2,
): HexKey[] {
  const pad = size * 2;

  // Four corners of the padded screen rectangle, relative to canvas centre.
  const sx0 = -originX - pad, sx1 = canvasW - originX + pad;
  const sy0 = -originY - pad, sy1 = canvasH - originY + pad;

  // Inverse-rotate each corner into unrotated axial space.
  // Inverse of rotation by θ is (x0, y0) = (sx·cosθ + sy·sinθ, −sx·sinθ + sy·cosθ).
  let x0Min = Infinity, x0Max = -Infinity;
  let y0Min = Infinity, y0Max = -Infinity;
  for (const [sx, sy] of [[sx0, sy0], [sx1, sy0], [sx0, sy1], [sx1, sy1]] as const) {
    const x0 = sx * GRID_COS + sy * GRID_SIN;
    const y0 = -sx * GRID_SIN + sy * GRID_COS;
    if (x0 < x0Min) x0Min = x0;
    if (x0 > x0Max) x0Max = x0;
    if (y0 < y0Min) y0Min = y0;
    if (y0 > y0Max) y0Max = y0;
  }

  // r from y0: y0 = 1.5·size·r
  const rMin = Math.floor(y0Min / (1.5 * size));
  const rMax = Math.ceil(y0Max / (1.5 * size));

  const keys: HexKey[] = [];
  for (let r = rMin; r <= rMax; r++) {
    // x0 = √3·size·q + (√3/2)·size·r  →  q = (x0 − baseX0) / (√3·size)
    const baseX0 = (SQRT3 / 2) * size * r;
    const qMin = Math.floor((x0Min - baseX0) / (SQRT3 * size));
    const qMax = Math.ceil((x0Max - baseX0) / (SQRT3 * size));
    for (let q = qMin; q <= qMax; q++) {
      if (q <= -Q_RANGE || q >= Q_RANGE || r <= -R_RANGE || r >= R_RANGE) continue;
      keys.push({ q, r, index: keyIndex(q, r) });
    }
  }
  return keys;
}
