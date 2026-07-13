import './style.css';
import { createAudioEngine } from './audioEngine.ts';
import { createRenderer } from './renderer.ts';
import { createRecordingEngine } from './recordingEngine.ts';
import { parseScene } from './scene.ts';
import type { Scene } from './scene.ts';
import { parseMidiFile } from './midiFile.ts';
import type { MidiEvent } from './midiFile.ts';
import { createScenePlayer } from './scenePlayer.ts';

const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
const audio = createAudioEngine();
const renderer = createRenderer(canvas);

const sceneFileInput = document.getElementById('scene-file-input') as HTMLInputElement;
const midiFileInput  = document.getElementById('midi-file-input')  as HTMLInputElement;
const renderBtn      = document.getElementById('render-btn')       as HTMLButtonElement;
const statusEl       = document.getElementById('render-status')    as HTMLSpanElement;

let scene: Scene | null = null;
let events: MidiEvent[] | null = null;

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
