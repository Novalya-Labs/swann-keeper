/**
 * Swann — "Hey Swann" text trigger.
 *
 * Watches guild messages; when a human's message starts with the configured
 * wake phrase (e.g. "Hey Swann"), strips the phrase and routes the remaining
 * free text to the Mistral agent, then relays the agent's reply.
 *
 * Requires the GuildMessages + MessageContent intents (set in client.ts).
 */

import type { Message } from 'discord.js';
import type { ActivityEntry, MistralAgent } from '../types.js';
import type { Logger } from '../logger.js';
import { buildAgentContext, buildCommandContextFromMessage } from './context.js';

export interface MessageHandlerDeps {
  readonly logger: Logger;
  readonly agent: MistralAgent;
  readonly wakePhrase: string;
  readonly recordActivity: (entry: ActivityEntry) => void;
}

/**
 * Returns the utterance after the wake phrase if the message triggers Swann,
 * otherwise null. Matching is case-insensitive and tolerates an optional
 * trailing comma/colon after the phrase.
 */
export function matchWakePhrase(content: string, wakePhrase: string): string | null {
  const trimmed = content.trim();
  const phrase = wakePhrase.trim().toLowerCase();
  if (phrase.length === 0) return null;
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith(phrase)) return null;

  let rest = trimmed.slice(wakePhrase.trim().length);
  // Drop a leading separator (comma/colon) and surrounding whitespace.
  rest = rest.replace(/^\s*[,:]?\s*/, '').trim();
  return rest;
}

export function createMessageHandler(
  deps: MessageHandlerDeps,
): (message: Message) => Promise<void> {
  const log = deps.logger.child('messages');

  return async function handle(message: Message): Promise<void> {
    // Ignore bots/webhooks/system messages and DMs.
    if (message.author.bot || message.system) return;
    if (!message.inGuild()) return;

    const utterance = matchWakePhrase(message.content, deps.wakePhrase);
    if (utterance === null) return;

    if (utterance.length === 0) {
      await message.reply({
        content: 'Yes? Tell me what to play.',
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const ctx = buildCommandContextFromMessage(message);
    const agentCtx = buildAgentContext(ctx);

    try {
      if (message.channel.isSendable()) await message.channel.sendTyping();
      const reply = await deps.agent.run(utterance, agentCtx);
      await ctx.reply(reply.text || (reply.ok ? 'Done.' : 'Sorry, I could not do that.'));
      deps.recordActivity({
        at: Date.now(),
        kind: 'agent',
        guildId: message.guildId ?? undefined,
        message: `"${utterance}" -> [${reply.toolsUsed.join(', ') || 'no tools'}]`,
      });
    } catch (err) {
      log.error('Agent run failed', { err });
      await ctx.reply('Sorry, something went wrong while handling that.');
    }
  };
}
