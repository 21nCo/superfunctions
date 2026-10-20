import type { TableSchemaMap } from '@superfunctions/db';

/** Apply this migration metadata before serving requests; no schema is required on adapter construction. */
export function getUserFnSchema(): TableSchemaMap {
  return { userfn_feedback: {
    modelName: 'userfn_feedback',
    fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 67 },
      tenantId: { type: 'string', required: true, maxLength: 200 },
      actorId: { type: 'string', required: true, maxLength: 200 },
      fingerprint: { type: 'string', required: true, maxLength: 64 },
      payload: { type: 'json', required: true, jsonStorageType: 'json-text' },
      createdAt: { type: 'date', required: true, dateStorageType: 'iso-text', dateValueType: 'iso-string' },
      status: { type: 'string', required: true, maxLength: 32 },
      votes: { type: 'number', required: true },
    },
    indexes: [{ name: 'userfn_feedback_tenant_created', fields: ['tenantId', 'createdAt'] }],
  } };
}
