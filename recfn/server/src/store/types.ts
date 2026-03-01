import type {
  Bot,
  BotConfig,
  BotStatus,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Platform,
  Recording,
  Transcript,
} from 'recfn';

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

export interface RecFnStore {
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

  getChatMessages(botId: string, namespace: string): Promise<ChatMessage[]>;

  getMetadata(
    botId: string,
    namespace: string,
  ): Promise<MeetingMetadata | null>;
}
