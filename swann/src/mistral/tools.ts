/**
 * Swann — Mistral function-calling tool definitions.
 *
 * These are the JSON-Schema tool specs handed to `client.chat.complete`. They
 * map 1:1 to the ToolName union in src/types.ts. The agent parses each tool
 * call's `arguments` STRING via JSON.parse, validates/normalises it against the
 * matching ToolArgs shape, and forwards it to the injected ToolExecutor.
 *
 * Design notes:
 *  - Every tool description is written so the model can translate French AND
 *    English requests (e.g. "fais-moi une playlist de Jul de 10 sons").
 *  - play_playlist is intentionally high-level: it takes a theme/artist + a
 *    count, and the EXECUTOR (audio glue) is responsible for fan-out. The agent
 *    does NOT issue N search calls itself — that keeps the tool loop short and
 *    deterministic. (See agent.ts for the rationale.)
 */

import type { LoopMode, SearchSource, ToolName } from '../types.js';

/** JSON-Schema "function" tool, in the shape the Mistral SDK expects. */
export interface MistralToolSpec {
  readonly type: 'function';
  readonly function: {
    readonly name: ToolName;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

const SEARCH_SOURCES: SearchSource[] = ['youtube', 'youtubemusic', 'spotify', 'soundcloud'];
const LOOP_MODES: LoopMode[] = ['off', 'track', 'queue'];

/**
 * The full tool catalogue. Frozen so it can be shared safely between agent
 * turns without risk of mutation.
 */
export const TOOL_SPECS: readonly MistralToolSpec[] = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'search_songs',
      description:
        'Search for songs WITHOUT playing them, to show the user candidates. ' +
        'Use only when the user explicitly wants to see/choose results rather ' +
        'than immediately play. To actually play, use play_song or play_playlist.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Song title, artist, or free-text search query.' },
          source: { type: 'string', enum: SEARCH_SOURCES, description: 'Optional explicit source to search.' },
          limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Max number of candidates to return (default 5).' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_song',
      description:
        'Search for and immediately play a single song (or add it to the end of ' +
        'the queue if something is already playing). Use this for requests like ' +
        '"play Bohemian Rhapsody" or "mets-moi du Daft Punk".',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Song title and/or artist, or a direct URL.' },
          source: { type: 'string', enum: SEARCH_SOURCES, description: 'Optional explicit source.' },
          play_next: { type: 'boolean', description: 'If true, add to the front of the queue to play right after the current track.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'play_playlist',
      description:
        'Build and enqueue a multi-song playlist from a theme or artist. Use for ' +
        'requests like "fais-moi une playlist de Jul de 10 sons" (artist="Jul", ' +
        'count=10) or "play some chill lofi" (theme="chill lofi"). The system ' +
        'resolves and enqueues the songs; do not call play_song repeatedly for this.',
      parameters: {
        type: 'object',
        properties: {
          theme: {
            type: 'string',
            description:
              'A description of the playlist to build (genre, mood, occasion, or ' +
              'the artist name if no separate artist is given). Always provide this.',
          },
          artist: { type: 'string', description: 'Specific artist to focus the playlist on, if the user named one.' },
          count: { type: 'integer', minimum: 1, maximum: 50, description: 'How many songs to add (default 10).' },
          source: { type: 'string', enum: SEARCH_SOURCES, description: 'Optional explicit source.' },
        },
        required: ['theme'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skip',
      description: 'Skip the current song. Optionally skip several songs at once.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 100, description: 'Number of songs to skip (default 1).' },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pause',
      description: 'Pause playback.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resume',
      description: 'Resume playback after a pause.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop',
      description: 'Stop playback and clear the queue (stays in the voice channel).',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_volume',
      description: 'Set the playback volume, on a 0 to 100 scale.',
      parameters: {
        type: 'object',
        properties: {
          volume: { type: 'integer', minimum: 0, maximum: 100, description: 'Target volume from 0 (mute) to 100 (max).' },
        },
        required: ['volume'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_loop',
      description: 'Set the loop mode: off (no loop), track (repeat the current song), or queue (repeat the whole queue).',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: LOOP_MODES, description: 'The loop mode to apply.' },
        },
        required: ['mode'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_queue',
      description: 'Get the current queue, now-playing track, volume and loop status, to answer the user about what is playing or what is next.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_queue',
      description: 'Clear the pending queue but keep the current song playing.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
]);

/** The set of valid tool names, for fast validation of model output. */
export const VALID_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_SPECS.map((t) => t.function.name));

/** Type guard: is this string a ToolName we defined? */
export function isToolName(name: string): name is ToolName {
  return VALID_TOOL_NAMES.has(name);
}
