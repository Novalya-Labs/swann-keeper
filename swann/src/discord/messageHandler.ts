/**
 * Swann — text triggers.
 *
 * Watches guild messages and routes a human's free text to the Mistral agent
 * when EITHER:
 *   - the message starts with the configured wake phrase (e.g. "Hey Swann"), or
 *   - the message @-mentions the bot directly (e.g. "@Swann comment ça va ?").
 *
 * In both cases the trigger (wake phrase / mention) is stripped and the
 * remaining text is sent to the agent, whose reply is relayed back.
 *
 * Requires the GuildMessages + MessageContent intents (set in client.ts).
 */

import type { Message } from 'discord.js';
import type { ActivityEntry, AgentReply, MistralAgent } from '../types.js';
import type { Logger } from '../logger.js';
import { buildAgentContext, buildCommandContextFromMessage } from './context.js';

export interface MessageHandlerDeps {
  readonly logger: Logger;
  readonly agent: MistralAgent;
  readonly wakePhrase: string;
  readonly recordActivity: (entry: ActivityEntry) => void;
  /** Optional usage hook called once per agent run (for the cost counter). */
  readonly onAgentReply?: (reply: AgentReply) => void;
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

/**
 * Returns the utterance after stripping a direct @-mention of the bot if the
 * message mentions it, otherwise null. All occurrences of the bot mention
 * (with or without the nickname `!`) are removed, and a leading separator is
 * trimmed so "@Swann, joue du Jul" yields "joue du Jul".
 */
export function matchMention(message: Message): string | null {
  const botId = message.client.user?.id;
  if (!botId) return null;
  // Only react to explicit user mentions of the bot (not @everyone/@here or roles).
  if (!message.mentions.users.has(botId)) return null;

  const stripped = message.content
    .replace(new RegExp(`<@!?${botId}>`, 'g'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\s*[,:]?\s*/, '')
    .trim();
  return stripped;
}

export function createMessageHandler(
  deps: MessageHandlerDeps,
): (message: Message) => Promise<void> {
  const log = deps.logger.child('messages');

  return async function handle(message: Message): Promise<void> {
    // Ignore bots/webhooks/system messages and DMs.
    if (message.author.bot || message.system) return;
    if (!message.inGuild()) return;

    // Trigger on either the wake phrase or a direct @-mention of the bot.
    const utterance = matchWakePhrase(message.content, deps.wakePhrase) ?? matchMention(message);
    if (utterance === null) return;

    if (utterance.length === 0) {
      await message.reply({
        content: 'Oui ? Je t\'écoute. / Yes? I\'m listening.',
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    const ctx = buildCommandContextFromMessage(message);
    const agentCtx = buildAgentContext(ctx);

    try {
      if (message.channel.isSendable()) await message.channel.sendTyping();
      const reply = await deps.agent.run(utterance, agentCtx);
      deps.onAgentReply?.(reply);
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
