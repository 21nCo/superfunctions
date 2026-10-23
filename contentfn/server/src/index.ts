/**
 * ContentFn server: create server instance and HTTP handler.
 */

export {
  CONTENTFN_TABLE_NAMES,
  ALL_TABLES,
  contentfnDatasets,
  contentfnSchema,
  contentfnDocsPublished,
  contentfnDocsDrafts,
  contentfnRevisions,
  contentfnAssets,
  contentfnWebhooks,
  contentfnWebhookQueue,
  contentfnEvents,
  contentfnRtSessions,
} from "./storage/schema.js";
export type { TableDef, ColumnDef } from "./storage/schema.js";
export { runContentfnMigrations } from "./storage/migrate.js";
export type { MigrationAdapter } from "./storage/migrate.js";

export { createContentfnServer } from "./server.js";
export type { ContentfnServerConfig, ContentfnServer } from "./server.js";

export { RealtimeServer, RealtimeConnectionHandle } from "./realtime/server.js";
export type { AuthorizeFn, RealtimeServerConfig } from "./realtime/server.js";
export { SubscriptionRouter } from "./realtime/subscribe.js";
export type { Subscription, RealtimeConnection } from "./realtime/subscribe.js";
export type {
  RealtimeSubscribeMessage,
  RealtimeUnsubscribeMessage,
  RealtimeClientMessage,
  RealtimeSubscribeAck,
  RealtimeUnsubscribeAck,
  RealtimeEventMessage,
  RealtimeErrorMessage,
  RealtimeServerMessage,
} from "./realtime/protocol.js";
export { parseClientMessage } from "./realtime/protocol.js";

export { createAssetStorageBackend, InMemoryStorageBackend } from "./storage/storageBackend.js";
export type { AssetStorageBackend } from "./storage/storageBackend.js";
export { contentfnSchedules, getContentfnSchema, getSchema } from "./storage/schema.js";

export { contentfnAudit } from "./storage/schema.js";
export type { AuditRecord, AuditQuery } from "./storage/audit.js";
export { upgradeWebhookAuditSchema } from "./storage/migrate.js";
export { backfillWebhookAudit } from "./storage/webhookAudit.js";
export type { WebhookAuditRecord, WebhookAuditQuery } from "@contentfn/core";

export { getHistoryIndexDefinition, upgradeHistoryIndexSchema } from "./storage/migrate.js";
export type { HistoryIndexDefinition } from "./storage/migrate.js";
