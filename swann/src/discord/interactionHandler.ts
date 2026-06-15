/**
 * Swann — slash-command interaction dispatch.
 *
 * Defers each interaction up front (search/connect can exceed Discord's 3s
 * window), normalises it into a {@link CommandContext}, then dispatches to the
 * matching command. Errors are caught and surfaced to the user without leaking
 * internals.
 */

import type { Interaction } from 'discord.js';
import { MessageFlags } from 'discord.js';
import type { AudioService, ActivityEntry } from '../types.js';
import type { Logger } from '../logger.js';
import { commands } from './commands/index.js';
import { buildCommandContextFromInteraction } from './context.js';

export interface InteractionHandlerDeps {
  readonly logger: Logger;
  readonly audio: AudioService;
  readonly recordActivity: (entry: ActivityEntry) => void;
}

export function createInteractionHandler(
  deps: InteractionHandlerDeps,
): (interaction: Interaction) => Promise<void> {
  const log = deps.logger.child('interactions');

  return async function handle(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) {
      log.warn('Unknown command', { name: interaction.commandName });
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: 'Unknown command.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Swann commands only work inside a server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await interaction.deferReply();
      const ctx = buildCommandContextFromInteraction(interaction);
      await command.execute(interaction, ctx, deps.audio);
      deps.recordActivity({
        at: Date.now(),
        kind: 'command',
        guildId: interaction.guildId ?? undefined,
        message: `/${interaction.commandName} by ${interaction.user.username}`,
      });
    } catch (err) {
      log.error('Command failed', { name: interaction.commandName, err });
      const content = 'Something went wrong handling that command.';
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content });
        } else {
          await interaction.reply({ content, flags: MessageFlags.Ephemeral });
        }
      } catch (replyErr) {
        log.error('Failed to report command error', { err: replyErr });
      }
    }
  };
}
