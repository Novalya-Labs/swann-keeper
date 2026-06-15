/**
 * Swann — slash-command registration script (`npm run register`).
 *
 * Registers the command set via the Discord REST API. If config.discord.guildId
 * is set, commands are registered guild-scoped (instant); otherwise globally
 * (can take up to ~1h to propagate).
 */

import { REST, Routes } from 'discord.js';
import { config, assertRequired } from '../config.js';
import { logger } from '../logger.js';
import { commandJSON } from './commands/index.js';

async function main(): Promise<void> {
  assertRequired();
  const log = logger.child('register');

  const body = commandJSON();
  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  if (config.discord.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discord.appId, config.discord.guildId),
      { body },
    );
    log.info('Registered guild-scoped slash commands', {
      guildId: config.discord.guildId,
      count: body.length,
    });
  } else {
    await rest.put(Routes.applicationCommands(config.discord.appId), { body });
    log.info('Registered global slash commands (may take up to ~1h)', {
      count: body.length,
    });
  }
}

main().catch((err) => {
  logger.error('Slash-command registration failed', { err });
  process.exitCode = 1;
});
