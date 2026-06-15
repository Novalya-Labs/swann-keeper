/**
 * Swann — shared type contracts.
 *
 * This file is the integration boundary between every module. Implementers
 * import from here and MUST NOT redefine these shapes locally. If a contract
 * needs to change, change it here first so all modules stay coherent.
 *
 * Module map (see README + manifest):
 *   audio   -> implements AudioService
 *   mistral -> implements MistralAgent + Transcriber, owns ToolName/ToolResult
 *   voice   -> implements VoiceListener, emits VoiceCommandEvent
 *   discord -> consumes AudioService + MistralAgent, owns CommandContext
 *   admin   -> consumes AudioService (read) + ConfigStatus, AdminState
 *   haos    -> packaging only (no TS surface)
 */

import type { EventEmitter } from 'node:events';

// ===========================================================================
// Core music domain
// ===========================================================================

/** A resolved, playable track (normalised from a yt-dlp result entry). */
export interface Track {
  /** Canonical source URL (YouTube watch URL) — the play key for yt-dlp. */
  readonly uri: string;
  /** Opaque source id (e.g. YouTube video id). */
  readonly encoded?: string;
  readonly title: string;
  readonly author: string;
  /** Length in milliseconds. 0 for live streams. */
  readonly durationMs: number;
  /** Whether this is a live stream (no fixed length). */
  readonly isStream: boolean;
  /** Thumbnail/artwork URL, if any. */
  readonly artworkUrl?: string;
  /** Source name (e.g. "youtube", "soundcloud"). */
  readonly sourceName?: string;
}

/** A track wrapped with who requested it and when. */
export interface QueueItem {
  readonly track: Track;
  /** Discord user id of the requester. */
  readonly requestedBy: string;
  /** Display name of the requester at request time. */
  readonly requestedByName: string;
  /** Epoch ms when this item was added to the queue. */
  readonly addedAt: number;
}

/** Result of a search/resolve operation against the media backend (yt-dlp). */
export interface SearchResult {
  /** "track" = single track, "playlist" = playlist, "search" = list of
   *  candidates, "empty" = nothing found, "error" = load failed. */
  readonly kind: 'track' | 'playlist' | 'search' | 'empty' | 'error';
  readonly tracks: Track[];
  /** Present when kind === "playlist". */
  readonly playlistName?: string;
  /** Present when kind === "error". */
  readonly error?: string;
}

/** Supported search sources for explicit-source queries. */
export type SearchSource = 'youtube' | 'youtubemusic' | 'spotify' | 'soundcloud';

/** Player lifecycle/playback status surfaced to admin + agent. */
export type PlayerStatus = 'idle' | 'playing' | 'paused' | 'disconnected';

/** Loop mode for the queue. */
export type LoopMode = 'off' | 'track' | 'queue';

/** A snapshot of one guild's player + queue for the admin UI / agent context. */
export interface PlayerSnapshot {
  readonly guildId: string;
  readonly status: PlayerStatus;
  readonly voiceChannelId: string | null;
  readonly current: QueueItem | null;
  /** Position into the current track, in ms. */
  readonly positionMs: number;
  readonly queue: QueueItem[];
  /** Volume 0..100. */
  readonly volume: number;
  readonly loop: LoopMode;
  readonly paused: boolean;
}

// ===========================================================================
// audio module — AudioService
// ===========================================================================

/**
 * The audio/queue service backed by @discordjs/voice (playback) + yt-dlp
 * (search/streaming). Created once at startup and shared with discord, mistral
 * (via the tool executor) and admin.
 *
 * Implemented by: src/audio/audioService.ts (createAudioService factory).
 *
 * Voice connection ownership: the composition root joins ONE voice connection
 * per guild (selfDeaf:false) shared with the wake-word listener, and hands it
 * to bindConnection(). The service subscribes its AudioPlayer to it.
 */
export interface AudioService {
  /**
   * Bind an established @discordjs/voice VoiceConnection for a guild so the
   * service can subscribe its AudioPlayer to it. The composition root joins
   * voice (selfDeaf:false, shared with the wake-word listener) and calls this
   * before any play() for that guild.
   */
  bindConnection(guildId: string, connection: VoiceConnectionLike): void;

  /** Resolve a query to tracks without enqueuing. */
  search(query: string, source?: SearchSource): Promise<SearchResult>;

  /**
   * Ensure a player exists + is connected to the requester's voice channel,
   * resolve the query, enqueue, and start playback if idle.
   */
  play(req: PlayRequest): Promise<PlayOutcome>;

  /** Enqueue already-resolved tracks (used for playlists from the agent). */
  enqueue(guildId: string, items: QueueItem[]): Promise<void>;

  /** Skip `count` tracks (default 1). Returns the now-playing item or null. */
  skip(guildId: string, count?: number): Promise<QueueItem | null>;

  /** Pause playback. No-op if already paused. */
  pause(guildId: string): Promise<void>;

  /** Resume playback. No-op if not paused. */
  resume(guildId: string): Promise<void>;

  /** Stop playback, clear the queue, but stay connected. */
  stop(guildId: string): Promise<void>;

  /** Set volume 0..100. */
  setVolume(guildId: string, volume: number): Promise<void>;

  /** Set loop mode. */
  setLoop(guildId: string, mode: LoopMode): Promise<void>;

  /** Remove a queue item by zero-based index. Returns the removed item. */
  remove(guildId: string, index: number): Promise<QueueItem | null>;

  /** Clear the pending queue but keep the current track playing. */
  clear(guildId: string): Promise<void>;

  /** Leave the voice channel and destroy the player. */
  disconnect(guildId: string): Promise<void>;

  /** Read-only snapshot of a guild's player, or null if none exists. */
  getSnapshot(guildId: string): PlayerSnapshot | null;

  /** Snapshots for every active guild (admin UI). */
  getAllSnapshots(): PlayerSnapshot[];

  /** Recently played tracks, newest first (admin "history" view). */
  getHistory(guildId: string, limit?: number): QueueItem[];

  /**
   * Player/queue lifecycle events for the admin UI live feed.
   * Event names: see AudioServiceEvents.
   */
  readonly events: AudioServiceEvents;
}

/** Where/what to play. Library-agnostic so audio never imports discord.js. */
export interface PlayRequest {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly textChannelId: string;
  readonly query: string;
  readonly source?: SearchSource;
  readonly requestedBy: string;
  readonly requestedByName: string;
  /** If true, add to front of queue / play next. */
  readonly playNext?: boolean;
}

/** Result of a play() call, suitable for building a user-facing reply. */
export interface PlayOutcome {
  readonly kind: 'queued' | 'queued_playlist' | 'now_playing' | 'empty' | 'error';
  /** The track that is now playing (now_playing) or was queued (queued). */
  readonly track?: Track;
  /** Number of tracks added (for playlists). */
  readonly addedCount?: number;
  readonly playlistName?: string;
  readonly error?: string;
}

/** Typed event surface for AudioService (a Node EventEmitter under the hood). */
export interface AudioServiceEvents extends EventEmitter {
  on(event: 'trackStart', listener: (guildId: string, item: QueueItem) => void): this;
  on(event: 'trackEnd', listener: (guildId: string, item: QueueItem) => void): this;
  on(event: 'queueEnd', listener: (guildId: string) => void): this;
  on(event: 'queueUpdate', listener: (snapshot: PlayerSnapshot) => void): this;
  on(event: 'error', listener: (guildId: string, error: Error) => void): this;
  emit(event: 'trackStart', guildId: string, item: QueueItem): boolean;
  emit(event: 'trackEnd', guildId: string, item: QueueItem): boolean;
  emit(event: 'queueEnd', guildId: string): boolean;
  emit(event: 'queueUpdate', snapshot: PlayerSnapshot): boolean;
  emit(event: 'error', guildId: string, error: Error): boolean;
}

// ===========================================================================
// mistral module — agent, tools, transcription
// ===========================================================================

/** Names of the tools the Mistral agent may call. */
export type ToolName =
  | 'search_songs'
  | 'play_song'
  | 'play_playlist'
  | 'skip'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'set_volume'
  | 'set_loop'
  | 'get_queue'
  | 'clear_queue';

/** Argument shapes for each tool (post-JSON.parse of toolCall arguments). */
export interface ToolArgs {
  search_songs: { query: string; source?: SearchSource; limit?: number };
  play_song: { query: string; source?: SearchSource; play_next?: boolean };
  /** e.g. "fais-moi une playlist de Jul de 10 sons" -> artist=Jul, count=10. */
  play_playlist: { theme: string; artist?: string; count?: number; source?: SearchSource };
  skip: { count?: number };
  pause: Record<string, never>;
  resume: Record<string, never>;
  stop: Record<string, never>;
  set_volume: { volume: number };
  set_loop: { mode: LoopMode };
  get_queue: Record<string, never>;
  clear_queue: Record<string, never>;
}

/** Normalised result returned by a tool execution (JSON-stringified for Mistral). */
export interface ToolResult {
  readonly ok: boolean;
  /** Human-readable summary the model can relay to the user. */
  readonly summary: string;
  /** Optional structured payload (e.g. queue snapshot, search candidates). */
  readonly data?: unknown;
  /** Present when ok === false. */
  readonly error?: string;
}

/**
 * Resolved context an agent turn runs in. The discord module builds this from
 * the interaction/message; voice builds it from the speaking member. The agent
 * passes it untouched to the ToolExecutor so tools know which guild/channel to
 * act on without the agent depending on discord.js.
 */
export interface AgentContext {
  readonly guildId: string;
  readonly voiceChannelId: string | null;
  readonly textChannelId: string;
  readonly userId: string;
  readonly userName: string;
}

/**
 * Executes a single tool call. Implemented in the audio/discord glue layer
 * (wires ToolName -> AudioService method) and injected into the agent so the
 * mistral module never imports audio directly.
 */
export type ToolExecutor = (
  name: ToolName,
  args: ToolArgs[ToolName],
  ctx: AgentContext,
) => Promise<ToolResult>;

/** Outcome of a full agent run (the multi-turn tool loop until no toolCalls). */
export interface AgentReply {
  /** Final natural-language reply to surface to the user. */
  readonly text: string;
  /** Tools that were invoked during the run (for logging / admin feed). */
  readonly toolsUsed: ToolName[];
  /** True if the loop terminated cleanly; false if it errored/aborted. */
  readonly ok: boolean;
}

/**
 * The natural-language agent. Created once with a ToolExecutor injected.
 * Implemented by: src/mistral/agent.ts (createMistralAgent factory).
 */
export interface MistralAgent {
  /** Run the tool-calling loop for a single user utterance. */
  run(utterance: string, ctx: AgentContext): Promise<AgentReply>;
}

/**
 * Voxtral transcription wrapper.
 * Implemented by: src/mistral/transcriber.ts (createTranscriber factory).
 */
export interface Transcriber {
  /**
   * Transcribe a finished utterance. Accepts a path to an audio file
   * (e.g. a temp .wav/.ogg the voice module wrote) OR raw 16k mono PCM
   * that the implementation will wrap into a container before upload.
   */
  transcribe(input: TranscriptionInput): Promise<TranscriptionOutput>;
}

export interface TranscriptionInput {
  /** Absolute path to an audio file on disk (preferred). */
  readonly filePath?: string;
  /** OR raw 16kHz mono signed-16-bit-LE PCM samples. */
  readonly pcm16kMono?: Buffer;
  /** Optional language hint (ISO-639-1, e.g. "fr") for accuracy. */
  readonly language?: string;
}

export interface TranscriptionOutput {
  readonly text: string;
  readonly language?: string;
  /** Seconds of audio billed, if reported. */
  readonly audioSeconds?: number;
}

// ===========================================================================
// voice module — receive pipeline, wake word, VAD
// ===========================================================================

/**
 * Emitted when the "Swann" wake word fires and a full utterance has been
 * captured + transcribed. The discord module wires this into the agent.
 */
export interface VoiceCommandEvent {
  readonly guildId: string;
  /** Discord user id who spoke the command. */
  readonly userId: string;
  readonly userName: string;
  /** Voice channel the user is speaking in. */
  readonly voiceChannelId: string;
  /** The transcribed command text (after the wake word). */
  readonly transcript: string;
  /** Captured utterance length in seconds. */
  readonly durationSec: number;
}

/** Lower-level voice pipeline events for diagnostics / admin status. */
export interface VoiceListenerEvents extends EventEmitter {
  on(event: 'command', listener: (e: VoiceCommandEvent) => void): this;
  on(event: 'wake', listener: (guildId: string, userId: string) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  emit(event: 'command', e: VoiceCommandEvent): boolean;
  emit(event: 'wake', guildId: string, userId: string): boolean;
  emit(event: 'error', error: Error): boolean;
}

/**
 * The voice receive pipeline: per-user Opus->16k mono PCM, Porcupine wake
 * word, Silero VAD utterance capture, then transcription via the injected
 * Transcriber. Emits VoiceCommandEvent.
 *
 * Implemented by: src/voice/voiceListener.ts (createVoiceListener factory).
 * The discord module owns the actual VoiceConnection (it joins via
 * @discordjs/voice) and hands it to attach().
 */
export interface VoiceListener {
  /** Begin listening on an established (selfDeaf:false) voice connection. */
  attach(guildId: string, connection: VoiceConnectionLike): void;

  /** Stop listening for a guild and release per-user pipelines. */
  detach(guildId: string): void;

  /** True if currently listening in the given guild. */
  isListening(guildId: string): boolean;

  readonly events: VoiceListenerEvents;
}

/**
 * Minimal structural type for a @discordjs/voice VoiceConnection so the
 * voice module's public interface doesn't force a hard type dependency on
 * the exact discord.js version at the contract layer. Implementations cast
 * to the real VoiceConnection internally.
 */
export interface VoiceConnectionLike {
  readonly receiver: unknown;
  readonly joinConfig: { readonly channelId: string | null; readonly guildId: string };
}

// ===========================================================================
// discord module — command context
// ===========================================================================

/**
 * Unified context passed to slash-command and text-trigger handlers so the
 * same handler logic works for /play and "Hey Swann ...".
 */
export interface CommandContext {
  readonly guildId: string;
  readonly userId: string;
  readonly userName: string;
  readonly textChannelId: string;
  /** Voice channel the invoking member is in, or null. */
  readonly voiceChannelId: string | null;
  /** Reply to the user (handles both interaction.reply and message.reply). */
  reply(content: string): Promise<void>;
  /** Edit/follow-up after a deferred reply (long operations). */
  followUp(content: string): Promise<void>;
}

// ===========================================================================
// config + status
// ===========================================================================

/** Per-credential presence/validity status for the admin UI (never values). */
export interface ConfigStatus {
  readonly discordToken: boolean;
  readonly discordAppId: boolean;
  readonly mistralApiKey: boolean;
  readonly picovoiceAccessKey: boolean;
  readonly picovoiceKeyword: boolean;
  readonly sileroModel: boolean;
  /** Whether the yt-dlp binary is available on PATH (media backend health). */
  readonly ytdlpAvailable: boolean;
}

/** Aggregate live state the admin server serves to its frontend. */
export interface AdminState {
  readonly config: ConfigStatus;
  readonly players: PlayerSnapshot[];
  /** Recently executed agent/voice actions, newest first. */
  readonly activity: ActivityEntry[];
  readonly uptimeSec: number;
}

export interface ActivityEntry {
  readonly at: number;
  readonly kind: 'command' | 'voice' | 'agent' | 'system';
  readonly guildId?: string;
  readonly message: string;
}
