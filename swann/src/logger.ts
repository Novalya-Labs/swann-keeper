/**
 * Swann — tiny structured logger with secret redaction.
 *
 * - Levels: trace < debug < info < warning < error (matches the HA add-on
 *   log_level option / Picovoice/bashio conventions).
 * - JSON-ish single-line output so it reads cleanly in `ha addon logs`.
 * - Redacts any registered secret substring and common key=value secret
 *   patterns so tokens never reach stdout, even via interpolated objects.
 *
 * Usage:
 *   import { logger, registerSecret } from './logger.js';
 *   registerSecret(token);            // call once at config load
 *   logger.info('Bot ready', { tag }); // values are redacted automatically
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warning' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warning: 40,
  error: 50,
};

/** Keys whose values are always masked regardless of registration. */
const SENSITIVE_KEY_RE =
  /(token|password|secret|api[_-]?key|access[_-]?key|authorization|bearer)/i;

const MASK = '***redacted***';

/** Live set of exact secret values to scrub from any rendered string. */
const secrets = new Set<string>();

let currentLevel: LogLevel = 'info';

/** Register a secret value so it is redacted from all subsequent log output. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.trim().length >= 4) secrets.add(value);
}

/** Set the active minimum log level. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function redactString(input: string): string {
  let out = input;
  for (const s of secrets) {
    // Escape regex-special chars in the secret before global replace.
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(escaped, 'g'), MASK);
  }
  return out;
}

/** Deep-redact an arbitrary value for safe logging. */
function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => redactValue(v, seen));

  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), stack: value.stack ? redactString(value.stack) : undefined };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? MASK : redactValue(v, seen);
  }
  return out;
}

function emit(level: LogLevel, msg: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const ts = new Date().toISOString();
  const safeMsg = redactString(msg);
  let line = `[${ts}] [${level.toUpperCase()}] ${safeMsg}`;
  if (meta !== undefined) {
    try {
      line += ` ${JSON.stringify(redactValue(meta))}`;
    } catch {
      line += ' [unserializable meta]';
    }
  }
  const stream = level === 'error' || level === 'warning' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export interface Logger {
  trace(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  /** Create a child logger that prefixes a scope tag to every message. */
  child(scope: string): Logger;
}

function makeLogger(scope?: string): Logger {
  const prefix = scope ? `(${scope}) ` : '';
  return {
    trace: (m, meta) => emit('trace', prefix + m, meta),
    debug: (m, meta) => emit('debug', prefix + m, meta),
    info: (m, meta) => emit('info', prefix + m, meta),
    warn: (m, meta) => emit('warning', prefix + m, meta),
    error: (m, meta) => emit('error', prefix + m, meta),
    child: (childScope) => makeLogger(scope ? `${scope}:${childScope}` : childScope),
  };
}

export const logger: Logger = makeLogger();
