/**
 * Swann — wake-word activation chime.
 *
 * Produces a short "I heard you" sound as 48 kHz stereo s16le PCM (the format
 * @discordjs/voice plays as StreamType.Raw), played via audio.speak() when a
 * voice command is matched.
 *
 * No file is required: a pleasant two-note chime is synthesized in code. A
 * custom 16-bit PCM **WAV** file can be supplied instead (resampled to 48 kHz
 * in JS — no ffmpeg, which is unreliable on this image). MP3 is not supported
 * for that reason; convert it to WAV first.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Logger } from '../logger.js';
import type { VoiceConfig } from '../config.js';

const OUT_RATE = 48_000;

function clampInt16(f: number): number {
  const s = f < -1 ? -1 : f > 1 ? 1 : f;
  return Math.round(s < 0 ? s * 0x8000 : s * 0x7fff);
}

/** Mono Float32 -> 48k stereo s16le Buffer (linear resample + L/R duplicate). */
function toRaw48Stereo(samples: Float32Array, inRate: number): Buffer {
  const ratio = OUT_RATE / inRate;
  const outLen = inRate === OUT_RATE ? samples.length : Math.floor(samples.length * ratio);
  const out = Buffer.allocUnsafe(outLen * 4);
  for (let i = 0; i < outLen; i++) {
    let s: number;
    if (inRate === OUT_RATE) {
      s = samples[i] ?? 0;
    } else {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const a = samples[i0] ?? 0;
      const b = samples[i0 + 1] ?? a;
      s = a + (b - a) * frac;
    }
    const v = clampInt16(s);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** One fading sine tone as mono Float32 at 48 kHz. */
function tone(freq: number, durSec: number, amp: number): Float32Array {
  const n = Math.floor(durSec * OUT_RATE);
  const out = new Float32Array(n);
  const fade = Math.max(1, Math.floor(0.006 * OUT_RATE));
  for (let i = 0; i < n; i++) {
    let a = amp;
    if (i < fade) a *= i / fade;
    if (i > n - fade) a *= (n - i) / fade;
    out[i] = a * Math.sin((2 * Math.PI * freq * i) / OUT_RATE);
  }
  return out;
}

/** Default rising two-note chime (E6 -> A6). */
function generateChime(): Buffer {
  const a = tone(1318.5, 0.1, 0.25);
  const b = tone(1760.0, 0.13, 0.25);
  const buf = Buffer.allocUnsafe((a.length + b.length) * 4);
  let o = 0;
  for (const arr of [a, b]) {
    for (let i = 0; i < arr.length; i++) {
      const v = clampInt16(arr[i] ?? 0);
      buf.writeInt16LE(v, o);
      buf.writeInt16LE(v, o + 2);
      o += 4;
    }
  }
  return buf;
}

/** Parse a 16-bit PCM WAV to mono Float32 + its sample rate, or null. */
function parseWavToMono(buf: Buffer): { samples: Float32Array; rate: number } | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }
  let channels = 1;
  let rate = OUT_RATE;
  let bits = 16;
  let dataOff = -1;
  let dataLen = 0;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataOff = body;
      dataLen = size;
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }
  if (dataOff < 0 || bits !== 16 || channels < 1) return null;
  const end = Math.min(dataOff + dataLen, buf.length);
  const frames = Math.floor((end - dataOff) / (2 * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += buf.readInt16LE(dataOff + (i * channels + c) * 2);
    samples[i] = sum / channels / 32768;
  }
  return { samples, rate };
}

/**
 * Build the wake chime PCM (48k stereo s16le). Uses a custom WAV if configured
 * and valid, otherwise the generated chime. Returns null only on unexpected
 * failure (caller treats null as "no chime").
 */
export function loadWakeSound(deps: { logger: Logger; voice: VoiceConfig }): Buffer | null {
  const log = deps.logger.child('chime');
  const path = deps.voice.wakeChimePath;
  if (path && existsSync(path)) {
    try {
      const parsed = parseWavToMono(readFileSync(path));
      if (parsed) {
        log.info('Wake chime loaded from file', { path, rate: parsed.rate });
        return toRaw48Stereo(parsed.samples, parsed.rate);
      }
      log.warn('Wake chime file is not a 16-bit PCM WAV; using the built-in chime', { path });
    } catch (err) {
      log.warn('Failed to read wake chime file; using the built-in chime', err);
    }
  }
  try {
    return generateChime();
  } catch (err) {
    log.warn('Failed to build wake chime', err);
    return null;
  }
}
