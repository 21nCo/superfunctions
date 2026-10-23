import {
  defineAdminCapability,
  type AdminObjectSchema,
  type AdminOperationDefinition,
  type AdminResourceDefinition,
} from "@superfunctions/admin";
import type {
  RecFnAnalyticsOutput,
  RecFnBotListOutput,
  RecFnBotOutput,
  RecFnBotResourceInput,
  RecFnChatListOutput,
  RecFnCreateWebhookInput,
  RecFnDeleteBotOutput,
  RecFnDeleteWebhookInput,
  RecFnDeleteWebhookOutput,
  RecFnGetBotInput,
  RecFnGetRecordingInput,
  RecFnLeaveBotOutput,
  RecFnListBotsInput,
  RecFnListWebhooksInput,
  RecFnMetadataOutput,
  RecFnParticipantListOutput,
  RecFnRecordingListOutput,
  RecFnRecordingOutput,
  RecFnTranscriptOutput,
  RecFnWebhookListOutput,
  RecFnWebhookOutput,
} from "./types.js";

const stringSchema = { type: "string", minLength: 1 } as const;
const dateSchema = { type: "string", minLength: 1, maxLength: 100 } as const;
const platformSchema = { type: "string", enum: ["zoom", "meet", "teams", "desktop"] } as const;
const botStatusSchema = { type: "string", enum: ["creating", "joining", "joined", "recording", "leaving", "finalizing", "left", "done", "error"] } as const;
const emptySchema: AdminObjectSchema = { type: "object", additionalProperties: false };

const botConfigSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    displayName: { type: "string" },
    joinTimeout: { type: "integer", minimum: 0 },
    autoLeaveOnEmpty: { type: "boolean" },
    autoLeaveEmptyTimeout: { type: "integer", minimum: 0 },
    consentMessage: { type: "string" },
    enableRealTimeTranscript: { type: "boolean" },
    asrProvider: { type: "string" },
    recordingFormat: { type: "string", enum: ["mp4", "audio_only"] },
    language: { type: "string" },
  },
  additionalProperties: false,
};

const botSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    namespace: stringSchema,
    meetingUrl: { type: "string" },
    platform: platformSchema,
    status: botStatusSchema,
    config: botConfigSchema,
    errorMessage: { type: "string" },
    createdAt: dateSchema,
    updatedAt: dateSchema,
  },
  required: ["id", "namespace", "meetingUrl", "platform", "status", "config", "createdAt", "updatedAt"],
  additionalProperties: false,
};

const recordingSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    botId: stringSchema,
    format: { type: "string", enum: ["mp4", "wav", "opus", "webm"] },
    duration: { type: "number", minimum: 0 },
    storageRef: { type: "string" },
    size: { type: "number", minimum: 0 },
    createdAt: dateSchema,
  },
  required: ["id", "botId", "format", "duration", "storageRef", "size", "createdAt"],
  additionalProperties: false,
};

const segmentSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    speakerId: stringSchema,
    startTime: { type: "number", minimum: 0 },
    endTime: { type: "number", minimum: 0 },
    text: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["speakerId", "startTime", "endTime", "text", "confidence"],
  additionalProperties: false,
};

const transcriptSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    recordingId: stringSchema,
    language: stringSchema,
    status: { type: "string", enum: ["processing", "ready", "error"] },
    segments: { type: "array", items: segmentSchema },
    createdAt: dateSchema,
  },
  required: ["id", "recordingId", "language", "status", "segments", "createdAt"],
  additionalProperties: false,
};

const participantSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    botId: stringSchema,
    name: stringSchema,
    email: { type: "string" },
    role: { type: "string", enum: ["host", "attendee", "bot"] },
    joinedAt: dateSchema,
    leftAt: dateSchema,
    consent: { type: "string", enum: ["granted", "denied", "pending", "unknown"] },
  },
  required: ["id", "botId", "name", "role", "joinedAt", "consent"],
  additionalProperties: false,
};

const chatSchema: AdminObjectSchema = {
  type: "object",
  properties: { participantId: stringSchema, text: { type: "string" }, timestamp: dateSchema },
  required: ["participantId", "text", "timestamp"],
  additionalProperties: false,
};

const metadataSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    id: stringSchema,
    botId: stringSchema,
    title: { type: "string" },
    startTime: dateSchema,
    endTime: dateSchema,
    platform: platformSchema,
    chatMessages: { type: "array", items: chatSchema },
  },
  required: ["id", "botId", "platform", "chatMessages"],
  additionalProperties: false,
};

const analyticsSchema: AdminObjectSchema = {
  type: "object",
  properties: {
    recordingId: stringSchema,
    totalDuration: { type: "number", minimum: 0 },
    talkTime: { type: "object", additionalProperties: { type: "number", minimum: 0 } },
    silencePercentage: { type: "number", minimum: 0, maximum: 100 },
    topicSegments: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  required: ["recordingId", "totalDuration", "talkTime", "silencePercentage"],
  additionalProperties: false,
};

const webhookSchema: AdminObjectSchema = {
  type: "object",
  properties: { id: stringSchema, url: stringSchema, events: { type: "array", items: stringSchema }, createdAt: dateSchema },
  required: ["id", "url", "events", "createdAt"],
  additionalProperties: false,
};

const botIdInput: AdminObjectSchema = { type: "object", properties: { botId: stringSchema }, required: ["botId"], additionalProperties: false };
const recordingIdInput: AdminObjectSchema = { type: "object", properties: { recordingId: stringSchema }, required: ["recordingId"], additionalProperties: false };
const webhookIdInput: AdminObjectSchema = { type: "object", properties: { webhookId: stringSchema }, required: ["webhookId"], additionalProperties: false };
const item = (schema: AdminObjectSchema): AdminObjectSchema => ({ type: "object", properties: { item: schema }, required: ["item"], additionalProperties: false });
const list = (schema: AdminObjectSchema, cursor: boolean): AdminObjectSchema => ({
  type: "object",
  properties: { items: { type: "array", items: schema }, nextCursor: cursor ? { type: ["string", "null"] } : { type: "null" } },
  required: ["items", "nextCursor"],
  additionalProperties: false,
});

export const recFnAdminResources = [
  { id: "bots", label: "Recording Bots", description: "Inspect and control persisted RecFn bot lifecycles.", icon: "recfn:bots", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "platform", "status", "updatedAt"], searchableFields: ["id", "status", "platform"], filterableFields: ["status", "platform"], sortableFields: ["createdAt", "updatedAt"], sensitiveFields: ["meetingUrl", "namespace", "errorMessage"] },
  { id: "recordings", label: "Recordings", description: "Inspect recordings persisted by RecFn.", icon: "recfn:recordings", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "botId", "format", "duration", "size"], searchableFields: ["id", "botId"], filterableFields: ["format"], sortableFields: ["createdAt", "duration", "size"], sensitiveFields: ["storageRef"] },
  { id: "transcripts", label: "Transcripts", description: "Inspect completed or in-progress RecFn transcripts.", icon: "recfn:transcripts", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "recordingId", "language", "status"], searchableFields: ["id", "recordingId"], filterableFields: ["status", "language"], sortableFields: ["createdAt"], sensitiveFields: ["segments"] },
  { id: "participants", label: "Participants", description: "Inspect participants captured for a RecFn bot.", icon: "recfn:participants", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "name", "role", "consent"], searchableFields: ["id", "name", "email"], filterableFields: ["role", "consent"], sortableFields: ["joinedAt", "leftAt"], sensitiveFields: ["email"] },
  { id: "chat", label: "Meeting Chat", description: "Inspect chat messages captured for a RecFn bot.", icon: "recfn:chat", risk: "sensitive", minimumScope: "project", idField: "timestamp", displayFields: ["participantId", "text", "timestamp"], searchableFields: ["participantId", "text"], filterableFields: [], sortableFields: ["timestamp"], sensitiveFields: ["text"] },
  { id: "metadata", label: "Meeting Metadata", description: "Inspect RecFn meeting metadata for a bot.", icon: "recfn:metadata", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "botId", "title", "platform"], searchableFields: ["id", "botId", "title"], filterableFields: ["platform"], sortableFields: ["startTime", "endTime"], sensitiveFields: ["chatMessages"] },
  { id: "analytics", label: "Recording Analytics", description: "Compute analytics from ready RecFn transcripts.", icon: "recfn:analytics", risk: "sensitive", minimumScope: "project", idField: "recordingId", displayFields: ["recordingId", "totalDuration", "silencePercentage"], searchableFields: ["recordingId"], filterableFields: [], sortableFields: ["totalDuration", "silencePercentage"], sensitiveFields: ["talkTime", "topicSegments"] },
  { id: "webhooks", label: "Webhooks", description: "Inspect and manage RecFn event webhook registrations.", icon: "recfn:webhooks", risk: "sensitive", minimumScope: "project", idField: "id", displayFields: ["id", "url", "events", "createdAt"], searchableFields: ["id", "url"], filterableFields: ["events"], sortableFields: ["createdAt"], sensitiveFields: ["secret"] },
] as const satisfies readonly AdminResourceDefinition[];

const readSafety = { classification: "read", idempotent: true, requiresConfirmation: false, audit: "required" } as const;
const readMcp = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;
const operations = [
  { id: "recfn.bots.list", title: "List bots", description: "List bots through RecFn's authenticated server route.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: stringSchema, status: botStatusSchema, platform: platformSchema }, additionalProperties: false }, outputSchema: list(botSchema, true), route: { method: "GET", path: "/resources/bots" }, permission: "recfn.bots.read", minimumScope: "project", safety: readSafety, pagination: { mode: "cursor", defaultLimit: 20, maxLimit: 100, cursorInput: "cursor", limitInput: "limit", itemsOutput: "items", nextCursorOutput: "nextCursor" }, mcp: readMcp, redaction: { outputFields: ["meetingUrl", "namespace", "errorMessage"] }, target: { resource: "bots", collection: true } } as const satisfies AdminOperationDefinition<RecFnListBotsInput, RecFnBotListOutput>,
  { id: "recfn.bots.get", title: "Get bot", description: "Get one bot without exposing its meeting URL.", inputSchema: botIdInput, outputSchema: item(botSchema), route: { method: "GET", path: "/resources/bots/:botId" }, permission: "recfn.bots.read", minimumScope: "project", safety: readSafety, mcp: readMcp, redaction: { outputFields: ["meetingUrl", "namespace", "errorMessage"] }, target: { resource: "bots", idInput: "botId" } } as const satisfies AdminOperationDefinition<RecFnGetBotInput, RecFnBotOutput>,
  { id: "recfn.bots.leave", title: "Leave meeting", description: "Move an active RecFn bot into its real leaving lifecycle.", inputSchema: botIdInput, outputSchema: { type: "object", properties: { botId: stringSchema, status: { type: "string", const: "leaving" } }, required: ["botId", "status"], additionalProperties: false }, route: { method: "POST", path: "/resources/bots/:botId/actions/leave" }, permission: "recfn.bots.leave", minimumScope: "project", safety: { classification: "write", idempotent: false, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "Leaving stops the bot's participation and recording lifecycle." }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, target: { resource: "bots", idInput: "botId" } } as const satisfies AdminOperationDefinition<RecFnGetBotInput, RecFnLeaveBotOutput>,
  { id: "recfn.bots.delete", title: "Delete bot", description: "Permanently delete a terminal RecFn bot.", inputSchema: botIdInput, outputSchema: { type: "object", properties: { botId: stringSchema, deleted: { type: "boolean", const: true } }, required: ["botId", "deleted"], additionalProperties: false }, route: { method: "DELETE", path: "/resources/bots/:botId" }, permission: "recfn.bots.delete", minimumScope: "project", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "critical", method: "recent-auth", reason: "Deletion permanently removes the terminal bot record.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "bots", idInput: "botId" } } as const satisfies AdminOperationDefinition<RecFnGetBotInput, RecFnDeleteBotOutput>,
  { id: "recfn.recordings.list", title: "List recordings", description: "List recordings persisted for one bot.", inputSchema: botIdInput, outputSchema: list(recordingSchema, false), route: { method: "GET", path: "/resources/recordings" }, permission: "recfn.recordings.read", minimumScope: "project", safety: readSafety, mcp: readMcp, redaction: { outputFields: ["storageRef"] }, target: { resource: "recordings", collection: true } } as const satisfies AdminOperationDefinition<RecFnBotResourceInput, RecFnRecordingListOutput>,
  { id: "recfn.recordings.get", title: "Get recording", description: "Get recording metadata without issuing a storage download.", inputSchema: recordingIdInput, outputSchema: item(recordingSchema), route: { method: "GET", path: "/resources/recordings/:recordingId" }, permission: "recfn.recordings.read", minimumScope: "project", safety: readSafety, mcp: readMcp, redaction: { outputFields: ["storageRef"] }, target: { resource: "recordings", idInput: "recordingId" } } as const satisfies AdminOperationDefinition<RecFnGetRecordingInput, RecFnRecordingOutput>,
  { id: "recfn.transcripts.get", title: "Get transcript", description: "Get the persisted transcript for one recording.", inputSchema: recordingIdInput, outputSchema: item(transcriptSchema), route: { method: "GET", path: "/resources/transcripts/:recordingId" }, permission: "recfn.transcripts.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "transcripts", idInput: "recordingId" } } as const satisfies AdminOperationDefinition<RecFnGetRecordingInput, RecFnTranscriptOutput>,
  { id: "recfn.participants.list", title: "List participants", description: "List participants persisted for one bot.", inputSchema: botIdInput, outputSchema: list(participantSchema, false), route: { method: "GET", path: "/resources/participants" }, permission: "recfn.participants.read", minimumScope: "project", safety: readSafety, mcp: readMcp, redaction: { outputFields: ["email"] }, target: { resource: "participants", collection: true } } as const satisfies AdminOperationDefinition<RecFnBotResourceInput, RecFnParticipantListOutput>,
  { id: "recfn.chat.list", title: "List chat messages", description: "List meeting chat persisted for one bot.", inputSchema: botIdInput, outputSchema: list(chatSchema, false), route: { method: "GET", path: "/resources/chat" }, permission: "recfn.chat.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "chat", collection: true } } as const satisfies AdminOperationDefinition<RecFnBotResourceInput, RecFnChatListOutput>,
  { id: "recfn.metadata.get", title: "Get meeting metadata", description: "Get meeting metadata persisted for one bot.", inputSchema: botIdInput, outputSchema: item(metadataSchema), route: { method: "GET", path: "/resources/metadata/:botId" }, permission: "recfn.metadata.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "metadata", idInput: "botId" } } as const satisfies AdminOperationDefinition<RecFnBotResourceInput, RecFnMetadataOutput>,
  { id: "recfn.analytics.get", title: "Get recording analytics", description: "Compute analytics through RecFn when the recording transcript is ready.", inputSchema: recordingIdInput, outputSchema: item(analyticsSchema), route: { method: "GET", path: "/resources/analytics/:recordingId" }, permission: "recfn.analytics.read", minimumScope: "project", safety: readSafety, mcp: readMcp, target: { resource: "analytics", idInput: "recordingId" } } as const satisfies AdminOperationDefinition<RecFnGetRecordingInput, RecFnAnalyticsOutput>,
  { id: "recfn.webhooks.list", title: "List webhooks", description: "List webhook registrations without returning signing secrets.", inputSchema: emptySchema, outputSchema: list(webhookSchema, false), route: { method: "GET", path: "/resources/webhooks" }, permission: "recfn.webhooks.read", minimumScope: "project", safety: readSafety, mcp: readMcp, redaction: { outputFields: ["secret"] }, target: { resource: "webhooks", collection: true } } as const satisfies AdminOperationDefinition<RecFnListWebhooksInput, RecFnWebhookListOutput>,
  { id: "recfn.webhooks.create", title: "Create webhook", description: "Register a webhook through RecFn's validated server route.", inputSchema: { type: "object", properties: { url: { type: "string", minLength: 1, maxLength: 5000 }, events: { type: "array", items: stringSchema, minItems: 1, maxItems: 100 }, secret: { type: "string", minLength: 1, maxLength: 10000 } }, required: ["url", "events"], additionalProperties: false }, outputSchema: item(webhookSchema), route: { method: "POST", path: "/resources/webhooks" }, permission: "recfn.webhooks.write", minimumScope: "project", safety: { classification: "write", idempotent: false, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "A webhook sends RecFn events to an external network destination." }, audit: "required" }, redaction: { inputFields: ["secret"] }, mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, target: { resource: "webhooks", collection: true } } as const satisfies AdminOperationDefinition<RecFnCreateWebhookInput, RecFnWebhookOutput>,
  { id: "recfn.webhooks.delete", title: "Delete webhook", description: "Permanently delete one RecFn webhook registration.", inputSchema: webhookIdInput, outputSchema: { type: "object", properties: { webhookId: stringSchema, deleted: { type: "boolean", const: true } }, required: ["webhookId", "deleted"], additionalProperties: false }, route: { method: "DELETE", path: "/resources/webhooks/:webhookId" }, permission: "recfn.webhooks.delete", minimumScope: "project", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason: "Deletion stops future RecFn event delivery to this endpoint.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "webhooks", idInput: "webhookId" } } as const satisfies AdminOperationDefinition<RecFnDeleteWebhookInput, RecFnDeleteWebhookOutput>,
] as const;

export const recFnAdminOperations = operations;
export type RecFnAdminOperationId = (typeof recFnAdminOperations)[number]["id"];

export const recFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0",
  id: "recfn",
  displayName: "RecFn",
  version: "1.0.0",
  description: "Project-scoped recording administration backed by RecFn's public server and store.",
  category: "media",
  availability: "required-product",
  scopeLevels: ["installation", "workspace", "project", "environment"],
  dependencies: [],
  resources: recFnAdminResources,
  navigation: [{ id: "recfn", label: "RecFn", path: "/modules/recfn", icon: "recfn", description: "Operate project-owned recordings.", order: 100 }],
  operations: recFnAdminOperations,
});
