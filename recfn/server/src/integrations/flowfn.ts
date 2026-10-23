import {
  MemoryQueueAdapter as SharedMemoryQueueAdapter,
  type QueueAdapter as SharedQueueAdapter,
} from '@superfunctions/queue';

export interface JobPayload {
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface BotJoinJobData {
  botId: string;
  namespace: string;
}

export interface RecordingUploadJobData {
  botId: string;
  namespace: string;
}

export type QueueAdapter = SharedQueueAdapter<JobPayload>;
export const MemoryQueueAdapter = SharedMemoryQueueAdapter as unknown as new () => QueueAdapter;

export const QUEUE_NAMES = {
  BOT_JOIN: 'recfn.bot.join',
  RECORDING_UPLOAD: 'recfn.recording.upload',
  TRANSCRIPTION: 'recfn.transcription',
} as const;
