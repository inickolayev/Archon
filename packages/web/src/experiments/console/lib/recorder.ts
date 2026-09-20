/**
 * The microphone half of dictating in the console.
 *
 * `MediaRecorder` records; the audio engine converts what it recorded into the
 * 16 kHz mono WAV the transcriber wants (see `primitives/voice.ts` for why the
 * conversion is here and not on the server). The hook owns three things that go
 * wrong when they are not owned: the microphone track, which keeps the
 * browser's recording indicator lit until every track is stopped; the elapsed
 * timer; and the audio contexts, which a browser will eventually refuse to keep
 * creating.
 *
 * Cancelling is a first-class outcome, not an error: the operator changes their
 * mind, and nothing should reach the chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_RECORDING_SECONDS,
  RECORDING_MIME_CANDIDATES,
  WAV_SAMPLE_RATE,
  encodeWav,
  recordingFileName,
} from '../primitives/voice';

/** The container this browser will actually record in, or '' for its default. */
function preferredMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  return RECORDING_MIME_CANDIDATES.find(type => MediaRecorder.isTypeSupported(type)) ?? '';
}

/** True when this browser can record at all — the button is hidden otherwise. */
export function canRecord(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    // `mediaDevices` is absent on an insecure origin, not merely unusable.
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * Decode whatever was recorded and re-encode it as a WAV the recogniser takes.
 *
 * `OfflineAudioContext` does the resampling: asking for the output at 16 kHz is
 * the whole conversion, and it also mixes down to the single channel we ask
 * for, so a stereo input needs no separate step.
 */
async function toWavFile(blob: Blob, at: Date): Promise<File> {
  const raw = await blob.arrayBuffer();
  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(raw);
  } finally {
    await decodeContext.close();
  }

  const frames = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, WAV_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const resampled = await offline.startRendering();

  const wav = encodeWav(resampled.getChannelData(0), WAV_SAMPLE_RATE);
  return new File([wav as BlobPart], recordingFileName(at), { type: 'audio/wav' });
}

export interface VoiceRecorder {
  /** True between `start` resolving and `stop`/`cancel`. */
  readonly recording: boolean;
  /** Whole seconds recorded so far, for the clock on screen. */
  readonly seconds: number;
  /** Why the last attempt failed — usually a refused microphone permission. */
  readonly error: string | null;
  readonly start: () => Promise<void>;
  /** Stop and hand back the clip, or null when there was nothing in it. */
  readonly stop: () => Promise<File | null>;
  readonly cancel: () => void;
}

export function useVoiceRecorder(): VoiceRecorder {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Set by `cancel` so the `stop` handler knows to throw the clip away. */
  const cancelledRef = useRef(false);

  const release = useCallback((): void => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    // Every track, not just the first: until they are all stopped the browser
    // keeps telling the operator they are being recorded.
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // A page left mid-recording must not keep the microphone open.
  useEffect(
    () => (): void => {
      release();
    },
    [release]
  );

  const start = useCallback(async (): Promise<void> => {
    if (recorderRef.current !== null) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType === '' ? undefined : { mimeType });
      chunksRef.current = [];
      cancelledRef.current = false;
      recorder.ondataavailable = (event): void => {
        if (event.data.size > 0) chunksRef.current = [...chunksRef.current, event.data];
      };
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.start();
      setSeconds(0);
      setRecording(true);
      tickRef.current = setInterval(() => {
        setSeconds(current => {
          const next = current + 1;
          // Stopped here rather than at upload time: a clip refused after five
          // minutes of talking is the version of this that loses the message.
          if (next >= MAX_RECORDING_SECONDS) recorderRef.current?.stop();
          return next;
        });
      }, 1000);
    } catch (err) {
      release();
      setError(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'The microphone is blocked for this page — allow it in the browser and try again.'
          : 'Could not start recording.'
      );
    }
  }, [release]);

  const stop = useCallback(async (): Promise<File | null> => {
    const recorder = recorderRef.current;
    if (recorder === null) return null;
    const at = new Date();
    const finished = new Promise<Blob | null>(resolve => {
      recorder.onstop = (): void => {
        resolve(
          cancelledRef.current ? null : new Blob(chunksRef.current, { type: recorder.mimeType })
        );
      };
    });
    if (recorder.state !== 'inactive') recorder.stop();
    const blob = await finished;
    release();
    if (blob === null || blob.size === 0) return null;
    try {
      return await toWavFile(blob, at);
    } catch {
      setError('That recording could not be prepared for sending.');
      return null;
    }
  }, [release]);

  const cancel = useCallback((): void => {
    cancelledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder !== null && recorder.state !== 'inactive') recorder.stop();
    chunksRef.current = [];
    release();
    setSeconds(0);
  }, [release]);

  return { recording, seconds, error, start, stop, cancel };
}
