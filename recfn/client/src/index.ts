import { RecFnHttpClient } from './client.js';
import { createBotsResource } from './resources/bots.js';
import { createRecordingsResource } from './resources/recordings.js';
import { createTranscriptsResource } from './resources/transcripts.js';
import { createParticipantsResource } from './resources/participants.js';
import { createChatResource } from './resources/chat.js';
import { createAnalyticsResource } from './resources/analytics.js';
import { createCalendarsResource } from './resources/calendars.js';
import { createWebhooksResource } from './resources/webhooks.js';
import { createMetadataResource } from './resources/metadata.js';

export type { ApiResult } from './client.js';
export type { CreateBotInput, ListBotsOptions, ListBotsResult } from './resources/bots.js';
export type { TranscriptSearchResult } from './resources/transcripts.js';
export type { CreateCalendarInput } from './resources/calendars.js';
export type { CreateWebhookInput } from './resources/webhooks.js';
export type { TranscriptStream, TranscriptStreamEvents } from './ws.js';

export interface RecFnConfig {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * RecFn TypeScript client SDK.
 * Wraps all REST API and WebSocket endpoints with typed methods.
 */
export class RecFn {
  private readonly client: RecFnHttpClient;

  readonly bots = createBotsResource(null as unknown as RecFnHttpClient);
  readonly recordings = createRecordingsResource(null as unknown as RecFnHttpClient);
  readonly transcripts = createTranscriptsResource(null as unknown as RecFnHttpClient);
  readonly participants = createParticipantsResource(null as unknown as RecFnHttpClient);
  readonly chat = createChatResource(null as unknown as RecFnHttpClient);
  readonly analytics = createAnalyticsResource(null as unknown as RecFnHttpClient);
  readonly calendars = createCalendarsResource(null as unknown as RecFnHttpClient);
  readonly webhooks = createWebhooksResource(null as unknown as RecFnHttpClient);
  readonly metadata = createMetadataResource(null as unknown as RecFnHttpClient);

  constructor(config: RecFnConfig) {
    this.client = new RecFnHttpClient(config);
    this.bots = createBotsResource(this.client);
    this.recordings = createRecordingsResource(this.client);
    this.transcripts = createTranscriptsResource(this.client);
    this.participants = createParticipantsResource(this.client);
    this.chat = createChatResource(this.client);
    this.analytics = createAnalyticsResource(this.client);
    this.calendars = createCalendarsResource(this.client);
    this.webhooks = createWebhooksResource(this.client);
    this.metadata = createMetadataResource(this.client);
  }

}
