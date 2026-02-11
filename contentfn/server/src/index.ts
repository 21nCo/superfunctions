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
