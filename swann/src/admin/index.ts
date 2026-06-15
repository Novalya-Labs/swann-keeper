/**
 * Swann — admin module public surface.
 *
 * The discord module (composition root, src/index.ts) imports
 * `createAdminServer` from here, wires it with the shared logger,
 * config.admin, the AudioService and configStatus, then calls start().
 */

export { createAdminServer } from './server.js';
export type { AdminServer, AdminServerDeps } from './server.js';
export type { AdminStateStore } from './state.js';
