/**
 * Swann — offline text-to-speech (TTS) for spoken replies.
 *
 * Wraps sherpa-onnx `OfflineTts` (a Piper VITS French voice) to synthesize the
 * agent's reply, then resamples it to the format @discordjs/voice plays as
 * StreamType.Raw: 48 kHz, stereo, signed-16-bit LE.
 *
 * Why resample in JS (not ffmpeg): the receive path proved that prism.FFmpeg
 * produces zero output on the HA Debian image. Synthesized replies are short, so
 * a simple linear-interpolation resample (model rate -> 48k) + mono->stereo
 * duplication is plenty for a voice notification and has no subprocess to fail.
 *
 * sherpa-onnx-node is a CJS native addon; loaded lazily via dynamic import with
 * default interop (same pattern as src/voice/vad.ts), so importing this module
 * never eagerly requires the native binary.
 *
 * Graceful degradation: if TTS is disabled or the model files are absent,
 * isAvailable() is false and synthesize() returns null — the caller just stays
 * silent, exactly like the wake-word/VAD files.
 */

import { existsSync } from 'node:fs';
import type { Logger } from '../logger.js';
import type { VoiceConfig } from '../config.js';
import type { OfflineTts } from 'sherpa-onnx-node';

const OUT_RATE = 48_000; // StreamType.Raw is 48 kHz stereo s16le

export interface TtsService {
  /** True only when enabled AND all model files exist (checked at construction). */
  isAvailable(): boolean;
  /**
   * Synthesize text to a 48 kHz stereo s16le Buffer, or null if TTS is
   * unavailable or synthesis failed (never throws).
   */
  synthesize(text: string): Promise<Buffer | null>;
}

type OfflineTtsCtor = typeof OfflineTts;
let ctorPromise: Promise<OfflineTtsCtor> | null = null;
async function loadOfflineTts(): Promise<OfflineTtsCtor> {
  if (!ctorPromise) {
    ctorPromise = import('sherpa-onnx-node').then((mod) => {
      const m = mod as unknown as { OfflineTts?: OfflineTtsCtor; default?: { OfflineTts?: OfflineTtsCtor } };
      const ctor = m.OfflineTts ?? m.default?.OfflineTts;
      if (!ctor) throw new Error('Could not resolve OfflineTts constructor from sherpa-onnx-node');
      return ctor;
    });
  }
  return ctorPromise;
}

/** Linear-resample mono Float32 [-1,1] @ inRate -> 48k STEREO s16le Buffer. */
function toRaw48Stereo(samples: Float32Array, inRate: number): Buffer {
  if (inRate === OUT_RATE) {
    const out = Buffer.allocUnsafe(samples.length * 4);
    for (let i = 0; i < samples.length; i++) {
      const v = clampInt16(samples[i] ?? 0);
      out.writeInt16LE(v, i * 4);
      out.writeInt16LE(v, i * 4 + 2);
    }
    return out;
  }
  const ratio = OUT_RATE / inRate;
  const outLen = Math.floor(samples.length * ratio);
  const out = Buffer.allocUnsafe(outLen * 4); // 2 channels * 2 bytes
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = samples[i0] ?? 0;
    const b = samples[i0 + 1] ?? a;
    const v = clampInt16(a + (b - a) * frac);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

function clampInt16(f: number): number {
  const s = f < -1 ? -1 : f > 1 ? 1 : f;
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
}

export function createTtsService(deps: { logger: Logger; voice: VoiceConfig }): TtsService {
  const { voice } = deps;
  const log = deps.logger.child('tts');

  const available =
    voice.ttsEnabled &&
    existsSync(voice.ttsModelPath) &&
    existsSync(voice.ttsTokensPath) &&
    existsSync(voice.ttsDataDir);

  if (voice.ttsEnabled && !available) {
    log.warn('TTS enabled but model files missing; staying silent', {
      model: voice.ttsModelPath,
      tokens: voice.ttsTokensPath,
      dataDir: voice.ttsDataDir,
    });
  } else if (available) {
    log.info('TTS enabled', { model: voice.ttsModelPath });
  }

  // The native model is heavy; construct lazily on first synthesize.
  let enginePromise: Promise<OfflineTts> | null = null;
  async function engine(): Promise<OfflineTts> {
    if (!enginePromise) {
      enginePromise = (async () => {
        const Ctor = await loadOfflineTts();
        const tts = new Ctor({
          model: {
            vits: {
              model: voice.ttsModelPath,
              tokens: voice.ttsTokensPath,
              dataDir: voice.ttsDataDir,
            },
            numThreads: 1,
            provider: 'cpu',
            debug: false,
          },
        });
        log.debug('TTS engine loaded', { sampleRate: tts.sampleRate, speakers: tts.numSpeakers });
        return tts;
      })();
    }
    return enginePromise;
  }

  return {
    isAvailable(): boolean {
      return available;
    },
    async synthesize(text: string): Promise<Buffer | null> {
      if (!available) return null;
      const clean = text.trim();
      if (!clean) return null;
      try {
        const tts = await engine();
        const audio = tts.generate({ text: clean, sid: 0, speed: voice.ttsRate });
        if (!audio.samples || audio.samples.length === 0) return null;
        return toRaw48Stereo(audio.samples, audio.sampleRate);
      } catch (err) {
        log.warn('TTS synthesis failed', err);
        return null;
      }
    },
  };
}
