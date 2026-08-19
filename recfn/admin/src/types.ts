import type {
  Analytics,
  Bot,
  BotStatus,
  ChatMessage,
  MeetingMetadata,
  Participant,
  Platform,
  Recording,
  Transcript,
  Webhook,
} from "@recfn/core";
import type { RecFnServerConfig } from "@recfn/server";
import type { AdminOperationContext } from "@superfunctions/admin";

export interface RecFnListBotsInput {
  limit?: number;
  cursor?: string;
  status?: BotStatus;
  platform?: Platform;
}
export interface RecFnGetBotInput { botId: string }
export interface RecFnBotListOutput { items: Bot[]; nextCursor: string | null }
export interface RecFnBotOutput { item: Bot }
export interface RecFnLeaveBotOutput { botId: string; status: "leaving" }
export interface RecFnDeleteBotOutput { botId: string; deleted: true }

export interface RecFnBotResourceInput { botId: string }
export interface RecFnGetRecordingInput { recordingId: string }
export interface RecFnRecordingListOutput { items: Recording[]; nextCursor: null }
export interface RecFnRecordingOutput { item: Recording }
export interface RecFnTranscriptOutput { item: Transcript }
export interface RecFnParticipantListOutput { items: Participant[]; nextCursor: null }
export interface RecFnChatListOutput { items: ChatMessage[]; nextCursor: null }
export interface RecFnMetadataOutput { item: MeetingMetadata }
export interface RecFnAnalyticsOutput { item: Analytics }

export interface RecFnListWebhooksInput {}
export interface RecFnCreateWebhookInput {
  url: string;
  events: string[];
  secret?: string;
}
export interface RecFnDeleteWebhookInput { webhookId: string }
export type RecFnAdminWebhook = Omit<Webhook, "secret">;
export interface RecFnWebhookListOutput { items: RecFnAdminWebhook[]; nextCursor: null }
export interface RecFnWebhookOutput { item: RecFnAdminWebhook }
export interface RecFnDeleteWebhookOutput { webhookId: string; deleted: true }

export interface RecFnAdminService {
  listBots(input: RecFnListBotsInput, context: AdminOperationContext): Promise<RecFnBotListOutput>;
  getBot(input: RecFnGetBotInput, context: AdminOperationContext): Promise<RecFnBotOutput>;
  leaveBot(input: RecFnGetBotInput, context: AdminOperationContext): Promise<RecFnLeaveBotOutput>;
  deleteBot(input: RecFnGetBotInput, context: AdminOperationContext): Promise<RecFnDeleteBotOutput>;
  listRecordings(input: RecFnBotResourceInput, context: AdminOperationContext): Promise<RecFnRecordingListOutput>;
  getRecording(input: RecFnGetRecordingInput, context: AdminOperationContext): Promise<RecFnRecordingOutput>;
  getTranscript(input: RecFnGetRecordingInput, context: AdminOperationContext): Promise<RecFnTranscriptOutput>;
  listParticipants(input: RecFnBotResourceInput, context: AdminOperationContext): Promise<RecFnParticipantListOutput>;
  listChat(input: RecFnBotResourceInput, context: AdminOperationContext): Promise<RecFnChatListOutput>;
  getMetadata(input: RecFnBotResourceInput, context: AdminOperationContext): Promise<RecFnMetadataOutput>;
  getAnalytics(input: RecFnGetRecordingInput, context: AdminOperationContext): Promise<RecFnAnalyticsOutput>;
  listWebhooks(input: RecFnListWebhooksInput, context: AdminOperationContext): Promise<RecFnWebhookListOutput>;
  createWebhook(input: RecFnCreateWebhookInput, context: AdminOperationContext): Promise<RecFnWebhookOutput>;
  deleteWebhook(input: RecFnDeleteWebhookInput, context: AdminOperationContext): Promise<RecFnDeleteWebhookOutput>;
}

export interface RecFnDomainAdminServiceOptions {
  /** Project that owns the supplied RecFn store and runtime adapters. */
  projectId: string;
  /**
   * Public RecFn server configuration. The admin binding supplies a
   * scope-derived API identity and disables per-request rate limiting.
   */
  server: Omit<RecFnServerConfig, "validateApiKey" | "rateLimit">;
}
