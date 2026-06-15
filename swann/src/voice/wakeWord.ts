/**
 * Swann — on-device wake-word detector via sherpa-onnx KeywordSpotter.
 *
 * Replaces Picovoice Porcupine with a fully local, no-account, no-API keyword
 * spotter built on the same sherpa-onnx ONNX runtime the VAD already uses.
 *
 * Audio format contract (sherpa-onnx KWS):
 *   - mono, 16000 Hz
 *   - Float32 samples in [-1, 1] (we convert int16 -> float32 by /32768)
 *   - chunk size is flexible: the OnlineStream accumulates context, so feeding
 *     the pipeline's 512-sample frames one at a time is fine.
 *
 * Detection model: a streaming transducer (encoder/decoder/joiner + tokens),
 * e.g. sherpa-onnx-kws-zipformer-gigaspeech-3.3M. The "Swann" keyword lives in
 * a tokenized keywords file (see DOCS.md for how to generate it with
 * text2token). One spotter + one stream per guild; reset() on each hit so the
 * same utterance can't re-fire.
 *
 * sherpa-onnx-node is a CommonJS native addon; imported via default interop.
 */

import type { Logger } from '../logger.js';
import type { VoiceConfig } from '../config.js';
import { KeywordSpotter, type SherpaOnlineStream } from 'sherpa-onnx-node';

const SAMPLE_RATE = 16000;
const FEATURE_DIM = 80;
const FRAME_SAMPLES = 512;

/**
 * A single guild's wake-word engine. Each guild gets its own spotter + stream
 * so detections never interleave across guilds and release() is clean.
 */
export interface WakeWordEngine {
  /** Informational: the frame length the receive pipeline emits. */
  readonly frameLength: number;
  /** Sample rate the engine expects (16000). */
  readonly sampleRate: number;
  /**
   * Run one 512-sample int16 frame through the engine.
   * Returns true if the "Swann" keyword fired on this frame.
   */
  detect(frame: Int16Array): boolean;
  /** Release native resources. Safe to call multiple times. */
  release(): void;
}

/**
 * Lazily load the CJS native addon so importing this module (e.g. for types)
 * does not eagerly require the native binary in environments where it is
 * unavailable (CI typecheck, tests).
 */
type KeywordSpotterCtor = typeof KeywordSpotter;
let ctorPromise: Promise<KeywordSpotterCtor> | null = null;
async function loadSpotter(): Promise<KeywordSpotterCtor> {
  if (!ctorPromise) {
    ctorPromise = import('sherpa-onnx-node').then((mod) => {
      const m = mod as unknown as {
        KeywordSpotter?: KeywordSpotterCtor;
        default?: { KeywordSpotter?: KeywordSpotterCtor };
      };
      const ctor = m.KeywordSpotter ?? m.default?.KeywordSpotter;
      if (!ctor) {
        throw new Error('Could not resolve KeywordSpotter constructor from sherpa-onnx-node');
      }
      return ctor;
    });
  }
  return ctorPromise;
}

/**
 * Create a wake-word engine for the "Swann" custom keyword.
 *
 * @throws if the model/keyword files are missing or unreadable, or the addon
 *         cannot be loaded.
 */
export async function createWakeWordEngine(deps: {
  logger: Logger;
  voice: VoiceConfig;
}): Promise<WakeWordEngine> {
  const { logger, voice } = deps;
  const Spotter = await loadSpotter();

  let spotter: InstanceType<KeywordSpotterCtor> | null = new Spotter({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: FEATURE_DIM },
    modelConfig: {
      transducer: {
        encoder: voice.kwsEncoderPath,
        decoder: voice.kwsDecoderPath,
        joiner: voice.kwsJoinerPath,
      },
      tokens: voice.kwsTokensPath,
      numThreads: 1,
      provider: 'cpu',
      debug: false,
    },
    keywordsFile: voice.kwsKeywordsPath,
    keywordsThreshold: voice.kwsThreshold,
    keywordsScore: voice.kwsScore,
  });

  let stream: SherpaOnlineStream | null = spotter.createStream();

  logger.debug('sherpa-onnx KWS wake-word engine created', {
    encoder: voice.kwsEncoderPath,
    keywordsFile: voice.kwsKeywordsPath,
    threshold: voice.kwsThreshold,
    score: voice.kwsScore,
  });

  // Reusable scratch buffer for int16 -> float32 conversion.
  const scratch = new Float32Array(FRAME_SAMPLES);

  return {
    frameLength: FRAME_SAMPLES,
    sampleRate: SAMPLE_RATE,
    detect(frame: Int16Array): boolean {
      if (!spotter || !stream) return false;
      const samples = frame.length === FRAME_SAMPLES ? scratch : new Float32Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        // 32768 keeps the result strictly within [-1, 1).
        samples[i] = (frame[i] ?? 0) / 32768;
      }
      try {
        stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
        while (spotter.isReady(stream)) spotter.decode(stream);
        const result = spotter.getResult(stream);
        if (result.keyword && result.keyword.length > 0) {
          // Clear the stream's keyword state so the same hit can't re-fire.
          spotter.reset(stream);
          return true;
        }
      } catch (err) {
        logger.error('KWS detect() failed', err);
        return false;
      }
      return false;
    },
    release(): void {
      // sherpa-onnx exposes no explicit free in the Node binding; drop the
      // references and let GC reclaim the native handles.
      spotter = null;
      stream = null;
    },
  };
}
