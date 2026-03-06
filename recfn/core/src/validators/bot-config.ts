import type { BotConfig } from '../types.js';
import { createError, ErrorCode } from '../errors.js';

const KNOWN_ASR_PROVIDERS = [
  'whisper',
  'deepgram',
  'assemblyai',
  'google-stt',
];

const BOT_CONFIG_DEFAULTS: Required<BotConfig> = {
  displayName: 'RecFn Bot',
  joinTimeout: 30_000,
  autoLeaveOnEmpty: true,
  autoLeaveEmptyTimeout: 30_000,
  consentMessage: 'This meeting is being recorded',
  enableRealTimeTranscript: false,
  asrProvider: 'whisper',
  recordingFormat: 'mp4',
  language: 'en-US',
};

const MAX_JOIN_TIMEOUT = 60_000;
const MIN_JOIN_TIMEOUT = 1_000;

export function getAsrProviders(): readonly string[] {
  return KNOWN_ASR_PROVIDERS;
}

export function validateBotConfig(config?: BotConfig): Required<BotConfig> {
  const merged: Required<BotConfig> = { ...BOT_CONFIG_DEFAULTS };

  if (!config) {
    return merged;
  }

  if (config.displayName !== undefined) {
    merged.displayName = config.displayName;
  }

  if (config.joinTimeout !== undefined) {
    if (
      typeof config.joinTimeout !== 'number' ||
      config.joinTimeout < MIN_JOIN_TIMEOUT ||
      config.joinTimeout > MAX_JOIN_TIMEOUT
    ) {
      throw createError(
        ErrorCode.BAD_REQUEST,
        `joinTimeout must be between ${MIN_JOIN_TIMEOUT}ms and ${MAX_JOIN_TIMEOUT}ms.`,
        { joinTimeout: config.joinTimeout },
      );
    }
    merged.joinTimeout = config.joinTimeout;
  }

  if (config.autoLeaveOnEmpty !== undefined) {
    merged.autoLeaveOnEmpty = config.autoLeaveOnEmpty;
  }

  if (config.autoLeaveEmptyTimeout !== undefined) {
    if (
      typeof config.autoLeaveEmptyTimeout !== 'number' ||
      config.autoLeaveEmptyTimeout < 0
    ) {
      throw createError(
        ErrorCode.BAD_REQUEST,
        'autoLeaveEmptyTimeout must be a non-negative number.',
        { autoLeaveEmptyTimeout: config.autoLeaveEmptyTimeout },
      );
    }
    merged.autoLeaveEmptyTimeout = config.autoLeaveEmptyTimeout;
  }

  if (config.consentMessage !== undefined) {
    merged.consentMessage = config.consentMessage;
  }

  if (config.enableRealTimeTranscript !== undefined) {
    merged.enableRealTimeTranscript = config.enableRealTimeTranscript;
  }

  if (config.asrProvider !== undefined) {
    if (!KNOWN_ASR_PROVIDERS.includes(config.asrProvider)) {
      throw createError(
        ErrorCode.BAD_REQUEST,
        `Unknown ASR provider: ${config.asrProvider}. Supported: ${KNOWN_ASR_PROVIDERS.join(', ')}.`,
        { asrProvider: config.asrProvider },
      );
    }
    merged.asrProvider = config.asrProvider;
  }

  if (config.recordingFormat !== undefined) {
    if (config.recordingFormat !== 'mp4' && config.recordingFormat !== 'audio_only') {
      throw createError(
        ErrorCode.BAD_REQUEST,
        'recordingFormat must be "mp4" or "audio_only".',
        { recordingFormat: config.recordingFormat },
      );
    }
    merged.recordingFormat = config.recordingFormat;
  }

  if (config.language !== undefined) {
    merged.language = config.language;
  }

  return merged;
}
