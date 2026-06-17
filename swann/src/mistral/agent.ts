/**
 * Swann — Mistral function-calling agent.
 *
 * Turns a natural-language utterance (text or transcribed voice) into concrete
 * music actions by running the standard Mistral tool-calling loop:
 *
 *   complete -> read message.toolCalls
 *           -> for each: JSON.parse(arguments STRING) -> ToolExecutor(...)
 *           -> push the assistant turn + one tool-role message per call
 *           -> complete again ... repeat until no toolCalls (or a cap)
 *
 * The agent is deliberately decoupled: it NEVER imports the audio or discord
 * modules. All side effects go through the injected ToolExecutor, and the
 * AgentContext (guild/channel/user) is passed through untouched so tools know
 * where to act.
 *
 * Playlist handling: the model emits ONE play_playlist tool call (artist/theme
 * + count). The ToolExecutor (in the discord/audio glue) is responsible for the
 * fan-out — generating N search queries, resolving and enqueuing them. Keeping
 * the fan-out server-side keeps the model loop short, cheap and deterministic,
 * and avoids the model having to manage encoded-track plumbing it can't see.
 */

import type { Logger } from '../logger.js';
import type {
  AgentContext,
  AgentReply,
  MistralAgent,
  ToolArgs,
  ToolExecutor,
  ToolName,
  ToolResult,
} from '../types.js';
import { createMistralClient, type MistralClient } from './client.js';
import { TOOL_SPECS, isToolName } from './tools.js';

/** Safety cap on tool-loop iterations to prevent runaway/looping models. */
const MAX_TURNS = 6;

/** Cap on the final reply length we surface to chat. */
const MAX_REPLY_CHARS = 1800;

const SYSTEM_PROMPT = [
  'You are Swann, a friendly Discord companion and music assistant.',
  'People talk to you by mentioning you or saying your wake phrase. Besides',
  'controlling music, you happily chat and answer general questions in a',
  'casual, friendly way — if a message is just conversation, simply reply',
  'without calling any tool.',
  'You control music playback ONLY through the provided tools — never claim to',
  'have done something you did not do via a tool call.',
  'Understand requests in both French and English and reply in the SAME language',
  'the user used. Keep replies short, natural and chat-friendly (one or two',
  'sentences, no markdown headings).',
  'When the user asks for a playlist by artist or theme (e.g. "fais-moi une',
  'playlist de Jul de 10 sons"), call play_playlist ONCE with the artist/theme',
  'and the requested count — do not call play_song many times.',
  'For a single song, call play_song. Only call search_songs when the user',
  'explicitly wants to browse/choose results rather than play immediately.',
  'After tools run, briefly tell the user what happened (what is now playing,',
  'how many tracks were queued, etc.). If a tool reports an error, apologise',
  'briefly and explain what went wrong in plain language.',
].join(' ');

export interface CreateMistralAgentDeps {
  readonly logger: Logger;
  readonly apiKey: string;
  readonly model: string;
  readonly executor: ToolExecutor;
  /**
   * Optional pre-built client (for tests). If omitted, one is created from
   * apiKey.
   */
  readonly client?: MistralClient;
}

/**
 * Minimal structural shapes for the bits of the Mistral SDK response we read.
 * We avoid importing the SDK's component types directly so a minor SDK shape
 * change doesn't break compilation; the agent validates everything defensively.
 */
interface SdkToolCall {
  id?: string | null;
  function?: { name?: string | null; arguments?: unknown } | null;
}
interface SdkMessage {
  role?: string;
  content?: unknown;
  toolCalls?: SdkToolCall[] | null;
}
interface SdkChoice {
  message?: SdkMessage;
}
interface SdkUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}
interface SdkCompletion {
  choices?: SdkChoice[];
  usage?: SdkUsage;
}

/** Read prompt/completion tokens defensively (camelCase or snake_case). */
function readUsage(c: SdkCompletion): { prompt: number; completion: number } {
  const u = c.usage;
  if (!u) return { prompt: 0, completion: 0 };
  const prompt = u.promptTokens ?? u.prompt_tokens ?? 0;
  const completion = u.completionTokens ?? u.completion_tokens ?? 0;
  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
  };
}

/** A message we feed back into the conversation. Loosely typed for the SDK. */
type ConversationMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | SdkMessage
  | { role: 'tool'; name: string; content: string; toolCallId: string };

/** Extract a plain-text content string from an SDK message (content may be chunks). */
function messageText(message: SdkMessage | undefined): string {
  if (!message) return '';
  const { content } = message;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Newer SDKs may return content chunks: [{ type:'text', text:'...' }, ...]
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text: unknown }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** Safely JSON.parse a tool-call arguments value, which the SDK gives as a STRING. */
function parseToolArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  // Already an object (some SDK versions may pre-parse): accept it.
  if (raw && typeof raw === 'object') return { ok: true, args: raw as Record<string, unknown> };
  if (typeof raw !== 'string') return { ok: true, args: {} };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') return { ok: true, args: parsed as Record<string, unknown> };
    return { ok: false, error: 'arguments did not parse to an object' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + '…';
}

export function createMistralAgent(deps: CreateMistralAgentDeps): MistralAgent {
  const log = deps.logger.child('mistral:agent');
  const client = deps.client ?? createMistralClient(deps.apiKey);

  async function run(utterance: string, ctx: AgentContext): Promise<AgentReply> {
    const text = utterance.trim();
    if (text === '') {
      return { text: '', toolsUsed: [], ok: false };
    }

    const messages: ConversationMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];
    const toolsUsed: ToolName[] = [];
    let promptTokens = 0;
    let completionTokens = 0;
    const usage = (): AgentReply['usage'] => ({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    });

    log.debug('Agent run start', { guildId: ctx.guildId, userId: ctx.userId, utterance: text });

    try {
      for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        const completion = (await client.chat.complete({
          model: deps.model,
          messages: messages as never,
          tools: TOOL_SPECS as never,
          toolChoice: 'auto',
        })) as SdkCompletion;
        const u1 = readUsage(completion);
        promptTokens += u1.prompt;
        completionTokens += u1.completion;

        const message = completion.choices?.[0]?.message;
        const toolCalls = message?.toolCalls ?? [];

        if (!message) {
          log.warn('Mistral returned no message', { turn });
          return { text: '', toolsUsed, ok: false };
        }

        // No more tool calls => this is the final natural-language reply.
        if (toolCalls.length === 0) {
          const reply = messageText(message).trim();
          log.debug('Agent run done', { turn, toolsUsed });
          return { text: truncate(reply, MAX_REPLY_CHARS), toolsUsed, ok: true, usage: usage() };
        }

        // Push the assistant turn verbatim so tool results line up by id.
        messages.push(message);

        // Execute every tool call and append a tool-role result message.
        for (const call of toolCalls) {
          const name = call.function?.name ?? '';
          const toolCallId = call.id ?? '';
          const result = await executeOne(name, call.function?.arguments, ctx, log, deps.executor);
          if (isToolName(name)) toolsUsed.push(name);
          messages.push({
            role: 'tool',
            name,
            content: JSON.stringify(result),
            toolCallId,
          });
        }
      }

      // Loop cap hit: ask once more without tools for a closing summary.
      log.warn('Agent hit MAX_TURNS, requesting final summary', { guildId: ctx.guildId });
      const finalCompletion = (await client.chat.complete({
        model: deps.model,
        messages: messages as never,
        toolChoice: 'none',
      })) as SdkCompletion;
      const u2 = readUsage(finalCompletion);
      promptTokens += u2.prompt;
      completionTokens += u2.completion;
      const finalText = messageText(finalCompletion.choices?.[0]?.message).trim();
      return {
        text: truncate(finalText || 'Done.', MAX_REPLY_CHARS),
        toolsUsed,
        ok: true,
        usage: usage(),
      };
    } catch (err) {
      log.error('Agent run failed', err);
      return {
        text: "Désolé, je n'ai pas pu traiter ta demande. / Sorry, I couldn't process that request.",
        toolsUsed,
        ok: false,
      };
    }
  }

  return { run };
}

/**
 * Execute a single tool call defensively: validate the name, parse the
 * arguments STRING, normalise to the typed ToolArgs shape, then call the
 * injected executor. Any failure is returned as a ToolResult so the model can
 * see the error and recover rather than the whole run crashing.
 */
async function executeOne(
  name: string,
  rawArgs: unknown,
  ctx: AgentContext,
  log: Logger,
  executor: ToolExecutor,
): Promise<ToolResult> {
  if (!isToolName(name)) {
    log.warn('Model requested unknown tool', { name });
    return { ok: false, summary: `Unknown tool "${name}".`, error: 'unknown_tool' };
  }

  const parsed = parseToolArgs(rawArgs);
  if (!parsed.ok) {
    log.warn('Failed to parse tool arguments', { name, error: parsed.error });
    return {
      ok: false,
      summary: `Could not parse arguments for ${name}; please retry with valid JSON.`,
      error: `bad_arguments: ${parsed.error}`,
    };
  }

  const args = normaliseArgs(name, parsed.args);

  try {
    log.debug('Executing tool', { name, args });
    return await executor(name, args, ctx);
  } catch (err) {
    log.error('Tool executor threw', { name, err });
    return {
      ok: false,
      summary: `The ${name} action failed unexpectedly.`,
      error: err instanceof Error ? err.message : 'executor_error',
    };
  }
}

/**
 * Coerce/clamp the loosely-typed parsed arguments into the strict ToolArgs
 * shape for the given tool. The model usually gets this right, but we defend
 * against type drift (e.g. count as a string) so the executor receives clean
 * values.
 */
function normaliseArgs(name: ToolName, raw: Record<string, unknown>): ToolArgs[ToolName] {
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
  const int = (v: unknown): number | undefined => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  };
  const boolean = (v: unknown): boolean | undefined => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') return v.toLowerCase() === 'true';
    return undefined;
  };

  switch (name) {
    case 'search_songs': {
      const out: ToolArgs['search_songs'] = { query: str(raw['query']) ?? '' };
      const source = str(raw['source']);
      if (source) (out as { source?: string }).source = source;
      const limit = int(raw['limit']);
      if (limit !== undefined) (out as { limit?: number }).limit = Math.min(25, Math.max(1, limit));
      return out as ToolArgs[ToolName];
    }
    case 'play_song': {
      const out: ToolArgs['play_song'] = { query: str(raw['query']) ?? '' };
      const source = str(raw['source']);
      if (source) (out as { source?: string }).source = source;
      const playNext = boolean(raw['play_next']);
      if (playNext !== undefined) (out as { play_next?: boolean }).play_next = playNext;
      return out as ToolArgs[ToolName];
    }
    case 'play_playlist': {
      const out: ToolArgs['play_playlist'] = { theme: str(raw['theme']) ?? str(raw['artist']) ?? '' };
      const artist = str(raw['artist']);
      if (artist) (out as { artist?: string }).artist = artist;
      const count = int(raw['count']);
      (out as { count?: number }).count = Math.min(50, Math.max(1, count ?? 10));
      const source = str(raw['source']);
      if (source) (out as { source?: string }).source = source;
      return out as ToolArgs[ToolName];
    }
    case 'skip': {
      const count = int(raw['count']);
      const out: ToolArgs['skip'] = {};
      if (count !== undefined) (out as { count?: number }).count = Math.max(1, count);
      return out as ToolArgs[ToolName];
    }
    case 'set_volume': {
      const out: ToolArgs['set_volume'] = { volume: Math.min(100, Math.max(0, int(raw['volume']) ?? 50)) };
      return out as ToolArgs[ToolName];
    }
    case 'set_loop': {
      const mode = str(raw['mode']);
      const valid = mode === 'off' || mode === 'track' || mode === 'queue' ? mode : 'off';
      const out: ToolArgs['set_loop'] = { mode: valid };
      return out as ToolArgs[ToolName];
    }
    // Zero-argument tools.
    case 'pause':
    case 'resume':
    case 'stop':
    case 'get_queue':
    case 'clear_queue':
    default:
      return {} as ToolArgs[ToolName];
  }
}
