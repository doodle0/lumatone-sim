// Scripted camera for scene playback: hold-then-ease keyframes over (q, r, zoom).
// The camera holds at the previous keyframe's value until `duration` seconds
// before the next keyframe's `t`, then eases in, arriving exactly at `t`.

export interface CameraState {
  q: number;
  r: number;
  zoom: number;
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

export interface CameraKeyframe {
  t: number;
  q: number;
  r: number;
  zoom: number;
  /** Seconds; the transition into this keyframe, ending at `t`. Ignored on the first keyframe. */
  duration?: number;
  easing?: Easing;
}

export const DEFAULT_CAMERA: CameraState = { q: 0, r: 0, zoom: 1 };

function ease(progress: number, kind: Easing): number {
  switch (kind) {
    case 'linear':    return progress;
    case 'easeIn':    return progress * progress;
    case 'easeOut':   return 1 - (1 - progress) * (1 - progress);
    case 'easeInOut': return progress < 0.5
      ? 2 * progress * progress
      : 1 - ((-2 * progress + 2) ** 2) / 2;
  }
}

function toState(kf: CameraKeyframe): CameraState {
  return { q: kf.q, r: kf.r, zoom: kf.zoom };
}

/**
 * Interpolated camera state at time `t`, given keyframes sorted ascending by `t`.
 * Before the first keyframe, returns its value. After the last, returns its value.
 */
export function interpolateCamera(keyframes: readonly CameraKeyframe[], t: number): CameraState {
  if (keyframes.length === 0) return DEFAULT_CAMERA;
  if (t <= keyframes[0]!.t) return toState(keyframes[0]!);

  for (let i = 1; i < keyframes.length; i++) {
    const kf = keyframes[i]!;
    if (t > kf.t) continue;

    const prev = toState(keyframes[i - 1]!);
    const duration = kf.duration ?? 0;
    const transitionStart = kf.t - duration;
    if (duration <= 0 || t <= transitionStart) return prev;

    const progress = ease((t - transitionStart) / duration, kf.easing ?? 'easeInOut');
    return {
      q: prev.q + (kf.q - prev.q) * progress,
      r: prev.r + (kf.r - prev.r) * progress,
      zoom: prev.zoom + (kf.zoom - prev.zoom) * progress,
    };
  }

  return toState(keyframes[keyframes.length - 1]!);
}
