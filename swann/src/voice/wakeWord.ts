/**
 * Swann — Porcupine wake-word detector wrapper.
 *
 * Wraps @picovoice/porcupine-node for the custom "Swann" keyword. Porcupine
 * is strict about its input format:
 *   - 16-bit PCM, mono, 16000 Hz
 *   - each process() call must receive an Int16Array of EXACTLY frameLength
 *     samples (512 for the v3 keyword model)
 *
 * The receive pipeline frames audio into exact 512-sample slices before
 * calling detect(); this wrapper only owns the engine handle + lifecycle.
 *
 * @picovoice/porcupine-node is a CommonJS native addon. Under "type":"module"
 * we import the default export and destructure Porcupine from it (named ESM
 * imports of a CJS addon can resolve to undefined under NodeNext).
 */

import type { Logger } from '../logger.js';
import type { PicovoiceConfig } from '../config.js';

// ---------------------------------------------------------------------------
// Minimal structural typing for the CJS native addon. The real package ships
// its own d.ts, but it is not guaranteed to resolve cleanly under NodeNext +
// noUncheckedIndexedAccess, so we describe only the surface we use.
// ---------------------------------------------------------------------------
interface PorcupineHandle {
  /** Required input frame length in samples (512 for the standard model). */
  readonly frameLength: number;
  /** Required sample rate (16000). */
  readonly sampleRate: number;
  /** Returns the matched keyword index, or -1 when no keyword was detected. */
  process(frame: Int16Array): number;
  /** Free native resources. */
  release(): void;
}

type PorcupineCtor = new (
  accessKey: string,
  keywordPaths: string[],
  sensitivities: number[],
) => PorcupineHandle;

/**
 * A single guild's wake-word engine. Each guild gets its own Porcupine handle
 * so detections never interleave across guilds and release() is clean.
 */
export interface WakeWordEngine {
  /** Exact frame length (in samples) every detect() call must receive. */
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
 * Lazily load the CJS native addon. Kept behind a function so importing this
 * module (e.g. for types) does not eagerly require the native binary — useful
 * in environments where the addon is unavailable (CI typecheck, tests).
 */
let ctorPromise: Promise<PorcupineCtor> | null = null;
async function loadPorcupine(): Promise<PorcupineCtor> {
  if (!ctorPromise) {
    ctorPromise = import('@picovoice/porcupine-node').then((mod) => {
      const m = mod as unknown as { Porcupine?: PorcupineCtor; default?: { Porcupine?: PorcupineCtor } };
      const ctor = m.Porcupine ?? m.default?.Porcupine;
      if (!ctor) {
        throw new Error('Could not resolve Porcupine constructor from @picovoice/porcupine-node');
      }
      return ctor;
    });
  }
  return ctorPromise;
}

/**
 * Create a wake-word engine for the "Swann" custom keyword.
 *
 * @throws if the AccessKey/keyword path are invalid (Picovoice validates the
 *         AccessKey online on first init) or the addon cannot be loaded.
 */
export async function createWakeWordEngine(deps: {
  logger: Logger;
  picovoice: PicovoiceConfig;
}): Promise<WakeWordEngine> {
  const { logger, picovoice } = deps;
  const Porcupine = await loadPorcupine();

  let handle: PorcupineHandle | null = new Porcupine(
    picovoice.accessKey,
    [picovoice.keywordPath],
    [picovoice.sensitivity],
  );

  logger.debug('Porcupine wake-word engine created', {
    frameLength: handle.frameLength,
    sampleRate: handle.sampleRate,
    keywordPath: picovoice.keywordPath,
    sensitivity: picovoice.sensitivity,
  });

  const frameLength = handle.frameLength;
  const sampleRate = handle.sampleRate;

  return {
    frameLength,
    sampleRate,
    detect(frame: Int16Array): boolean {
      if (!handle) return false;
      if (frame.length !== frameLength) {
        // Porcupine throws on a wrong-length frame; guard rather than crash.
        logger.warn('Dropping wake-word frame with wrong length', {
          got: frame.length,
          expected: frameLength,
        });
        return false;
      }
      try {
        return handle.process(frame) >= 0;
      } catch (err) {
        logger.error('Porcupine process() failed', err);
        return false;
      }
    },
    release(): void {
      if (handle) {
        try {
          handle.release();
        } catch (err) {
          logger.warn('Porcupine release() failed', err);
        }
        handle = null;
      }
    },
  };
}
