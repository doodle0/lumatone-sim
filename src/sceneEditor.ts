import './style.css';
import { createAudioEngine } from './audioEngine.ts';
import { createRenderer } from './renderer.ts';
import { createRecordingEngine } from './recordingEngine.ts';
import { parseScene } from './scene.ts';
import type { Scene } from './scene.ts';
import type { ChannelConfig } from './scene.ts';
import { DEFAULT_CHANNEL_CONFIG } from './scene.ts';
import { parseMidiFile, midiDuration } from './midiFile.ts';
import type { MidiEvent } from './midiFile.ts';
import { createScenePlayer } from './scenePlayer.ts';
import { createTimelineTrack } from './timelineTrack.ts';
import type { CameraKeyframe } from './camera.ts';
import { interpolateCamera, DEFAULT_CAMERA } from './camera.ts';
import type { ModeKeyframe } from './scene.ts';
import { TUNINGS } from './tuningEngine.ts';
import { LAYOUT_PRESETS } from './layout.ts';
import { buildKeyboardWindow } from './keyboardInput.ts';

const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const audio = createAudioEngine();
const renderer = createRenderer(canvas);

const sceneFileInput = document.getElementById('scene-file-input') as HTMLInputElement;
const midiFileInput  = document.getElementById('midi-file-input')  as HTMLInputElement;
const renderBtn      = document.getElementById('render-btn')       as HTMLButtonElement;
const statusEl       = document.getElementById('render-status')    as HTMLSpanElement;

const PREVIEW_KEY_WINDOW = buildKeyboardWindow(-6, -2);

let scene: Scene | null = null;
let events: MidiEvent[] | null = null;

let selectedCameraIndex = -1;
let selectedModeIndex = -1;
let scrubTime = 0;

const scrubInput   = document.getElementById('scrub')            as HTMLInputElement;
const scrubTimeEl  = document.getElementById('scrub-time')       as HTMLSpanElement;
const cameraTrackEl     = document.getElementById('camera-track')     as HTMLDivElement;
const cameraInspectorEl = document.getElementById('camera-inspector') as HTMLDivElement;
const cameraAddBtn      = document.getElementById('camera-add-btn')   as HTMLButtonElement;
const cameraDelBtn      = document.getElementById('camera-del-btn')   as HTMLButtonElement;
const modeTrackEl       = document.getElementById('mode-track')       as HTMLDivElement;
const modeInspectorEl   = document.getElementById('mode-inspector')   as HTMLDivElement;
const modeAddBtn        = document.getElementById('mode-add-btn')     as HTMLButtonElement;
const modeDelBtn        = document.getElementById('mode-del-btn')     as HTMLButtonElement;
const channelsTableEl = document.getElementById('channels-table')  as HTMLDivElement;
const channelAddBtn   = document.getElementById('channel-add-btn') as HTMLButtonElement;
const saveSceneBtn    = document.getElementById('save-scene-btn')  as HTMLButtonElement;

const cameraTrack = createTimelineTrack<CameraKeyframe>(cameraTrackEl,
  (index) => { selectedCameraIndex = index; renderCameraInspector(); },
  (index, newT) => {
    if (!scene) return;
    scene.cameraKeyframes[index]!.t = Math.max(0, newT);
    scene.cameraKeyframes.sort((a, b) => a.t - b.t);
    selectedCameraIndex = index;
    refreshTimeline();
  });

const modeTrack = createTimelineTrack<ModeKeyframe>(modeTrackEl,
  (index) => { selectedModeIndex = index; renderModeInspector(); },
  (index, newT) => {
    if (!scene) return;
    scene.modeKeyframes[index]!.t = Math.max(0, newT);
    scene.modeKeyframes.sort((a, b) => a.t - b.t);
    selectedModeIndex = index;
    refreshTimeline();
  });

function sceneDuration(): number {
  return events ? midiDuration(events) + 1 : 1;
}

function refreshTimeline(): void {
  if (!scene) return;
  const duration = sceneDuration();
  scrubInput.max = String(duration);
  cameraTrack.setDuration(duration);
  cameraTrack.setKeyframes(scene.cameraKeyframes);
  modeTrack.setDuration(duration);
  modeTrack.setKeyframes(scene.modeKeyframes);
  renderCameraInspector();
  renderModeInspector();
  updatePreview();
  renderChannelsTable();
}

function renderChannelsTable(): void {
  channelsTableEl.innerHTML = '';
  if (!scene) return;

  for (const [key, config] of Object.entries(scene.channels)) {
    const channel = Number(key);
    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 text-sm';

    const label = document.createElement('span');
    label.className = 'ctrl-label w-20';
    label.textContent = `Ch ${channel}`;
    row.appendChild(label);

    const waveSelect = document.createElement('select');
    waveSelect.className = 'ctrl-select';
    for (const wave of ['sine', 'triangle', 'sawtooth', 'square']) {
      const o = document.createElement('option');
      o.value = wave; o.textContent = wave;
      if (config.waveform === wave) o.selected = true;
      waveSelect.appendChild(o);
    }
    waveSelect.addEventListener('change', () => {
      config.waveform = waveSelect.value as ChannelConfig['waveform'];
    });
    row.appendChild(waveSelect);

    for (const field of ['attack', 'decay', 'sustain', 'release'] as const) {
      const wrap = document.createElement('label');
      wrap.className = 'ctrl-label';
      wrap.textContent = field[0]!.toUpperCase() + ' ';
      const input = document.createElement('input');
      input.type = 'number';
      input.step = '0.01';
      input.value = String(config.adsr[field]);
      input.className = 'ctrl-select w-16';
      input.addEventListener('input', () => { config.adsr[field] = parseFloat(input.value) || 0; });
      wrap.appendChild(input);
      row.appendChild(wrap);
    }

    const delBtn = document.createElement('button');
    delBtn.textContent = 'remove';
    delBtn.className = 'px-2 py-0.5 rounded text-xs bg-red-500/ghost text-red-400 hover:bg-red-500/hover cursor-pointer';
    delBtn.addEventListener('click', () => {
      delete scene!.channels[channel];
      renderChannelsTable();
    });
    row.appendChild(delBtn);

    channelsTableEl.appendChild(row);
  }
}

channelAddBtn.addEventListener('click', () => {
  if (!scene) return;
  let next = 0;
  while (scene.channels[next]) next++;
  scene.channels[next] = { waveform: DEFAULT_CHANNEL_CONFIG.waveform, adsr: { ...DEFAULT_CHANNEL_CONFIG.adsr } };
  renderChannelsTable();
});

saveSceneBtn.addEventListener('click', () => {
  if (!scene) return;
  const json = JSON.stringify(scene, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scene.name.replace(/\s+/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

function renderCameraInspector(): void {
  cameraInspectorEl.innerHTML = '';
  if (!scene || selectedCameraIndex < 0 || selectedCameraIndex >= scene.cameraKeyframes.length) return;
  const kf = scene.cameraKeyframes[selectedCameraIndex]!;

  function numberField(label: string, value: number, onInput: (v: number) => void, step = 0.1): HTMLLabelElement {
    const wrap = document.createElement('label');
    wrap.className = 'ctrl-label';
    wrap.textContent = label + ' ';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = String(step);
    input.value = String(value);
    input.className = 'ctrl-select w-20';
    input.addEventListener('input', () => { onInput(parseFloat(input.value)); refreshTimeline(); });
    wrap.appendChild(input);
    return wrap;
  }

  cameraInspectorEl.appendChild(numberField('q', kf.q, (v) => { kf.q = v; }));
  cameraInspectorEl.appendChild(numberField('r', kf.r, (v) => { kf.r = v; }));
  cameraInspectorEl.appendChild(numberField('zoom', kf.zoom, (v) => { kf.zoom = v; }, 0.05));
  cameraInspectorEl.appendChild(numberField('duration', kf.duration ?? 0, (v) => { kf.duration = v; }, 0.1));

  const easingSelect = document.createElement('select');
  easingSelect.className = 'ctrl-select';
  for (const opt of ['easeInOut', 'linear', 'easeIn', 'easeOut']) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt;
    if ((kf.easing ?? 'easeInOut') === opt) o.selected = true;
    easingSelect.appendChild(o);
  }
  easingSelect.addEventListener('change', () => {
    kf.easing = easingSelect.value as CameraKeyframe['easing'];
    refreshTimeline();
  });
  cameraInspectorEl.appendChild(easingSelect);
}

function renderModeInspector(): void {
  modeInspectorEl.innerHTML = '';
  if (!scene || selectedModeIndex < 0 || selectedModeIndex >= scene.modeKeyframes.length) return;
  const kf = scene.modeKeyframes[selectedModeIndex]!;

  const wrap = document.createElement('label');
  wrap.className = 'ctrl-label';
  wrap.textContent = 'modeOffset ';
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '1';
  input.value = String(kf.modeOffset);
  input.className = 'ctrl-select w-20';
  input.addEventListener('input', () => { kf.modeOffset = parseInt(input.value, 10) || 0; refreshTimeline(); });
  wrap.appendChild(input);
  modeInspectorEl.appendChild(wrap);
}

cameraAddBtn.addEventListener('click', () => {
  if (!scene) return;
  const prev = interpolateCamera(scene.cameraKeyframes, scrubTime) ?? DEFAULT_CAMERA;
  scene.cameraKeyframes.push({ t: scrubTime, q: prev.q, r: prev.r, zoom: prev.zoom, duration: 1, easing: 'easeInOut' });
  scene.cameraKeyframes.sort((a, b) => a.t - b.t);
  selectedCameraIndex = scene.cameraKeyframes.findIndex((k) => k.t === scrubTime);
  refreshTimeline();
});

cameraDelBtn.addEventListener('click', () => {
  if (!scene || selectedCameraIndex < 0) return;
  scene.cameraKeyframes.splice(selectedCameraIndex, 1);
  selectedCameraIndex = -1;
  refreshTimeline();
});

modeAddBtn.addEventListener('click', () => {
  if (!scene) return;
  scene.modeKeyframes.push({ t: scrubTime, modeOffset: 0 });
  scene.modeKeyframes.sort((a, b) => a.t - b.t);
  selectedModeIndex = scene.modeKeyframes.findIndex((k) => k.t === scrubTime);
  refreshTimeline();
});

modeDelBtn.addEventListener('click', () => {
  if (!scene || selectedModeIndex < 0) return;
  scene.modeKeyframes.splice(selectedModeIndex, 1);
  selectedModeIndex = -1;
  refreshTimeline();
});

scrubInput.addEventListener('input', () => {
  scrubTime = parseFloat(scrubInput.value);
  updatePreview();
});

function updatePreview(): void {
  const duration = sceneDuration();
  scrubTimeEl.textContent = `${scrubTime.toFixed(1)} / ${duration.toFixed(1)}s`;
  cameraTrack.setPlayhead(scrubTime);
  modeTrack.setPlayhead(scrubTime);
  if (!scene) return;
  const camera = interpolateCamera(scene.cameraKeyframes, scrubTime);
  renderer.render({
    tuning: TUNINGS[String(scene.tuning.edo)]!,
    layout: LAYOUT_PRESETS[String(scene.tuning.edo)]!,
    activeKeys: new Set(),
    activeDegrees: new Set(),
    inModePitchClasses: null,
    keyWindow: PREVIEW_KEY_WINDOW,
    colorMode: 'spiral',
    showKbGuide: false,
    camera,
  });
}

function updateRenderButton(): void {
  renderBtn.disabled = !(scene && events);
}

sceneFileInput.addEventListener('change', async () => {
  const file = sceneFileInput.files?.[0];
  if (!file) return;
  try {
    scene = parseScene(await file.text());
    statusEl.textContent = `Loaded scene "${scene.name}"`;
  } catch (err) {
    scene = null;
    statusEl.textContent = `Scene error: ${err instanceof Error ? err.message : String(err)}`;
  }
  updateRenderButton();
  refreshTimeline();
});

midiFileInput.addEventListener('change', async () => {
  const file = midiFileInput.files?.[0];
  if (!file) return;
  try {
    events = parseMidiFile(await file.arrayBuffer());
    statusEl.textContent = `Loaded MIDI (${events.length} events)`;
  } catch (err) {
    events = null;
    statusEl.textContent = `MIDI error: ${err instanceof Error ? err.message : String(err)}`;
  }
  updateRenderButton();
  refreshTimeline();
});

renderBtn.addEventListener('click', () => {
  if (!scene || !events) return;
  renderBtn.disabled = true;
  const recording = createRecordingEngine(canvas, audio.getAudioContext(), audio.getMasterOutput());
  const player = createScenePlayer(scene, events, audio, renderer, recording, {
    onProgress(elapsed, total) {
      statusEl.textContent = `Rendering… ${elapsed.toFixed(1)}s / ${total.toFixed(1)}s`;
    },
    onDone(blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${scene!.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      statusEl.textContent = 'Render complete — downloaded.';
      renderBtn.disabled = false;
    },
    onError(err) {
      statusEl.textContent = `Render error: ${err.message}`;
      renderBtn.disabled = false;
    },
  });
  player.render();
});

const resizeObserver = new ResizeObserver((entries) => {
  const entry = entries[0];
  if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
});
resizeObserver.observe(canvas);
const initRect = canvas.getBoundingClientRect();
if (initRect.width > 0) renderer.resize(initRect.width, initRect.height);
