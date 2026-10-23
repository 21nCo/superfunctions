import type { TableSchema } from '@superfunctions/db';
export const ALERTS = 'watchfn_alerts';
export const ALERT_OUTBOX = 'watchfn_alert_outbox';
export const ALERT_RUNTIME = 'watchfn_alert_runtime';
export function getAlertSchema(): Record<string, TableSchema> {
  return {
    [ALERT_RUNTIME]: { modelName: ALERT_RUNTIME, fields: {
      id: { type: 'string', required: true, unique: true }, protocol: { type: 'string', required: true },
      migrationPhase: { type: 'string' }, migrationCursor: { type: 'string' }, migrationRevision: { type: 'number' },
    } },
    [ALERTS]: { modelName: ALERTS, fields: {
      id: { type: 'string', required: true, unique: true }, namespace: { type: 'string', required: true },
      state: { type: 'string', required: true }, revision: { type: 'number', required: true }, payload: { type: 'json', jsonStorageType: 'json-text', required: true },
    }, indexes: [{ name: 'watchfn_alert_namespace', fields: ['namespace', 'id'] }] },
    [ALERT_OUTBOX]: { modelName: ALERT_OUTBOX, fields: {
      id: { type: 'string', required: true, unique: true }, namespace: { type: 'string', required: true }, alertId: { type: 'string', required: true },
      revision: { type: 'number', required: true }, state: { type: 'string', required: true }, availableAt: { type: 'number', required: true },
      leaseToken: { type: 'string' }, predecessorId: { type: 'string' }, completedAt: { type: 'number' }, attempts: { type: 'number', required: true },
      payload: { type: 'json', jsonStorageType: 'json-text', required: true },
    }, indexes: [{ name: 'watchfn_alert_dispatch', fields: ['namespace', 'state', 'availableAt', 'id'] }, { name: 'watchfn_alert_receipts', fields: ['namespace', 'completedAt', 'id'] }, { name: 'watchfn_alert_predecessor', fields: ['namespace', 'predecessorId'] }, { name: 'watchfn_alert_jobs', fields: ['namespace', 'id'] }] },
  };
}
