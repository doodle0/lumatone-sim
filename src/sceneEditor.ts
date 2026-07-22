import './style.css';
import { createAudioEngine } from './audio/audioEngine.ts';
import { createRenderer } from './render/renderer.ts';
import { createRecordingEngine } from './io/recordingEngine.ts';
import { parseScene, createDefaultScene } from './scene/scene.ts';
import type { Scene } from './scene/scene.ts';
import type { ChannelConfig } from './scene/scene.ts';
import { DEFAULT_CHANNEL_CONFIG } from './scene/scene.ts';
import { SYNTH_PRESETS } from './audio/synthPresets.ts';
import { parseMidiFile, midiDuration, parseMidiChannelPans } from './io/midiFile.ts';
import type { MidiEvent } from './io/midiFile.ts';
import { createScenePlayer, activeDegreesAt } from './scene/scenePlayer.ts';
import type { ScenePlayer } from './scene/scenePlayer.ts';
import { createTimelineTrack } from './scene/timelineTrack.ts';
import type { CameraKeyframe } from './render/camera.ts';
import { interpolateCamera, DEFAULT_CAMERA } from './render/camera.ts';
import type { ModeKeyframe } from './scene/scene.ts';
import { modeOffsetAt, inModePitchClassesFor } from './scene/scene.ts';
import { TUNINGS } from './core/tuningEngine.ts';
import { LAYOUT_PRESETS } from './core/layout.ts';
import { buildKeyboardWindow } from './input/keyboardInput.ts';

const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const audio = createAudioEngine();
const renderer = createRenderer(canvas);

const sceneFileInput = document.getElementById('scene-file-input') as HTMLInputElement;
const midiFileInput  = document.getElementById('midi-file-input')  as HTMLInputElement;
const playBtn         = document.getElementById('play-btn')        as HTMLButtonElement;
const renderBtn       = document.getElementById('render-btn')      as HTMLButtonElement;
const playStopBtn      = document.getElementById('stop-btn')        as HTMLButtonElement;
const statusEl       = document.getElementById('render-status')    as HTMLSpanElement;

const PREVIEW_KEY_WINDOW = buildKeyboardWindow(-6, -2);

let scene: Scene | null = null;
let events: MidiEvent[] | null = null;
let activePlayer: ScenePlayer | null = null;

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
const channelsFoldBtn   = document.getElementById('channels-fold-btn') as HTMLButtonElement;
const channelsSummaryEl = document.getElementById('channels-summary') as HTMLSpanElement;
let channelsExpanded = true;
const expandedFilterRows = new Set<number>();

channelsFoldBtn.addEventListener('click', () => {
  channelsExpanded = !channelsExpanded;
  renderChannelsTable();
});

function updateChannelsHeader(): void {
  const count = scene ? Object.keys(scene.channels).length : 0;
  channelsFoldBtn.textContent = `${channelsExpanded ? '▾' : '▸'} Channels`;
  channelsFoldBtn.setAttribute('aria-expanded', String(channelsExpanded));
  channelsSummaryEl.textContent = channelsExpanded ? '' : `(${count} channel${count === 1 ? '' : 's'})`;
}
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
  updateChannelsHeader();
  if (!scene || !channelsExpanded) return;

  for (const [key, config] of Object.entries(scene.channels)) {
    const channel = Number(key);
    const rowWrap = document.createElement('div');
    rowWrap.className = 'flex flex-col gap-1 pb-1 border-b border-border/50 last:border-b-0';

    const row = document.createElement('div');
    row.className = 'flex items-center gap-3 text-sm flex-wrap';

    const label = document.createElement('span');
    label.className = 'ctrl-label w-20';
    label.textContent = `Ch ${channel}`;
    row.appendChild(label);

    const presetSelect = document.createElement('select');
    presetSelect.className = 'ctrl-select';
    const presetPlaceholder = document.createElement('option');
    presetPlaceholder.value = '';
    presetPlaceholder.textContent = 'Preset…';
    presetSelect.appendChild(presetPlaceholder);
    for (const preset of SYNTH_PRESETS) {
      const o = document.createElement('option');
      o.value = preset.name;
      o.textContent = preset.name;
      presetSelect.appendChild(o);
    }
    presetSelect.addEventListener('change', () => {
      const preset = SYNTH_PRESETS.find((p) => p.name === presetSelect.value);
      if (!preset) return;
      config.waveform = preset.waveform;
      config.adsr = { ...preset.adsr };
      config.filterEnvelope = { ...preset.filterEnvelope, adsr: { ...preset.filterEnvelope.adsr } };
      renderChannelsTable();
    });
    row.appendChild(presetSelect);

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

    const panWrap = document.createElement('label');
    panWrap.className = 'ctrl-label';
    panWrap.textContent = 'Pan ';
    const panInput = document.createElement('input');
    panInput.type = 'number';
    panInput.step = '0.1';
    panInput.min = '-1';
    panInput.max = '1';
    panInput.value = String(config.pan);
    panInput.className = 'ctrl-select w-16';
    panInput.addEventListener('input', () => {
      config.pan = Math.max(-1, Math.min(1, parseFloat(panInput.value) || 0));
    });
    panWrap.appendChild(panInput);
    row.appendChild(panWrap);

    const filterToggleBtn = document.createElement('button');
    filterToggleBtn.type = 'button';
    filterToggleBtn.className = 'text-fg/label text-xs cursor-pointer select-none px-1';
    filterToggleBtn.textContent = expandedFilterRows.has(channel) ? '▾ Filter' : '▸ Filter';
    filterToggleBtn.addEventListener('click', () => {
      if (expandedFilterRows.has(channel)) expandedFilterRows.delete(channel);
      else expandedFilterRows.add(channel);
      renderChannelsTable();
    });
    row.appendChild(filterToggleBtn);

    const delBtn = document.createElement('button');
    delBtn.textContent = 'remove';
    delBtn.className = 'px-2 py-0.5 rounded text-xs bg-red-500/ghost text-red-400 hover:bg-red-500/hover cursor-pointer';
    delBtn.addEventListener('click', () => {
      delete scene!.channels[channel];
      renderChannelsTable();
    });
    row.appendChild(delBtn);

    rowWrap.appendChild(row);

    if (expandedFilterRows.has(channel)) {
      const filterRow = document.createElement('div');
      filterRow.className = 'flex items-center gap-3 text-sm flex-wrap pl-20';

      const baseWrap = document.createElement('label');
      baseWrap.className = 'ctrl-label';
      baseWrap.textContent = 'Base ';
      const baseInput = document.createElement('input');
      baseInput.type = 'number';
      baseInput.step = '10';
      baseInput.min = '20';
      baseInput.value = String(config.filterEnvelope.baseCutoff);
      baseInput.className = 'ctrl-select w-20';
      baseInput.addEventListener('input', () => {
        config.filterEnvelope.baseCutoff = parseFloat(baseInput.value) || 0;
      });
      baseWrap.appendChild(baseInput);
      filterRow.appendChild(baseWrap);

      const depthWrap = document.createElement('label');
      depthWrap.className = 'ctrl-label';
      depthWrap.textContent = 'Depth ';
      const depthInput = document.createElement('input');
      depthInput.type = 'number';
      depthInput.step = '0.1';
      depthInput.value = String(config.filterEnvelope.depthOctaves);
      depthInput.className = 'ctrl-select w-16';
      depthInput.addEventListener('input', () => {
        config.filterEnvelope.depthOctaves = parseFloat(depthInput.value) || 0;
      });
      depthWrap.appendChild(depthInput);
      filterRow.appendChild(depthWrap);

      const qWrap = document.createElement('label');
      qWrap.className = 'ctrl-label';
      qWrap.textContent = 'Q ';
      const qInput = document.createElement('input');
      qInput.type = 'number';
      qInput.step = '0.1';
      qInput.min = '0.1';
      qInput.max = '20';
      qInput.value = String(config.filterEnvelope.resonance);
      qInput.className = 'ctrl-select w-16';
      qInput.addEventListener('input', () => {
        config.filterEnvelope.resonance = parseFloat(qInput.value) || 0.1;
      });
      qWrap.appendChild(qInput);
      filterRow.appendChild(qWrap);

      for (const field of ['attack', 'decay', 'sustain', 'release'] as const) {
        const wrap = document.createElement('label');
        wrap.className = 'ctrl-label';
        wrap.textContent = 'f' + field[0]!.toUpperCase() + ' ';
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '0.01';
        input.value = String(config.filterEnvelope.adsr[field]);
        input.className = 'ctrl-select w-16';
        input.addEventListener('input', () => { config.filterEnvelope.adsr[field] = parseFloat(input.value) || 0; });
        wrap.appendChild(input);
        filterRow.appendChild(wrap);
      }

      rowWrap.appendChild(filterRow);
    }

    channelsTableEl.appendChild(rowWrap);
  }
}

channelAddBtn.addEventListener('click', () => {
  if (!scene) return;
  let next = 0;
  while (scene.channels[next]) next++;
  scene.channels[next] = {
    waveform: DEFAULT_CHANNEL_CONFIG.waveform,
    adsr: { ...DEFAULT_CHANNEL_CONFIG.adsr },
    pan: DEFAULT_CHANNEL_CONFIG.pan,
    filterEnvelope: { ...DEFAULT_CHANNEL_CONFIG.filterEnvelope, adsr: { ...DEFAULT_CHANNEL_CONFIG.filterEnvelope.adsr } },
  };
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
  const modeOffset = modeOffsetAt(scene.modeKeyframes, scrubTime);
  renderer.render({
    tuning: TUNINGS[String(scene.tuning.edo)]!,
    layout: LAYOUT_PRESETS[String(scene.tuning.edo)]!,
    activeKeys: new Set(),
    activeDegrees: events ? activeDegreesAt(scene, events, scene.tuning.edo, scrubTime) : new Set(),
    inModePitchClasses: inModePitchClassesFor(scene.tuning.edo, modeOffset),
    keyWindow: PREVIEW_KEY_WINDOW,
    colorMode: 'spiral',
    showKbGuide: false,
    camera,
  });
}

function updateRenderButton(): void {
  const ready = !!(scene && events) && !activePlayer;
  renderBtn.disabled = !ready;
  playBtn.disabled = !ready;
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
    const buffer = await file.arrayBuffer();
    events = parseMidiFile(buffer);
    if (!scene) {
      scene = createDefaultScene(file.name);
      statusEl.textContent = `Loaded MIDI (${events.length} events) — created default scene`;
    } else {
      statusEl.textContent = `Loaded MIDI (${events.length} events)`;
    }

    // Seed a channel row (with the file's own Pan CC, if any) for every
    // channel the MIDI file actually uses that isn't already configured —
    // so playback respects each channel's panning without manual setup.
    const pans = parseMidiChannelPans(buffer);
    for (const channel of new Set(events.map((e) => e.channel))) {
      if (scene.channels[channel]) continue;
      scene.channels[channel] = {
        waveform: DEFAULT_CHANNEL_CONFIG.waveform,
        adsr: { ...DEFAULT_CHANNEL_CONFIG.adsr },
        pan: pans[channel] ?? DEFAULT_CHANNEL_CONFIG.pan,
        filterEnvelope: { ...DEFAULT_CHANNEL_CONFIG.filterEnvelope, adsr: { ...DEFAULT_CHANNEL_CONFIG.filterEnvelope.adsr } },
      };
    }
  } catch (err) {
    events = null;
    statusEl.textContent = `MIDI error: ${err instanceof Error ? err.message : String(err)}`;
  }
  updateRenderButton();
  refreshTimeline();
});

function startPlayback(recordFlag: boolean): void {
  if (!scene || !events || activePlayer) return;

  const recording = createRecordingEngine(canvas, audio.getAudioContext(), audio.getMasterOutput());
  const player = createScenePlayer(scene, events, audio, renderer, recording, {
    onProgress(elapsed, total) {
      statusEl.textContent = recordFlag
        ? `Rendering… ${elapsed.toFixed(1)}s / ${total.toFixed(1)}s`
        : `Playing… ${elapsed.toFixed(1)}s / ${total.toFixed(1)}s`;
      scrubTime = elapsed;
      scrubInput.value = String(elapsed);
      scrubTimeEl.textContent = `${elapsed.toFixed(1)} / ${total.toFixed(1)}s`;
      cameraTrack.setPlayhead(elapsed);
      modeTrack.setPlayhead(elapsed);
    },
    onDone(blob) {
      if (blob) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${scene!.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.webm`;
        a.click();
        URL.revokeObjectURL(url);
        statusEl.textContent = 'Render complete — downloaded.';
      } else {
        statusEl.textContent = 'Playback complete.';
      }
      activePlayer = null;
      playStopBtn.classList.add('hidden');
      updateRenderButton();
    },
    onError(err) {
      statusEl.textContent = `${recordFlag ? 'Render' : 'Playback'} error: ${err.message}`;
      activePlayer = null;
      playStopBtn.classList.add('hidden');
      updateRenderButton();
    },
  });

  activePlayer = player;
  playStopBtn.classList.remove('hidden');
  updateRenderButton();
  if (recordFlag) player.render(); else player.play(scrubTime);
}

renderBtn.addEventListener('click', () => startPlayback(true));
playBtn.addEventListener('click', () => startPlayback(false));
playStopBtn.addEventListener('click', () => activePlayer?.stop());

// --- Keyboard shortcuts ---
// Space is a global transport shortcut and always wins, no matter what has
// focus: it must never fall through to a focused element's own native Space
// behavior (a button "clicking" itself, a <select> popping its option list,
// a file input opening the OS file picker). So it's handled first, before any
// focus check — there is no element on this page that gets to consume it.
//
// The other shortcuts below (arrows/Home/End/Delete) are different: they'd
// step on a genuinely focused editable control (typing a number, picking a
// select option), so those back off via isInteractiveTarget. The one
// exception is the #scrub range input — it's the control users interact with
// constantly, mouse click/drag leaves it holding focus in Chrome/Firefox, and
// our arrow/Home/End handlers already call preventDefault() before touching
// scrubTime, so they cleanly take over from (rather than fight with) the
// slider's native nudging.
function isInteractiveTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || el.tagName === 'BUTTON' || el.isContentEditable) return true;
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).type !== 'range';
  return false;
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (activePlayer) activePlayer.stop();
    else startPlayback(false);
    return;
  }

  if (e.code === 'Escape') {
    if (activePlayer) activePlayer.stop();
    return;
  }

  if (isInteractiveTarget(e.target)) return;

  if (!scene || activePlayer) return;

  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 1 : 0.1;
    const delta = e.code === 'ArrowLeft' ? -step : step;
    scrubTime = Math.max(0, Math.min(sceneDuration(), scrubTime + delta));
    scrubInput.value = String(scrubTime);
    updatePreview();
    return;
  }

  if (e.code === 'Home') {
    e.preventDefault();
    scrubTime = 0;
    scrubInput.value = '0';
    updatePreview();
    return;
  }

  if (e.code === 'End') {
    e.preventDefault();
    scrubTime = sceneDuration();
    scrubInput.value = String(scrubTime);
    updatePreview();
    return;
  }

  if (e.code === 'Delete' || e.code === 'Backspace') {
    if (selectedCameraIndex >= 0) { e.preventDefault(); cameraDelBtn.click(); }
    else if (selectedModeIndex >= 0) { e.preventDefault(); modeDelBtn.click(); }
  }
});

const resizeObserver = new ResizeObserver((entries) => {
  const entry = entries[0];
  if (entry) renderer.resize(entry.contentRect.width, entry.contentRect.height);
});
resizeObserver.observe(canvas);
const initRect = canvas.getBoundingClientRect();
if (initRect.width > 0) renderer.resize(initRect.width, initRect.height);
