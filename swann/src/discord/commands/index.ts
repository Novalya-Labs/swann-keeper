/**
 * Swann — slash command registry.
 *
 * Single source of truth for the command set, shared by the interaction
 * handler (dispatch) and the register script (REST registration).
 */

import type {
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import type { AudioService, CommandContext } from '../../types.js';

import * as play from './play.js';
import * as skip from './skip.js';
import * as queue from './queue.js';
import * as stop from './stop.js';

export interface SlashCommand {
  readonly data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute(
    interaction: ChatInputCommandInteraction,
    ctx: CommandContext,
    audio: AudioService,
  ): Promise<void>;
}

/** Every command Swann exposes, keyed by name for O(1) dispatch. */
export const commands: ReadonlyMap<string, SlashCommand> = new Map<string, SlashCommand>([
  [play.data.name, play],
  [skip.data.name, skip],
  [queue.data.name, queue],
  [stop.data.name, stop],
]);

/** Command definitions serialised for REST registration. */
export function commandJSON(): unknown[] {
  return [...commands.values()].map((c) => c.data.toJSON());
}
