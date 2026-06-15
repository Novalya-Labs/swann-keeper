/**
 * /skip — skip the current track (or several).
 */

import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AudioService, CommandContext } from '../../types.js';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current track')
  .addIntegerOption((o) =>
    o
      .setName('count')
      .setDescription('How many tracks to skip')
      .setRequired(false)
      .setMinValue(1),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  audio: AudioService,
): Promise<void> {
  const count = interaction.options.getInteger('count') ?? 1;
  const next = await audio.skip(ctx.guildId, count);
  if (next) {
    await ctx.reply(`⏭️ Skipped. Now playing **${next.track.title}** by ${next.track.author}.`);
  } else {
    await ctx.reply('⏭️ Skipped. The queue is now empty.');
  }
}
