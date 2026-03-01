export type Platform = 'zoom' | 'meet' | 'teams';

export type BotStatus =
  | 'creating'
  | 'joining'
  | 'joined'
  | 'recording'
  | 'leaving'
  | 'left'
  | 'done'
  | 'error';

export type ConsentStatus = 'granted' | 'denied' | 'pending' | 'unknown';

export type ParticipantRole = 'host' | 'attendee' | 'bot';

export type RecordingFormat = 'mp4' | 'wav' | 'opus' | 'webm';

export type TranscriptStatus = 'processing' | 'ready' | 'error';

export type TranscriptExportFormat = 'json' | 'srt' | 'vtt' | 'text';

export type CalendarProvider = 'google' | 'outlook';

export interface BotConfig {
  displayName?: string;
  joinTimeout?: number;
  autoLeaveOnEmpty?: boolean;
  autoLeaveEmptyTimeout?: number;
  consentMessage?: string;
  enableRealTimeTranscript?: boolean;
  asrProvider?: string;
  recordingFormat?: 'mp4' | 'audio_only';
  language?: string;
}

export interface Bot {
  id: string;
  namespace: string;
  meetingUrl: string;
  platform: Platform;
  status: BotStatus;
  config: BotConfig;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Recording {
  id: string;
  botId: string;
  format: RecordingFormat;
  duration: number;
  storageRef: string;
  size: number;
  downloadUrl?: string;
  createdAt: string;
}

export interface Transcript {
  id: string;
  recordingId: string;
  language: string;
  status: TranscriptStatus;
  segments: Segment[];
  createdAt: string;
}

export interface Segment {
  speakerId: string;
  startTime: number;
  endTime: number;
  text: string;
  confidence: number;
}

export interface Participant {
  id: string;
  botId: string;
  name: string;
  email?: string;
  role: ParticipantRole;
  joinedAt: string;
  leftAt?: string;
  consent: ConsentStatus;
}

export interface MeetingMetadata {
  id: string;
  botId: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  platform: Platform;
  chatMessages: ChatMessage[];
}

export interface ChatMessage {
  participantId: string;
  text: string;
  timestamp: string;
}

export interface Analytics {
  recordingId: string;
  totalDuration: number;
  talkTime: Record<string, number>;
  silencePercentage: number;
  topicSegments?: TopicSegment[];
}

export interface TopicSegment {
  topic: string;
  startTime: number;
  endTime: number;
  keywords: string[];
}

export interface Calendar {
  id: string;
  provider: CalendarProvider;
  autoSchedule: boolean;
  createdAt: string;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  startTime: string;
  endTime: string;
  meetingUrl?: string;
  botId?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret?: string;
  createdAt: string;
}

export interface Envelope<T> {
  ok: true;
  data: T;
}

export interface EnvelopeError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type Result<T> = Envelope<T> | EnvelopeError;

export interface AudioChunk {
  data: Uint8Array;
  timestamp: number;
  sampleRate: number;
  channels: number;
}

export interface VideoChunk {
  data: Uint8Array;
  timestamp: number;
  width: number;
  height: number;
}
