/**
 * Swann — Mistral SDK client factory.
 *
 * Single place that constructs the `@mistralai/mistralai` client so the rest
 * of the mistral module never touches the SDK constructor directly. The SDK is
 * ESM-only (v2) and pure JS (no native bindings), so it imports cleanly under
 * NodeNext.
 *
 * SECURITY: this project pins @mistralai/mistralai to 2.2.1 in package.json.
 * Version 2.2.4 is a confirmed compromised supply-chain release and must never
 * be installed. Do not bump this dependency without verifying the advisory.
 */

import { Mistral } from '@mistralai/mistralai';

/** Construct a Mistral client bound to the given API key. */
export function createMistralClient(apiKey: string): Mistral {
  return new Mistral({ apiKey });
}

export type MistralClient = Mistral;
