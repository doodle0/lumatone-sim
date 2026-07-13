// Generic draggable keyframe track: renders one marker per keyframe (any shape
// with a numeric `t`), lets the user drag a marker to retime it and click to
// select one. Used for both the Camera and Mode tracks in the scene editor.

export interface TimelineKeyframeLike {
  t: number;
}

export interface TimelineTrack<K extends TimelineKeyframeLike> {
  setKeyframes(keyframes: K[]): void;
  setPlayhead(t: number): void;
  setDuration(seconds: number): void;
}

export function createTimelineTrack<K extends TimelineKeyframeLike>(
  container: HTMLElement,
  onSelect: (index: number) => void,
  onDrag: (index: number, newT: number) => void,
): TimelineTrack<K> {
  let keyframes: K[] = [];
  let duration = 1;
  let selectedIndex = -1;

  const trackEl = document.createElement('div');
  trackEl.className = 'relative h-8 bg-fg/ghost rounded';
  container.appendChild(trackEl);

  const playheadEl = document.createElement('div');
  playheadEl.className = 'absolute top-0 bottom-0 w-px bg-accent pointer-events-none';
  trackEl.appendChild(playheadEl);

  function timeToPct(t: number): number {
    return duration > 0 ? Math.max(0, Math.min(1, t / duration)) * 100 : 0;
  }

  function pxToTime(clientX: number): number {
    const rect = trackEl.getBoundingClientRect();
    const pct = rect.width > 0 ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
    return pct * duration;
  }

  function redrawMarkers(): void {
    trackEl.querySelectorAll('.kf-marker').forEach((el) => el.remove());
    keyframes.forEach((kf, index) => {
      const marker = document.createElement('div');
      marker.className = 'kf-marker absolute top-0.5 bottom-0.5 w-2.5 rounded-sm cursor-grab '
        + (index === selectedIndex ? 'bg-accent' : 'bg-fg/label');
      marker.style.left = `calc(${timeToPct(kf.t)}% - 5px)`;

      marker.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        selectedIndex = index;
        onSelect(index);
        redrawMarkers();

        function onMove(ev: PointerEvent): void {
          onDrag(index, pxToTime(ev.clientX));
        }
        function onUp(): void {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
        }
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });

      trackEl.appendChild(marker);
    });
  }

  return {
    setKeyframes(kfs: K[]): void {
      keyframes = kfs;
      redrawMarkers();
    },
    setPlayhead(t: number): void {
      playheadEl.style.left = `${timeToPct(t)}%`;
    },
    setDuration(seconds: number): void {
      duration = Math.max(seconds, 0.001);
      redrawMarkers();
    },
  };
}
