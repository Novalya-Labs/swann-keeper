/**
 * /stop — stop playback and clear the queue (stays connected).
 */

import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AudioService, CommandContext } from '../../types.js';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback and clear the queue');

export async function execute(
  _interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  audio: AudioService,
): Promise<void> {
  await audio.stop(ctx.guildId);
  await ctx.reply('⏹️ Stopped playback and cleared the queue.');
}
