import type { Bot, Participant, Recording, Transcript } from 'recfn';

export const WEBHOOK_EVENTS = [
  'bot.joining',
  'bot.joined',
  'bot.left',
  'bot.error',
  'recording.ready',
  'transcript.ready',
  'participant.joined',
  'participant.left',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookPayload {
  event: WebhookEventType;
  eventId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function buildBotJoiningPayload(bot: Bot): WebhookPayload {
  return {
    event: 'bot.joining',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      botId: bot.id,
      meetingUrl: bot.meetingUrl,
      platform: bot.platform,
    },
  };
}

export function buildBotJoinedPayload(bot: Bot): WebhookPayload {
  return {
    event: 'bot.joined',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      botId: bot.id,
      meetingUrl: bot.meetingUrl,
      platform: bot.platform,
    },
  };
}

export function buildBotLeftPayload(bot: Bot): WebhookPayload {
  return {
    event: 'bot.left',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      botId: bot.id,
      meetingUrl: bot.meetingUrl,
      platform: bot.platform,
    },
  };
}

export function buildBotErrorPayload(
  botId: string,
  meetingUrl: string,
  platform: string,
  errorMessage: string,
): WebhookPayload {
  return {
    event: 'bot.error',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      botId,
      meetingUrl,
      platform,
      errorMessage,
    },
  };
}

export function buildRecordingReadyPayload(
  recording: Recording,
  botId: string,
): WebhookPayload {
  return {
    event: 'recording.ready',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      recordingId: recording.id,
      botId,
      format: recording.format,
      duration: recording.duration,
      size: recording.size,
    },
  };
}

export function buildTranscriptReadyPayload(
  transcript: Transcript,
  recordingId: string,
  botId: string,
): WebhookPayload {
  return {
    event: 'transcript.ready',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      transcriptId: transcript.id,
      recordingId,
      botId,
      language: transcript.language,
      segmentCount: transcript.segments.length,
    },
  };
}

export function buildParticipantJoinedPayload(
  botId: string,
  participant: Participant,
): WebhookPayload {
  return {
    event: 'participant.joined',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      botId,
      participant: {
        id: participant.id,
        name: participant.name,
        email: participant.email,
        role: participant.role,
        joinedAt: participant.joinedAt,
        consent: participant.consent,
      },
    },
  };
}

export function buildParticipantLeftPayload(
  botId: string,
  participantId: string,
): WebhookPayload {
  return {
    event: 'participant.left',
    eventId: generateEventId(),
    timestamp: new Date().toISOString(),
    data: {
      botId,
      participantId,
    },
  };
}
