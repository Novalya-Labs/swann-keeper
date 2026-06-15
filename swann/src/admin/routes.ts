/**
 * Swann — admin HTTP routes.
 *
 * Registers:
 *   GET  /                      -> the SPA shell (templated with <base href> from
 *                                  the X-Ingress-Path header so all relative
 *                                  asset/API URLs resolve under the Ingress prefix)
 *   GET  /api/state             -> AdminState (config presence, players, activity)
 *   POST /api/guilds/:id/skip   -> skip the current track
 *   POST /api/guilds/:id/stop   -> stop + clear queue
 *   POST /api/guilds/:id/pause  -> pause playback
 *   POST /api/guilds/:id/resume -> resume playback
 *   POST /api/guilds/:id/volume -> set volume (body: { volume: number })
 *
 * Static assets (app.js, style.css) are served by @fastify/static registered in
 * server.ts under the root prefix. The SPA uses RELATIVE URLs only, so the
 * injected <base href> makes them work both directly (dev) and behind Ingress.
 *
 * No auth here by design — Home Assistant Ingress authenticates the user; the
 * source-IP gate lives in server.ts.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AudioService } from '../types.js';
import type { Logger } from '../logger.js';
import type { AdminStateStore } from './state.js';
import { ingressBasePath } from './ingress.js';

export interface RouteDeps {
  readonly logger: Logger;
  readonly audio: AudioService;
  readonly store: AdminStateStore;
  /** Absolute path to the directory containing index.html / app.js / style.css. */
  readonly publicDir: string;
}

interface GuildParams {
  id: string;
}

interface VolumeBody {
  volume?: number;
}

/** Read + cache the SPA shell once; we re-template only the <base href> per request. */
function loadShell(publicDir: string): string {
  return readFileSync(join(publicDir, 'index.html'), 'utf8');
}

/**
 * Inject (or rewrite) a <base href> into the shell so every relative URL the
 * frontend uses resolves under the dynamic Ingress prefix. A trailing slash is
 * required on <base href> for relative resolution to work as expected.
 */
function templateShell(shell: string, basePath: string): string {
  const href = `${basePath}/`;
  const baseTag = `<base href="${href.replace(/"/g, '&quot;')}">`;
  if (shell.includes('<!--BASE_HREF-->')) {
    return shell.replace('<!--BASE_HREF-->', baseTag);
  }
  // Fallback: insert right after <head> if the placeholder is missing.
  return shell.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n    ${baseTag}`);
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { logger, audio, store, publicDir } = deps;

  let shell: string;
  try {
    shell = loadShell(publicDir);
  } catch (err) {
    logger.error('Failed to load admin index.html shell', err);
    shell = '<!doctype html><html><head><!--BASE_HREF--></head><body><h1>Swann admin UI assets missing</h1></body></html>';
  }

  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    const base = ingressBasePath(req);
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .send(templateShell(shell, base));
  });

  app.get('/api/state', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store').send(store.snapshot());
  });

  const skip = async (req: FastifyRequest<{ Params: GuildParams }>, reply: FastifyReply) => {
    const now = await audio.skip(req.params.id);
    store.recordActivity({
      at: Date.now(),
      kind: 'command',
      guildId: req.params.id,
      message: now ? `Admin skipped -> ${now.track.title}` : 'Admin skipped (queue empty)',
    });
    reply.send({ ok: true, nowPlaying: now });
  };

  const stop = async (req: FastifyRequest<{ Params: GuildParams }>, reply: FastifyReply) => {
    await audio.stop(req.params.id);
    store.recordActivity({ at: Date.now(), kind: 'command', guildId: req.params.id, message: 'Admin stopped playback' });
    reply.send({ ok: true });
  };

  const pause = async (req: FastifyRequest<{ Params: GuildParams }>, reply: FastifyReply) => {
    await audio.pause(req.params.id);
    store.recordActivity({ at: Date.now(), kind: 'command', guildId: req.params.id, message: 'Admin paused playback' });
    reply.send({ ok: true });
  };

  const resume = async (req: FastifyRequest<{ Params: GuildParams }>, reply: FastifyReply) => {
    await audio.resume(req.params.id);
    store.recordActivity({ at: Date.now(), kind: 'command', guildId: req.params.id, message: 'Admin resumed playback' });
    reply.send({ ok: true });
  };

  const volume = async (
    req: FastifyRequest<{ Params: GuildParams; Body: VolumeBody }>,
    reply: FastifyReply,
  ) => {
    const raw = req.body?.volume;
    const vol = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(vol) || vol < 0 || vol > 100) {
      reply.code(400).send({ ok: false, error: 'volume must be a number between 0 and 100' });
      return;
    }
    await audio.setVolume(req.params.id, Math.round(vol));
    store.recordActivity({
      at: Date.now(),
      kind: 'command',
      guildId: req.params.id,
      message: `Admin set volume to ${Math.round(vol)}`,
    });
    reply.send({ ok: true, volume: Math.round(vol) });
  };

  app.post('/api/guilds/:id/skip', skip);
  app.post('/api/guilds/:id/stop', stop);
  app.post('/api/guilds/:id/pause', pause);
  app.post('/api/guilds/:id/resume', resume);
  app.post('/api/guilds/:id/volume', volume);
}
