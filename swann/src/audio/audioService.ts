/**
 * Swann — audio/audioService.
 *
 * Per-guild player/queue service backed by @discordjs/voice (playback) and
 * yt-dlp (search + streaming). This module is fully discord.js-agnostic at the
 * request level: it takes a `guildId` + `PlayRequest` and returns
 * `PlayerSnapshot` / `PlayOutcome`. The composition root joins ONE voice
 * connection per guild (selfDeaf:false, shared with the wake-word listener)
 * and hands it to `bindConnection()`; the service subscribes its AudioPlayer
 * to that connection so music and voice reception coexist.
 *
 * Queue, loop mode, volume and history are all kept in memory per guild. The
 * AudioPlayer's Idle transition drives queue advancement.
 *
 * Implements the `AudioService` contract from `src/types.ts`.
 */

import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  demuxProbe,
  type AudioPlayer,
  type AudioPlayerState,
  type AudioResource,
  type VoiceConnection,
} from '@discordjs/voice';
import type { MediaConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type {
  AudioService,
  AudioServiceEvents,
  LoopMode,
  PlayOutcome,
  PlayRequest,
  PlayerSnapshot,
  PlayerStatus,
  QueueItem,
  SearchResult,
  SearchSource,
  Track,
  VoiceConnectionLike,
} from '../types.js';
import { mapYtdlpResult, toQueueItem } from './trackMapper.js';

/** Cap on how many recently-played tracks we retain per guild for the admin UI. */
const MAX_HISTORY = 50;

/** yt-dlp child handle: stdin ignored, stdout/stderr piped. */
type StreamingChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Per-guild runtime state. Created lazily on the first bindConnection/play and
 * torn down on disconnect.
 */
interface GuildState {
  readonly guildId: string;
  player: AudioPlayer;
  connection: VoiceConnection | null;
  voiceChannelId: string | null;
  /** The item currently loaded into the player (or null if idle). */
  current: QueueItem | null;
  /** The resource currently playing, for volume + position reads. */
  resource: AudioResource | null;
  /** The yt-dlp child process feeding the current resource, if any. */
  child: StreamingChild | null;
  /** Pending tracks (FIFO). */
  queue: QueueItem[];
  history: QueueItem[];
  /** Volume 0..100. */
  volume: number;
  loop: LoopMode;
  /** True while we are intentionally tearing the current track down (skip/stop/
   *  loop swap) so the Idle handler doesn't double-advance. */
  transitioning: boolean;
}

class AudioServiceImpl implements AudioService {
  public readonly events: AudioServiceEvents = new EventEmitter() as AudioServiceEvents;

  private readonly log: Logger;
  private readonly media: MediaConfig;
  private readonly defaultVolume: number;
  private readonly guilds = new Map<string, GuildState>();

  constructor(log: Logger, media: MediaConfig, defaultVolume: number) {
    this.log = log;
    this.media = media;
    this.defaultVolume = clampVolume(defaultVolume);
  }

  // -------------------------------------------------------------------------
  // Connection binding
  // -------------------------------------------------------------------------

  public bindConnection(guildId: string, connection: VoiceConnectionLike): void {
    const conn = connection as unknown as VoiceConnection;
    const state = this.ensureState(guildId);
    state.connection = conn;
    state.voiceChannelId = conn.joinConfig.channelId ?? state.voiceChannelId;
    conn.subscribe(state.player);
    this.log.info('Voice connection bound', { guildId, voiceChannelId: state.voiceChannelId });
    this.emitQueueUpdate(guildId);
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  public async search(query: string, source?: SearchSource): Promise<SearchResult> {
    try {
      return await this.resolveQuery(query, source);
    } catch (err) {
      this.log.error('Search failed', err);
      return { kind: 'error', tracks: [], error: (err as Error).message };
    }
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  public async play(req: PlayRequest): Promise<PlayOutcome> {
    const state = this.guilds.get(req.guildId);
    if (!state || !state.connection) {
      return { kind: 'error', error: 'Not connected to a voice channel.' };
    }

    let result: SearchResult;
    try {
      result = await this.resolveQuery(req.query, req.source);
    } catch (err) {
      this.log.error('play(): resolve failed', err);
      return { kind: 'error', error: (err as Error).message };
    }

    if (result.kind === 'error') return { kind: 'error', error: result.error };
    if (result.kind === 'empty' || result.tracks.length === 0) return { kind: 'empty' };

    const now = Date.now();
    const items: QueueItem[] = result.tracks.map((track) =>
      toQueueItem(track, req.requestedBy, req.requestedByName, now),
    );

    const wasIdle = state.current === null;

    // Playlist: enqueue every track. Honour playNext by inserting at the front.
    if (result.kind === 'playlist') {
      if (req.playNext) state.queue.unshift(...items);
      else state.queue.push(...items);

      if (wasIdle) await this.startNext(state);
      this.emitQueueUpdate(req.guildId);

      const outcome: PlayOutcome = { kind: 'queued_playlist', addedCount: items.length };
      return result.playlistName !== undefined
        ? { ...outcome, playlistName: result.playlistName }
        : outcome;
    }

    // Single track (or first search candidate).
    const item = items[0];
    if (!item) return { kind: 'empty' };

    if (req.playNext) state.queue.unshift(item);
    else state.queue.push(item);

    if (wasIdle) {
      await this.startNext(state);
      this.emitQueueUpdate(req.guildId);
      return { kind: 'now_playing', track: item.track };
    }

    this.emitQueueUpdate(req.guildId);
    return { kind: 'queued', track: item.track };
  }

  public async enqueue(guildId: string, items: QueueItem[]): Promise<void> {
    if (items.length === 0) return;
    const state = this.guilds.get(guildId);
    if (!state) {
      this.log.warn('enqueue(): no state for guild', { guildId });
      return;
    }
    const wasIdle = state.current === null;
    state.queue.push(...items);
    if (wasIdle) await this.startNext(state);
    this.emitQueueUpdate(guildId);
  }

  public async skip(guildId: string, count = 1): Promise<QueueItem | null> {
    const state = this.guilds.get(guildId);
    if (!state) return null;
    const steps = Math.max(1, Math.trunc(count));

    // Drop (steps - 1) upcoming tracks, then stop the current one. Stopping the
    // player triggers the Idle handler which advances to the next queue item.
    state.queue.splice(0, steps - 1);

    // A skip should never replay the current track via 'track' loop.
    const restoreLoop = state.loop;
    if (state.loop === 'track') state.loop = 'off';
    this.stopCurrent(state);
    if (restoreLoop === 'track') state.loop = restoreLoop;

    await this.startNext(state);
    this.emitQueueUpdate(guildId);
    return state.current;
  }

  public async pause(guildId: string): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    if (state.player.state.status === AudioPlayerStatus.Paused) return;
    if (state.player.pause()) this.emitQueueUpdate(guildId);
  }

  public async resume(guildId: string): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    if (state.player.state.status !== AudioPlayerStatus.Paused) return;
    if (state.player.unpause()) this.emitQueueUpdate(guildId);
  }

  public async stop(guildId: string): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    state.queue = [];
    const had = state.current !== null;
    this.stopCurrent(state);
    state.current = null;
    state.resource = null;
    this.emitQueueUpdate(guildId);
    if (had) this.events.emit('queueEnd', guildId);
  }

  public async setVolume(guildId: string, volume: number): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    state.volume = clampVolume(volume);
    state.resource?.volume?.setVolume(state.volume / 100);
    this.emitQueueUpdate(guildId);
  }

  public async setLoop(guildId: string, mode: LoopMode): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    state.loop = mode;
    this.emitQueueUpdate(guildId);
  }

  /**
   * Play a one-shot TTS clip on the shared player, then resume the music.
   *
   * The player holds one resource at a time, so we swap to the TTS resource and
   * — once it finishes — re-play the saved music resource (its yt-dlp/ffmpeg
   * stream keeps running while detached, so it continues roughly where it left
   * off). `transitioning` is held true for the whole clip so the persistent
   * Idle handler does NOT advance the queue when the clip ends.
   */
  public async speak(
    guildId: string,
    audioData: Buffer,
    streamType: 'pcm' | 'opus' = 'pcm',
  ): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state || !state.connection) {
      this.log.warn('speak(): no voice connection for guild', { guildId });
      return;
    }

    const savedResource = state.resource;
    const wasPlaying =
      state.player.state.status === AudioPlayerStatus.Playing ||
      state.player.state.status === AudioPlayerStatus.Buffering;

    let ttsResource: AudioResource;
    try {
      ttsResource = createAudioResource(Readable.from([audioData]), {
        inputType: streamType === 'opus' ? StreamType.Opus : StreamType.Raw,
        inlineVolume: true,
      });
      ttsResource.volume?.setVolume(state.volume / 100);
    } catch (err) {
      this.log.warn('speak(): failed to build TTS resource', { guildId, err });
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        state.player.off('stateChange', onChange);
        // Resume the music exactly where it was, if it was playing.
        if (wasPlaying && savedResource && !savedResource.ended) {
          try {
            state.player.play(savedResource);
          } catch (err) {
            this.log.debug('speak(): resume failed', { guildId, err });
          }
        }
        state.transitioning = false;
        resolve();
      };
      const onChange = (_old: AudioPlayerState, next: AudioPlayerState): void => {
        if (next.status === AudioPlayerStatus.Idle) finish();
      };
      const timer = setTimeout(finish, 60_000);

      // Hold transitioning across the clip so onTrackIdle() doesn't advance the
      // queue when the TTS resource hits Idle.
      state.transitioning = true;
      state.player.on('stateChange', onChange);
      try {
        state.player.play(ttsResource);
      } catch (err) {
        this.log.warn('speak(): play failed', { guildId, err });
        finish();
      }
    });
  }

  public async remove(guildId: string, index: number): Promise<QueueItem | null> {
    const state = this.guilds.get(guildId);
    if (!state) return null;
    if (index < 0 || index >= state.queue.length) return null;
    const [removed] = state.queue.splice(index, 1);
    this.emitQueueUpdate(guildId);
    return removed ?? null;
  }

  public async clear(guildId: string): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    state.queue = [];
    this.emitQueueUpdate(guildId);
  }

  public async disconnect(guildId: string): Promise<void> {
    const state = this.guilds.get(guildId);
    if (!state) return;
    state.queue = [];
    state.loop = 'off';
    this.stopCurrent(state);
    state.current = null;
    state.resource = null;
    try {
      state.player.stop(true);
    } catch (err) {
      this.log.warn('disconnect(): player stop failed', err);
    }
    if (state.connection) {
      try {
        state.connection.destroy();
      } catch (err) {
        this.log.warn('disconnect(): connection destroy failed', err);
      }
    }
    this.guilds.delete(guildId);
    this.log.info('Disconnected and cleared guild state', { guildId });
  }

  // -------------------------------------------------------------------------
  // Read models
  // -------------------------------------------------------------------------

  public getSnapshot(guildId: string): PlayerSnapshot | null {
    const state = this.guilds.get(guildId);
    if (!state) return null;
    return this.buildSnapshot(state);
  }

  public getAllSnapshots(): PlayerSnapshot[] {
    return [...this.guilds.values()].map((s) => this.buildSnapshot(s));
  }

  public getHistory(guildId: string, limit = MAX_HISTORY): QueueItem[] {
    const state = this.guilds.get(guildId);
    if (!state) return [];
    return state.history.slice(0, Math.max(0, limit));
  }

  // -------------------------------------------------------------------------
  // Internals — query resolution (yt-dlp)
  // -------------------------------------------------------------------------

  /** Build the base argv shared by every yt-dlp invocation. */
  private baseArgs(): string[] {
    // `--socket-timeout` bounds each network read so a stalled connection can't
    // hang yt-dlp indefinitely (the wall-clock kill in runYtdlp is the backstop).
    const args = ['--no-warnings', '--socket-timeout', '15'];
    if (this.media.cookiesPath && this.media.cookiesPath.length > 0) {
      args.push('--cookies', this.media.cookiesPath);
    }
    return args;
  }

  /**
   * Resolve a query into a SearchResult. URLs are resolved directly; bare text
   * becomes a bounded `ytsearch<N>:` (flat) search.
   */
  private async resolveQuery(query: string, source?: SearchSource): Promise<SearchResult> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return { kind: 'empty', tracks: [] };

    // Reject local filesystem paths. These never come from a real request; they
    // are Voxtral hallucinations on non-speech audio (e.g. a macOS screenshot
    // temp path) that would otherwise be fed to `ytsearch` and play junk.
    if (looksLikeLocalPath(trimmed)) {
      this.log.warn('Rejecting local-path-like query', { query: trimmed.slice(0, 120) });
      return { kind: 'empty', tracks: [] };
    }

    const isUrl = /^https?:\/\//i.test(trimmed);
    const args = ['-J', ...this.baseArgs()];
    let isSearch = false;

    if (isUrl) {
      args.push(trimmed);
    } else {
      isSearch = true;
      const n = Math.max(1, Math.min(this.media.searchLimitMax, 10));
      // `source` is accepted for parity with the contract; yt-dlp only ships a
      // first-class ytsearch resolver, so we always search YouTube here.
      void source;
      args.push('--flat-playlist', `ytsearch${n}:${trimmed}`);
    }

    const stdout = await this.runYtdlp(args);
    if (stdout.trim().length === 0) return { kind: 'empty', tracks: [] };

    let doc: unknown;
    try {
      doc = JSON.parse(stdout);
    } catch (err) {
      this.log.error('Failed to parse yt-dlp JSON', err);
      return { kind: 'error', tracks: [], error: 'Could not parse media metadata.' };
    }
    return mapYtdlpResult(doc, isSearch);
  }

  /**
   * Run yt-dlp and collect stdout. Rejects on non-zero exit or spawn error.
   * A wall-clock timeout SIGKILLs a hung child and rejects, so a stalled
   * metadata fetch can never leave `play()` (and the voice pipeline) pending.
   */
  private runYtdlp(args: string[]): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.media.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new Error(`yt-dlp timed out after ${this.media.ytdlpTimeoutMs}ms`));
      }, this.media.ytdlpTimeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8');
      });
      child.on('error', (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`yt-dlp exited with code ${code}: ${err.trim().slice(0, 400)}`));
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internals — playback
  // -------------------------------------------------------------------------

  /** Lazily create the per-guild state + AudioPlayer (wiring its events once). */
  private ensureState(guildId: string): GuildState {
    const existing = this.guilds.get(guildId);
    if (existing) return existing;

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    const state: GuildState = {
      guildId,
      player,
      connection: null,
      voiceChannelId: null,
      current: null,
      resource: null,
      child: null,
      queue: [],
      history: [],
      volume: this.defaultVolume,
      loop: 'off',
      transitioning: false,
    };
    this.guilds.set(guildId, state);
    this.wirePlayer(state);
    return state;
  }

  /** Subscribe (once) to the player's lifecycle to advance the queue on Idle. */
  private wirePlayer(state: GuildState): void {
    state.player.on('stateChange', (oldState: AudioPlayerState, newState: AudioPlayerState) => {
      if (
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        void this.onTrackIdle(state);
      }
    });

    state.player.on('error', (error) => {
      this.log.error('AudioPlayer error', { guildId: state.guildId, error: error.message });
      this.events.emit('error', state.guildId, error);
      // Treat a playback error like the track ending so we don't get stuck.
      void this.onTrackIdle(state);
    });
  }

  /**
   * Called when the player transitions to Idle (track finished or errored).
   * Records history, applies loop policy, and starts the next track.
   */
  private async onTrackIdle(state: GuildState): Promise<void> {
    if (state.transitioning) return;

    const finished = state.current;
    state.current = null;
    state.resource = null;
    this.killChild(state);

    if (finished) {
      this.pushHistory(state, finished);
      this.events.emit('trackEnd', state.guildId, finished);

      // Loop policy: requeue the finished item per the active mode.
      if (state.loop === 'track') {
        state.queue.unshift(finished);
      } else if (state.loop === 'queue') {
        state.queue.push(finished);
      }
    }

    if (state.queue.length === 0) {
      this.emitQueueUpdate(state.guildId);
      this.events.emit('queueEnd', state.guildId);
      return;
    }

    await this.startNext(state);
    this.emitQueueUpdate(state.guildId);
  }

  /**
   * Pull the next queued item and begin streaming it through yt-dlp. No-op if
   * something is already playing or the queue is empty. Emits trackStart.
   */
  private async startNext(state: GuildState): Promise<void> {
    if (state.current !== null) return;
    const next = state.queue.shift();
    if (!next) return;

    state.current = next;
    try {
      const resource = await this.createTrackResource(state, next.track);
      state.resource = resource;
      resource.volume?.setVolume(state.volume / 100);
      state.player.play(resource);
      this.log.info('Track started', { guildId: state.guildId, title: next.track.title });
      this.events.emit('trackStart', state.guildId, next);
    } catch (err) {
      this.log.error('Failed to start track', { guildId: state.guildId, error: (err as Error).message });
      this.events.emit('error', state.guildId, err as Error);
      // Clear and advance past the broken track.
      state.current = null;
      state.resource = null;
      this.killChild(state);
      if (state.queue.length > 0) await this.startNext(state);
      else this.events.emit('queueEnd', state.guildId);
    }
  }

  /**
   * Spawn yt-dlp to stream a single track's audio to stdout, probe the stream
   * format, and wrap it in an inline-volume AudioResource. The child process is
   * retained on the guild state so skip/stop/disconnect can kill it.
   */
  private async createTrackResource(state: GuildState, track: Track): Promise<AudioResource> {
    const args = [
      '-f',
      this.media.ytdlpFormat,
      '-o',
      '-',
      '--no-playlist',
      ...this.baseArgs(),
      track.uri,
    ];

    const child = spawn(this.media.ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    state.child = child;

    child.on('error', (err) => {
      this.log.error('yt-dlp stream spawn error', { guildId: state.guildId, error: err.message });
      this.events.emit('error', state.guildId, err);
    });
    // Surface fatal stderr at debug; yt-dlp is chatty on stderr by design.
    child.stderr.on('data', (chunk: Buffer) => {
      this.log.debug('yt-dlp stderr', { guildId: state.guildId, line: chunk.toString('utf8').trim() });
    });

    // Bound the probe: if yt-dlp spawns but never produces a decodable byte,
    // demuxProbe would await forever and wedge startNext(). Race it against a
    // timeout that kills the child so the caller's catch advances the queue.
    const probe = await this.probeWithTimeout(child, state.guildId);
    return createAudioResource(probe.stream, {
      inputType: probe.type === StreamType.Arbitrary ? StreamType.Arbitrary : probe.type,
      inlineVolume: true,
    });
  }

  /** demuxProbe the child's stdout, rejecting (and SIGKILLing) past the cap. */
  private probeWithTimeout(
    child: StreamingChild,
    guildId: string,
  ): Promise<Awaited<ReturnType<typeof demuxProbe>>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.warn('yt-dlp stream probe timed out; killing child', { guildId });
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        reject(new Error(`yt-dlp stream produced no decodable audio within ${this.media.ytdlpTimeoutMs}ms`));
      }, this.media.ytdlpTimeoutMs);
      demuxProbe(child.stdout).then(
        (probe) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(probe);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Force the current resource to stop (player Idle handler will react). */
  private stopCurrent(state: GuildState): void {
    try {
      state.player.stop(true);
    } catch (err) {
      this.log.warn('stopCurrent() failed', err);
    }
    this.killChild(state);
  }

  /** Kill the streaming child process, if any. */
  private killChild(state: GuildState): void {
    if (state.child) {
      try {
        state.child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      state.child = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals — snapshots / history / events
  // -------------------------------------------------------------------------

  private buildSnapshot(state: GuildState): PlayerSnapshot {
    return {
      guildId: state.guildId,
      status: this.statusOf(state),
      voiceChannelId: state.voiceChannelId,
      current: state.current,
      positionMs: Math.max(0, Math.trunc(state.resource?.playbackDuration ?? 0)),
      queue: [...state.queue],
      volume: state.volume,
      loop: state.loop,
      paused: state.player.state.status === AudioPlayerStatus.Paused,
    };
  }

  private statusOf(state: GuildState): PlayerStatus {
    if (!state.connection) return 'disconnected';
    const status = state.player.state.status;
    if (status === AudioPlayerStatus.Paused || status === AudioPlayerStatus.AutoPaused) {
      return 'paused';
    }
    if (status === AudioPlayerStatus.Playing || status === AudioPlayerStatus.Buffering) {
      return 'playing';
    }
    return state.current ? 'playing' : 'idle';
  }

  private pushHistory(state: GuildState, item: QueueItem): void {
    state.history.unshift(item);
    if (state.history.length > MAX_HISTORY) state.history.length = MAX_HISTORY;
  }

  private emitQueueUpdate(guildId: string): void {
    const snapshot = this.getSnapshot(guildId);
    if (snapshot) this.events.emit('queueUpdate', snapshot);
  }
}

/** Clamp + truncate a volume into the 0..100 integer range. */
function clampVolume(volume: number): number {
  return Math.min(100, Math.max(0, Math.trunc(volume)));
}

/**
 * Heuristic: does this query look like a local filesystem path rather than
 * something to search/stream? These come from Voxtral hallucinations on
 * non-speech audio (notably macOS screenshot temp paths) and must never reach
 * yt-dlp. Matches absolute POSIX/Windows paths and bare media/file filenames.
 */
function looksLikeLocalPath(query: string): boolean {
  const q = query.trim();
  if (/^(?:\/|~\/|[a-z]:\\)/i.test(q)) return true; // /var/folders…, ~/…, C:\…
  if (/(?:var\/folders|temporaryitems|screencaptureui|\/users\/|\/tmp\/)/i.test(q)) return true;
  // A bare filename ending in a non-audio file extension (e.g. "Screenshot.png").
  if (/\.(?:png|jpe?g|gif|webp|heic|pdf|txt|docx?|mov|zip)$/i.test(q)) return true;
  return false;
}

/** Re-export so callers don't need to import the helper from trackMapper. */
export { toQueueItem };

/**
 * Factory for the audio service. The composition root joins voice and calls
 * `bindConnection(guildId, connection)` before any `play()` for that guild.
 */
export function createAudioService(deps: {
  logger: Logger;
  media: MediaConfig;
  defaultVolume: number;
}): AudioService {
  const log = deps.logger.child('audio');
  return new AudioServiceImpl(log, deps.media, deps.defaultVolume);
}
