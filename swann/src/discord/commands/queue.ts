/**
 * /queue — show the now-playing track and the upcoming queue.
 */

import { SlashCommandBuilder } from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import type { AudioService, CommandContext, QueueItem } from '../../types.js';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue');

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'live';
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

const MAX_LISTED = 15;

export async function execute(
  _interaction: ChatInputCommandInteraction,
  ctx: CommandContext,
  audio: AudioService,
): Promise<void> {
  const snapshot = audio.getSnapshot(ctx.guildId);
  if (!snapshot || (!snapshot.current && snapshot.queue.length === 0)) {
    await ctx.reply('The queue is empty and nothing is playing.');
    return;
  }

  const lines: string[] = [];
  if (snapshot.current) {
    const c = snapshot.current.track;
    lines.push(`▶️ **Now playing:** ${c.title} — ${c.author} (${fmtDuration(c.durationMs)})`);
  }

  if (snapshot.queue.length > 0) {
    lines.push('', '**Up next:**');
    snapshot.queue.slice(0, MAX_LISTED).forEach((item: QueueItem, i: number) => {
      lines.push(`${i + 1}. ${item.track.title} — ${item.track.author} (${fmtDuration(item.track.durationMs)})`);
    });
    const remaining = snapshot.queue.length - MAX_LISTED;
    if (remaining > 0) lines.push(`…and ${remaining} more`);
  }

  const flags: string[] = [];
  if (snapshot.loop !== 'off') flags.push(`loop: ${snapshot.loop}`);
  flags.push(`volume: ${snapshot.volume}%`);
  if (snapshot.paused) flags.push('paused');
  lines.push('', `_${flags.join(' · ')}_`);

  await ctx.reply(lines.join('\n'));
}
