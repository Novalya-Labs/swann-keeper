/**
 * Swann — composition root / entrypoint.
 *
 * Owns process wiring for all modules. Builds config + logger, constructs the
 * audio, mistral, voice and admin services against their factory contracts,
 * wires the Discord client (slash commands, the "Hey Swann" text trigger), and
 * — crucially — owns the SINGLE voice connection per guild that is shared by
 * both playback (@discordjs/voice AudioPlayer) and the wake-word listener
 * (voice receive). Discord only allows one voice connection per bot per guild,
 * so this file joins once (selfDeaf:false) and hands the same connection to
 * `audio.bindConnection()` and `voice.attach()`.
 */

import { Events, REST, Routes } from 'discord.js';
import type { Interaction, Message, VoiceBasedChannel } from 'discord.js';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

import { config, assertRequired, configStatus } from './config.js';
import { logger } from './logger.js';
import type { ActivityEntry, AgentContext, AudioService, VoiceCommandEvent } from './types.js';

import { createAudioService } from './audio/index.js';
import { loadWakeSound } from './audio/wakeSound.js';
import { createMistralAgent, createTranscriber } from './mistral/index.js';
import { createVoiceListener } from './voice/index.js';
import { createTtsService } from './tts/index.js';
import { createAdminServer } from './admin/index.js';

import { createClient, joinVoice } from './discord/client.js';
import { createToolExecutor } from './discord/toolExecutor.js';
import { createInteractionHandler } from './discord/interactionHandler.js';
import { createMessageHandler } from './discord/messageHandler.js';
import { commandJSON } from './discord/commands/index.js';

/** Probe whether the yt-dlp binary is callable (media backend health flag). */
function checkYtdlp(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(config.media.ytdlpPath, ['--version'], { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

/** Register slash commands at boot so a fresh deploy is immediately usable. */
async function registerCommands(): Promise<void> {
  const log = logger.child('register');
  try {
    const rest = new REST({ version: '10' }).setToken(config.discord.token);
    const body = commandJSON();
    if (config.discord.guildId) {
      await rest.put(
        Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId),
        { body },
      );
      log.info('Slash commands registered (guild-scoped)', { count: body.length });
    } else {
      await rest.put(Routes.applicationCommands(config.discord.appId), { body });
      log.info('Slash commands registered (global)', { count: body.length });
    }
  } catch (err) {
    // Non-fatal: the bot still runs; commands can be (re)registered via `npm run register`.
    log.error('Failed to auto-register slash commands at boot', { err });
  }
}

export async function startBot(): Promise<void> {
  const log = logger.child('boot');
  assertRequired();

  const ytdlpAvailable = await checkYtdlp();
  if (!ytdlpAvailable) {
    log.warn('yt-dlp not found on PATH — playback will fail until it is installed', {
      ytdlpPath: config.media.ytdlpPath,
    });
  }
  log.info('Starting Swann', { homeAssistant: config.isHomeAssistant, ytdlpAvailable });

  // --- activity sink (shared with admin for the live feed) -----------------
  let recordActivity: (entry: ActivityEntry) => void = () => {};

  // --- discord client + audio (single shared voice connection) -------------
  const client = createClient();
  const audio: AudioService = createAudioService({
    logger,
    media: config.media,
    defaultVolume: config.behaviour.defaultVolume,
  });

  // --- mistral (agent + transcriber) ---------------------------------------
  const executor = createToolExecutor(audio, logger);
  const agent = createMistralAgent({
    logger,
    apiKey: config.mistral.apiKey,
    model: config.mistral.chatModel,
    executor,
  });
  const transcriber = createTranscriber({
    logger,
    apiKey: config.mistral.apiKey,
    model: config.mistral.transcribeModel,
  });

  // --- voice (wake word + VAD + transcription) -----------------------------
  const voice = createVoiceListener({
    logger,
    voice: config.voice,
    transcriber,
    ...(config.voice.language ? { language: config.voice.language } : {}),
  });

  // Optional spoken replies (offline TTS); silent no-op if disabled or model
  // files absent.
  const tts = createTtsService({ logger, voice: config.voice });

  // Optional wake-acknowledged chime, built once at boot (null when disabled).
  const wakeSound = config.voice.wakeChime ? loadWakeSound({ logger, voice: config.voice }) : null;

  /** Tools whose effect IS audible playback — speaking over them is pointless. */
  const PLAYBACK_TOOLS = new Set(['play_song', 'play_playlist', 'skip', 'resume']);

  // --- admin (Ingress web UI) ----------------------------------------------
  const admin = createAdminServer({
    logger,
    admin: config.admin,
    audio,
    configStatus: () => {
      const status = configStatus();
      return {
        discordToken: status.discordToken,
        discordAppId: status.discordAppId,
        mistralApiKey: status.mistralApiKey,
        // Reflect whether the user actually dropped the model files into /config.
        kwsModel: existsSync(config.voice.kwsEncoderPath) && existsSync(config.voice.kwsKeywordsPath),
        sileroModel: existsSync(config.voice.sileroVadPath),
        ytdlpAvailable,
      };
    },
    costRates: {
      chatPromptPer1M: config.mistral.chatPromptCostPer1M,
      chatCompletionPer1M: config.mistral.chatCompletionCostPer1M,
      transcribePerMinute: config.mistral.transcribeCostPerMinute,
    },
    // NOTE: do NOT pass `pushActivity` here. The admin server's recordActivity
    // already writes to its store and would call pushActivity back — and since
    // we set `recordActivity = admin.recordActivity` below, a pushActivity that
    // forwards to recordActivity creates infinite recursion (stack overflow).
  });
  // The admin server returns the canonical recorder; route all activity to it.
  recordActivity = admin.recordActivity;

  audio.events.on('error', (guildId, error) => {
    log.error('Audio error', { guildId, err: error });
  });

  // --- single shared voice connection per guild ----------------------------
  // joined: guildId -> channelId the bot is currently connected to.
  const joined = new Map<string, string>();
  // welcomeSent: track channels where the welcome message has been sent (guildId-channelId)
  const welcomeSent = new Set<string>();

  /**
   * Join a voice channel once (selfDeaf:false) and share the connection with
   * BOTH the audio player and the wake-word listener. Idempotent per channel.
   */
  async function ensureVoice(channel: VoiceBasedChannel): Promise<void> {
    const guildId = channel.guild.id;
    if (joined.get(guildId) === channel.id && voice.isListening(guildId)) return;

    const me = channel.guild.members.me;
    if (me && !channel.permissionsFor(me).has('Connect')) {
      log.warn('Missing Connect permission for voice channel', { guildId, channelId: channel.id });
      return;
    }

    const connection = await joinVoice(channel, logger);
    joined.set(guildId, channel.id);

    audio.bindConnection(guildId, connection);
    if (voice.isListening(guildId)) voice.detach(guildId);
    voice.attach(guildId, connection);
    log.info('Joined voice (shared play + receive)', { guildId, channelId: channel.id });

    // Welcome message once per channel — AFTER attach so it can never block the
    // voice listener, and guarded so a missing Send-Messages permission only
    // warns (the voice channel's text chat needs that permission).
    const channelId = channel.id;
    const welcomeKey = `${guildId}-${channelId}`;
    if (!welcomeSent.has(welcomeKey)) {
      welcomeSent.add(welcomeKey);
      const sendable = channel.isSendable();
      if (!sendable) {
        log.warn('Welcome/confirmation messages disabled: the bot lacks "Send Messages" in this voice channel', {
          guildId,
          channelId,
        });
      } else {
        try {
          await channel.send({
            content:
              'Bonjour, je suis Swann, votre assistant IA. Déclenchez-moi en prononçant mon nom suivi de votre demande — par exemple « Swann, mets du Jul » ou « Swann, arrête la musique ».',
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          log.warn('Welcome message failed to send', { guildId, err });
        }
      }
    }
    recordActivity({
      at: Date.now(),
      kind: 'system',
      guildId,
      message: `Joined voice channel ${channel.name}`,
    });
  }

  /** Leave voice for a guild: detach the listener and destroy the connection. */
  async function leaveVoice(guildId: string): Promise<void> {
    if (!joined.has(guildId)) return;
    const channelId = joined.get(guildId);
    try {
      voice.detach(guildId);
      await audio.disconnect(guildId);
    } catch (err) {
      log.warn('leaveVoice failed', { guildId, err });
    }
    joined.delete(guildId);
    // Clean up welcome message tracking for this channel
    if (channelId) {
      welcomeSent.delete(`${guildId}-${channelId}`);
    }
    log.info('Left voice', { guildId });
  }

  // --- voice command pipeline: transcript -> agent -> action ---------------
  voice.events.on('command', (event: VoiceCommandEvent) => {
    void handleVoiceCommand(event).catch((err) =>
      log.error('Voice command handling failed', { err }),
    );
  });
  voice.events.on('error', (err) => log.error('Voice listener error', { err }));

  async function handleVoiceCommand(event: VoiceCommandEvent): Promise<void> {
    // Resolve the speaker's display name from the userId the voice module emits.
    let userName = event.userName;
    try {
      const member = await client.guilds.cache.get(event.guildId)?.members.fetch(event.userId);
      if (member) userName = member.displayName;
    } catch {
      /* fall back to the raw id */
    }
    const agentCtx: AgentContext = {
      guildId: event.guildId,
      voiceChannelId: event.voiceChannelId,
      // Playback is driven by voiceChannelId; the @discordjs/voice backend needs
      // no originating text channel, so an empty value is harmless here.
      textChannelId: '',
      userId: event.userId,
      userName,
    };
    log.info('Voice command', { user: userName, transcript: event.transcript });

    // Acknowledge the wake word with a short chime before the agent round-trip.
    if (wakeSound) {
      try {
        await audio.speak(event.guildId, wakeSound, 'pcm');
      } catch (err) {
        log.debug('Wake chime failed', { err });
      }
    }

    const reply = await agent.run(event.transcript, agentCtx);
    admin.recordAgentRun();
    if (reply.usage) admin.recordTokenUsage(reply.usage);
    if (event.audioBilledSec !== undefined) admin.recordAudioSeconds(event.audioBilledSec);
    recordActivity({
      at: Date.now(),
      kind: 'voice',
      guildId: event.guildId,
      message: `${userName}: "${event.transcript}" -> ${reply.toolsUsed.join(', ') || 'no tools'}`,
    });

    // Acknowledge in the voice channel's built-in text chat so the speaker sees
    // what Swann understood and did (voice commands otherwise have no feedback).
    try {
      const channel =
        client.channels.cache.get(event.voiceChannelId) ??
        (await client.channels.fetch(event.voiceChannelId));
      if (channel?.isSendable()) {
        const body = reply.text?.trim() || (reply.ok ? '✅ Fait.' : "❌ Je n'ai pas pu faire ça.");
        await channel.send({
          content: `🎙️ **${userName}** : « ${event.transcript} »\n${body}`,
          allowedMentions: { parse: [] },
        });
      }
    } catch (err) {
      log.debug('Could not post voice confirmation to the channel', { err });
    }

    // Speak the reply aloud — but NOT when the command started music: the music
    // is the feedback, and ducking it to say "now playing X" is clunky + races
    // the just-started track on the shared player. Speak for stops/errors/info.
    const startedPlayback = reply.toolsUsed.some((t) => PLAYBACK_TOOLS.has(t));
    if (tts.isAvailable() && reply.text?.trim() && !startedPlayback) {
      try {
        const clip = await tts.synthesize(reply.text.trim());
        if (clip) await audio.speak(event.guildId, clip, 'pcm');
      } catch (err) {
        log.debug('TTS reply failed', { err });
      }
    }
  }

  // --- discord event handlers ----------------------------------------------
  const onInteraction = createInteractionHandler({ logger, audio, recordActivity });
  const onMessage = createMessageHandler({
    logger,
    agent,
    wakePhrase: config.behaviour.textWakePhrase,
    recordActivity,
    onAgentReply: (reply) => {
      admin.recordAgentRun();
      if (reply.usage) admin.recordTokenUsage(reply.usage);
    },
  });

  client.on(Events.InteractionCreate, (interaction: Interaction) => {
    void onInteraction(interaction);
  });
  client.on(Events.MessageCreate, (message: Message) => {
    void onMessage(message);
  });

  // Auto-join the first populated voice channel and leave when it empties, so
  // the wake-word listener is active whenever colleagues are in the call.
  client.on(Events.VoiceStateUpdate, (_oldState, newState) => {
    void (async () => {
      const guild = newState.guild;
      const member = newState.member;
      const channel = newState.channel;

      // A human is in a channel and the bot isn't connected here yet -> join.
      if (member && !member.user.bot && channel && !joined.has(guild.id)) {
        await ensureVoice(channel);
      }

      // The bot's current channel has no humans left -> leave.
      const myChannelId = joined.get(guild.id);
      if (myChannelId) {
        const myChannel = guild.channels.cache.get(myChannelId);
        if (myChannel?.isVoiceBased()) {
          const humans = myChannel.members.filter((m) => !m.user.bot).size;
          if (humans === 0) await leaveVoice(guild.id);
        }
      }
    })().catch((err) => log.error('Failed to handle voice state update', { err }));
  });

  // --- ready: start admin, auto-join populated channels --------------------
  client.once(Events.ClientReady, (ready) => {
    void (async () => {
      log.info('Discord client ready', { tag: ready.user.tag, id: ready.user.id });
      recordActivity({ at: Date.now(), kind: 'system', message: `Logged in as ${ready.user.tag}` });
      // Bot may start while colleagues are already in a call (no VoiceStateUpdate
      // fires for them), so scan once at boot.
      for (const guild of client.guilds.cache.values()) {
        const populated = guild.channels.cache.find(
          (c) => c.isVoiceBased() && c.members.some((m) => !m.user.bot),
        );
        if (populated?.isVoiceBased()) {
          await ensureVoice(populated).catch((err) => log.warn('Boot auto-join failed', { err }));
        }
      }
    })();
  });

  // --- start order ---------------------------------------------------------
  await registerCommands();
  await admin.start();
  await client.login(config.discord.token);

  // --- graceful shutdown ---------------------------------------------------
  const shutdown = (signal: string): void => {
    log.info('Shutting down', { signal });
    void (async () => {
      try {
        for (const guildId of [...joined.keys()]) await leaveVoice(guildId);
      } catch (err) {
        log.error('Voice teardown failed', { err });
      }
      try {
        await admin.stop();
      } catch (err) {
        log.error('Admin stop failed', { err });
      }
      try {
        client.destroy();
      } catch (err) {
        log.error('Client destroy failed', { err });
      }
      process.exit(0);
    })();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

startBot().catch((err) => {
  logger.error('Fatal: failed to start Swann', { err });
  process.exit(1);
});
