/**
 * Swann — Silero VAD wrapper (via sherpa-onnx-node).
 *
 * After the wake word fires, the pipeline switches into "capture" mode and
 * feeds every subsequent 512-sample frame here. Silero VAD decides where the
 * utterance ends (after `minSilenceDuration` of trailing silence) and exposes
 * the completed segment through an internal queue.
 *
 * Audio format contract (Silero, via sherpa-onnx):
 *   - mono, 16000 Hz
 *   - Float32 samples in [-1, 1] (we convert int16 -> float32 by /32768)
 *   - window size 512 samples (matches the standard silero_vad.onnx model and
 *     the KWS frame size, so one frame feeds both engines).
 *
 * sherpa-onnx-node is a CommonJS native addon; imported via default interop.
 */

import type { Logger } from '../logger.js';
import type { VoiceConfig } from '../config.js';

const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 512;
const BUFFER_SECONDS = 30;

// ---------------------------------------------------------------------------
// Minimal structural typing for the sherpa-onnx-node Vad surface we use.
// ---------------------------------------------------------------------------
interface SileroSegment {
  /** Buffered utterance, mono 16k Float32 in [-1, 1]. */
  readonly samples: Float32Array;
  /** Start sample index relative to the stream. */
  readonly start: number;
}

interface SherpaVad {
  acceptWaveform(samples: Float32Array): void;
  /** True while speech is currently ongoing. */
  isDetected(): boolean;
  /** True when no completed segment is queued. */
  isEmpty(): boolean;
  /** Peek the oldest completed segment. */
  front(): SileroSegment;
  /** Drop the oldest completed segment. */
  pop(): void;
  /** Flush any in-progress speech as a final segment (end of stream). */
  flush(): void;
  /** Clear all internal state. */
  reset(): void;
}

interface SherpaVadConfig {
  sileroVad: {
    model: string;
    threshold: number;
    minSpeechDuration: number;
    minSilenceDuration: number;
    windowSize: number;
  };
  sampleRate: number;
}

type SherpaVadCtor = new (config: SherpaVadConfig, bufferSizeInSeconds: number) => SherpaVad;

interface SherpaModule {
  Vad: SherpaVadCtor;
}

let modPromise: Promise<SherpaModule> | null = null;
async function loadSherpa(): Promise<SherpaModule> {
  if (!modPromise) {
    modPromise = import('sherpa-onnx-node').then((mod) => {
      const m = mod as unknown as { Vad?: SherpaVadCtor; default?: { Vad?: SherpaVadCtor } };
      const Vad = m.Vad ?? m.default?.Vad;
      if (!Vad) throw new Error('Could not resolve Vad constructor from sherpa-onnx-node');
      return { Vad };
    });
  }
  return modPromise;
}

/** Reusable scratch buffer for int16 -> float32 conversion (one per detector). */
function int16ToFloat32(frame: Int16Array, out: Float32Array): Float32Array {
  for (let i = 0; i < frame.length; i++) {
    // 32768 keeps the result strictly within [-1, 1).
    out[i] = (frame[i] ?? 0) / 32768;
  }
  return out;
}

/**
 * A single guild's utterance detector. Created on demand after a wake-word
 * hit, drained when a full segment completes, then released.
 */
export interface UtteranceDetector {
  /**
   * Feed one frame (after the wake word fired). Returns the completed
   * utterance as 16k mono Float32 when speech has ended (after the configured
   * trailing silence), otherwise null.
   */
  feed(frame: Int16Array): Float32Array | null;
  /**
   * Force-finish the current utterance (e.g. the user stopped speaking and the
   * Discord stream ended). Returns the captured samples, or null if empty.
   */
  finish(): Float32Array | null;
  /** Clear state to reuse the detector for the next utterance. */
  reset(): void;
  /** Release native resources. */
  release(): void;
}

export async function createUtteranceDetector(deps: {
  logger: Logger;
  voice: VoiceConfig;
}): Promise<UtteranceDetector> {
  const { logger, voice } = deps;
  const { Vad } = await loadSherpa();

  const vad: SherpaVad = new Vad(
    {
      sileroVad: {
        model: voice.sileroVadPath,
        threshold: 0.5,
        minSpeechDuration: 0.25,
        // Trailing silence that ends an utterance. 0.8s tolerates the natural
        // inter-word pauses inside a spoken command ("mets ... du ... Jul") so
        // the capture isn't cut mid-sentence.
        minSilenceDuration: 0.8,
        windowSize: WINDOW_SIZE,
      },
      sampleRate: SAMPLE_RATE,
    },
    BUFFER_SECONDS,
  );

  logger.debug('Silero VAD detector created', { model: voice.sileroVadPath });

  const scratch = new Float32Array(WINDOW_SIZE);

  const drain = (): Float32Array | null => {
    if (vad.isEmpty()) return null;
    const seg = vad.front();
    // Copy out before pop() — the native segment buffer may be reused.
    const out = Float32Array.from(seg.samples);
    vad.pop();
    return out;
  };

  return {
    feed(frame: Int16Array): Float32Array | null {
      const float =
        frame.length === WINDOW_SIZE ? int16ToFloat32(frame, scratch) : int16ToFloat32(frame, new Float32Array(frame.length));
      try {
        vad.acceptWaveform(float);
      } catch (err) {
        logger.error('Silero VAD acceptWaveform failed', err);
        return null;
      }
      return drain();
    },
    finish(): Float32Array | null {
      try {
        vad.flush();
      } catch (err) {
        logger.warn('Silero VAD flush failed', err);
      }
      return drain();
    },
    reset(): void {
      try {
        vad.reset();
      } catch (err) {
        logger.warn('Silero VAD reset failed', err);
      }
    },
    release(): void {
      // sherpa-onnx Vad has no explicit free in the Node binding; reset clears
      // internal queues and lets GC reclaim the native handle.
      try {
        vad.reset();
      } catch {
        /* ignore */
      }
    },
  };
}

export { SAMPLE_RATE as VAD_SAMPLE_RATE, WINDOW_SIZE as VAD_WINDOW_SIZE };
