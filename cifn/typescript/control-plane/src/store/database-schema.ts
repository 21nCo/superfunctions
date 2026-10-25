import type { TableSchemaMap } from '@superfunctions/db';

export const CIFN_STATE_TABLE = 'cifn_state';
/** Schema v1: encrypted payloads, public selection metadata, optimistic revisions. */
export function getCiFnStoreSchema(): TableSchemaMap {
  return { [CIFN_STATE_TABLE]: { modelName: CIFN_STATE_TABLE, fields: {
    id: { type: 'string', required: true, unique: true },
    namespace: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    status: { type: 'string', required: true },
    createdAt: { type: 'string', required: true },
    revision: { type: 'number', required: true },
    payload: { type: 'json', jsonStorageType: 'json-text', required: true },
  }, indexes: [{ name: 'cifn_state_listing', fields: ['namespace', 'kind', 'status', 'createdAt'] }, { name: 'cifn_state_telemetry', fields: ['namespace', 'id'] }] } };
}
/** SQLite v1 migration. Existing tables are never rewritten or silently upgraded. */
export const CIFN_SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS cifn_state (
  id TEXT PRIMARY KEY NOT NULL,
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cifn_state_listing
  ON cifn_state (namespace, kind, status, createdAt, id);
CREATE INDEX IF NOT EXISTS cifn_state_telemetry
  ON cifn_state (namespace, id);
`;
