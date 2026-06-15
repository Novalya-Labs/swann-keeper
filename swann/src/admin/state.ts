/**
 * Swann — admin live state aggregator.
 *
 * Bridges the AudioService (player snapshots + history + live events) and the
 * config credential-presence view into the single AdminState shape the
 * frontend polls. Also keeps a bounded ring buffer of recent activity (agent /
 * voice / command / system events) for the live feed.
 *
 * It subscribes to AudioService events so it can append concise activity lines
 * automatically, and exposes a `recordActivity` method for the discord/voice
 * modules to push richer entries (e.g. "Hey Swann -> played X").
 */

import type {
  ActivityEntry,
  AdminState,
  AudioService,
  ConfigStatus,
  PlayerSnapshot,
} from '../types.js';
import type { Logger } from '../logger.js';

/** How many activity entries to retain in memory (newest-first cap). */
const ACTIVITY_LIMIT = 100;

export interface AdminStateStore {
  /** Build the full state document the frontend renders. */
  snapshot(): AdminState;
  /** All current player snapshots. */
  players(): PlayerSnapshot[];
  /** Append an activity entry (newest-first, bounded). */
  recordActivity(entry: ActivityEntry): void;
  /** Recent activity, newest first. */
  activity(): ActivityEntry[];
  /** Stop listening to AudioService events. */
  dispose(): void;
}

export interface AdminStateDeps {
  readonly logger: Logger;
  readonly audio: AudioService;
  readonly configStatus: () => ConfigStatus;
}

export function createAdminStateStore(deps: AdminStateDeps): AdminStateStore {
  const { logger, audio, configStatus } = deps;
  const startedAt = Date.now();
  const activityLog: ActivityEntry[] = [];

  function recordActivity(entry: ActivityEntry): void {
    activityLog.unshift(entry);
    if (activityLog.length > ACTIVITY_LIMIT) activityLog.length = ACTIVITY_LIMIT;
  }

  // Auto-derive activity lines from AudioService lifecycle events.
  const onTrackStart = (guildId: string, item: { track: { title: string; author: string } }): void => {
    recordActivity({
      at: Date.now(),
      kind: 'system',
      guildId,
      message: `Now playing: ${item.track.title} — ${item.track.author}`,
    });
  };
  const onQueueEnd = (guildId: string): void => {
    recordActivity({ at: Date.now(), kind: 'system', guildId, message: 'Queue finished' });
  };
  const onAudioError = (guildId: string, error: Error): void => {
    recordActivity({
      at: Date.now(),
      kind: 'system',
      guildId,
      message: `Playback error: ${error.message}`,
    });
  };

  audio.events.on('trackStart', onTrackStart);
  audio.events.on('queueEnd', onQueueEnd);
  audio.events.on('error', onAudioError);

  function players(): PlayerSnapshot[] {
    try {
      return audio.getAllSnapshots();
    } catch (err) {
      logger.warn('Failed to read player snapshots', err);
      return [];
    }
  }

  function snapshot(): AdminState {
    return {
      config: configStatus(),
      players: players(),
      activity: activityLog.slice(0, ACTIVITY_LIMIT),
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };
  }

  function dispose(): void {
    audio.events.off('trackStart', onTrackStart);
    audio.events.off('queueEnd', onQueueEnd);
    audio.events.off('error', onAudioError);
  }

  return {
    snapshot,
    players,
    recordActivity,
    activity: () => activityLog.slice(0, ACTIVITY_LIMIT),
    dispose,
  };
}
