/**
 * Swann — voice module public surface.
 *
 * The discord module imports createVoiceListener, joins voice (selfDeaf:false),
 * hands the VoiceConnection to attach(), and subscribes to events 'command' to
 * feed transcripts into the Mistral agent.
 */

export { createVoiceListener } from './voiceListener.js';

// Lower-level building blocks, exported for diagnostics / advanced wiring.
export { createWakeWordEngine, type WakeWordEngine } from './wakeWord.js';
export {
  createUtteranceDetector,
  type UtteranceDetector,
  VAD_SAMPLE_RATE,
  VAD_WINDOW_SIZE,
} from './vad.js';
export { startUserPipeline, type UserPipeline, FRAME_SAMPLES } from './receivePipeline.js';
