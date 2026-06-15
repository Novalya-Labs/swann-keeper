/**
 * Swann — per-user Discord voice receive pipeline.
 *
 * Discord voice receive is ALWAYS 48kHz stereo Opus, frameSize 960. To feed
 * Porcupine + Silero (both want 16kHz mono int16, 512-sample frames) we:
 *
 *   opus packets
 *     -> prism.opus.Decoder({rate:48000, channels:2, frameSize:960})  // 48k stereo s16le
 *     -> prism.FFmpeg(-ar 16000 -ac 1)                                // 16k mono s16le
 *     -> ring buffer sliced into exact 512-sample Int16Array frames
 *
 * We do NOT decimate manually (aliasing wrecks wake-word accuracy); FFmpeg's
 * resampler does the downsample + downmix.
 *
 * One pipeline instance per (guild, speaking user). The VoiceListener creates
 * one on each `receiver.speaking 'start'` and tears it down when the per-user
 * opus stream ends (AfterSilence).
 *
 * prism-media's default export is CJS under ESM; import the default and reach
 * into prism.opus / prism.FFmpeg.
 */

import { pipeline } from 'node:stream';
import prism from 'prism-media';
import { EndBehaviorType } from '@discordjs/voice';
import type { VoiceReceiver } from '@discordjs/voice';
import type { Logger } from '../logger.js';

/** Exactly one 512-sample int16 frame = 1024 bytes (s16le). */
const FRAME_SAMPLES = 512;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/** End the per-user opus stream this many ms after the user stops speaking. */
const SILENCE_END_MS = 1000;

export interface UserPipeline {
  /** Stop and clean up all streams for this user. */
  stop(): void;
}

/**
 * Subscribe to a single user's opus stream and emit 16k mono 512-sample int16
 * frames via onFrame. onEnd fires once the user's stream ends (silence) so the
 * caller can flush the VAD and resume wake-word listening.
 */
export function startUserPipeline(deps: {
  logger: Logger;
  receiver: VoiceReceiver;
  userId: string;
  onFrame: (frame: Int16Array) => void;
  onEnd: () => void;
}): UserPipeline {
  const { logger, receiver, userId, onFrame, onEnd } = deps;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
  });

  // Opus -> 48kHz stereo s16le PCM (Discord's native receive format).
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

  // 48k stereo -> 16k mono s16le. FFmpeg handles resample + downmix correctly.
  const transcoder = new prism.FFmpeg({
    args: [
      '-loglevel', 'error',
      '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
    ],
  });

  // Carry partial frames across chunk boundaries (FFmpeg chunks never align to
  // 512 samples). We emit exact 512-sample frames and keep the remainder.
  let carry: Buffer = Buffer.alloc(0);
  let ended = false;

  const onData = (chunk: Buffer): void => {
    carry = carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([carry, chunk]);
    let offset = 0;
    while (carry.length - offset >= FRAME_BYTES) {
      const slice = carry.subarray(offset, offset + FRAME_BYTES);
      offset += FRAME_BYTES;
      // Copy into a fresh Int16Array (native engines may retain the reference,
      // and subarray over a reused Buffer is unsafe to hand off).
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = slice.readInt16LE(i * 2);
      }
      onFrame(frame);
    }
    carry = offset > 0 ? carry.subarray(offset) : carry;
  };

  transcoder.on('data', onData as (chunk: unknown) => void);

  const finish = (err?: NodeJS.ErrnoException | null): void => {
    if (ended) return;
    ended = true;
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      logger.warn('User receive pipeline error', { userId, error: err.message });
    }
    onEnd();
  };

  // Wire opus -> decoder -> transcoder; pipeline handles error propagation and
  // cleanup of all three streams.
  pipeline(opusStream, decoder, transcoder, finish);

  return {
    stop(): void {
      if (ended) return;
      ended = true;
      try {
        opusStream.destroy();
      } catch {
        /* ignore */
      }
      try {
        decoder.destroy();
      } catch {
        /* ignore */
      }
      try {
        transcoder.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

export { FRAME_SAMPLES };
