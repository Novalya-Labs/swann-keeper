/**
 * Swann — per-user Discord voice receive pipeline.
 *
 * Discord voice receive is ALWAYS 48kHz stereo Opus, frameSize 960. To feed
 * the KWS spotter + Silero (both want 16kHz mono int16, 512-sample frames) we:
 *
 *   opus packets (one Buffer per frame from receiver.subscribe)
 *     -> OpusEncoder.decode(packet) PER PACKET, in try/catch   // 48k stereo s16le
 *     -> prism.FFmpeg(-ar 16000 -ac 1)                         // 16k mono s16le
 *     -> ring buffer sliced into exact 512-sample Int16Array frames
 *
 * Decoding ONE PACKET AT A TIME (instead of piping the whole opus stream
 * through a single streaming decoder) is deliberate: a single corrupt packet —
 * e.g. a DAVE E2EE transition frame, or a stray packet — would otherwise throw
 * "The compressed data passed is corrupted" and tear down the entire pipeline,
 * so NO audio ever reaches the wake engine. Here a bad packet is counted and
 * skipped; the good packets keep flowing.
 *
 * We do NOT decimate manually (aliasing wrecks wake-word accuracy); FFmpeg's
 * resampler does the downsample + downmix.
 *
 * One pipeline instance per (guild, speaking user). The VoiceListener creates
 * one on each `receiver.speaking 'start'` and tears it down when the per-user
 * opus stream ends (AfterSilence).
 *
 * prism-media / @discordjs/opus are CJS under ESM; imported via namespace/default
 * interop.
 */

import prism from 'prism-media';
import { createRequire } from 'node:module';
import { EndBehaviorType } from '@discordjs/voice';
import type { VoiceReceiver } from '@discordjs/voice';
import type { Logger } from '../logger.js';

/** Exactly one 512-sample int16 frame = 1024 bytes (s16le). */
const FRAME_SAMPLES = 512;
const FRAME_BYTES = FRAME_SAMPLES * 2;

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

  // Per-packet Opus decoder (48kHz stereo). Decoding packet-by-packet lets us
  // skip a corrupt packet instead of killing the stream.
  const decoder = new OpusEncoder(48000, 2);

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
  let pktTotal = 0;
  let pktFail = 0;
  let framesOut = 0;

  const onPacket = (packet: Buffer): void => {
    pktTotal++;
    let pcm: Buffer;
    try {
      pcm = decoder.decode(packet);
    } catch {
      // Corrupt/undecryptable packet — skip it, keep the pipeline alive.
      pktFail++;
      return;
    }
    try {
      transcoder.write(pcm);
    } catch {
      /* transcoder closing/closed; ignore */
    }
  };

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
      framesOut++;
      onFrame(frame);
    }
    carry = offset > 0 ? carry.subarray(offset) : carry;
  };

  transcoder.on('data', onData as (chunk: unknown) => void);
  transcoder.on('error', (err: Error) => {
    logger.debug('Receive transcoder error', { userId, error: err.message });
  });

  opusStream.on('data', onPacket as (chunk: unknown) => void);

  const finish = (): void => {
    if (ended) return;
    ended = true;
    const stats = { userId, packets: pktTotal, decodeFailures: pktFail, framesOut };
    if (debug) logger.info('Receive pipeline stats', stats);
    else logger.debug('Receive pipeline ended', stats);
    onEnd();
  };

  // When the user stops (AfterSilence), close ffmpeg stdin so it flushes; the
  // transcoder 'end'/'close' then finalises. Stream errors just end it too.
  const endTranscoder = (): void => {
    try {
      transcoder.end();
    } catch {
      /* ignore */
    }
  };
  opusStream.on('end', endTranscoder);
  opusStream.on('close', endTranscoder);
  opusStream.on('error', (err: Error) => {
    logger.debug('Opus receive stream error', { userId, error: err.message });
    endTranscoder();
  });
  transcoder.on('end', finish);
  transcoder.on('close', finish);

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
        transcoder.destroy();
      } catch {
        /* ignore */
      }
    },
  };
}

export { FRAME_SAMPLES };
