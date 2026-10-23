export type {
  Platform,
  BotStatus,
  ConsentStatus,
  ParticipantRole,
  RecordingFormat,
  TranscriptStatus,
  TranscriptExportFormat,
  CalendarProvider,
  BotConfig,
  Bot,
  Recording,
  Transcript,
  Segment,
  Participant,
  MeetingMetadata,
  ChatMessage,
  Analytics,
  TopicSegment,
  Calendar,
  CalendarEvent,
  Webhook,
  Envelope,
  EnvelopeError,
  Result,
  AudioChunk,
  VideoChunk,
} from './types.js';

export type { AsrAdapter, AsrOpts } from './adapters/asr.js';
export type { PlatformAdapter } from './adapters/platform.js';
export type {
  TranscriptStreamFrameType,
  TranscriptStreamFrameDataMap,
  TranscriptStreamFrame,
  TranscriptStreamServerFrame,
  TranscriptStreamParticipantLeftData,
  TranscriptStreamStatusData,
  TranscriptStreamErrorData,
} from './ws.js';

export {
  ErrorCode,
  ErrorHttpStatus,
  RecFnError,
  createError,
} from './errors.js';
export type { ErrorCodeType, RecFnErrorOptions } from './errors.js';

export {
  detectPlatform,
  validateMeetingUrl,
} from './validators/url.js';

export {
  validateBotConfig,
  getAsrProviders,
} from './validators/bot-config.js';

export {
  canTransition,
  assertTransition,
  isTerminalState,
  getValidTransitions,
  BOT_STATUS_ORDER,
} from './validators/state-machine.js';

export { toSRT } from './formatters/srt.js';
export { toVTT } from './formatters/vtt.js';
export { toText } from './formatters/text.js';

export {
  computeAnalytics,
  computeTalkTime,
  computeSilencePercentage,
  computeTopicSegments,
} from './analytics/index.js';

export {
  TRANSCRIPT_STREAM_FRAME_SCHEMA,
  parseTranscriptStreamFrame,
  serializeTranscriptStreamFrame,
} from './ws.js';
