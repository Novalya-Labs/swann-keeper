/**
 * Swann — per-user Discord voice receive pipeline.
 *
 * Discord voice receive is ALWAYS 48kHz stereo Opus. The wake engine + Silero
 * VAD want 16kHz mono int16, 512-sample frames. We get there WITHOUT ffmpeg:
 *
 *   opus packets (one Buffer per frame from receiver.subscribe)
 *     -> OpusEncoder(16000, 2).decode(packet) PER PACKET, in try/catch
 *        (libopus resamples 48k -> 16k internally, high quality)
 *     -> downmix stereo -> mono in JS (average L/R)
 *     -> ring buffer sliced into exact 512-sample Int16Array frames
 *
 * Two deliberate choices, both learned the hard way:
 *   1. Decode ONE PACKET AT A TIME (not a streaming decoder): a single corrupt
 *      packet (e.g. a DAVE E2EE transition frame) is skipped, not fatal — it
 *      used to throw "compressed data corrupted" and tear down the pipeline.
 *   2. NO ffmpeg subprocess: the previous resample-via-ffmpeg stage silently
 *      produced ZERO output on the HA Debian image (packets decoded fine but
 *      framesOut was 0), so no audio ever reached the wake engine. Letting
 *      libopus decode straight to 16k removes that whole failure mode.
 *
 * One pipeline instance per (guild, speaking user). The VoiceListener creates
 * one on each `receiver.speaking 'start'` and tears it down when the per-user
 * opus stream ends (AfterSilence).
 *
 * @discordjs/opus is a CJS native addon; loaded via createRequire for reliable
 * ESM interop.
 */

import { createRequire } from 'node:module';
import { EndBehaviorType } from '@discordjs/voice';
import type { VoiceReceiver } from '@discordjs/voice';
import type { Logger } from '../logger.js';

/** Exactly one 512-sample int16 mono frame = 1024 bytes (s16le). */
const FRAME_SAMPLES = 512;
const FRAME_BYTES = FRAME_SAMPLES * 2;

/** Decode straight to 16 kHz; libopus handles the 48k -> 16k resample. */
const TARGET_RATE = 16000;

/** End the per-user opus stream this many ms after the user stops speaking. */
const SILENCE_END_MS = 1000;

// @discordjs/opus is a CJS native addon. Load it via createRequire so the
// constructor resolves reliably under ESM (named/namespace interop put the
// class under `.default` at runtime -> "OpusEncoder is not a constructor").
const nodeRequire = createRequire(import.meta.url);
interface OpusDecoder {
  decode(buf: Buffer): Buffer;
}
type OpusCtor = new (rate: number, channels: number) => OpusDecoder;
const { OpusEncoder } = nodeRequire('@discordjs/opus') as { OpusEncoder: OpusCtor };

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
  /** When true, log per-pipeline receive stats at INFO (kws_debug). */
  debug?: boolean;
  onFrame: (frame: Int16Array) => void;
  onEnd: () => void;
}): UserPipeline {
  const { logger, receiver, userId, debug, onFrame, onEnd } = deps;

  const opusStream = receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS },
  });

  // Decode straight to 16 kHz stereo; we downmix to mono ourselves.
  const decoder = new OpusEncoder(TARGET_RATE, 2);

  // Mono s16le remainder carried across packets (320-sample packets never align
  // to 512-sample frames).
  let carry: Buffer = Buffer.alloc(0);
  let ended = false;
  let pktTotal = 0;
  let pktFail = 0;
  let framesOut = 0;

  const onPacket = (packet: Buffer): void => {
    pktTotal++;
    let stereo: Buffer;
    try {
      stereo = decoder.decode(packet);
    } catch {
      // Corrupt/undecryptable packet — skip it, keep the pipeline alive.
      pktFail++;
      return;
    }

    // Downmix interleaved 16k stereo s16le -> mono s16le.
    const pairs = stereo.length >> 2; // 4 bytes per L/R sample pair
    const mono = Buffer.allocUnsafe(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      const l = stereo.readInt16LE(i * 4);
      const r = stereo.readInt16LE(i * 4 + 2);
      mono.writeInt16LE((l + r) >> 1, i * 2);
    }

    carry = carry.length === 0 ? mono : Buffer.concat([carry, mono]);
    let offset = 0;
    while (carry.length - offset >= FRAME_BYTES) {
      const slice = carry.subarray(offset, offset + FRAME_BYTES);
      offset += FRAME_BYTES;
      // Copy into a fresh Int16Array (native engines may retain the reference).
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        frame[i] = slice.readInt16LE(i * 2);
      }
      framesOut++;
      onFrame(frame);
    }
    carry = offset > 0 ? carry.subarray(offset) : carry;
  };

  opusStream.on('data', onPacket as (chunk: unknown) => void);

  const finish = (): void => {
    if (ended) return;
    ended = true;
    const stats = { userId, packets: pktTotal, decodeFailures: pktFail, framesOut };
    if (debug) logger.info('Receive pipeline stats', stats);
    else logger.debug('Receive pipeline ended', stats);
    onEnd();
  };

  opusStream.on('end', finish);
  opusStream.on('close', finish);
  opusStream.on('error', (err: Error) => {
    logger.debug('Opus receive stream error', { userId, error: err.message });
    finish();
  });

  return {
    stop(): void {
      if (ended) return;
      ended = true;
      try {
        opusStream.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

export { FRAME_SAMPLES };
