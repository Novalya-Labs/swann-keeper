/**
 * Swann — Ingress-aware admin web server (Fastify).
 *
 * Serves a minimal single-page admin UI for the bot:
 *   - live queue / now-playing per guild (polls /api/state)
 *   - recent command/voice/agent activity feed
 *   - credential-status panel (configured / missing — never the secret values)
 *   - basic controls (skip / stop / pause / resume / volume) -> AudioService
 *
 * Home Assistant Ingress integration:
 *   - binds config.admin.bindAddress : config.admin.ingressPort (default 8099),
 *     which must equal the add-on's ingress_port
 *   - when config.admin.ingressOnly is true, rejects any request not coming
 *     from the HA Ingress gateway (172.30.32.2) — HA performs user auth, we only
 *     verify the request actually traversed the Ingress proxy
 *   - honours the dynamic X-Ingress-Path header by emitting a templated
 *     <base href> so every relative asset/API URL resolves under the prefix
 *
 * No custom authentication is implemented (HA Ingress owns that).
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { ActivityEntry, AudioService, ConfigStatus } from '../types.js';
import type { AdminConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createAdminStateStore, type AdminStateStore } from './state.js';
import { registerRoutes } from './routes.js';
import { isRequestAllowed, remoteIp } from './ingress.js';

export interface AdminServerDeps {
  readonly logger: Logger;
  readonly admin: AdminConfig;
  readonly audio: AudioService;
  readonly configStatus: () => ConfigStatus;
  /**
   * Optional sink the rest of the app can call to push activity entries. The
   * returned server also exposes `recordActivity`; this dep lets index.ts share
   * a single push function across modules if it prefers.
   */
  readonly pushActivity?: (e: ActivityEntry) => void;
}

/**
 * Resolve the directory that holds index.html / app.js / style.css. At runtime
 * the compiled server lives in dist/admin/, while the static assets live in
 * src/admin/public/. The Dockerfile copies the public assets next to the
 * compiled output (dist/admin/public). We probe the likely locations so it
 * works in dev (ts-node from src) and in production (compiled dist).
 */
function resolvePublicDir(logger: Logger): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'public'), // dist/admin/public or src/admin/public (dev)
    join(here, '..', '..', 'src', 'admin', 'public'), // dist/admin -> repo src (dev/build fallback)
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  logger.warn('Admin public assets not found; falling back to module-relative public dir', {
    tried: candidates,
  });
  return candidates[0]!;
}

/**
 * Public handle returned by createAdminServer. Matches the manifest contract:
 * `{ start(): Promise<void>; stop(): Promise<void>; recordActivity(e): void }`.
 */
export interface AdminServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Append an activity entry to the live feed (for discord/voice modules). */
  recordActivity(e: ActivityEntry): void;
}

export function createAdminServer(deps: AdminServerDeps): AdminServer {
  const { logger: rootLogger, admin, audio, configStatus, pushActivity } = deps;
  const logger = rootLogger.child('admin');

  const store: AdminStateStore = createAdminStateStore({ logger, audio, configStatus });
  const publicDir = resolvePublicDir(logger);

  let app: FastifyInstance | null = null;

  function recordActivity(e: ActivityEntry): void {
    store.recordActivity(e);
    pushActivity?.(e);
  }

  async function start(): Promise<void> {
    if (app) return;

    const instance = Fastify({
      logger: false,
      // HA Ingress is the only proxy in front of us; trust it so req.ip is
      // meaningful, but the source-IP gate below relies on the socket address.
      trustProxy: admin.ingressOnly,
      bodyLimit: 256 * 1024,
    });

    // Source-IP gate: reject anything not from the HA Ingress gateway when
    // ingressOnly is on. Runs before routing so no handler ever sees it.
    instance.addHook('onRequest', async (req, reply) => {
      if (!isRequestAllowed(req, admin.ingressOnly)) {
        logger.warn('Rejected non-ingress request', { ip: remoteIp(req), url: req.url });
        await reply.code(403).send({ ok: false, error: 'Forbidden: ingress-only' });
      }
    });

    // Serve static assets (app.js, style.css, etc.). The SPA shell at "/" is
    // handled by our own route so we can inject the dynamic <base href>; tell
    // the static plugin not to auto-serve index.html.
    await instance.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      index: false,
      cacheControl: true,
      maxAge: '1h',
    });

    registerRoutes(instance, { logger, audio, store, publicDir });

    instance.setErrorHandler((err, _req, reply) => {
      logger.error('Admin request failed', err);
      if (!reply.sent) reply.code(500).send({ ok: false, error: 'Internal error' });
    });

    try {
      const address = await instance.listen({ host: admin.bindAddress, port: admin.ingressPort });
      app = instance;
      logger.info('Admin server listening', {
        address,
        ingressOnly: admin.ingressOnly,
        publicDir,
      });
      recordActivity({ at: Date.now(), kind: 'system', message: 'Admin server started' });
    } catch (err) {
      logger.error('Failed to start admin server', err);
      await instance.close().catch(() => undefined);
      throw err;
    }
  }

  async function stop(): Promise<void> {
    store.dispose();
    if (app) {
      const instance = app;
      app = null;
      await instance.close();
      logger.info('Admin server stopped');
    }
  }

  return { start, stop, recordActivity };
}
