/**
 * Swann — context builders for the discord module.
 *
 * Both slash commands and the "Hey Swann" text trigger funnel into the same
 * handler logic. To make that possible we normalise a discord.js interaction
 * or message into the shared {@link CommandContext}, and we build the
 * {@link AgentContext} the Mistral agent needs (so the agent never touches
 * discord.js).
 */

import type {
  ChatInputCommandInteraction,
  GuildMember,
  Message,
} from 'discord.js';
import type { AgentContext, CommandContext } from '../types.js';

/** Resolve the voice channel id of a guild member, or null. */
function voiceChannelIdOf(member: GuildMember | null): string | null {
  return member?.voice.channelId ?? null;
}

/**
 * Build a {@link CommandContext} from a slash-command interaction.
 *
 * The reply/followUp helpers transparently handle Discord's defer/edit dance:
 * the interaction handler defers up front, so `reply` here edits that deferred
 * reply and `followUp` posts an additional message.
 */
export function buildCommandContextFromInteraction(
  interaction: ChatInputCommandInteraction,
): CommandContext {
  const member =
    interaction.member && 'voice' in interaction.member
      ? (interaction.member as GuildMember)
      : null;

  return {
    guildId: interaction.guildId ?? '',
    userId: interaction.user.id,
    userName: interaction.user.displayName ?? interaction.user.username,
    textChannelId: interaction.channelId,
    voiceChannelId: voiceChannelIdOf(member),
    async reply(content: string): Promise<void> {
      // The interaction handler always defers before dispatching, so the
      // initial response is editable here.
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content });
      } else {
        await interaction.reply({ content });
      }
    },
    async followUp(content: string): Promise<void> {
      await interaction.followUp({ content });
    },
  };
}

/**
 * Build a {@link CommandContext} from a text message (the "Hey Swann" trigger).
 */
export function buildCommandContextFromMessage(message: Message): CommandContext {
  const member = message.member ?? null;
  return {
    guildId: message.guildId ?? '',
    userId: message.author.id,
    userName: message.member?.displayName ?? message.author.username,
    textChannelId: message.channelId,
    voiceChannelId: voiceChannelIdOf(member),
    async reply(content: string): Promise<void> {
      await message.reply({ content, allowedMentions: { repliedUser: false } });
    },
    async followUp(content: string): Promise<void> {
      if (message.channel.isSendable()) {
        await message.channel.send({ content });
      }
    },
  };
}

/** Derive an {@link AgentContext} from a resolved {@link CommandContext}. */
export function buildAgentContext(ctx: CommandContext): AgentContext {
  return {
    guildId: ctx.guildId,
    voiceChannelId: ctx.voiceChannelId,
    textChannelId: ctx.textChannelId,
    userId: ctx.userId,
    userName: ctx.userName,
  };
}
