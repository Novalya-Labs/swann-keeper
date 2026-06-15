/**
 * Swann — Voxtral transcription wrapper.
 *
 * Wraps `client.audio.transcriptions.complete` (Voxtral, model
 * voxtral-mini-latest by default) behind the shared Transcriber interface.
 *
 * Accepts either:
 *   - a path to an existing audio file on disk (preferred), OR
 *   - raw 16 kHz mono signed-16-bit-LE PCM (what the voice module produces),
 *     which we wrap into a minimal WAV container in-memory before upload. We
 *     send a real container (WAV) rather than naked PCM because Mistral's docs
 *     do NOT enumerate accepted raw formats, but WAV/MP3/OGG are shown working.
 *
 * UNCERTAINTY: the exact Voxtral response field names (text / language /
 * usage.prompt_audio_seconds) and the accepted `file` Blob input shape are not
 * fully nailed down in public docs. This module isolates that behind one place
 * and reads the response defensively. See followups.
 */

import { openAsBlob } from 'node:fs';
import type { Logger } from '../logger.js';
import type { Transcriber, TranscriptionInput, TranscriptionOutput } from '../types.js';
import { createMistralClient, type MistralClient } from './client.js';

export interface CreateTranscriberDeps {
  readonly logger: Logger;
  readonly apiKey: string;
  readonly model: string;
  /** Optional pre-built client (for tests). */
  readonly client?: MistralClient;
}

/** Default sample rate of the PCM the voice module hands us. */
const PCM_SAMPLE_RATE = 16_000;
const PCM_CHANNELS = 1;
const PCM_BITS_PER_SAMPLE = 16;

/**
 * Build a 44-byte canonical WAV header for the given PCM payload and return the
 * full WAV file as a single Buffer. PCM is assumed 16 kHz / mono / 16-bit LE.
 */
function pcmToWav(pcm: Buffer): Buffer {
  const byteRate = (PCM_SAMPLE_RATE * PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const blockAlign = (PCM_CHANNELS * PCM_BITS_PER_SAMPLE) / 8;
  const dataSize = pcm.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0); // ChunkID
  header.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  header.write('WAVE', 8); // Format
  header.write('fmt ', 12); // Subchunk1ID
  header.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  header.writeUInt16LE(1, 20); // AudioFormat = PCM
  header.writeUInt16LE(PCM_CHANNELS, 22); // NumChannels
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24); // SampleRate
  header.writeUInt32LE(byteRate, 28); // ByteRate
  header.writeUInt16LE(blockAlign, 32); // BlockAlign
  header.writeUInt16LE(PCM_BITS_PER_SAMPLE, 34); // BitsPerSample
  header.write('data', 36); // Subchunk2ID
  header.writeUInt32LE(dataSize, 40); // Subchunk2Size

  return Buffer.concat([header, pcm]);
}

/** Read a string field from an unknown response object, trying several keys. */
function readString(obj: unknown, keys: string[]): string | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Read the billed audio seconds from the (snake_case) usage block, if present. */
function readAudioSeconds(obj: unknown): number | undefined {
  if (!obj || typeof obj !== 'object') return undefined;
  const usage = (obj as Record<string, unknown>)['usage'];
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const v = u['prompt_audio_seconds'] ?? u['promptAudioSeconds'] ?? u['audio_seconds'];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function createTranscriber(deps: CreateTranscriberDeps): Transcriber {
  const log = deps.logger.child('mistral:transcriber');
  const client = deps.client ?? createMistralClient(deps.apiKey);

  async function transcribe(input: TranscriptionInput): Promise<TranscriptionOutput> {
    // Build the file Blob from either a path or raw PCM.
    let file: Blob;
    if (input.filePath) {
      file = await openAsBlob(input.filePath);
    } else if (input.pcm16kMono) {
      const wav = pcmToWav(input.pcm16kMono);
      file = new Blob([new Uint8Array(wav.buffer, wav.byteOffset, wav.byteLength)], { type: 'audio/wav' });
    } else {
      throw new Error('TranscriptionInput requires either filePath or pcm16kMono');
    }

    // The SDK's File-like input wants a name; attach one for nicer multipart.
    const named = file as Blob & { name?: string };
    if (named.name === undefined) {
      try {
        Object.defineProperty(named, 'name', { value: input.filePath ?? 'utterance.wav', configurable: true });
      } catch {
        /* some Blob impls disallow defineProperty; harmless to skip */
      }
    }

    const params: Record<string, unknown> = {
      model: deps.model,
      file: named,
    };
    if (input.language) params['language'] = input.language;

    log.debug('Transcribing utterance', {
      via: input.filePath ? 'file' : 'pcm',
      language: input.language,
    });

    const response = (await client.audio.transcriptions.complete(params as never)) as unknown;

    const text = (readString(response, ['text']) ?? '').trim();
    const out: TranscriptionOutput = { text };
    const language = readString(response, ['language']);
    if (language) (out as { language?: string }).language = language;
    const audioSeconds = readAudioSeconds(response);
    if (audioSeconds !== undefined) (out as { audioSeconds?: number }).audioSeconds = audioSeconds;

    log.debug('Transcription complete', { chars: text.length, language: out.language, audioSeconds });
    return out;
  }

  return { transcribe };
}
