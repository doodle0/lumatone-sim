// Maps QWERTY keyboard rows to the pointy-top hex grid.
// Row i → r = rOffset + i,  key j → q = qOffset + j  (no stagger).
// Default window: 12 wide × 4 tall, centered on (0, 0).

import { keyIndex } from '../core/hexGrid.ts';

const KB_ROWS: [string, string][][] = [
  [
    ['Digit1','1'],['Digit2','2'],['Digit3','3'],['Digit4','4'],
    ['Digit5','5'],['Digit6','6'],['Digit7','7'],['Digit8','8'],
    ['Digit9','9'],['Digit0','0'],['Minus','-'],['Equal','='],
  ],
  [
    ['KeyQ','q'],['KeyW','w'],['KeyE','e'],['KeyR','r'],
    ['KeyT','t'],['KeyY','y'],['KeyU','u'],['KeyI','i'],
    ['KeyO','o'],['KeyP','p'],['BracketLeft','['],['BracketRight',']'],
  ],
  [
    ['KeyA','a'],['KeyS','s'],['KeyD','d'],['KeyF','f'],
    ['KeyG','g'],['KeyH','h'],['KeyJ','j'],['KeyK','k'],
    ['KeyL','l'],['Semicolon',';'],['Quote',"'"],
  ],
  [
    ['KeyZ','z'],['KeyX','x'],['KeyC','c'],['KeyV','v'],
    ['KeyB','b'],['KeyN','n'],['KeyM','m'],['Comma',','],
    ['Period','.'],['Slash','/'],
  ],
];

const MAX_OFFSET = 250; // prevents overflowing the virtual coordinate space

export interface KeyboardWindow {
  /** Map from KeyboardEvent.code → [q, r] in the hex grid. */
  mapping: ReadonlyMap<string, [number, number]>;
  /** Map from KeyboardEvent.code → display label. */
  keyLabels: ReadonlyMap<string, string>;
  qOffset: number;
  rOffset: number;
}

export function buildKeyboardWindow(qOffset: number, rOffset: number): KeyboardWindow {
  const clampedQ = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, qOffset));
  const clampedR = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, rOffset));

  const mapping  = new Map<string, [number, number]>();
  const keyLabels = new Map<string, string>();

  for (let kbRow = 0; kbRow < KB_ROWS.length; kbRow++) {
    const r = clampedR + kbRow;
    for (let kbCol = 0; kbCol < KB_ROWS[kbRow].length; kbCol++) {
      const q = clampedQ + kbCol;
      const [code, label] = KB_ROWS[kbRow][kbCol];
      mapping.set(code, [q, r]);
      keyLabels.set(code, label);
    }
  }

  return { mapping, keyLabels, qOffset: clampedQ, rOffset: clampedR };
}

export function keyWindowIndex(code: string, window: KeyboardWindow): number {
  const pos = window.mapping.get(code);
  if (!pos) return -1;
  return keyIndex(pos[0], pos[1]);
}
