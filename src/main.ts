import './style.css';
import { TUNINGS } from './tuningEngine.ts';
import { LAYOUT_PRESETS } from './layout.ts';
import { getDegree } from './layout.ts';
import { keyCoords } from './hexGrid.ts';
import { createAudioEngine } from './audioEngine.ts';
import { createRenderer } from './renderer.ts';
import { buildKeyboardWindow, keyWindowIndex } from './keyboardInput.ts';
import { createMidiInput, midiToDegree } from './midiInput.ts';
import { build12ToEdoMap, kToName } from './spiralFifths.ts';
import type { RendererState, ColorMode } from './renderer.ts';
import { createRecordingEngine } from './recordingEngine.ts';
import type { RecordingEngine } from './recordingEngine.ts';

// --- State ---
let tuningKey = '31';
let tuning = TUNINGS[tuningKey]!;
let layout = LAYOUT_PRESETS[tuningKey]!;
const activeKeys = new Set<number>();
const activeMidiDegrees = new Set<number>();
const midiNoteToActiveDegree = new Map<number, number>(); // tracks degree used per noteOn
let keyWindow = buildKeyboardWindow(-6, -2); // centered on (0,0) = middle C
let colorMode: ColorMode = 'spiral';
let showKbGuide = true;
let modeOffset = 0;
let inModePcs: Set<number> | null = buildInModePcs(tuning.stepsPerOctave, modeOffset);
let rafId = 0;

const audio = createAudioEngine();
const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const renderer = createRenderer(canvas);

// --- Mode helpers ---
function buildInModePcs(edo: number, offset: number): Set<number> | null {
  if (edo === 12) return null;
  return new Set(build12ToEdoMap(edo, offset));
}

/** Valid modeOffset range for a given EDO — ensures all 12 window positions
 *  have a matching pitch class in the EDO's spiral range. */
function modeOffsetRange(edo: number): [number, number] {
  const half = Math.floor(edo / 2);
  return [6 - half, edo - half - 6];
}

function clampModeOffset(offset: number, edo: number): number {
  const [min, max] = modeOffsetRange(edo);
  return Math.max(min, Math.min(max, offset));
}

function releaseMidiNotes(): void {
  for (const midiNote of midiNoteToActiveDegree.keys()) {
    audio.noteOff(`midi-${midiNote}`);
  }
  activeMidiDegrees.clear();
  midiNoteToActiveDegree.clear();
}

// --- Spiral strip ---
const spiralNotesEl  = document.getElementById('spiral-notes')!;
const modeOffsetLabel = document.getElementById('mode-offset-label')!;
const MODE_MARGIN = 3; // notes to show outside the 12-note window on each side

function updateSpiralStrip(offset: number): void {
  const lo = -4 + offset; // window start k
  const hi = lo + 11;     // window end k

  spiralNotesEl.innerHTML = '';
  for (let k = lo - MODE_MARGIN; k <= hi + MODE_MARGIN; k++) {
    const span = document.createElement('span');
    span.textContent = kToName(k);
    span.className = 'spiral-note' + (k >= lo && k <= hi ? ' in-window' : '');
    spiralNotesEl.appendChild(span);
  }

  if (offset === 0) {
    modeOffsetLabel.textContent = '—';
  } else if (offset > 0) {
    modeOffsetLabel.textContent = `${offset}♯`;
  } else {
    modeOffsetLabel.textContent = `${-offset}♭`;
  }
}

updateSpiralStrip(modeOffset);

// --- MIDI ---
const midiStatusEl = document.getElementById('midi-status')!;
const MIDI_STATUS_LABELS: Record<string, string> = {
  unavailable:  'MIDI: n/a',
  denied:       'MIDI: denied',
  connected:    'MIDI: connected',
  'no-devices': 'MIDI: no devices',
};

createMidiInput(
  (midiNote, _velocity) => {
    const degree = midiToDegree(midiNote, tuning.stepsPerOctave, modeOffset);
    midiNoteToActiveDegree.set(midiNote, degree);
    activeMidiDegrees.add(degree);
    audio.noteOn(`midi-${midiNote}`, tuning.getFrequency(degree));
  },
  (midiNote) => {
    const degree = midiNoteToActiveDegree.get(midiNote);
    if (degree !== undefined) {
      activeMidiDegrees.delete(degree);
      midiNoteToActiveDegree.delete(midiNote);
    }
    audio.noteOff(`midi-${midiNote}`);
  },
  (status) => {
    midiStatusEl.textContent = MIDI_STATUS_LABELS[status] ?? 'MIDI: ?';
    midiStatusEl.dataset.status = status;
  },
).catch(() => {
  midiStatusEl.textContent = 'MIDI: error';
});

// --- Helpers ---
function voiceId(index: number): string { return `key-${index}`; }

function noteOn(index: number): void {
  if (activeKeys.has(index)) return;
  activeKeys.add(index);
  const [q, r] = keyCoords(index);
  const degree = getDegree(q, r, layout);
  const freq = tuning.getFrequency(degree);
  audio.noteOn(voiceId(index), freq);
}

function noteOff(index: number): void {
  if (!activeKeys.has(index)) return;
  activeKeys.delete(index);
  audio.noteOff(voiceId(index));
}

// --- Render loop ---
function frame(): void {
  const state: RendererState = {
    tuning, layout, activeKeys, activeDegrees: activeMidiDegrees,
    inModePitchClasses: inModePcs, keyWindow, colorMode, showKbGuide,
  };
  renderer.render(state);
  rafId = requestAnimationFrame(frame);
}

// --- Keyboard input ---
const heldKeys = new Set<string>();

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;

  // Shift+Arrow: move the chromatic mode window along the spiral of fifths.
  if (e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    const delta = e.code === 'ArrowLeft' ? -1 : 1;
    modeOffset = clampModeOffset(modeOffset + delta, tuning.stepsPerOctave);
    inModePcs = buildInModePcs(tuning.stepsPerOctave, modeOffset);
    releaseMidiNotes();
    updateSpiralStrip(modeOffset);
    return;
  }

  // Arrow: shift keyboard window.
  if (e.code === 'ArrowLeft') {
    keyWindow = buildKeyboardWindow(keyWindow.qOffset - 1, keyWindow.rOffset);
    audio.releaseAll(); activeKeys.clear();
    return;
  }
  if (e.code === 'ArrowRight') {
    keyWindow = buildKeyboardWindow(keyWindow.qOffset + 1, keyWindow.rOffset);
    audio.releaseAll(); activeKeys.clear();
    return;
  }
  if (e.code === 'ArrowUp') {
    keyWindow = buildKeyboardWindow(keyWindow.qOffset, keyWindow.rOffset - 1);
    audio.releaseAll(); activeKeys.clear();
    return;
  }
  if (e.code === 'ArrowDown') {
    keyWindow = buildKeyboardWindow(keyWindow.qOffset, keyWindow.rOffset + 1);
    audio.releaseAll(); activeKeys.clear();
    return;
  }

  if (heldKeys.has(e.code)) return;
  heldKeys.add(e.code);
  const idx = keyWindowIndex(e.code, keyWindow);
  if (idx !== -1) noteOn(idx);
});

window.addEventListener('keyup', (e) => {
  heldKeys.delete(e.code);
  const idx = keyWindowIndex(e.code, keyWindow);
  if (idx !== -1) noteOff(idx);
});

// Release all notes when window loses focus
window.addEventListener('blur', () => {
  heldKeys.clear();
  audio.releaseAll();
  activeKeys.clear();
  releaseMidiNotes();
});

// --- Mouse input ---
let mouseHeld = false;
let mouseKey = -1;

canvas.addEventListener('mousedown', (e) => {
  mouseHeld = true;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  mouseKey = renderer.hitTest(x, y);
  if (mouseKey !== -1) noteOn(mouseKey);
});

canvas.addEventListener('mousemove', (e) => {
  if (!mouseHeld) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const newKey = renderer.hitTest(x, y);
  if (newKey !== mouseKey) {
    if (mouseKey !== -1) noteOff(mouseKey);
    mouseKey = newKey;
    if (mouseKey !== -1) noteOn(mouseKey);
  }
});

canvas.addEventListener('mouseup', () => {
  mouseHeld = false;
  if (mouseKey !== -1) { noteOff(mouseKey); mouseKey = -1; }
});

canvas.addEventListener('mouseleave', () => {
  if (mouseHeld && mouseKey !== -1) { noteOff(mouseKey); mouseKey = -1; }
  mouseHeld = false;
});

// --- UI controls ---
const tuningSelect = document.getElementById('tuning-select') as HTMLSelectElement;
tuningSelect.value = tuningKey;
tuningSelect.addEventListener('change', () => {
  audio.releaseAll(); activeKeys.clear(); releaseMidiNotes();
  tuningKey = tuningSelect.value;
  tuning = TUNINGS[tuningKey]!;
  layout = LAYOUT_PRESETS[tuningKey]!;
  modeOffset = clampModeOffset(modeOffset, tuning.stepsPerOctave);
  inModePcs = buildInModePcs(tuning.stepsPerOctave, modeOffset);
  updateSpiralStrip(modeOffset);
});

const waveSelect = document.getElementById('wave-select') as HTMLSelectElement;
waveSelect.addEventListener('change', () => {
  audio.setWaveform(waveSelect.value as OscillatorType);
});

function bindRange(id: string, fn: (v: number) => void): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.addEventListener('input', () => fn(parseFloat(el.value)));
}

bindRange('attack',   (v) => audio.setADSR({ attack: v }));
bindRange('decay',    (v) => audio.setADSR({ decay: v }));
bindRange('sustain',  (v) => audio.setADSR({ sustain: v }));
bindRange('release',  (v) => audio.setADSR({ release: v }));
bindRange('volume',   (v) => audio.setMasterVolume(v));
bindRange('hex-size', (v) => { renderer.setHexSize(v); activeKeys.clear(); audio.releaseAll(); });

const colorSelect = document.getElementById('color-select') as HTMLSelectElement;
colorSelect.addEventListener('change', () => { colorMode = colorSelect.value as ColorMode; });

const kbGuideToggle = document.getElementById('kb-guide-toggle') as HTMLInputElement;
kbGuideToggle.addEventListener('change', () => { showKbGuide = kbGuideToggle.checked; });

// --- Resize ---
const resizeObserver = new ResizeObserver((entries) => {
  const entry = entries[0];
  if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
});
resizeObserver.observe(canvas);
const initRect = canvas.getBoundingClientRect();
if (initRect.width > 0) renderer.resize(initRect.width, initRect.height);

// --- Recording ---
const recordBtn    = document.getElementById('record-btn')    as HTMLButtonElement;
const stopBtn      = document.getElementById('stop-btn')      as HTMLButtonElement;
const recordStatus = document.getElementById('record-status') as HTMLSpanElement;
const recordTimeEl = document.getElementById('record-time')   as HTMLSpanElement;
const recordErrorEl = document.getElementById('record-error') as HTMLSpanElement;

let recEngine: RecordingEngine | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let recordStart = 0;

function formatRecTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

recordBtn.addEventListener('click', () => {
  if (!recEngine) {
    recEngine = createRecordingEngine(canvas, audio.getAudioContext(), audio.getMasterOutput());
  }
  recordErrorEl.classList.add('hidden');
  try {
    recEngine.start();
  } catch (err) {
    recordErrorEl.textContent = `Recording error: ${err instanceof Error ? err.message : String(err)}`;
    recordErrorEl.classList.remove('hidden');
    return;
  }
  recordStart = Date.now();
  recordTimeEl.textContent = '0:00';
  recordBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  recordStatus.classList.remove('hidden');
  timerInterval = setInterval(() => {
    recordTimeEl.textContent = formatRecTime(Date.now() - recordStart);
  }, 1000);
});

stopBtn.addEventListener('click', () => {
  if (!recEngine) return;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  stopBtn.classList.add('hidden');
  recordStatus.classList.add('hidden');
  recordBtn.classList.remove('hidden');
  recEngine.stop().then((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumatone-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// --- Start ---
rafId = requestAnimationFrame(frame);
void rafId;
