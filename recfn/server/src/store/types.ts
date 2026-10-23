import type {
  Bot,
  BotConfig,
  BotStatus,
  Calendar,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Platform,
  Recording,
  Transcript,
  Webhook,
} from '@recfn/core';

export interface RecFnStoreCapabilities {
  durable: boolean;
  /** Built-in store atomic namespace admission; custom stores must explicitly implement this contract. */
  botAdmission?: { atomic: true; maximum: number };
  backend: 'memory' | 'db';
  adapterName: string;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
}

export interface ListBotsOptions extends ListOptions {
  status?: BotStatus;
  platform?: Platform;
}

export interface ListResult<T> {
  items: T[];
  nextCursor?: string;
}

export interface CreateBotInput {
  meetingUrl: string;
  platform: Platform;
  config: Required<BotConfig>;
  namespace: string;
}

export interface RecFnStore extends ReturnType<typeof import('./deletion.js').deletionMethods> {
  readonly capabilities: RecFnStoreCapabilities;

  createBot(input: CreateBotInput): Promise<Bot>;
  getBot(id: string, namespace: string): Promise<Bot | null>;
  listBots(namespace: string, opts: ListBotsOptions): Promise<ListResult<Bot>>;
  updateBot(
    id: string,
    namespace: string,
    updates: Partial<Pick<Bot, 'status' | 'errorMessage' | 'updatedAt'>>,
  ): Promise<Bot | null>;
  deleteBot(id: string, namespace: string): Promise<boolean>;

  createRecording(recording: Recording, namespace: string): Promise<Recording>;
  getRecordings(botId: string, namespace: string): Promise<Recording[]>;
  getRecording(
    id: string,
    namespace: string,
  ): Promise<(Recording & { namespace?: string }) | null>;

  createTranscript(transcript: Transcript, namespace: string): Promise<Transcript>;
  updateTranscript(
    id: string,
    namespace: string,
    updates: Partial<Pick<Transcript, 'status' | 'segments'>>,
  ): Promise<Transcript | null>;
  getTranscript(
    recordingId: string,
    namespace: string,
  ): Promise<Transcript | null>;

  getParticipants(botId: string, namespace: string): Promise<Participant[]>;
  addParticipant(
    botId: string,
    participant: Participant,
    namespace: string,
  ): Promise<Participant>;
  updateParticipant(
    botId: string,
    participantId: string,
    namespace: string,
    updates: Partial<Pick<Participant, 'leftAt' | 'consent'>>,
  ): Promise<Participant | null>;

  addChatMessage(
    botId: string,
    message: ChatMessage,
    namespace: string,
  ): Promise<ChatMessage>;
  getChatMessages(botId: string, namespace: string): Promise<ChatMessage[]>;

  upsertMetadata(
    botId: string,
    metadata: MeetingMetadata,
    namespace: string,
  ): Promise<MeetingMetadata>;
  getMetadata(
    botId: string,
    namespace: string,
  ): Promise<MeetingMetadata | null>;

  createWebhook(webhook: Omit<Webhook, 'id' | 'createdAt'>, namespace: string): Promise<Webhook>;
  listWebhooks(namespace: string): Promise<Webhook[]>;
  getWebhook(id: string, namespace: string): Promise<Webhook | null>;
  deleteWebhook(id: string, namespace: string): Promise<boolean>;

  createCalendar(calendar: Omit<Calendar, 'id' | 'createdAt'>, namespace: string): Promise<Calendar>;
  listCalendars(namespace: string): Promise<Calendar[]>;
  getCalendar(id: string, namespace: string): Promise<Calendar | null>;
  deleteCalendar(id: string, namespace: string): Promise<boolean>;

  setEventBotId(calendarId: string, eventId: string, botId: string, namespace: string): Promise<void>;
  getEventBotIds(calendarId: string, eventIds: string[], namespace: string): Promise<Map<string, string>>;
}
