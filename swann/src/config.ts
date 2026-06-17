/**
 * Swann — centralized, typed configuration loader.
 *
 * Resolution order (highest priority first):
 *   1. /data/options.json   (Home Assistant Supervisor add-on options)
 *   2. process.env          (.env in dev, or env injected by s6 run scripts)
 *   3. built-in defaults
 *
 * HA add-on option keys are snake_case (see haos config.yaml schema); env
 * vars are SCREAMING_SNAKE. Both are mapped here so the rest of the code only
 * ever reads the strongly-typed `config` object.
 *
 * Secrets are registered with the logger so they can never be printed.
 * Nothing in this module logs a secret value.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { LogLevel } from './logger.js';
import { registerSecret, setLogLevel, logger } from './logger.js';

/** Path the HA Supervisor writes resolved add-on options to. */
const HA_OPTIONS_PATH = '/data/options.json';

export interface DiscordConfig {
  readonly token: string;
  readonly appId: string;
  /** Empty string => register slash commands globally. */
  readonly guildId: string;
}

export interface MistralConfig {
  readonly apiKey: string;
  readonly chatModel: string;
  readonly transcribeModel: string;
  /** Pricing used only for the admin UI's rough cost estimate (USD). */
  readonly chatPromptCostPer1M: number;
  readonly chatCompletionCostPer1M: number;
  readonly transcribeCostPerMinute: number;
}

export interface VoiceConfig {
  /** sherpa-onnx streaming-transducer KWS model files. */
  readonly kwsEncoderPath: string;
  readonly kwsDecoderPath: string;
  readonly kwsJoinerPath: string;
  readonly kwsTokensPath: string;
  /** Tokenized keywords file (the "Swann" line, encoded for the model). */
  readonly kwsKeywordsPath: string;
  /** Detection threshold 0..1 (lower = more sensitive / more false fires). */
  readonly kwsThreshold: number;
  /** Per-keyword score boost (raises recall for a specific keyword). */
  readonly kwsScore: number;
  /**
   * Diagnostic mode: when true, the wake engine also runs a parallel ASR
   * recognizer (same model) and logs frame counts, audio peak level, and the
   * raw transcript of what it hears — so the keyword can be encoded to match
   * the real pronunciation. Off in normal operation (extra CPU).
   */
  readonly kwsDebug: boolean;
  /**
   * Voice wake detection strategy:
   *   'transcribe' — Voxtral transcribes every utterance (multilingual, reliable
   *      for French); fires when the transcript starts with a wake word. Costs
   *      one transcription per utterance.
   *   'kws' — on-device sherpa KeywordSpotter (English model, low latency, free)
   *      but unreliable for non-English pronunciations.
   */
  readonly wakeMode: 'transcribe' | 'kws';
  /** transcribe mode: accepted spoken wake words (normalized lowercase). */
  readonly wakeWords: string[];
  /**
   * Transcription language hint (ISO-639-1, e.g. "fr") passed to Voxtral for the
   * command spoken after the wake word. Empty = let Voxtral auto-detect. A hint
   * markedly improves accuracy for non-English speech.
   */
  readonly language: string;
  /** Silero VAD model path (utterance capture after the wake word). */
  readonly sileroVadPath: string;
  /** Speak agent replies aloud (offline sherpa-onnx TTS). Off by default. */
  readonly ttsEnabled: boolean;
  /** Piper VITS model + tokens + espeak-ng data dir for French TTS. */
  readonly ttsModelPath: string;
  readonly ttsTokensPath: string;
  readonly ttsDataDir: string;
  /** TTS speaking speed (1.0 = normal). */
  readonly ttsRate: number;
  /** Play a short chime when a voice command's wake word is matched. */
  readonly wakeChime: boolean;
  /** Optional custom 16-bit PCM WAV for the chime (empty = built-in tone). */
  readonly wakeChimePath: string;
}

export interface MediaConfig {
  /** Path/name of the yt-dlp binary (on PATH inside the add-on container). */
  readonly ytdlpPath: string;
  /** yt-dlp format selector for audio extraction. */
  readonly ytdlpFormat: string;
  /** Optional cookies.txt path to bypass age/region gates (empty = none). */
  readonly cookiesPath: string;
  /** Max number of results a single search/playlist request may resolve. */
  readonly searchLimitMax: number;
}

export interface AdminConfig {
  readonly ingressPort: number;
  readonly bindAddress: string;
  /** When true, only accept requests from the HA Ingress gateway. */
  readonly ingressOnly: boolean;
}

export interface BehaviourConfig {
  readonly logLevel: LogLevel;
  readonly textWakePhrase: string;
  readonly defaultVolume: number;
}

export interface Config {
  /** True when running inside a Home Assistant add-on container. */
  readonly isHomeAssistant: boolean;
  readonly discord: DiscordConfig;
  readonly mistral: MistralConfig;
  readonly voice: VoiceConfig;
  readonly media: MediaConfig;
  readonly admin: AdminConfig;
  readonly behaviour: BehaviourConfig;
}

/** Raw HA options.json shape (snake_case). All optional / best-effort. */
interface HaOptions {
  discord_token?: string;
  discord_app_id?: string;
  discord_guild_id?: string;
  mistral_api_key?: string;
  mistral_chat_model?: string;
  mistral_transcribe_model?: string;
  mistral_chat_prompt_cost_per_1m?: number;
  mistral_chat_completion_cost_per_1m?: number;
  mistral_transcribe_cost_per_minute?: number;
  kws_encoder_path?: string;
  kws_decoder_path?: string;
  kws_joiner_path?: string;
  kws_tokens_path?: string;
  kws_keywords_path?: string;
  kws_threshold?: number;
  kws_score?: number;
  kws_debug?: boolean;
  wake_mode?: string;
  voice_wake_words?: string;
  voice_language?: string;
  silero_vad_path?: string;
  tts_enabled?: boolean;
  tts_model_path?: string;
  tts_tokens_path?: string;
  tts_data_dir?: string;
  tts_rate?: number;
  wake_chime?: boolean;
  wake_chime_path?: string;
  ytdlp_path?: string;
  ytdlp_format?: string;
  ytdlp_cookies_path?: string;
  search_limit_max?: number;
  ingress_port?: number;
  admin_bind_address?: string;
  admin_ingress_only?: boolean;
  log_level?: string;
  text_wake_phrase?: string;
  default_volume?: number;
}

function loadHaOptions(): HaOptions | null {
  if (!existsSync(HA_OPTIONS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(HA_OPTIONS_PATH, 'utf8')) as HaOptions;
  } catch (err) {
    logger.warn('Failed to parse /data/options.json; falling back to env', err);
    return null;
  }
}

const VALID_LEVELS: ReadonlySet<string> = new Set(['trace', 'debug', 'info', 'warning', 'error']);

function asLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  return value && VALID_LEVELS.has(value) ? (value as LogLevel) : fallback;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return fallback;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Build the immutable config from HA options + env + defaults. */
function build(): Config {
  const ha = loadHaOptions();
  const env = process.env;
  const isHomeAssistant = ha !== null || !!env.SUPERVISOR_TOKEN;

  // Helper: HA option wins, then env, then default.
  const pick = (haVal: unknown, envVal: string | undefined, def = ''): string => {
    if (haVal !== undefined && haVal !== null && `${haVal}` !== '') return `${haVal}`;
    if (envVal !== undefined && envVal !== '') return envVal;
    return def;
  };

  const config: Config = {
    isHomeAssistant,
    discord: {
      token: pick(ha?.discord_token, env.DISCORD_TOKEN),
      appId: pick(ha?.discord_app_id, env.DISCORD_APP_ID),
      guildId: pick(ha?.discord_guild_id, env.DISCORD_GUILD_ID),
    },
    mistral: {
      apiKey: pick(ha?.mistral_api_key, env.MISTRAL_API_KEY),
      chatModel: pick(ha?.mistral_chat_model, env.MISTRAL_CHAT_MODEL, 'mistral-medium-3-5'),
      transcribeModel: pick(ha?.mistral_transcribe_model, env.MISTRAL_TRANSCRIBE_MODEL, 'voxtral-mini-latest'),
      chatPromptCostPer1M: num(ha?.mistral_chat_prompt_cost_per_1m ?? env.MISTRAL_CHAT_PROMPT_COST_PER_1M, 0.4),
      chatCompletionCostPer1M: num(ha?.mistral_chat_completion_cost_per_1m ?? env.MISTRAL_CHAT_COMPLETION_COST_PER_1M, 2.0),
      transcribeCostPerMinute: num(ha?.mistral_transcribe_cost_per_minute ?? env.MISTRAL_TRANSCRIBE_COST_PER_MINUTE, 0.001),
    },
    voice: {
      kwsEncoderPath: pick(ha?.kws_encoder_path, env.KWS_ENCODER_PATH, '/config/kws/encoder.onnx'),
      kwsDecoderPath: pick(ha?.kws_decoder_path, env.KWS_DECODER_PATH, '/config/kws/decoder.onnx'),
      kwsJoinerPath: pick(ha?.kws_joiner_path, env.KWS_JOINER_PATH, '/config/kws/joiner.onnx'),
      kwsTokensPath: pick(ha?.kws_tokens_path, env.KWS_TOKENS_PATH, '/config/kws/tokens.txt'),
      kwsKeywordsPath: pick(ha?.kws_keywords_path, env.KWS_KEYWORDS_PATH, '/config/kws/keywords.txt'),
      kwsThreshold: clamp(num(ha?.kws_threshold ?? env.KWS_THRESHOLD, 0.25), 0, 1),
      kwsScore: num(ha?.kws_score ?? env.KWS_SCORE, 1.0),
      kwsDebug: bool(ha?.kws_debug ?? env.KWS_DEBUG, false),
      wakeMode: pick(ha?.wake_mode, env.WAKE_MODE, 'transcribe') === 'kws' ? 'kws' : 'transcribe',
      wakeWords: pick(ha?.voice_wake_words, env.VOICE_WAKE_WORDS, 'swann,souane,swan,soane,soin')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
      language: pick(ha?.voice_language, env.VOICE_LANGUAGE, 'fr'),
      sileroVadPath: pick(ha?.silero_vad_path, env.SILERO_VAD_PATH, '/config/silero_vad.onnx'),
      ttsEnabled: bool(ha?.tts_enabled ?? env.TTS_ENABLED, false),
      ttsModelPath: pick(ha?.tts_model_path, env.TTS_MODEL_PATH, '/config/tts/fr_FR-siwis-medium.onnx'),
      ttsTokensPath: pick(ha?.tts_tokens_path, env.TTS_TOKENS_PATH, '/config/tts/tokens.txt'),
      ttsDataDir: pick(ha?.tts_data_dir, env.TTS_DATA_DIR, '/config/tts/espeak-ng-data'),
      ttsRate: clamp(num(ha?.tts_rate ?? env.TTS_RATE, 1.0), 0.5, 2.0),
      wakeChime: bool(ha?.wake_chime ?? env.WAKE_CHIME, false),
      wakeChimePath: pick(ha?.wake_chime_path, env.WAKE_CHIME_PATH, ''),
    },
    media: {
      ytdlpPath: pick(ha?.ytdlp_path, env.YTDLP_PATH, 'yt-dlp'),
      ytdlpFormat: pick(ha?.ytdlp_format, env.YTDLP_FORMAT, 'bestaudio[ext=webm]/bestaudio/best'),
      cookiesPath: pick(ha?.ytdlp_cookies_path, env.YTDLP_COOKIES_PATH),
      searchLimitMax: clamp(num(ha?.search_limit_max ?? env.SEARCH_LIMIT_MAX, 25), 1, 50),
    },
    admin: {
      ingressPort: clamp(num(ha?.ingress_port ?? env.INGRESS_PORT, 8099), 1, 65535),
      bindAddress: pick(ha?.admin_bind_address, env.ADMIN_BIND_ADDRESS, '0.0.0.0'),
      ingressOnly: bool(ha?.admin_ingress_only ?? env.ADMIN_INGRESS_ONLY, isHomeAssistant),
    },
    behaviour: {
      logLevel: asLevel(ha?.log_level ?? env.LOG_LEVEL, 'info'),
      textWakePhrase: pick(ha?.text_wake_phrase, env.TEXT_WAKE_PHRASE, 'Hey Swann'),
      defaultVolume: clamp(num(ha?.default_volume ?? env.DEFAULT_VOLUME, 80), 0, 100),
    },
  };

  // Register every secret with the logger so it can never be printed.
  registerSecret(config.discord.token);
  registerSecret(config.mistral.apiKey);

  setLogLevel(config.behaviour.logLevel);

  return config;
}

/** The resolved, immutable application config. */
export const config: Config = build();

/**
 * Presence-only view of credentials for the admin UI / startup checks.
 * Never exposes any value. File-presence (keyword/silero) and yt-dlp
 * availability are added by the composition root in index.ts.
 */
export function configStatus(): {
  discordToken: boolean;
  discordAppId: boolean;
  mistralApiKey: boolean;
} {
  return {
    discordToken: config.discord.token.length > 0,
    discordAppId: config.discord.appId.length > 0,
    mistralApiKey: config.mistral.apiKey.length > 0,
  };
}

/**
 * Throw early with a clear message if a required credential is missing.
 * Call from index.ts before booting. Does not log values.
 */
export function assertRequired(): void {
  const missing: string[] = [];
  if (!config.discord.token) missing.push('DISCORD_TOKEN / discord_token');
  if (!config.discord.appId) missing.push('DISCORD_APP_ID / discord_app_id');
  if (!config.mistral.apiKey) missing.push('MISTRAL_API_KEY / mistral_api_key');
  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(', ')}`);
  }
}
