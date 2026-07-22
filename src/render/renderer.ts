// Canvas renderer for the hex grid.
// Offscreen canvas for the static base layer (rebuilt on resize or state change);
// active-key overlay composited on every animation frame.

import {
  SQRT3, DEFAULT_HEX_SIZE,
  hexCenter, hexVertices, visibleKeys,
} from '../core/hexGrid.ts';
import type { HexKey } from '../core/hexGrid.ts';
import type { TuningEngine } from '../core/tuningEngine.ts';
import type { LayoutConfig } from '../core/layout.ts';
import { getDegree } from '../core/layout.ts';
import type { KeyboardWindow } from '../input/keyboardInput.ts';
import { spiralNote } from '../core/spiralFifths.ts';
import type { CameraState } from './camera.ts';
import { DEFAULT_CAMERA } from './camera.ts';

let originX = 0;
let originY = 0;

// ─── Color mode ──────────────────────────────────────────────────────────────

export type ColorMode = 'pitch' | 'spiral';

// Pitch (rainbow) mode: fixed L and C, H sweeps the hue circle by pitch class.
const PITCH_L = 0.60;
const PITCH_C = 0.10;

const D_ACTIVE_L = 0.20;

// Hex border colors
const STROKE_L_DELTA = 0.15;  // L offset for idle/active hex borders
const STROKE_C_FACTOR = 0.7;   // chroma reduction for hex borders
const KB_OUTLINE_L = 0.90;
const KB_OUTLINE_C_FACTOR = 0.5;  // scales key's own chroma, so achromatic keys stay achromatic
const KB_OUTLINE_A = 1.00;

// ─── Colour helpers ───────────────────────────────────────────────────────────

function pitchHue(degree: number, edo: number): number {
  return (((degree % edo) + edo) % edo / edo) * 360;
}

function spiralLch(acc: number): [number, number, number] {
  if (acc === 0) {
    return [0.80, 0, 0];
  } else if (acc === 1) {
    return [0.60, 0.10, 30];
  } else if (acc === 2) {
    return [0.60, 0.10, 60];
  } else if (acc === -1) {
    return [0.60, 0.10, 210];
  } else if (acc === -2) {
    return [0.60, 0.10, 240];
  } else {
    return [0.50, 0.15, 30];
  }
}

/** Returns the [L, C, H] triple for an idle key under the given colour mode. */
function idleLCH(
  degree: number, edo: number, acc: number, mode: ColorMode,
): [number, number, number] {
  return mode === 'spiral'
    ? spiralLch(acc)
    : [PITCH_L, PITCH_C, pitchHue(degree, edo)];
}

function ok(l: number, c: number, h: number, a = 1): string {
  return a < 1 ? `oklch(${l} ${c} ${h} / ${a})` : `oklch(${l} ${c} ${h})`;
}

// ─── Draw helpers ─────────────────────────────────────────────────────────────

function drawHex(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  q: number,
  r: number,
  size: number,
  fill: string,
  stroke: string,
  strokeWidth: number,
  glow?: string,
): void {
  const [cx, cy] = hexCenter(q, r, size, originX, originY);
  const verts = hexVertices(cx, cy, size * 0.96);
  ctx.beginPath();
  ctx.moveTo(verts[0][0], verts[0][1]);
  for (let i = 1; i < 6; i++) ctx.lineTo(verts[i][0], verts[i][1]);
  ctx.closePath();
  if (glow) { ctx.shadowColor = glow; ctx.shadowBlur = 14; }
  else { ctx.shadowBlur = 0; }
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.stroke();
}

function drawLabel(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  q: number,
  r: number,
  size: number,
  text: string,
  color: string,
): void {
  const [cx, cy] = hexCenter(q, r, size, originX, originY);
  const fontSize = Math.max(10, Math.min(16, size * 0.38));
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy);
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RendererState {
  tuning: TuningEngine;
  layout: LayoutConfig;
  activeKeys: ReadonlySet<number>;
  activeDegrees: ReadonlySet<number>;
  /** Pitch classes (0..edo-1) that are inside the current chromatic mode window.
   *  null = all notes in-mode (used for 12-EDO where the concept doesn't apply). */
  inModePitchClasses: ReadonlySet<number> | null;
  keyWindow: KeyboardWindow;
  colorMode: ColorMode;
  showKbGuide: boolean;
  /** Scripted view transform; defaults to {q:0, r:0, zoom:1} (unrotated, centered). */
  camera?: CameraState;
}

export interface Renderer {
  resize(w: number, h: number): void;
  render(state: RendererState): void;
  hitTest(x: number, y: number): number;
  setHexSize(s: number): void;
  getSize(): number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext('2d')!;
  let offscreen: OffscreenCanvas | null = null;
  let offCtx: OffscreenCanvasRenderingContext2D | null = null;
  let hexSize = DEFAULT_HEX_SIZE;
  let effSize = DEFAULT_HEX_SIZE;
  let camera: CameraState = DEFAULT_CAMERA;
  let dpr = 1;
  let cssW = 0;
  let cssH = 0;
  let lastState: RendererState | null = null;
  let keys: HexKey[] = [];

  function camerasEqual(a: CameraState, b: CameraState): boolean {
    return a.q === b.q && a.r === b.r && a.zoom === b.zoom;
  }

  function recomputeKeys(): void {
    effSize = hexSize * camera.zoom;
    const [focusX, focusY] = hexCenter(camera.q, camera.r, effSize, 0, 0);
    originX = cssW / 2 - focusX;
    originY = cssH / 2 - focusY;
    keys = visibleKeys(cssW, cssH, effSize, originX, originY);
  }

  function resize(w: number, h: number): void {
    dpr = window.devicePixelRatio || 1;
    cssW = w; cssH = h;
    recomputeKeys();

    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    offscreen = new OffscreenCanvas(canvas.width, canvas.height);
    offCtx = offscreen.getContext('2d') as OffscreenCanvasRenderingContext2D;
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    lastState = null;
  }

  function setHexSize(s: number): void {
    hexSize = Math.max(8, s);
    recomputeKeys();
    lastState = null;
  }

  function buildStaticLayer(state: RendererState): void {
    if (!offCtx) return;
    const { tuning, layout, colorMode, inModePitchClasses } = state;
    const edo = tuning.stepsPerOctave;

    offCtx.clearRect(0, 0, offscreen!.width, offscreen!.height);

    for (const key of keys) {
      const deg = getDegree(key.q, key.r, layout);
      const note = spiralNote(deg, edo);
      const pc   = ((deg % edo) + edo) % edo;
      const inMode = inModePitchClasses === null || inModePitchClasses.has(pc);

      let [l, c, h] = idleLCH(deg, edo, note.acc, colorMode);
      if (!inMode) { l *= 0.5; c *= 0.5; }

      const sl = l < 0.5 ? l + STROKE_L_DELTA : l - STROKE_L_DELTA;
      drawHex(offCtx, key.q, key.r, effSize,
        ok(l, c, h),
        ok(sl, c * STROKE_C_FACTOR, h),
        0.5,
      );

      if (effSize >= 18) {
        const ll = l < 0.5 ? l + 0.5 : l - 0.5;
        drawLabel(offCtx, key.q, key.r, effSize, note.name,
          ok(ll, c * 0.55, h, inMode ? 0.70 : 0.35));
      }
    }
  }

  function render(state: RendererState): void {
    const nextCamera = state.camera ?? DEFAULT_CAMERA;
    const cameraChanged = !camerasEqual(camera, nextCamera);
    if (cameraChanged) {
      camera = nextCamera;
      recomputeKeys();
    }

    const rebuild = !lastState
      || lastState.tuning !== state.tuning
      || lastState.layout !== state.layout
      || lastState.colorMode !== state.colorMode
      || lastState.inModePitchClasses !== state.inModePitchClasses
      || cameraChanged;
    if (rebuild || !offscreen) buildStaticLayer(state);
    lastState = state;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (offscreen) ctx.drawImage(offscreen, 0, 0, canvas.width / dpr, canvas.height / dpr);

    const { tuning, layout, activeKeys, activeDegrees, keyWindow, colorMode, showKbGuide } = state;
    const edo = tuning.stepsPerOctave;

    // Keyboard window outline
    if (showKbGuide) {
      for (const [keyCode, [q, r]] of keyWindow.mapping) {
        const deg = getDegree(q, r, layout);
        const note = spiralNote(deg, edo);
        const [l, c, h] = idleLCH(deg, edo, note.acc, colorMode);
        drawHex(ctx, q, r, effSize, 'transparent', ok(KB_OUTLINE_L, c * KB_OUTLINE_C_FACTOR, h, KB_OUTLINE_A), 3);
        if (effSize >= 18) {
          const label = keyWindow.keyLabels.get(keyCode) ?? '';
          const [cx, cy] = hexCenter(q, r, effSize, originX, originY);
          const fontSize = Math.max(6, Math.min(9, effSize * 0.30));
          ctx.font = `${fontSize}px system-ui, sans-serif`;
          ctx.fillStyle = ok(l < 0.5 ? l + 0.40 : l - 0.25, c * 0.5, h, 0.55);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(label, cx, cy + effSize * SQRT3 * 0.28);
        }
      }
    }

    // Active (pressed) keys — by key index (keyboard/mouse) or by degree (MIDI).
    for (const key of keys) {
      const deg = getDegree(key.q, key.r, layout);
      if (!activeKeys.has(key.index) && !activeDegrees.has(deg)) continue;
      const note = spiralNote(deg, edo);
      const [l, c, h] = idleLCH(deg, edo, note.acc, colorMode);
      drawHex(ctx, key.q, key.r, effSize,
        ok(l + D_ACTIVE_L, c, h),
        ok(l + D_ACTIVE_L + STROKE_L_DELTA, c, h),
        1,
        ok(l + D_ACTIVE_L, c, h),
      );
      if (effSize >= 18) {
        const al = l + D_ACTIVE_L;
        const ll = al < 0.5 ? al + 0.5 : al - 0.5;
        drawLabel(ctx, key.q, key.r, effSize, note.name, ok(ll, c * 0.55, h));
      }
    }
  }

  function hitTest(x: number, y: number): number {
    let best = -1;
    let bestDist = Infinity;
    const sqRadius = (effSize * 0.96) ** 2;
    for (const key of keys) {
      const [cx, cy] = hexCenter(key.q, key.r, effSize, originX, originY);
      const dx = x - cx, dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < sqRadius && d2 < bestDist) { bestDist = d2; best = key.index; }
    }
    return best;
  }

  return { resize, render, hitTest, setHexSize, getSize(): number { return hexSize; } };
}
