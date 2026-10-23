import type { TableSchemaMap } from '@superfunctions/db';

/** Apply this migration metadata before serving requests; no schema is required on adapter construction. */
export function getUserFnSchema(): TableSchemaMap {
  return { userfn_message_counters: {
    modelName: 'userfn_message_counters', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 64 },
      count: { type: 'number', required: true },
    },
  }, userfn_message_receipts: {
    modelName: 'userfn_message_receipts', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 64 },
      fingerprint: { type: 'string', required: true, maxLength: 64 },
      campaignId: { type: 'string', required: true, maxLength: 100 },
      allowed: { type: 'boolean', required: true },
      shown: { type: 'boolean', required: true },
      reason: { type: 'string', required: true, maxLength: 16 },
    },
  }, userfn_message_timing: {
    modelName: 'userfn_message_timing', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 64 },
      lastReservedAt: { type: 'number', required: true },
    },
  }, userfn_message_receipt_timing: {
    modelName: 'userfn_message_receipt_timing', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 64 },
      reservedAt: { type: 'number', required: true },
      expiresAt: { type: 'number', required: true },
    },
  }, userfn_flag_config: {
    modelName: 'userfn_flag_config',
    fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 64 },
      tenantId: { type: 'string', required: true, maxLength: 200 },
      environment: { type: 'string', required: true, maxLength: 100 },
      etag: { type: 'string', required: true, maxLength: 66 },
      body: { type: 'string', required: true },
      signature: { type: 'string', required: true, maxLength: 100 },
    },
  }, userfn_feedback: {
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
  }, userfn_feedback_votes: {
    modelName: 'userfn_feedback_votes',
    fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 67 },
      tenantId: { type: 'string', required: true, maxLength: 200 },
      feedbackId: { type: 'string', required: true, maxLength: 67 },
      actorType: { type: 'string', required: true, maxLength: 16 },
      actorId: { type: 'string', required: true, maxLength: 200 },
      direction: { type: 'number', required: true },
    },
    indexes: [{ name: 'userfn_votes_feedback_direction', fields: ['tenantId', 'feedbackId', 'direction'] }],
  }, userfn_feedback_attributes: {
    modelName: 'userfn_feedback_attributes', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 67 },
      tenantId: { type: 'string', required: true, maxLength: 200 },
      productArea: { type: 'string', maxLength: 100 },
    }, indexes: [{ name: 'userfn_feedback_area', fields: ['tenantId', 'productArea', 'id'] }],
  }, userfn_feedback_tags: {
    modelName: 'userfn_feedback_tags', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 67 },
      tenantId: { type: 'string', required: true, maxLength: 200 },
      feedbackId: { type: 'string', required: true, maxLength: 67 },
      tag: { type: 'string', required: true, maxLength: 64 },
    }, indexes: [{ name: 'userfn_feedback_tag', fields: ['tenantId', 'tag', 'feedbackId'] }],
  }, userfn_feedback_migrations: {
    modelName: 'userfn_feedback_migrations', fields: {
      id: { type: 'string', required: true, unique: true, maxLength: 64 },
      status: { type: 'string', required: true, maxLength: 16 },
      cursor: { type: 'string', maxLength: 67 },
    },
  } };
}
