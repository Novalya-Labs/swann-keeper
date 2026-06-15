/**
 * Swann — audio module public surface.
 *
 * The composition root (`src/index.ts`) imports `createAudioService` from here.
 * Everything else (AudioService, PlayRequest, PlayerSnapshot, …) lives in
 * `src/types.ts` and must be imported from there, not re-exported as values.
 */

export { createAudioService } from './audioService.js';
export {
  mapTrack,
  mapTracks,
  mapYtdlpResult,
  toQueueItem,
} from './trackMapper.js';
