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
import { createMistralAgent, createTranscriber } from './mistral/index.js';
import { createVoiceListener } from './voice/index.js';
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
    picovoice: config.picovoice,
    transcriber,
  });

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
        picovoiceAccessKey: status.picovoiceAccessKey,
        // Reflect whether the user actually dropped the model files into /data.
        picovoiceKeyword: existsSync(config.picovoice.keywordPath),
        sileroModel: existsSync(config.picovoice.sileroVadPath),
        ytdlpAvailable,
      };
    },
    pushActivity: (entry: ActivityEntry) => recordActivity(entry),
  });
  // The admin server returns the canonical recorder; route all activity to it.
  recordActivity = admin.recordActivity;

  audio.events.on('error', (guildId, error) => {
    log.error('Audio error', { guildId, err: error });
  });

  // --- single shared voice connection per guild ----------------------------
  // joined: guildId -> channelId the bot is currently connected to.
  const joined = new Map<string, string>();

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
    try {
      voice.detach(guildId);
      await audio.disconnect(guildId);
    } catch (err) {
      log.warn('leaveVoice failed', { guildId, err });
    }
    joined.delete(guildId);
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
    const reply = await agent.run(event.transcript, agentCtx);
    recordActivity({
      at: Date.now(),
      kind: 'voice',
      guildId: event.guildId,
      message: `${userName}: "${event.transcript}" -> ${reply.toolsUsed.join(', ') || 'no tools'}`,
    });
  }

  // --- discord event handlers ----------------------------------------------
  const onInteraction = createInteractionHandler({ logger, audio, recordActivity });
  const onMessage = createMessageHandler({
    logger,
    agent,
    wakePhrase: config.behaviour.textWakePhrase,
    recordActivity,
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
