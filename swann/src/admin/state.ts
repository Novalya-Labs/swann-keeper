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
  UsageMetrics,
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
  /** Add Mistral chat token usage from one agent run. */
  recordTokenUsage(u: { promptTokens: number; completionTokens: number }): void;
  /** Add billed transcription seconds from one utterance. */
  recordAudioSeconds(seconds: number): void;
  /** Count one agent run (voice or text command). */
  recordAgentRun(): void;
  /** Stop listening to AudioService events. */
  dispose(): void;
}

export interface AdminStateDeps {
  readonly logger: Logger;
  readonly audio: AudioService;
  readonly configStatus: () => ConfigStatus;
  /** Pricing for the rough cost estimate (USD). */
  readonly costRates: {
    readonly chatPromptPer1M: number;
    readonly chatCompletionPer1M: number;
    readonly transcribePerMinute: number;
  };
}

export function createAdminStateStore(deps: AdminStateDeps): AdminStateStore {
  const { logger, audio, configStatus, costRates } = deps;
  const startedAt = Date.now();
  const activityLog: ActivityEntry[] = [];

  // In-memory session usage (resets on restart).
  const acc = { prompt: 0, completion: 0, audioSeconds: 0, commands: 0 };
  const usageStartedAt = startedAt;
  const addFinite = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0);

  function recordActivity(entry: ActivityEntry): void {
    activityLog.unshift(entry);
    if (activityLog.length > ACTIVITY_LIMIT) activityLog.length = ACTIVITY_LIMIT;
  }

  function recordTokenUsage(u: { promptTokens: number; completionTokens: number }): void {
    acc.prompt += addFinite(u.promptTokens);
    acc.completion += addFinite(u.completionTokens);
  }
  function recordAudioSeconds(seconds: number): void {
    acc.audioSeconds += addFinite(seconds);
  }
  function recordAgentRun(): void {
    acc.commands += 1;
  }

  function usage(): UsageMetrics {
    const total = acc.prompt + acc.completion;
    const cost =
      (acc.prompt / 1_000_000) * costRates.chatPromptPer1M +
      (acc.completion / 1_000_000) * costRates.chatCompletionPer1M +
      (acc.audioSeconds / 60) * costRates.transcribePerMinute;
    return {
      transcriptionAudioSeconds: acc.audioSeconds,
      agentCommands: acc.commands,
      chatTokensPrompt: acc.prompt,
      chatTokensCompletion: acc.completion,
      chatTokensTotal: total,
      estimatedCostUsd: cost,
      sessionStartAt: usageStartedAt,
    };
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
      usage: usage(),
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
    recordTokenUsage,
    recordAudioSeconds,
    recordAgentRun,
    dispose,
  };
}
