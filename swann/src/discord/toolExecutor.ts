/**
 * Swann — ToolExecutor.
 *
 * The Mistral agent emits {@link ToolName} calls with parsed {@link ToolArgs};
 * this glue layer maps each one onto an {@link AudioService} method. It lives in
 * the discord module (the composition root) so the mistral module never imports
 * audio directly — dependency inversion at the seam.
 *
 * Every tool returns a {@link ToolResult} with a human-readable `summary` the
 * model can relay to the user, plus optional structured `data`.
 */

import type {
  AgentContext,
  AudioService,
  LoopMode,
  PlayRequest,
  QueueItem,
  Track,
  ToolArgs,
  ToolExecutor,
  ToolName,
  ToolResult,
} from '../types.js';
import type { Logger } from '../logger.js';

function ok(summary: string, data?: unknown): ToolResult {
  return { ok: true, summary, data };
}

function fail(error: string): ToolResult {
  return { ok: false, summary: error, error };
}

/** Format ms as m:ss for human-readable summaries. */
function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'live';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function describeTrack(track: Track): string {
  return `"${track.title}" by ${track.author} (${fmtDuration(track.durationMs)})`;
}

function requirePlayRequest(
  ctx: AgentContext,
  query: string,
  source: ToolArgs['play_song']['source'],
  playNext?: boolean,
): PlayRequest | null {
  if (!ctx.voiceChannelId) return null;
  return {
    guildId: ctx.guildId,
    voiceChannelId: ctx.voiceChannelId,
    textChannelId: ctx.textChannelId,
    query,
    source,
    requestedBy: ctx.userId,
    requestedByName: ctx.userName,
    playNext,
  };
}

/**
 * Build the {@link ToolExecutor} bound to a concrete {@link AudioService}.
 * Injected into the Mistral agent at composition time in index.ts.
 */
export function createToolExecutor(audio: AudioService, logger: Logger): ToolExecutor {
  const log = logger.child('tools');

  const handlers: {
    [K in ToolName]: (args: ToolArgs[K], ctx: AgentContext) => Promise<ToolResult>;
  } = {
    async search_songs(args, _ctx) {
      const result = await audio.search(args.query, args.source);
      if (result.kind === 'error') return fail(result.error ?? 'Search failed.');
      if (result.kind === 'empty' || result.tracks.length === 0) {
        return ok(`No results found for "${args.query}".`, { tracks: [] });
      }
      const limit = Math.max(1, Math.min(args.limit ?? 5, result.tracks.length));
      const tracks = result.tracks.slice(0, limit);
      const lines = tracks.map((t, i) => `${i + 1}. ${describeTrack(t)}`);
      return ok(
        `Found ${tracks.length} result(s) for "${args.query}":\n${lines.join('\n')}`,
        { tracks },
      );
    },

    async play_song(args, ctx) {
      const req = requirePlayRequest(ctx, args.query, args.source, args.play_next);
      if (!req) return fail('You must be in a voice channel to play music.');
      const outcome = await audio.play(req);
      switch (outcome.kind) {
        case 'now_playing':
          return ok(`Now playing ${describeTrack(outcome.track!)}.`, outcome);
        case 'queued':
          return ok(`Added ${describeTrack(outcome.track!)} to the queue.`, outcome);
        case 'queued_playlist':
          return ok(
            `Added ${outcome.addedCount ?? 0} tracks from "${outcome.playlistName ?? 'playlist'}" to the queue.`,
            outcome,
          );
        case 'empty':
          return ok(`No results found for "${args.query}".`, outcome);
        case 'error':
        default:
          return fail(outcome.error ?? 'Playback failed.');
      }
    },

    async play_playlist(args, ctx) {
      if (!ctx.voiceChannelId) return fail('You must be in a voice channel to play music.');

      // Build a search query from the artist/theme and fan it out into N tracks.
      const parts = [args.artist, args.theme].filter(Boolean) as string[];
      const query = parts.join(' ').trim() || args.theme;
      const count = Math.max(1, Math.min(args.count ?? 10, 25));

      const result = await audio.search(query, args.source);
      if (result.kind === 'error') return fail(result.error ?? 'Search failed.');
      if (result.kind === 'empty' || result.tracks.length === 0) {
        return ok(`Couldn't find any songs for "${query}".`, { tracks: [] });
      }

      const tracks = result.tracks.slice(0, count);
      const now = Date.now();
      const items: QueueItem[] = tracks.map((track: Track) => ({
        track,
        requestedBy: ctx.userId,
        requestedByName: ctx.userName,
        addedAt: now,
      }));

      await audio.enqueue(ctx.guildId, items);

      // enqueue() is a no-op when the bot isn't connected; surface that clearly.
      if (!audio.getSnapshot(ctx.guildId)) {
        return fail("I'm not in a voice channel yet — join one and try again.");
      }
      return ok(`Queued ${items.length} track(s) for "${query}".`, {
        count: items.length,
        query,
        tracks,
      });
    },

    async skip(args, ctx) {
      const count = Math.max(1, args.count ?? 1);
      const next = await audio.skip(ctx.guildId, count);
      if (next) return ok(`Skipped. Now playing ${describeTrack(next.track)}.`);
      return ok('Skipped. The queue is now empty.');
    },

    async pause(_args, ctx) {
      await audio.pause(ctx.guildId);
      return ok('Playback paused.');
    },

    async resume(_args, ctx) {
      await audio.resume(ctx.guildId);
      return ok('Playback resumed.');
    },

    async stop(_args, ctx) {
      await audio.stop(ctx.guildId);
      return ok('Playback stopped and the queue cleared.');
    },

    async set_volume(args, ctx) {
      const volume = Math.max(0, Math.min(100, Math.round(args.volume)));
      await audio.setVolume(ctx.guildId, volume);
      return ok(`Volume set to ${volume}%.`);
    },

    async set_loop(args, ctx) {
      const mode: LoopMode = args.mode;
      await audio.setLoop(ctx.guildId, mode);
      const label =
        mode === 'off' ? 'disabled' : mode === 'track' ? 'on the current track' : 'over the queue';
      return ok(`Loop ${label}.`);
    },

    async get_queue(_args, ctx) {
      const snapshot = audio.getSnapshot(ctx.guildId);
      if (!snapshot) return ok('Nothing is playing and the queue is empty.', { queue: [] });
      const current = snapshot.current
        ? `Now playing: ${describeTrack(snapshot.current.track)}`
        : 'Nothing is playing.';
      const upcoming = snapshot.queue.slice(0, 10).map((item: QueueItem, i: number) =>
        `${i + 1}. ${describeTrack(item.track)}`,
      );
      const body =
        upcoming.length > 0
          ? `${current}\nUp next:\n${upcoming.join('\n')}`
          : `${current}\nThe queue is empty.`;
      return ok(body, snapshot);
    },

    async clear_queue(_args, ctx) {
      await audio.clear(ctx.guildId);
      return ok('Cleared the upcoming queue.');
    },
  };

  return async function execute(name, args, ctx): Promise<ToolResult> {
    const handler = handlers[name] as
      | ((a: ToolArgs[ToolName], c: AgentContext) => Promise<ToolResult>)
      | undefined;
    if (!handler) {
      log.warn('Unknown tool requested', { name });
      return fail(`Unknown tool: ${name}`);
    }
    try {
      log.debug('Executing tool', { name, guildId: ctx.guildId });
      return await handler(args, ctx);
    } catch (err) {
      log.error('Tool execution failed', { name, err });
      return fail(err instanceof Error ? err.message : 'Tool execution failed.');
    }
  };
}
