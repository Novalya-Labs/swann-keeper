/**
 * /play — search a query and enqueue/play it in the caller's voice channel.
 */

import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AudioService, CommandContext, SearchSource } from '../../types.js';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song or add it to the queue')
  .addStringOption((o) =>
    o.setName('query').setDescription('Song name, URL, or search terms').setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName('source')
      .setDescription('Where to search')
      .setRequired(false)
      .addChoices(
        { name: 'YouTube', value: 'youtube' },
        { name: 'YouTube Music', value: 'youtubemusic' },
        { name: 'Spotify', value: 'spotify' },
        { name: 'SoundCloud', value: 'soundcloud' },
      ),
  );

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'live';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  audio: AudioService,
): Promise<void> {
  if (!ctx.voiceChannelId) {
    await ctx.reply('You need to be in a voice channel first.');
    return;
  }

  const query = interaction.options.getString('query', true);
  const source = (interaction.options.getString('source') as SearchSource | null) ?? undefined;

  const outcome = await audio.play({
    guildId: ctx.guildId,
    voiceChannelId: ctx.voiceChannelId,
    textChannelId: ctx.textChannelId,
    query,
    source,
    requestedBy: ctx.userId,
    requestedByName: ctx.userName,
  });

  switch (outcome.kind) {
    case 'now_playing':
      await ctx.reply(
        `▶️ Now playing **${outcome.track?.title}** by ${outcome.track?.author} (${fmtDuration(outcome.track?.durationMs ?? 0)})`,
      );
      break;
    case 'queued':
      await ctx.reply(
        `➕ Queued **${outcome.track?.title}** by ${outcome.track?.author} (${fmtDuration(outcome.track?.durationMs ?? 0)})`,
      );
      break;
    case 'queued_playlist':
      await ctx.reply(
        `➕ Queued **${outcome.addedCount ?? 0}** tracks from *${outcome.playlistName ?? 'playlist'}*`,
      );
      break;
    case 'empty':
      await ctx.reply(`No results found for "${query}".`);
      break;
    case 'error':
    default:
      await ctx.reply(`Couldn't play that: ${outcome.error ?? 'unknown error'}`);
      break;
  }
}
