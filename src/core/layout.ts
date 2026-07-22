// Bosanquet-Wilson isomorphic layout for the pointy-top hex grid.
// Axes: q = right (0°), r = lower-right (60° below horizontal).
//   degree = q * qStep + r * rStep
//
// Neighbor degree intervals:
//   Right        (+1,  0):  +qStep
//   Lower-right  ( 0, +1):  +rStep
//   Upper-right  (+1, -1):  +qStep − rStep

export interface LayoutConfig {
  /** Pitch steps per step in the q / right direction. */
  qStep: number;
  /** Pitch steps per step in the r / lower-right direction. */
  rStep: number;
}

export function getDegree(q: number, r: number, cfg: LayoutConfig): number {
  return q * cfg.qStep + r * cfg.rStep;
}

export const LAYOUT_PRESETS: Record<string, LayoutConfig> = {
  '12': { qStep: 2, rStep: 1 },
  '19': { qStep: 3, rStep: 2 },
  '31': { qStep: 5, rStep: 3 },
};
