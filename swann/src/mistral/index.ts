/**
 * Swann — mistral module public surface.
 *
 * The discord module (composition root) imports the factories from here and
 * never reaches into the individual files. All exported types live in
 * src/types.ts; this barrel only re-exports the factories + their dep shapes.
 */

export { createMistralAgent, type CreateMistralAgentDeps } from './agent.js';
export { createTranscriber, type CreateTranscriberDeps } from './transcriber.js';
export { TOOL_SPECS, isToolName, type MistralToolSpec } from './tools.js';
export { createMistralClient, type MistralClient } from './client.js';
