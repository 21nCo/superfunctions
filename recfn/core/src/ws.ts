import type {
  BotStatus,
  ConsentStatus,
  Participant,
  ParticipantRole,
  Segment,
} from './types.js';

const BOT_STATUSES: readonly BotStatus[] = [
  'creating',
  'joining',
  'joined',
  'recording',
  'leaving',
  'finalizing',
  'left',
  'done',
  'error',
];

const PARTICIPANT_ROLES: readonly ParticipantRole[] = ['host', 'attendee', 'bot'];
const CONSENT_STATUSES: readonly ConsentStatus[] = [
  'granted',
  'denied',
  'pending',
  'unknown',
];

export const TRANSCRIPT_STREAM_FRAME_SCHEMA = {
  segment: {
    direction: 'server_to_client',
    requiresData: true,
    requiredKeys: ['speakerId', 'startTime', 'endTime', 'text', 'confidence'],
  },
  participant_joined: {
    direction: 'server_to_client',
    requiresData: true,
    requiredKeys: ['id', 'botId', 'name', 'role', 'joinedAt', 'consent'],
  },
  participant_left: {
    direction: 'server_to_client',
    requiresData: true,
    requiredKeys: ['participantId'],
  },
  status: {
    direction: 'server_to_client',
    requiresData: true,
    requiredKeys: ['botStatus'],
  },
  error: {
    direction: 'server_to_client',
    requiresData: true,
    requiredKeys: ['code', 'message'],
  },
  ping: {
    direction: 'bidirectional',
    requiresData: false,
    requiredKeys: [],
  },
  pong: {
    direction: 'server_to_client',
    requiresData: false,
    requiredKeys: [],
  },
} as const;

export type TranscriptStreamFrameType = keyof typeof TRANSCRIPT_STREAM_FRAME_SCHEMA;

export interface TranscriptStreamParticipantLeftData {
  participantId: string;
}

export interface TranscriptStreamStatusData {
  botStatus: BotStatus;
}

export interface TranscriptStreamErrorData {
  code: string;
  message: string;
}

export interface TranscriptStreamFrameDataMap {
  segment: Segment;
  participant_joined: Participant;
  participant_left: TranscriptStreamParticipantLeftData;
  status: TranscriptStreamStatusData;
  error: TranscriptStreamErrorData;
  ping: never;
  pong: never;
}

type NoDataFrameType = {
  [K in TranscriptStreamFrameType]: TranscriptStreamFrameDataMap[K] extends never ? K : never;
}[TranscriptStreamFrameType];

type DataFrameType = Exclude<TranscriptStreamFrameType, NoDataFrameType>;

export type TranscriptStreamFrame =
  | {
      [K in DataFrameType]: {
        type: K;
        data: TranscriptStreamFrameDataMap[K];
      };
    }[DataFrameType]
  | {
      [K in NoDataFrameType]: {
        type: K;
      };
    }[NoDataFrameType];

export type TranscriptStreamServerFrame = Exclude<TranscriptStreamFrame, { type: 'ping' }>;

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return isString(value) && allowed.includes(value as T);
}

function parseSegment(value: unknown): Segment | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    !isString(value.speakerId) ||
    !isNumber(value.startTime) ||
    !isNumber(value.endTime) ||
    !isString(value.text) ||
    !isNumber(value.confidence)
  ) {
    return null;
  }
  return {
    speakerId: value.speakerId,
    startTime: value.startTime,
    endTime: value.endTime,
    text: value.text,
    confidence: value.confidence,
  };
}

function parseParticipant(value: unknown): Participant | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (
    !isString(value.id) ||
    !isString(value.botId) ||
    !isString(value.name) ||
    !isOneOf(value.role, PARTICIPANT_ROLES) ||
    !isString(value.joinedAt) ||
    !isOneOf(value.consent, CONSENT_STATUSES)
  ) {
    return null;
  }
  if (value.email !== undefined && !isString(value.email)) {
    return null;
  }
  if (value.leftAt !== undefined && !isString(value.leftAt)) {
    return null;
  }

  return {
    id: value.id,
    botId: value.botId,
    name: value.name,
    role: value.role,
    joinedAt: value.joinedAt,
    consent: value.consent,
    ...(value.email !== undefined ? { email: value.email } : {}),
    ...(value.leftAt !== undefined ? { leftAt: value.leftAt } : {}),
  };
}

function parseParticipantLeftData(value: unknown): TranscriptStreamParticipantLeftData | null {
  if (!isObjectRecord(value) || !isString(value.participantId)) {
    return null;
  }
  return { participantId: value.participantId };
}

function parseStatusData(value: unknown): TranscriptStreamStatusData | null {
  if (!isObjectRecord(value) || !isOneOf(value.botStatus, BOT_STATUSES)) {
    return null;
  }
  return { botStatus: value.botStatus };
}

function parseErrorData(value: unknown): TranscriptStreamErrorData | null {
  if (!isObjectRecord(value) || !isString(value.code) || !isString(value.message)) {
    return null;
  }
  return { code: value.code, message: value.message };
}

export function parseTranscriptStreamFrame(value: unknown): TranscriptStreamFrame | null {
  if (!isObjectRecord(value) || !isString(value.type)) {
    return null;
  }

  switch (value.type) {
    case 'segment': {
      const data = parseSegment(value.data);
      return data ? { type: 'segment', data } : null;
    }
    case 'participant_joined': {
      const data = parseParticipant(value.data);
      return data ? { type: 'participant_joined', data } : null;
    }
    case 'participant_left': {
      const data = parseParticipantLeftData(value.data);
      return data ? { type: 'participant_left', data } : null;
    }
    case 'status': {
      const data = parseStatusData(value.data);
      return data ? { type: 'status', data } : null;
    }
    case 'error': {
      const data = parseErrorData(value.data);
      return data ? { type: 'error', data } : null;
    }
    case 'ping':
    case 'pong':
      return value.data === undefined ? { type: value.type } : null;
    default:
      return null;
  }
}

export function serializeTranscriptStreamFrame(frame: TranscriptStreamFrame): string {
  const parsed = parseTranscriptStreamFrame(frame);
  if (!parsed) {
    throw new Error('Invalid transcript stream frame.');
  }
  return JSON.stringify(parsed);
}
