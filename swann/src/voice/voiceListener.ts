/**
 * Swann — VoiceListener: the Discord voice RECEIVE orchestrator.
 *
 * Per guild, given a (selfDeaf:false) VoiceConnection handed over by the
 * discord module, this:
 *   1. owns one sherpa-onnx KWS wake-word engine + one Silero VAD detector,
 *   2. on each `receiver.speaking 'start'` spins up a per-user receive pipeline
 *      (Opus -> 16k mono int16 512-sample frames),
 *   3. while idle, runs every frame through the KWS spotter ("Swann"),
 *   4. once "Swann" fires, switches that guild into CAPTURE mode and feeds
 *      subsequent frames to Silero VAD until trailing silence ends the
 *      utterance,
 *   5. transcribes the captured 16k mono PCM via the injected Transcriber,
 *   6. emits a VoiceCommandEvent (transcript + speaker/guild/channel).
 *
 * The discord module subscribes to events 'command' to feed the agent. This
 * module never imports audio/discord and never joins voice itself.
 */

import { EventEmitter } from 'node:events';
import type {
  VoiceListener,
  VoiceListenerEvents,
  VoiceConnectionLike,
  Transcriber,
} from '../types.js';
import type { Logger } from '../logger.js';
import type { VoiceConfig } from '../config.js';
import { createWakeWordEngine, type WakeWordEngine } from './wakeWord.js';
import { createUtteranceDetector, type UtteranceDetector, VAD_SAMPLE_RATE } from './vad.js';
import { startUserPipeline, type UserPipeline } from './receivePipeline.js';

// @discordjs/voice receiver type — cast from VoiceConnectionLike.receiver.
import type { VoiceReceiver } from '@discordjs/voice';

/** Cap a single utterance so a stuck VAD can't grow an unbounded buffer. */
const MAX_UTTERANCE_SAMPLES = VAD_SAMPLE_RATE * 20; // 20s @ 16k

interface SpeakingHandler {
  (userId: string): void;
}

/** Per-guild runtime state. */
interface GuildState {
  readonly guildId: string;
  readonly voiceChannelId: string;
  readonly receiver: VoiceReceiver;
  /** null in 'transcribe' wake mode (no on-device keyword spotter). */
  readonly wake: WakeWordEngine | null;
  readonly vad: UtteranceDetector;
  /** Active per-user receive pipelines, keyed by Discord user id. */
  readonly pipelines: Map<string, UserPipeline>;
  /**
   * The user whose utterance is currently being captured after a wake hit,
   * or null when listening for the wake word. Capture is single-speaker: once
   * "Swann" fires for a user, we capture only that user until the utterance
   * completes.
   */
  capturingUserId: string | null;
  /** Running count of samples fed to the VAD for the in-flight utterance. */
  captureSamples: number;
  /** Bound speaking 'start' handler so we can remove it on detach. */
  onSpeakingStart: SpeakingHandler | null;
  detached: boolean;
}

class VoiceListenerImpl implements VoiceListener {
  readonly events: VoiceListenerEvents = new EventEmitter() as VoiceListenerEvents;

  private readonly guilds = new Map<string, GuildState>();

  constructor(
    private readonly logger: Logger,
    private readonly voice: VoiceConfig,
    private readonly transcriber: Transcriber,
    private readonly language: string | undefined,
  ) {}

  attach(guildId: string, connection: VoiceConnectionLike): void {
    if (this.guilds.has(guildId)) {
      this.logger.debug('attach() called for already-listening guild; re-attaching', { guildId });
      this.detach(guildId);
    }

    const receiver = connection.receiver as VoiceReceiver;
    const voiceChannelId = connection.joinConfig.channelId ?? '';

    // Async engine init; if it fails we surface via the error event and skip.
    void this.initGuild(guildId, voiceChannelId, receiver).catch((err) => {
      this.logger.error('Failed to start voice listening', { guildId, error: (err as Error).message });
      this.events.emit('error', err as Error);
    });
  }

  private async initGuild(guildId: string, voiceChannelId: string, receiver: VoiceReceiver): Promise<void> {
    const vad = await createUtteranceDetector({ logger: this.logger.child('vad'), voice: this.voice });
    // Only the 'kws' mode needs the on-device keyword spotter; 'transcribe'
    // mode wakes purely from the Voxtral transcript.
    const wake =
      this.voice.wakeMode === 'kws'
        ? await createWakeWordEngine({ logger: this.logger.child('wake'), voice: this.voice })
        : null;

    const state: GuildState = {
      guildId,
      voiceChannelId,
      receiver,
      wake,
      vad,
      pipelines: new Map(),
      capturingUserId: null,
      captureSamples: 0,
      onSpeakingStart: null,
      detached: false,
    };

    const onSpeakingStart: SpeakingHandler = (userId: string) => {
      this.handleSpeakingStart(state, userId);
    };
    state.onSpeakingStart = onSpeakingStart;
    receiver.speaking.on('start', onSpeakingStart);

    this.guilds.set(guildId, state);
    this.logger.info('Voice listening started', { guildId, voiceChannelId, wakeMode: this.voice.wakeMode });
  }

  private handleSpeakingStart(state: GuildState, userId: string): void {
    if (state.detached) return;
    // Already have a pipeline for this user (stream ends on silence then we
    // re-subscribe on the next 'start'); avoid double subscription.
    if (state.pipelines.has(userId)) return;

    const pipeline = startUserPipeline({
      logger: this.logger.child('pipe'),
      receiver: state.receiver,
      userId,
      debug: this.voice.kwsDebug,
      onFrame: (frame) => this.handleFrame(state, userId, frame),
      onEnd: () => this.handlePipelineEnd(state, userId),
    });
    state.pipelines.set(userId, pipeline);
  }

  private handleFrame(state: GuildState, userId: string, frame: Int16Array): void {
    if (state.detached) return;

    // Transcribe mode: no keyword gate — feed every frame to the VAD and let
    // Voxtral decide (the wake word is matched on the transcript). One VAD per
    // guild; on a small server one person speaks at a time.
    if (this.voice.wakeMode === 'transcribe') {
      const completed = state.vad.feed(frame);
      if (completed) void this.handleTranscribedUtterance(state, userId, completed);
      return;
    }

    if (!state.wake) return;
    if (state.capturingUserId === null) {
      // Listening for the wake word.
      if (state.wake.detect(frame)) {
        this.logger.debug('Wake word "Swann" detected', { guildId: state.guildId, userId });
        this.events.emit('wake', state.guildId, userId);
        state.capturingUserId = userId;
        state.captureSamples = 0;
        state.vad.reset();
        // Do NOT feed the triggering frame: it is the TAIL of the wake word
        // itself. Capturing it lets the VAD finalize "…ann" as the command the
        // moment the user pauses after the wake word (so "Swann <pause> play X"
        // captured just the wake tail). Capture starts from the next frame, so
        // a brief pause after the wake word is fine.
      }
      return;
    }

    // In capture mode: only the triggering user's audio counts.
    if (state.capturingUserId === userId) {
      this.feedCapture(state, userId, frame);
    }
  }

  private feedCapture(state: GuildState, userId: string, frame: Int16Array): void {
    state.captureSamples += frame.length;
    const completed = state.vad.feed(frame);
    if (completed) {
      this.finalizeCapture(state, userId, completed);
      return;
    }
    // Hard cap so a never-ending VAD segment can't grow without bound.
    if (state.captureSamples >= MAX_UTTERANCE_SAMPLES) {
      this.logger.warn('Utterance exceeded max length; forcing finish', { guildId: state.guildId });
      const flushed = state.vad.finish();
      if (flushed) this.finalizeCapture(state, userId, flushed);
      else this.resetCapture(state);
    }
  }

  private handlePipelineEnd(state: GuildState, userId: string): void {
    state.pipelines.delete(userId);
    if (this.voice.wakeMode === 'transcribe') {
      const flushed = state.vad.finish();
      if (flushed) void this.handleTranscribedUtterance(state, userId, flushed);
      return;
    }
    // If the capturing user's stream ended mid-utterance, flush the VAD to get
    // whatever was captured.
    if (state.capturingUserId === userId) {
      const flushed = state.vad.finish();
      if (flushed) this.finalizeCapture(state, userId, flushed);
      else this.resetCapture(state);
    }
  }

  private finalizeCapture(state: GuildState, userId: string, samples: Float32Array): void {
    this.resetCapture(state);
    const durationSec = samples.length / VAD_SAMPLE_RATE;
    this.logger.debug('Utterance captured', { guildId: state.guildId, userId, durationSec: durationSec.toFixed(2) });
    void this.transcribeAndEmit(state, userId, samples, durationSec);
  }

  private resetCapture(state: GuildState): void {
    state.capturingUserId = null;
    state.captureSamples = 0;
  }

  private async transcribeAndEmit(
    state: GuildState,
    userId: string,
    samples: Float32Array,
    durationSec: number,
  ): Promise<void> {
    try {
      const pcm = float32ToPcm16le(samples);
      const result = await this.transcriber.transcribe({
        pcm16kMono: pcm,
        ...(this.language ? { language: this.language } : {}),
      });
      const transcript = result.text.trim();
      if (!transcript) {
        this.logger.debug('Empty transcript; ignoring utterance', { guildId: state.guildId, userId });
        return;
      }
      this.events.emit('command', {
        guildId: state.guildId,
        userId,
        userName: userId, // discord module resolves the display name from userId
        voiceChannelId: state.voiceChannelId,
        transcript,
        durationSec,
        ...(result.audioSeconds !== undefined ? { audioBilledSec: result.audioSeconds } : {}),
      });
    } catch (err) {
      this.logger.error('Transcription failed', { guildId: state.guildId, error: (err as Error).message });
      this.events.emit('error', err as Error);
    }
  }

  /**
   * Transcribe mode: transcribe a completed utterance with Voxtral, and if it
   * starts with a wake word, emit the rest as a command. Multilingual and far
   * more reliable than the English KWS for non-English wake words.
   */
  private async handleTranscribedUtterance(
    state: GuildState,
    userId: string,
    samples: Float32Array,
  ): Promise<void> {
    const durationSec = samples.length / VAD_SAMPLE_RATE;
    if (durationSec < 0.4) return; // ignore sub-word blips

    let transcript: string;
    let audioBilledSec: number | undefined;
    try {
      const pcm = float32ToPcm16le(samples);
      const result = await this.transcriber.transcribe({
        pcm16kMono: pcm,
        ...(this.language ? { language: this.language } : {}),
      });
      transcript = result.text.trim();
      audioBilledSec = result.audioSeconds;
    } catch (err) {
      this.logger.error('Transcription failed', { guildId: state.guildId, error: (err as Error).message });
      this.events.emit('error', err as Error);
      return;
    }
    if (!transcript) return;

    const command = this.stripWake(transcript);
    if (command === null) {
      this.logger.debug('No wake word in utterance; ignoring', { guildId: state.guildId, transcript });
      return;
    }
    if (command.length === 0) {
      this.logger.debug('Wake word with no command; ignoring', { guildId: state.guildId, transcript });
      return;
    }

    this.logger.info('Voice wake matched', { guildId: state.guildId, userId, transcript, command });
    this.events.emit('command', {
      guildId: state.guildId,
      userId,
      userName: userId, // the discord module resolves the display name
      voiceChannelId: state.voiceChannelId,
      transcript: command,
      durationSec,
      ...(audioBilledSec !== undefined ? { audioBilledSec } : {}),
    });
  }

  /**
   * Return the command after the wake word if the transcript opens with one,
   * else null. Accents/case-insensitive. Scans the first few tokens (not just
   * the first) so a leading filler or a stray word Voxtral prepends ("hey",
   * "eh", "alors", …) doesn't defeat the match.
   */
  private stripWake(transcript: string): string | null {
    const tokens = transcript
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining accents
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    if (tokens.length === 0) return null;

    const scan = Math.min(3, tokens.length);
    for (let i = 0; i < scan; i++) {
      const w = tokens[i];
      if (w !== undefined && this.voice.wakeWords.includes(w)) {
        return tokens.slice(i + 1).join(' ').trim();
      }
    }
    return null;
  }

  detach(guildId: string): void {
    const state = this.guilds.get(guildId);
    if (!state) return;
    state.detached = true;

    if (state.onSpeakingStart) {
      try {
        state.receiver.speaking.removeListener('start', state.onSpeakingStart);
      } catch {
        /* ignore */
      }
    }
    for (const pipeline of state.pipelines.values()) {
      pipeline.stop();
    }
    state.pipelines.clear();
    state.wake?.release();
    state.vad.release();
    this.guilds.delete(guildId);
    this.logger.info('Voice listening stopped', { guildId });
  }

  isListening(guildId: string): boolean {
    return this.guilds.has(guildId);
  }
}

/** Convert 16k mono Float32 [-1,1] to signed 16-bit LE PCM Buffer. */
function float32ToPcm16le(samples: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i] ?? 0;
    s = s < -1 ? -1 : s > 1 ? 1 : s;
    // Scale to int16 range; * 32767 keeps positive peaks in range.
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

/**
 * Create the VoiceListener. The discord module joins voice (selfDeaf:false)
 * and calls attach() with the resulting connection.
 */
export function createVoiceListener(deps: {
  logger: Logger;
  voice: VoiceConfig;
  transcriber: Transcriber;
  language?: string;
}): VoiceListener {
  return new VoiceListenerImpl(
    deps.logger.child('voice'),
    deps.voice,
    deps.transcriber,
    deps.language,
  );
}
