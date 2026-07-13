// Records the canvas + audio into a WebM blob.
// Caller supplies the canvas, an AudioContext, and the AudioNode to tap
// (typically the master gain). On stop(), returns a Blob ready for download.
//
// Integration note: audioEngine will need a method that exposes its
// AudioContext and masterGain so the caller can pass them here.

export interface RecordingOptions {
  fps?: number;              // canvas capture frame rate (default: 30)
  videoBitsPerSecond?: number; // omit to let the browser decide
}

export interface RecordingEngine {
  start(): void;
  stop(): Promise<Blob>;
  isRecording(): boolean;
  dispose(): void;
}

const PREFERRED_MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const;

function pickMimeType(): string {
  for (const type of PREFERRED_MIME_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function createRecordingEngine(
  canvas: HTMLCanvasElement,
  audioContext: AudioContext,
  audioSource: AudioNode,
  options: RecordingOptions = {},
): RecordingEngine {
  const { fps = 30, videoBitsPerSecond } = options;

  let recorder: MediaRecorder | null = null;
  let audioDestination: MediaStreamAudioDestinationNode | null = null;
  let chunks: Blob[] = [];
  let stopResolve: ((blob: Blob) => void) | null = null;

  function start(): void {
    if (recorder) throw new Error('Already recording');

    audioDestination = audioContext.createMediaStreamDestination();
    audioSource.connect(audioDestination);

    const videoStream = canvas.captureStream(fps);
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks(),
    ]);

    const mimeType = pickMimeType();
    const recorderOptions: MediaRecorderOptions = {};
    if (mimeType) recorderOptions.mimeType = mimeType;
    if (videoBitsPerSecond !== undefined) recorderOptions.videoBitsPerSecond = videoBitsPerSecond;

    chunks = [];
    recorder = new MediaRecorder(combined, recorderOptions);

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      chunks = [];
      audioDestination?.disconnect();
      audioDestination = null;
      recorder = null;
      stopResolve?.(blob);
      stopResolve = null;
    };

    recorder.start();
  }

  function stop(): Promise<Blob> {
    if (!recorder || recorder.state === 'inactive') {
      return Promise.reject(new Error('Not recording'));
    }
    return new Promise<Blob>((resolve) => {
      stopResolve = resolve;
      recorder!.stop();
    });
  }

  function isRecording(): boolean {
    return recorder !== null && recorder.state === 'recording';
  }

  function dispose(): void {
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    audioDestination?.disconnect();
    audioDestination = null;
    recorder = null;
    stopResolve = null;
    chunks = [];
  }

  return { start, stop, isRecording, dispose };
}
