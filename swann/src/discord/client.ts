/**
 * Swann — Discord client bootstrap.
 *
 * Constructs the discord.js v14 Client with the intents the bot needs:
 *   - Guilds:           slash commands, guild/channel lookups
 *   - GuildVoiceStates: REQUIRED to track who is in voice + to join/receive
 *   - GuildMessages + MessageContent: the "Hey Swann" text trigger reads
 *     message text (both privileged for content; MessageContent must be
 *     enabled in the Developer Portal).
 *
 * Also provides the voice-join helper that the composition root uses to join a
 * member's channel (selfDeaf:false so the voice module can RECEIVE audio) and
 * hand the connection to the VoiceListener.
 */

import { Client, IntentsBitField, Partials } from 'discord.js';

// discord.js's typings import `GatewayIntentBits` from discord-api-types but do
// not re-export it as a value (TS2459), so we use `IntentsBitField.Flags` — a
// value-exported class static typed as `typeof GatewayIntentBits` — instead.
const Intents = IntentsBitField.Flags;
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  type VoiceConnection,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import type { Logger } from '../logger.js';

export function createClient(): Client {
  return new Client({
    intents: [
      Intents.Guilds,
      Intents.GuildVoiceStates,
      Intents.GuildMessages,
      Intents.MessageContent,
    ],
    // Partials let us react to messages in uncached channels for the trigger.
    partials: [Partials.Channel],
  });
}

/**
 * Join a voice channel with selfDeaf:false (so we can receive audio) and wait
 * until the connection is Ready. Returns the live VoiceConnection.
 */
export async function joinVoice(
  channel: VoiceBasedChannel,
  logger: Logger,
): Promise<VoiceConnection> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    logger.child('voice').info('Voice connection ready', {
      guildId: channel.guild.id,
      channelId: channel.id,
    });
    return connection;
  } catch (err) {
    connection.destroy();
    throw err instanceof Error ? err : new Error('Failed to join voice channel');
  }
}
